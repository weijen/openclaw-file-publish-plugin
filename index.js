const crypto = require("crypto");
const fs = require("node:fs/promises");
const path = require("path");
const { uploadToBlob } = require("./lib/blob");
const { sendTelegramDocument } = require("./lib/delivery");
const {
  contentTypeForPath,
  sanitiseFilename,
  safeResolve,
  buildBlobName,
} = require("./lib/file");

function normalizeOptionalValue(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.startsWith("__") && text.endsWith("__")) return "";
  if (text.startsWith("<") && text.endsWith(">")) return "";
  return text;
}

function normalizeChannel(value) {
  return String(value || "").trim().toLowerCase();
}

function expandHomePath(p) {
  if (!p) return p;
  if (p === "~" || p.startsWith("~/")) {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    return path.join(home, p.slice(1) || "");
  }
  return p;
}

/**
 * Emit one structured JSON line per call so downstream log shippers
 * (journald → Azure Monitor Agent → Log Analytics) can index by field.
 *
 * Intentionally redacts file contents, captions, prompts, and storage keys.
 */
function auditLog(api, payload) {
  const line = JSON.stringify({ event: "file_publish", ...payload });
  if (api.logger?.info) {
    api.logger.info(line);
  } else {
    // Fallback to stdout — captured by journald on the VM.
    console.log(line);
  }
}

function register(api) {
  const cfg = Object.assign(
    {
      mediaStorageAccount: "",
      mediaStorageKey: "",
      documentsContainer: "documents",
      workspaceRoot: "",
      maxSizeMB: 50,
      telegramMaxSizeMB: 50,
    },
    api.pluginConfig || {},
  );

  cfg.mediaStorageAccount = normalizeOptionalValue(cfg.mediaStorageAccount);
  cfg.documentsContainer = normalizeOptionalValue(cfg.documentsContainer) || "documents";
  cfg.workspaceRoot = expandHomePath(normalizeOptionalValue(cfg.workspaceRoot));

  function resolveStorageKey() {
    const configured = normalizeOptionalValue(cfg.mediaStorageKey);
    if (configured && !configured.startsWith("__KEYVAULT__:")) return configured;
    if (api.resolveSecret) {
      const secret = api.resolveSecret("media-storage-key");
      if (secret) return secret;
    }
    return process.env.MEDIA_STORAGE_KEY || "";
  }

  api.registerTool((toolCtx) => ({
    name: "publish_file",
    label: "publish_file",
    description:
      "Upload a locally-generated file to public storage and deliver it to the current chat. " +
      "Use AFTER you have produced a file (e.g. report.docx, sales.xlsx, slides.pptx, summary.pdf) " +
      "in your agent workspace via shell tools (pandoc, libreoffice, wkhtmltopdf, etc.). " +
      "On Telegram the user receives the file inline; on LINE/WhatsApp they receive a clickable HTTPS link. " +
      "NEVER publish private workspace files (memory, credentials, identity files).",
    parameters: {
      type: "object",
      required: ["path"],
      properties: {
        path: {
          type: "string",
          description: "Absolute path to the file to publish. Must live inside the agent workspace.",
        },
        displayName: {
          type: "string",
          description: "Filename shown to the user (defaults to basename of path).",
        },
        caption: {
          type: "string",
          description: "Optional one-line caption / message body shown next to the file.",
        },
      },
    },
    execute: async (_toolCallId, params) => {
      const channel = normalizeChannel(toolCtx?.messageChannel);
      const requested = String(params?.path || "");
      const displayName = sanitiseFilename(params?.displayName || path.basename(requested));
      const caption = String(params?.caption || "");

      // ---- Path safety + size limit ---------------------------------------
      let resolved;
      try {
        resolved = await safeResolve(requested, cfg.workspaceRoot, fs);
      } catch (err) {
        auditLog(api, {
          channel,
          to: toolCtx?.deliveryContext?.to || "",
          filename: displayName,
          status: "error",
          reason: "path",
          error: err.message,
        });
        return {
          content: [{ type: "text", text: `publish_file error: ${err.message}` }],
          details: { status: "error", reason: "path", error: err.message },
        };
      }

      const maxBytes = (cfg.maxSizeMB || 50) * 1024 * 1024;
      if (resolved.size > maxBytes) {
        const msg = `File too large: ${resolved.size} bytes exceeds ${cfg.maxSizeMB} MB limit.`;
        auditLog(api, {
          channel,
          to: toolCtx?.deliveryContext?.to || "",
          filename: displayName,
          size: resolved.size,
          status: "error",
          reason: "too_large",
        });
        return {
          content: [{ type: "text", text: `publish_file error: ${msg}` }],
          details: { status: "error", reason: "too_large", size: resolved.size },
        };
      }

      // ---- Read file & upload to blob -------------------------------------
      const buffer = await fs.readFile(resolved.realPath);
      const contentType = contentTypeForPath(resolved.realPath);

      const storageKey = resolveStorageKey();
      if (!cfg.mediaStorageAccount || !storageKey) {
        const msg = "Storage not configured (mediaStorageAccount or storage key missing).";
        auditLog(api, {
          channel,
          to: toolCtx?.deliveryContext?.to || "",
          filename: displayName,
          status: "error",
          reason: "no_storage",
        });
        return {
          content: [{ type: "text", text: `publish_file error: ${msg}` }],
          details: { status: "error", reason: "no_storage" },
        };
      }

      const blobName = buildBlobName(displayName, new Date(), () => crypto.randomUUID());
      let publicUrl;
      try {
        publicUrl = await uploadToBlob({
          accountName: cfg.mediaStorageAccount,
          accountKey: storageKey,
          containerName: cfg.documentsContainer,
          blobName,
          buffer,
          contentType,
        });
      } catch (err) {
        auditLog(api, {
          channel,
          to: toolCtx?.deliveryContext?.to || "",
          filename: displayName,
          size: buffer.length,
          contentType,
          status: "error",
          reason: "blob_upload",
          error: err.message,
        });
        return {
          content: [{ type: "text", text: `publish_file error: blob upload failed: ${err.message}` }],
          details: { status: "error", reason: "blob_upload", error: err.message },
        };
      }

      // ---- Telegram inline delivery (best-effort) -------------------------
      let deliveryMode = "url";
      const telegramMaxBytes = (cfg.telegramMaxSizeMB || 50) * 1024 * 1024;
      if (channel === "telegram" && buffer.length <= telegramMaxBytes) {
        const botToken = api.config?.channels?.telegram?.botToken;
        const rawTo = toolCtx?.deliveryContext?.to || "";
        const chatId = rawTo.replace(/^telegram:/i, "").trim();
        if (botToken && chatId) {
          try {
            await sendTelegramDocument({
              botToken,
              chatId,
              buffer,
              filename: displayName,
              contentType,
              caption,
            });
            deliveryMode = "telegram-direct";
          } catch (err) {
            api.logger?.warn?.(
              `file-publish: telegram sendDocument failed (${err.message}), falling back to URL`,
            );
          }
        }
      }

      // ---- Audit log + tool result ----------------------------------------
      auditLog(api, {
        channel,
        to: toolCtx?.deliveryContext?.to || "",
        filename: displayName,
        size: buffer.length,
        contentType,
        publicUrl,
        deliveryMode,
        status: "ok",
      });

      const text = caption
        ? `${caption}\n📎 ${displayName}\n${publicUrl}`
        : `📎 ${displayName}\n${publicUrl}`;

      return {
        content: [{ type: "text", text }],
        details: {
          status: "ok",
          deliveryMode,
          publicUrl,
          size: buffer.length,
          contentType,
        },
      };
    },
  }));

  api.on(
    "before_prompt_build",
    () => ({
      appendSystemContext:
        "You have a publish_file tool. When you have generated a file (e.g. via pandoc, libreoffice, wkhtmltopdf) " +
        "and want to deliver it to the user, call publish_file({ path: \"<absolute path inside your workspace>\", " +
        "displayName: \"<name>\", caption: \"<one line>\" }). " +
        "On Telegram the user receives the file inline AND a URL. On LINE/WhatsApp they receive a clickable HTTPS URL. " +
        "If the result includes a URL, include EXACTLY that URL in your reply. NEVER fabricate URLs. " +
        "NEVER call publish_file on private workspace files such as memory, credentials, or identity files — " +
        "only on artifacts you generated for the user in this turn.",
    }),
    { priority: 20 },
  );

  const blobStatus = cfg.mediaStorageAccount
    ? `blob=${cfg.mediaStorageAccount}/${cfg.documentsContainer}`
    : "blob=disabled";
  api.logger?.info?.(
    `file-publish plugin ready: workspace=${cfg.workspaceRoot}, ${blobStatus}, maxSizeMB=${cfg.maxSizeMB}`,
  );
}

module.exports = register;
module.exports._internals = {
  uploadToBlob,
  sendTelegramDocument,
  contentTypeForPath,
  sanitiseFilename,
  safeResolve,
  buildBlobName,
  normalizeOptionalValue,
  normalizeChannel,
  expandHomePath,
};

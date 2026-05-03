const path = require("path");

/**
 * Map common filename extensions to MIME types. Anything not in this table
 * falls back to "application/octet-stream" — safe for download but won't
 * trigger inline rendering in browsers.
 */
const MIME_TYPES = {
  // Office documents
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".doc": "application/msword",
  ".xls": "application/vnd.ms-excel",
  ".ppt": "application/vnd.ms-powerpoint",
  ".odt": "application/vnd.oasis.opendocument.text",
  ".ods": "application/vnd.oasis.opendocument.spreadsheet",
  ".odp": "application/vnd.oasis.opendocument.presentation",

  // Plain documents
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".html": "text/html",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".json": "application/json",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".xml": "application/xml",

  // Archives
  ".zip": "application/zip",
  ".tar": "application/x-tar",
  ".gz": "application/gzip",

  // Images (rarely used here — mai-image owns image generation)
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

function contentTypeForPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || "application/octet-stream";
}

/**
 * Sanitise a filename for use as a blob name segment. Strips path separators
 * and limits to printable ASCII so we never produce a blob name that would
 * confuse the Azure Blob REST API or unsuspecting download clients.
 */
function sanitiseFilename(name) {
  const base = path.basename(String(name || "")).trim() || "file";
  return base
    .replace(/[/\\]/g, "_")
    .replace(/[^\w.\-]/g, "_")
    .slice(0, 80);
}

/**
 * Reject paths that escape the configured workspace root, contain symlinks,
 * or are not regular files. Returns the resolved real path on success.
 *
 * IMPORTANT: This is the security boundary. Do not weaken without review.
 */
async function safeResolve(filePath, workspaceRoot, fs) {
  if (!filePath || typeof filePath !== "string") {
    throw new Error("path is required and must be a string");
  }
  if (!workspaceRoot) {
    throw new Error("workspaceRoot is not configured for the file-publish plugin");
  }

  const realRoot = await fs.realpath(workspaceRoot);
  let realPath;
  try {
    realPath = await fs.realpath(filePath);
  } catch (err) {
    throw new Error(`File not found: ${filePath}`);
  }

  const rel = path.relative(realRoot, realPath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(
      `Refusing to publish file outside the workspace root (${workspaceRoot}): ${filePath}`,
    );
  }

  const stat = await fs.stat(realPath);
  if (!stat.isFile()) {
    throw new Error(`Not a regular file: ${filePath}`);
  }

  return { realPath, size: stat.size };
}

/**
 * Build the date-prefixed blob name used for `documents/`:
 *   2026-05-03/<epoch-ms>-<uuidv4>-<sanitised-name>
 */
function buildBlobName(displayName, now = new Date(), randomUUID = () => "") {
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const ts = now.getTime();
  const uuid = randomUUID();
  const safe = sanitiseFilename(displayName);
  return `${yyyy}-${mm}-${dd}/${ts}-${uuid}-${safe}`;
}

module.exports = {
  MIME_TYPES,
  contentTypeForPath,
  sanitiseFilename,
  safeResolve,
  buildBlobName,
};

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
 * For extensions that have a well-known binary container format, return the
 * required magic bytes. The plugin uses this to reject files where the agent
 * (or a script) wrote text/markdown directly into a file with a binary
 * extension instead of running pandoc/libreoffice/wkhtmltopdf on it. Common
 * symptom: a 200-byte ".docx" that Word can't open.
 *
 * Only formats with a stable, short, leading magic are listed; everything
 * else is allowed through unchecked. Plain-text formats (txt/md/csv/html/...)
 * are intentionally not checked because they have no magic.
 */
const MAGIC_BYTES = {
  // Office Open XML: ZIP container, "PK\x03\x04"
  ".docx": [0x50, 0x4b, 0x03, 0x04],
  ".xlsx": [0x50, 0x4b, 0x03, 0x04],
  ".pptx": [0x50, 0x4b, 0x03, 0x04],
  // Legacy ODF: also ZIP
  ".odt": [0x50, 0x4b, 0x03, 0x04],
  ".ods": [0x50, 0x4b, 0x03, 0x04],
  ".odp": [0x50, 0x4b, 0x03, 0x04],
  // PDF: "%PDF-"
  ".pdf": [0x25, 0x50, 0x44, 0x46, 0x2d],
  // Image formats — agents shouldn't be hand-writing these either
  ".png": [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  ".jpg": [0xff, 0xd8, 0xff],
  ".jpeg": [0xff, 0xd8, 0xff],
  ".gif": [0x47, 0x49, 0x46, 0x38],
  ".webp": [0x52, 0x49, 0x46, 0x46], // RIFF; full check would also verify "WEBP" at offset 8
  // Archives — would be misleading if mislabelled
  ".zip": [0x50, 0x4b, 0x03, 0x04],
  ".gz": [0x1f, 0x8b],
};

/**
 * Validate that the first bytes of a file match the magic bytes implied by
 * its extension. Returns null on success (or when the extension has no known
 * magic), or an Error message string describing the mismatch.
 *
 * `head` is a Buffer holding the first N bytes of the file (caller should
 * supply at least 8 bytes).
 */
function validateMagicBytes(filePath, head) {
  const ext = path.extname(filePath).toLowerCase();
  const expected = MAGIC_BYTES[ext];
  if (!expected) return null;
  if (!head || head.length < expected.length) {
    return `file is too small (${head ? head.length : 0} bytes) to be a valid ${ext} — did you forget to run the converter?`;
  }
  for (let i = 0; i < expected.length; i++) {
    if (head[i] !== expected[i]) {
      const got = Array.from(head.slice(0, expected.length))
        .map((b) => "0x" + b.toString(16).padStart(2, "0"))
        .join(" ");
      const want = expected
        .map((b) => "0x" + b.toString(16).padStart(2, "0"))
        .join(" ");
      return `file extension is ${ext} but content does not match expected magic bytes (got [${got}], want [${want}]). The file is probably plain text/markdown that was written directly to a ${ext} file. Run the right converter (pandoc / libreoffice / wkhtmltopdf) on a source file before publishing.`;
    }
  }
  return null;
}

/**
 * Parse the ZIP central directory and return the list of entry filenames.
 * Returns null if the buffer does not look like a ZIP file.
 *
 * Implementation note: parses only what we need (End of Central Directory
 * + Central Directory entries' filenames). Does NOT decompress anything.
 * No external dependency. Sufficient for OOXML structure validation.
 */
function listZipEntries(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) return null;

  // Find End of Central Directory Record (signature 0x06054b50). It lives
  // near the end and is at most 22 + 65535 bytes from EOF (comment max).
  const EOCD_SIG = 0x06054b50;
  const maxScan = Math.min(buffer.length, 22 + 65535);
  let eocdOffset = -1;
  for (let i = buffer.length - 22; i >= buffer.length - maxScan && i >= 0; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) return null;

  const cdSize = buffer.readUInt32LE(eocdOffset + 12);
  const cdOffset = buffer.readUInt32LE(eocdOffset + 16);
  if (cdOffset + cdSize > buffer.length) return null;

  // Walk the central directory, collecting filenames.
  const CD_SIG = 0x02014b50;
  const names = [];
  let p = cdOffset;
  while (p < cdOffset + cdSize) {
    if (p + 46 > buffer.length) break;
    if (buffer.readUInt32LE(p) !== CD_SIG) break;
    const nameLen = buffer.readUInt16LE(p + 28);
    const extraLen = buffer.readUInt16LE(p + 30);
    const commentLen = buffer.readUInt16LE(p + 32);
    if (p + 46 + nameLen > buffer.length) break;
    names.push(buffer.toString("utf8", p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

/**
 * Parts that a real OOXML file MUST contain to be readable by Word / Excel /
 * PowerPoint. This catches the common bug where the agent assembles a minimal
 * ZIP with `python3 -c "import zipfile..."` containing only the slides /
 * sheets / document body but missing themes, slideLayouts, slideMasters, etc.
 *
 * Each value is a list of patterns; ALL must match (an entry whose name
 * starts-with the pattern, OR satisfies the prefix+suffix tuple). pptx is the
 * strictest because PowerPoint requires the full theme/master/layout chain.
 */
const OOXML_REQUIREMENTS = {
  ".docx": [
    { startsWith: "[Content_Types].xml" },
    { startsWith: "word/document.xml" },
  ],
  ".xlsx": [
    { startsWith: "[Content_Types].xml" },
    { startsWith: "xl/workbook.xml" },
  ],
  ".pptx": [
    { startsWith: "[Content_Types].xml" },
    { startsWith: "ppt/presentation.xml" },
    { startsWith: "ppt/theme/theme" },
    { startsWith: "ppt/slideMasters/slideMaster" },
    { startsWith: "ppt/slideLayouts/slideLayout" },
    { startsWith: "ppt/slides/slide" },
  ],
};

/**
 * For OOXML extensions, validate that the ZIP archive contains the required
 * OOXML parts. Returns null on success, or an error message string. For
 * non-OOXML extensions (PDF, plain text, ...), returns null.
 */
function validateOoxmlStructure(filePath, buffer) {
  const ext = path.extname(filePath).toLowerCase();
  const required = OOXML_REQUIREMENTS[ext];
  if (!required) return null;

  const names = listZipEntries(buffer);
  if (!names) {
    return `file extension is ${ext} but the file is not a valid ZIP archive (could not parse central directory).`;
  }

  const missing = [];
  for (const req of required) {
    const found = names.some((n) => n.startsWith(req.startsWith));
    if (!found) missing.push(req.startsWith + "*");
  }
  if (missing.length === 0) return null;

  return (
    `file extension is ${ext} but the archive is missing required OOXML parts: ${missing.join(", ")}. ` +
    `This usually means the file was assembled by hand (e.g. with python's zipfile module) instead of by a real converter. ` +
    `Run pandoc / libreoffice on a source file (Markdown, CSV, ...) so it produces a complete OOXML package with theme, slideMasters, and slideLayouts.`
  );
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
  MAGIC_BYTES,
  OOXML_REQUIREMENTS,
  contentTypeForPath,
  validateMagicBytes,
  validateOoxmlStructure,
  listZipEntries,
  sanitiseFilename,
  safeResolve,
  buildBlobName,
};

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  contentTypeForPath,
  sanitiseFilename,
  safeResolve,
  buildBlobName,
  validateMagicBytes,
  validateOoxmlStructure,
  listZipEntries,
} = require("../lib/file");

describe("contentTypeForPath", () => {
  it("maps office extensions correctly", () => {
    assert.equal(
      contentTypeForPath("/x/report.docx"),
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    assert.equal(
      contentTypeForPath("/x/sales.XLSX"),
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    assert.equal(
      contentTypeForPath("/x/slides.pptx"),
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    );
    assert.equal(contentTypeForPath("/x/summary.pdf"), "application/pdf");
    assert.equal(contentTypeForPath("/x/data.csv"), "text/csv");
  });

  it("falls back to octet-stream for unknown extensions", () => {
    assert.equal(contentTypeForPath("/x/whatever.xyz"), "application/octet-stream");
    assert.equal(contentTypeForPath("/x/no-extension"), "application/octet-stream");
  });
});

describe("sanitiseFilename", () => {
  it("strips path separators", () => {
    assert.equal(sanitiseFilename("../../etc/passwd"), "passwd");
    assert.equal(sanitiseFilename("a/b/c.txt"), "c.txt");
    // POSIX path.basename does not treat backslash as a separator, but the
    // regex still neutralises it to underscore so it cannot reach the URL.
    assert.equal(sanitiseFilename("a\\b\\c.txt"), "a_b_c.txt");
  });

  it("replaces unsafe chars with underscore", () => {
    assert.equal(sanitiseFilename("my report (final).docx"), "my_report__final_.docx");
  });

  it("returns 'file' for empty input", () => {
    assert.equal(sanitiseFilename(""), "file");
    assert.equal(sanitiseFilename(null), "file");
    assert.equal(sanitiseFilename(undefined), "file");
  });

  it("limits length to 80 chars", () => {
    const long = "a".repeat(200) + ".pdf";
    assert.ok(sanitiseFilename(long).length <= 80);
  });
});

describe("buildBlobName", () => {
  it("includes ISO date prefix, timestamp, uuid and sanitised name", () => {
    const fixedNow = new Date(Date.UTC(2026, 4, 3, 12, 30, 45));
    const name = buildBlobName("My Report.pdf", fixedNow, () => "abcd-1234");
    assert.match(name, /^2026-05-03\/\d+-abcd-1234-My_Report\.pdf$/);
  });

  it("sanitises path-traversal display names", () => {
    const fixedNow = new Date(Date.UTC(2026, 0, 1));
    const name = buildBlobName("../../etc/passwd", fixedNow, () => "x");
    assert.match(name, /^2026-01-01\/\d+-x-passwd$/);
  });
});

describe("safeResolve", () => {
  it("rejects empty path", async () => {
    await assert.rejects(safeResolve("", "/tmp", fs), /path is required/);
  });

  it("rejects when workspaceRoot is missing", async () => {
    await assert.rejects(safeResolve("/tmp/foo", "", fs), /workspaceRoot is not configured/);
  });

  it("rejects nonexistent files", async () => {
    const tmpDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "fp-test-"));
    await assert.rejects(safeResolve(path.join(tmpDir, "missing.pdf"), tmpDir, fs), /not found/i);
  });

  it("rejects files outside workspaceRoot", async () => {
    const root = fsSync.mkdtempSync(path.join(os.tmpdir(), "fp-root-"));
    const outside = fsSync.mkdtempSync(path.join(os.tmpdir(), "fp-outside-"));
    const f = path.join(outside, "secret.pdf");
    await fs.writeFile(f, "x");
    await assert.rejects(safeResolve(f, root, fs), /Refusing to publish file outside/);
  });

  it("rejects symlinks that escape workspaceRoot", async () => {
    const root = fsSync.mkdtempSync(path.join(os.tmpdir(), "fp-root-"));
    const outside = fsSync.mkdtempSync(path.join(os.tmpdir(), "fp-outside-"));
    const target = path.join(outside, "real.pdf");
    await fs.writeFile(target, "x");
    const link = path.join(root, "link.pdf");
    await fs.symlink(target, link);
    await assert.rejects(safeResolve(link, root, fs), /Refusing to publish/);
  });

  it("rejects directories", async () => {
    const root = fsSync.mkdtempSync(path.join(os.tmpdir(), "fp-root-"));
    const sub = path.join(root, "sub");
    await fs.mkdir(sub);
    await assert.rejects(safeResolve(sub, root, fs), /Not a regular file/);
  });

  it("accepts a real file inside workspaceRoot and returns size", async () => {
    const root = fsSync.mkdtempSync(path.join(os.tmpdir(), "fp-root-"));
    const f = path.join(root, "ok.pdf");
    await fs.writeFile(f, "hello world");
    const result = await safeResolve(f, root, fs);
    assert.equal(result.size, 11);
    assert.equal(path.basename(result.realPath), "ok.pdf");
  });
});

describe("validateMagicBytes", () => {
  const ZIP_HEAD = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
  const PDF_HEAD = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e]); // "%PDF-1."
  const TEXT_HEAD = Buffer.from("# Hello\n", "utf8");

  it("returns null for unknown extensions (no magic to check)", () => {
    assert.equal(validateMagicBytes("/x/notes.txt", TEXT_HEAD), null);
    assert.equal(validateMagicBytes("/x/notes.md", TEXT_HEAD), null);
    assert.equal(validateMagicBytes("/x/data.csv", TEXT_HEAD), null);
    assert.equal(validateMagicBytes("/x/page.html", TEXT_HEAD), null);
    assert.equal(validateMagicBytes("/x/blob.bin", TEXT_HEAD), null);
  });

  it("accepts ZIP-based Office formats with correct magic", () => {
    assert.equal(validateMagicBytes("/x/r.docx", ZIP_HEAD), null);
    assert.equal(validateMagicBytes("/x/s.xlsx", ZIP_HEAD), null);
    assert.equal(validateMagicBytes("/x/p.pptx", ZIP_HEAD), null);
    assert.equal(validateMagicBytes("/x/o.odt", ZIP_HEAD), null);
    assert.equal(validateMagicBytes("/x/z.zip", ZIP_HEAD), null);
  });

  it("accepts a PDF with %PDF- header", () => {
    assert.equal(validateMagicBytes("/x/r.pdf", PDF_HEAD), null);
  });

  it("rejects markdown text written to a .docx", () => {
    const err = validateMagicBytes("/x/r.docx", TEXT_HEAD);
    assert.ok(err);
    assert.match(err, /\.docx/);
    assert.match(err, /pandoc|libreoffice|wkhtmltopdf/);
  });

  it("rejects markdown text written to a .pdf", () => {
    const err = validateMagicBytes("/x/r.pdf", TEXT_HEAD);
    assert.ok(err);
    assert.match(err, /\.pdf/);
  });

  it("rejects a too-small file", () => {
    const tiny = Buffer.from([0x50, 0x4b]); // first 2 bytes of ZIP, but not enough
    const err = validateMagicBytes("/x/r.docx", tiny);
    assert.ok(err);
    assert.match(err, /too small/);
  });

  it("rejects an empty buffer", () => {
    const err = validateMagicBytes("/x/r.docx", Buffer.alloc(0));
    assert.ok(err);
    assert.match(err, /too small/);
  });

  it("rejects null head buffer", () => {
    const err = validateMagicBytes("/x/r.docx", null);
    assert.ok(err);
    assert.match(err, /too small/);
  });

  it("is case-insensitive on extension", () => {
    assert.equal(validateMagicBytes("/x/r.DOCX", ZIP_HEAD), null);
    assert.equal(validateMagicBytes("/x/r.PDF", PDF_HEAD), null);
  });
});

// ----- Helpers for ZIP / OOXML tests --------------------------------------

const zlib = require("node:zlib");

/**
 * Build an in-memory ZIP archive (STORED, no compression) containing the
 * given entries. Each entry is { name: string, data: Buffer|string }.
 * Just enough for OOXML structural tests; not a general ZIP writer.
 */
function buildZip(entries) {
  const localParts = [];
  const cdParts = [];
  let offset = 0;

  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, "utf8");
    const crc = zlib.crc32 ? zlib.crc32(data) : 0; // node 20+; tests don't validate CRC
    const local = Buffer.alloc(30 + name.length + data.length);
    local.writeUInt32LE(0x04034b50, 0); // local file header sig
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method = stored
    local.writeUInt16LE(0, 10); // mtime
    local.writeUInt16LE(0, 12); // mdate
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); // compressed size
    local.writeUInt32LE(data.length, 22); // uncompressed size
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra len
    name.copy(local, 30);
    data.copy(local, 30 + name.length);
    localParts.push(local);

    const cd = Buffer.alloc(46 + name.length);
    cd.writeUInt32LE(0x02014b50, 0); // central dir sig
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    name.copy(cd, 46);
    cdParts.push(cd);

    offset += local.length;
  }

  const cdBuf = Buffer.concat(cdParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([Buffer.concat(localParts), cdBuf, eocd]);
}

describe("listZipEntries", () => {
  it("returns null for non-ZIP buffer", () => {
    assert.equal(listZipEntries(Buffer.from("not a zip", "utf8")), null);
  });

  it("returns null for null/empty input", () => {
    assert.equal(listZipEntries(null), null);
    assert.equal(listZipEntries(Buffer.alloc(0)), null);
  });

  it("returns the file names from a valid ZIP", () => {
    const zip = buildZip([
      { name: "a.txt", data: "hello" },
      { name: "dir/b.xml", data: "<x/>" },
    ]);
    const names = listZipEntries(zip);
    assert.deepEqual(names, ["a.txt", "dir/b.xml"]);
  });

  it("scans backward to find EOCD even with trailing bytes after the archive", () => {
    const zip = buildZip([{ name: "x.txt", data: "y" }]);
    const padded = Buffer.concat([zip, Buffer.from("xxxxxxxxxx")]);
    // Both the unpadded archive and one with arbitrary trailing junk parse
    // because the parser scans backward from EOF for the EOCD signature.
    assert.deepEqual(listZipEntries(zip), ["x.txt"]);
    assert.deepEqual(listZipEntries(padded), ["x.txt"]);
  });
});

describe("validateOoxmlStructure", () => {
  it("returns null for non-OOXML extensions", () => {
    assert.equal(validateOoxmlStructure("/x/r.pdf", Buffer.from("%PDF-1.4")), null);
    assert.equal(validateOoxmlStructure("/x/r.txt", Buffer.from("hello")), null);
    assert.equal(validateOoxmlStructure("/x/r.zip", buildZip([{ name: "a", data: "b" }])), null);
  });

  it("rejects a .docx that is not a ZIP at all", () => {
    const err = validateOoxmlStructure("/x/r.docx", Buffer.from("hello"));
    assert.ok(err);
    assert.match(err, /not a valid ZIP/);
  });

  it("rejects a .docx ZIP missing word/document.xml", () => {
    const zip = buildZip([
      { name: "[Content_Types].xml", data: "<x/>" },
      { name: "_rels/.rels", data: "<x/>" },
    ]);
    const err = validateOoxmlStructure("/x/r.docx", zip);
    assert.ok(err);
    assert.match(err, /missing required OOXML parts/);
    assert.match(err, /word\/document\.xml/);
  });

  it("accepts a .docx ZIP with [Content_Types] and word/document.xml", () => {
    const zip = buildZip([
      { name: "[Content_Types].xml", data: "<x/>" },
      { name: "word/document.xml", data: "<doc/>" },
    ]);
    assert.equal(validateOoxmlStructure("/x/r.docx", zip), null);
  });

  it("rejects an .xlsx missing xl/workbook.xml", () => {
    const zip = buildZip([{ name: "[Content_Types].xml", data: "<x/>" }]);
    const err = validateOoxmlStructure("/x/r.xlsx", zip);
    assert.ok(err);
    assert.match(err, /xl\/workbook\.xml/);
  });

  it("accepts an .xlsx with required parts", () => {
    const zip = buildZip([
      { name: "[Content_Types].xml", data: "<x/>" },
      { name: "xl/workbook.xml", data: "<wb/>" },
    ]);
    assert.equal(validateOoxmlStructure("/x/r.xlsx", zip), null);
  });

  it("rejects a hand-rolled .pptx missing theme/slideMasters/slideLayouts (the real bug)", () => {
    // Mirrors the actual broken file the agent produced: only presentation +
    // slides, no theme/master/layout.
    const zip = buildZip([
      { name: "[Content_Types].xml", data: "<x/>" },
      { name: "_rels/.rels", data: "<x/>" },
      { name: "ppt/presentation.xml", data: "<x/>" },
      { name: "ppt/slides/slide1.xml", data: "<x/>" },
      { name: "ppt/slides/slide2.xml", data: "<x/>" },
    ]);
    const err = validateOoxmlStructure("/x/r.pptx", zip);
    assert.ok(err);
    assert.match(err, /missing required OOXML parts/);
    assert.match(err, /ppt\/theme\/theme/);
    assert.match(err, /ppt\/slideMasters\/slideMaster/);
    assert.match(err, /ppt\/slideLayouts\/slideLayout/);
    assert.match(err, /pandoc|libreoffice/);
  });

  it("accepts a complete .pptx package", () => {
    const zip = buildZip([
      { name: "[Content_Types].xml", data: "<x/>" },
      { name: "ppt/presentation.xml", data: "<x/>" },
      { name: "ppt/theme/theme1.xml", data: "<x/>" },
      { name: "ppt/slideMasters/slideMaster1.xml", data: "<x/>" },
      { name: "ppt/slideLayouts/slideLayout1.xml", data: "<x/>" },
      { name: "ppt/slides/slide1.xml", data: "<x/>" },
    ]);
    assert.equal(validateOoxmlStructure("/x/r.pptx", zip), null);
  });

  it("is case-insensitive on extension", () => {
    const zip = buildZip([
      { name: "[Content_Types].xml", data: "<x/>" },
      { name: "word/document.xml", data: "<x/>" },
    ]);
    assert.equal(validateOoxmlStructure("/x/r.DOCX", zip), null);
  });
});

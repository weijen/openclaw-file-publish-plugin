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

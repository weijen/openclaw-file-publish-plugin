const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { buildSharedKeyAuthHeader, buildBlobUrl } = require("../lib/blob");

describe("buildBlobUrl", () => {
  it("returns correct public URL", () => {
    const url = buildBlobUrl("myaccount", "documents", "test.pdf");
    assert.equal(url, "https://myaccount.blob.core.windows.net/documents/test.pdf");
  });

  it("handles date-prefixed blob names", () => {
    const url = buildBlobUrl("acct", "documents", "2026-05-03/12345-uuid-report.pdf");
    assert.equal(
      url,
      "https://acct.blob.core.windows.net/documents/2026-05-03/12345-uuid-report.pdf",
    );
  });
});

describe("buildSharedKeyAuthHeader", () => {
  const testKey = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");

  it("returns SharedKey format", () => {
    const header = buildSharedKeyAuthHeader({
      accountName: "testaccount",
      accountKey: testKey,
      method: "PUT",
      contentLength: 1024,
      contentType: "application/pdf",
      blobType: "BlockBlob",
      date: "Sun, 01 Jan 2026 00:00:00 GMT",
      urlPath: "/documents/test.pdf",
    });
    assert.ok(header.startsWith("SharedKey testaccount:"));
    const sig = header.split(":").slice(1).join(":");
    assert.ok(sig.length > 10);
  });

  it("produces different signatures for different content types", () => {
    const common = {
      accountName: "testaccount",
      accountKey: testKey,
      method: "PUT",
      contentLength: 1024,
      blobType: "BlockBlob",
      date: "Sun, 01 Jan 2026 00:00:00 GMT",
      urlPath: "/documents/test.bin",
    };
    const hPdf = buildSharedKeyAuthHeader({ ...common, contentType: "application/pdf" });
    const hDocx = buildSharedKeyAuthHeader({
      ...common,
      contentType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    assert.notEqual(hPdf, hDocx);
  });
});

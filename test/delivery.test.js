const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { sendTelegramDocument } = require("../lib/delivery");

// Save originals so we can restore after each test
const realFetch = global.fetch;

function mockFetch(impl) {
  global.fetch = impl;
}

describe("sendTelegramDocument", () => {
  after(() => {
    global.fetch = realFetch;
  });

  it("posts multipart form to sendDocument endpoint", async () => {
    let receivedUrl = null;
    let receivedForm = null;
    mockFetch(async (url, opts) => {
      receivedUrl = url;
      receivedForm = opts.body;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const ok = await sendTelegramDocument({
      botToken: "BOT123:abc",
      chatId: "1234567",
      buffer: Buffer.from("hello"),
      filename: "report.pdf",
      contentType: "application/pdf",
    });
    assert.equal(ok, true);
    assert.equal(receivedUrl, "https://api.telegram.org/botBOT123:abc/sendDocument");
    assert.ok(receivedForm instanceof FormData);
    assert.equal(receivedForm.get("chat_id"), "1234567");
    const docPart = receivedForm.get("document");
    assert.ok(docPart, "document field should be present");
  });

  it("truncates captions over 1024 chars and appends ellipsis", async () => {
    let captured = null;
    mockFetch(async (_url, opts) => {
      captured = opts.body.get("caption");
      return new Response("{}", { status: 200 });
    });
    const longCap = "x".repeat(2000);
    await sendTelegramDocument({
      botToken: "B:c",
      chatId: "1",
      buffer: Buffer.from("y"),
      filename: "f.txt",
      caption: longCap,
    });
    assert.equal(captured.length, 1024);
    assert.ok(captured.endsWith("..."));
  });

  it("omits caption when not provided", async () => {
    let captured = "MARKER";
    mockFetch(async (_url, opts) => {
      captured = opts.body.get("caption");
      return new Response("{}", { status: 200 });
    });
    await sendTelegramDocument({
      botToken: "B:c",
      chatId: "1",
      buffer: Buffer.from("y"),
      filename: "f.txt",
    });
    assert.equal(captured, null);
  });

  it("throws on non-2xx response", async () => {
    mockFetch(async () => new Response("nope", { status: 400 }));
    await assert.rejects(
      sendTelegramDocument({
        botToken: "B:c",
        chatId: "1",
        buffer: Buffer.from("y"),
        filename: "f.txt",
      }),
      /Telegram sendDocument failed: 400/,
    );
  });
});

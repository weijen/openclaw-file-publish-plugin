const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { auditLog } = require("../index")._internals;

describe("auditLog", () => {
  let originalConsoleLog;
  let captured;

  beforeEach(() => {
    captured = [];
    originalConsoleLog = console.log;
    console.log = (msg) => captured.push(msg);
  });

  afterEach(() => {
    console.log = originalConsoleLog;
  });

  it("emits one JSON line on stdout with event=file_publish", () => {
    auditLog({}, { channel: "telegram", filename: "report.pdf", status: "ok" });
    assert.equal(captured.length, 1);
    const parsed = JSON.parse(captured[0]);
    assert.equal(parsed.event, "file_publish");
    assert.equal(parsed.channel, "telegram");
    assert.equal(parsed.filename, "report.pdf");
    assert.equal(parsed.status, "ok");
  });

  it("emits to stdout AND to api.logger.info when present", () => {
    const loggerCalls = [];
    const api = { logger: { info: (msg) => loggerCalls.push(msg) } };
    auditLog(api, { channel: "line", status: "ok" });
    assert.equal(captured.length, 1, "console.log called once");
    assert.equal(loggerCalls.length, 1, "logger.info called once");
    assert.equal(captured[0], loggerCalls[0]);
  });

  it("still emits to stdout when api.logger.info throws", () => {
    const api = {
      logger: {
        info: () => {
          throw new Error("logger failure");
        },
      },
    };
    // Must not throw
    auditLog(api, { channel: "whatsapp", status: "ok" });
    assert.equal(captured.length, 1);
    assert.equal(JSON.parse(captured[0]).channel, "whatsapp");
  });

  it("emits to stdout when api has no logger", () => {
    auditLog({}, { channel: "telegram", status: "error", reason: "path" });
    assert.equal(captured.length, 1);
    const parsed = JSON.parse(captured[0]);
    assert.equal(parsed.event, "file_publish");
    assert.equal(parsed.reason, "path");
  });

  it("does not include any extra wrapping", () => {
    auditLog({}, { foo: "bar" });
    // Must be parseable as plain JSON, not wrapped
    const parsed = JSON.parse(captured[0]);
    assert.equal(parsed.event, "file_publish");
    assert.equal(parsed.foo, "bar");
  });
});

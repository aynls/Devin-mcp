"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { PassThrough } = require("node:stream");
const { once } = require("node:events");
const { setTimeout: delay } = require("node:timers/promises");
const { StdioServer } = require("../dist/protocol.js");
const { InputError } = require("../dist/tools.js");

function harness(call = async () => ({ ok: true, stdout: "done" })) {
  const input = new PassThrough();
  const output = new PassThrough();
  const responses = [];
  let buffer = "";
  output.setEncoding("utf8");
  output.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      responses.push(JSON.parse(buffer.slice(0, index)));
      buffer = buffer.slice(index + 1);
    }
  });
  const server = new StdioServer({ call }, input, output, 10);
  server.start();
  const send = (method, id, params) => input.write(JSON.stringify({ jsonrpc: "2.0", method, id, params }) + "\n");
  const init = (protocolVersion = "2025-11-25") => {
    send("initialize", 1, { protocolVersion, capabilities: {}, clientInfo: { name: "test", version: "1" } });
    send("notifications/initialized");
  };
  const close = async () => {
    if (output.writableFinished) return;
    const finished = once(output, "finish");
    input.end();
    await finished;
  };
  return { input, output, responses, server, send, init, close };
}

test("negotiates supported and unknown MCP revisions", async () => {
  for (const version of ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25", "2099-01-01"]) {
    const h = harness();
    h.init(version);
    assert.equal(h.responses[0].result.protocolVersion, version === "2099-01-01" ? "2025-11-25" : version);
    h.send("tools/list", 2);
    assert.equal(h.responses[1].result.tools.length, 4);
    await h.close();
  }
});

test("requires initialization, rejects duplicate initialization and answers ping", async () => {
  const h = harness();
  h.send("tools/list", 0);
  assert.equal(h.responses.at(-1).error.code, -32002);
  h.send("ping", 9);
  assert.deepEqual(h.responses.at(-1).result, {});
  h.init();
  h.init();
  assert.equal(h.responses.at(-1).error.code, -32600);
  h.send("unknown", 10);
  assert.equal(h.responses.at(-1).error.code, -32601);
  await h.close();
});

test("reports malformed JSON and invalid requests without losing subsequent frames", async () => {
  const h = harness();
  h.input.write("{not json}\nnull\n[]\n");
  h.input.write(JSON.stringify({ jsonrpc: "1.0", method: "ping", id: 1 }) + "\n");
  h.input.write(Buffer.from([0xff, 0x0a]));
  assert.deepEqual(h.responses.map((r) => r.error.code), [-32700, -32600, -32600, -32600, -32700]);
  h.init();
  assert.ok(h.responses.at(-1).result.serverInfo);
  h.send("notifications/unknown");
  await h.close();
  assert.equal(h.responses.length, 6);
});

test("handles split UTF-8 frames, CRLF and a final line without a newline", async () => {
  const h = harness(async (_name, args) => ({ ok: true, echo: args.prompt }));
  h.init();
  const data = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "echo", arguments: { prompt: "你好" } } }) + "\r\n");
  for (const byte of data) h.input.write(Buffer.from([byte]));
  h.input.write('{"jsonrpc":"2.0","id":3,"method":"ping"}');
  await h.close();
  assert.equal(h.responses.find((r) => r.id === 2).result.structuredContent.echo, "你好");
  assert.deepEqual(h.responses.find((r) => r.id === 3).result, {});
});

test("bounds input frames and recovers after an oversized request", async () => {
  const h = harness();
  h.input.write("x".repeat(1048577) + "\n");
  assert.equal(h.responses[0].error.code, -32600);
  h.init();
  assert.ok(h.responses[1].result.serverInfo);
  await h.close();
});

test("drains in-flight tool responses on EOF without truncating output", async () => {
  const content = "中文".repeat(100000);
  const h = harness(async () => { await delay(20); return { ok: true, stdout: content }; });
  h.init();
  h.send("tools/call", 2, { name: "large" });
  await h.close();
  const result = h.responses.find((r) => r.id === 2).result;
  assert.equal(result.structuredContent.stdout, content);
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
});

test("cancellation aborts the handler, stops progress and suppresses the response", async () => {
  let aborted = false;
  const h = harness(async (_name, _args, signal) => {
    await new Promise((resolve) => signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true }));
    return { ok: false };
  });
  h.init();
  h.send("tools/call", 2, { name: "slow", _meta: { progressToken: "work" } });
  await delay(35);
  h.send("notifications/cancelled", undefined, { requestId: 2 });
  await h.close();
  assert.equal(aborted, true);
  assert.ok(h.responses.some((r) => r.method === "notifications/progress" && r.params.progressToken === "work"));
  assert.equal(h.responses.some((r) => r.id === 2), false);
});

test("rejects reused IDs and excessive in-flight requests", async () => {
  const h = harness(async () => { await delay(10); return { ok: true }; });
  h.init();
  for (let id = 2; id < 19; id++) h.send("tools/call", id, { name: "slow" });
  h.send("tools/call", 2, { name: "duplicate" });
  assert.ok(h.responses.some((r) => r.id === 18 && r.error.code === -32000));
  assert.ok(h.responses.some((r) => r.id === 2 && r.error?.code === -32600));
  await h.close();
});

test("distinguishes parameter errors from internal errors", async () => {
  const h = harness(async (name) => { throw name === "bad-input" ? new InputError("invalid") : new Error("failed"); });
  h.init();
  h.send("tools/call", 2, { name: "bad-input" });
  h.send("tools/call", 3, { name: "internal" });
  h.send("tools/call", 4, { name: 123 });
  h.send("tools/call", 5, { name: "valid", _meta: { progressToken: {} } });
  await h.close();
  assert.equal(h.responses.find((r) => r.id === 2).error.code, -32602);
  assert.equal(h.responses.find((r) => r.id === 3).error.code, -32603);
  assert.equal(h.responses.find((r) => r.id === 4).error.code, -32602);
  assert.equal(h.responses.find((r) => r.id === 5).error.code, -32602);
});

test("graceful shutdown cancels work and flushes the transport", async () => {
  let aborted = false;
  const h = harness(async (_name, _args, signal) => {
    await new Promise((resolve) => signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true }));
    return { ok: false };
  });
  h.init();
  h.send("tools/call", 2, { name: "wait" });
  await delay(5);
  const finished = once(h.output, "finish");
  h.server.stop();
  await finished;
  assert.equal(aborted, true);
  assert.equal(h.responses.some((r) => r.id === 2), false);
});

test("rejects malformed initialization, pagination and metadata", async () => {
  const h = harness();
  h.send("initialize", 0, { protocolVersion: "2025-11-25" });
  assert.equal(h.responses.at(-1).error.code, -32602);
  h.init();
  h.send("tools/list", 2, { cursor: "unknown" });
  assert.equal(h.responses.at(-1).error.code, -32602);
  h.send("tools/call", 3, { name: "hello", _meta: [] });
  assert.equal(h.responses.at(-1).error.code, -32602);
  await h.close();
});

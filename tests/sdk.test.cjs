"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");

test("official MCP SDK discovers tools and runs, resumes and cancels tasks", { timeout: 20000 }, async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "local-devin-sdk-"));
  const client = new Client({ name: "local-devin-tests", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath, args: [path.join(__dirname, "fixtures", "server.cjs")],
    env: Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)), stderr: "pipe",
  });
  t.after(async () => {
    await client.close();
    await fs.rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await client.connect(transport);
  assert.equal(client.getServerVersion().name, "local-devin");
  assert.equal((await client.listTools()).tools.length, 4);
  const run = await client.callTool({ name: "run_prompt", arguments: { cwd, prompt: "utf8" } });
  assert.equal(run.isError, false);
  assert.equal(run.structuredContent.stdout, "你好，世界 𠮷");
  assert.equal(run.structuredContent.sessionId, "new-session-456");
  const sessions = await client.callTool({ name: "list_sessions", arguments: { cwd } });
  const id = sessions.structuredContent.sessions[0].id;
  const resumed = await client.callTool({ name: "resume_session", arguments: { cwd, sessionId: id, prompt: "hello" } });
  assert.equal(resumed.structuredContent.sessionId, id);
  await assert.rejects(client.callTool({ name: "run_prompt", arguments: { prompt: 7 } }), /prompt/);
  const pidPath = path.join(cwd, "cancel.json");
  const abort = new AbortController();
  const running = client.callTool({ name: "run_prompt", arguments: { cwd, prompt: `wait:${pidPath}` } }, undefined, { signal: abort.signal });
  const cancelled = assert.rejects(running);
  for (let i = 0; i < 200; i++) {
    if (await fs.access(pidPath).then(() => true, () => false)) break;
    await delay(25);
  }
  await fs.access(pidPath);
  abort.abort();
  await cancelled;
  let ready;
  for (let i = 0; i < 100; i++) {
    ready = await client.callTool({ name: "run_prompt", arguments: { cwd, prompt: "hello" } });
    if (ready.structuredContent.error?.code !== "WORKSPACE_BUSY") break;
    await delay(50);
  }
  assert.equal(ready.isError, false);
});

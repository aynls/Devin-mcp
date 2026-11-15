"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { ProcessRunner } = require("../dist/process.js");
const { ToolService, readConfig, InputError } = require("../dist/tools.js");
const fixture = path.join(__dirname, "fixtures", "cli.cjs");

function service(env = {}) {
  const config = readConfig(env);
  return new ToolService(config, new ProcessRunner({ bin: process.execPath, prefixArgs: [fixture] }));
}

async function workspace(t) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "local-devin-test-"));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  return fs.realpath(cwd);
}

test("preserves split UTF-8 output and returns the exported session ID", async (t) => {
  const cwd = await workspace(t);
  const result = await service().call("run_prompt", { cwd, prompt: "utf8" });
  assert.equal(result.ok, true);
  assert.equal(result.stdout, "你好，世界 𠮷");
  assert.equal(result.sessionId, "new-session-456");
});

test("validates arguments and never defaults to the plugin directory", async () => {
  const tools = service();
  for (const args of [{ prompt: 42 }, { prompt: "" }, { prompt: "ok", unexpected: true }, { prompt: "ok", timeoutMs: 0 }, { prompt: "ok", permissionMode: "invalid" }]) {
    await assert.rejects(tools.call("run_prompt", args), InputError);
  }
  const result = await tools.call("run_prompt", { prompt: "hello" });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "WORKSPACE_REQUIRED");
});

test("pins safe permissions and passes prompts through private temporary files", async (t) => {
  const cwd = await workspace(t);
  const prompt = "--cloud\n中文 & echo not-a-shell";
  const result = await service().call("run_prompt", { cwd, prompt });
  assert.equal(result.ok, true);
  const seen = JSON.parse(result.stdout);
  assert.equal(seen.prompt, prompt);
  assert.ok(seen.args.includes("--permission-mode=auto"));
  assert.ok(seen.args.includes("--respect-workspace-trust=true"));
  assert.ok(!seen.args.includes(prompt));
  const promptPath = seen.args.find((arg) => arg.startsWith("--prompt-file=")).slice(14);
  await assert.rejects(fs.access(promptPath));
});

test("dangerous permissions and trust bypass require server opt-in", async (t) => {
  const cwd = await workspace(t);
  for (const options of [{ permissionMode: "dangerous" }, { respectWorkspaceTrust: false }]) {
    const result = await service().call("run_prompt", { cwd, prompt: "hello", ...options });
    assert.equal(result.error.code, "POLICY_DENIED");
  }
  const result = await service({ DEVIN_MCP_ALLOW_DANGEROUS: "true", DEVIN_MCP_ALLOW_UNTRUSTED: "true" })
    .call("run_prompt", { cwd, prompt: "hello", permissionMode: "dangerous", respectWorkspaceTrust: false });
  assert.equal(result.ok, true);
});

test("normalizes discovered sessions and resumes an explicit session", async (t) => {
  const cwd = await workspace(t);
  const tools = service();
  const list = await tools.call("list_sessions", { cwd });
  assert.deepEqual(list.sessions, [{ id: "session-123", cwd, title: "A previous task", lastActivityAt: "2026-10-11T12:00:00Z" }]);
  const result = await tools.call("resume_session", { cwd, sessionId: "session-123", prompt: "continue" });
  assert.equal(result.ok, true);
  assert.equal(result.sessionId, "session-123");
  assert.ok(JSON.parse(result.stdout).args.includes("--resume=session-123"));
  const missing = await tools.call("resume_session", { cwd, sessionId: "not-present", prompt: "continue" });
  assert.equal(missing.error.code, "SESSION_NOT_FOUND");
  await assert.rejects(tools.call("resume_session", { cwd, prompt: "continue" }), InputError);
});

test("reports missing exports without pretending the task did not execute", async (t) => {
  const cwd = await workspace(t);
  const result = await service().call("run_prompt", { cwd, prompt: "missing-export" });
  assert.equal(result.ok, true);
  assert.equal(result.sessionId, null);
  assert.ok(result.warnings[0].includes("list_sessions"));
});

test("reports process failures and bounds output", async (t) => {
  const cwd = await workspace(t);
  const failed = await service().call("run_prompt", { cwd, prompt: "fail" });
  assert.equal(failed.ok, false);
  assert.equal(failed.exitCode, 7);
  assert.equal(failed.stderr, "deliberate failure");
  const limited = await service({ DEVIN_MCP_MAX_OUTPUT_BYTES: "1024" }).call("run_prompt", { cwd, prompt: "flood" });
  assert.equal(limited.error.code, "OUTPUT_LIMIT");
  assert.ok(Buffer.byteLength(limited.stdout) <= 1024);
});

test("rejects bad configuration and honors an explicit default workspace", async (t) => {
  for (const env of [
    { DEVIN_CWD: "relative" }, { DEVIN_MCP_TIMEOUT_MS: "0" },
    { DEVIN_MCP_TIMEOUT_MS: "Infinity" }, { DEVIN_MCP_MAX_OUTPUT_BYTES: "1" },
    { DEVIN_MCP_ALLOW_DANGEROUS: "yes" }, { DEVIN_MCP_ALLOW_UNTRUSTED: "1" },
  ]) assert.throws(() => readConfig(env));
  const cwd = await workspace(t);
  const tools = service({ DEVIN_CWD: cwd, DEVIN_MCP_TIMEOUT_MS: "5000" });
  assert.equal((await tools.call("run_prompt", { prompt: "hello" })).ok, true);
  await assert.rejects(tools.call("run_prompt", { prompt: "hello", timeoutMs: 5001 }), InputError);
  for (const invalid of [null, [], "hello"]) await assert.rejects(tools.call("auth_status", invalid), InputError);
  await assert.rejects(tools.call("nonexistent", {}), InputError);
  assert.equal((await tools.call("list_sessions", { cwd: "relative" })).error.code, "INVALID_WORKSPACE");
  assert.equal((await tools.call("list_sessions", { cwd: path.join(cwd, "missing") })).error.code, "INVALID_WORKSPACE");
  assert.equal((await tools.call("auth_status", {})).ok, true);
  assert.equal((await service({ DEVIN_CWD: path.join(cwd, "missing") }).call("auth_status", {})).ok, true);
});

test("invalid session output is an error, never a successful empty list", async (t) => {
  const cwd = await workspace(t);
  for (const stdout of ["", "not-json", "{}", '[{"id":"s"}]', "[null]"]) {
    const tools = new ToolService(readConfig({}), { run: async () => ({ exitCode: 0, signal: null, stdout, stderr: "", error: null, durationMs: 0 }) });
    assert.equal((await tools.call("list_sessions", { cwd })).error.code, "INVALID_CLI_OUTPUT");
  }
});

test("bounds all concurrent CLI requests, including session discovery", async (t) => {
  const cwd = await workspace(t);
  const waiting = [];
  const tools = new ToolService(readConfig({}), { run: () => new Promise((resolve) => waiting.push(resolve)) });
  const pending = Array.from({ length: 4 }, () => tools.call("list_sessions", { cwd }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await tools.call("list_sessions", { cwd })).error.code, "BUSY");
  for (let i = 0; i < 100 && waiting.length < 4; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(waiting.length, 4);
  waiting.forEach((resolve) => resolve({ exitCode: 0, signal: null, stdout: "[]", stderr: "", error: null, durationMs: 0 }));
  assert.ok((await Promise.all(pending)).every((result) => result.ok));
});

test("unconfirmed process termination blocks further CLI work until restart", async (t) => {
  const cwd = await workspace(t);
  let calls = 0;
  const tools = new ToolService(readConfig({}), { run: async () => {
    calls += 1;
    return { exitCode: null, signal: null, stdout: "", stderr: "", durationMs: 0, error: { code: "TERMINATION_FAILED", message: "Process may still be running." } };
  } });
  assert.equal((await tools.call("run_prompt", { cwd, prompt: "hello" })).error.code, "TERMINATION_FAILED");
  assert.equal((await tools.call("run_prompt", { cwd, prompt: "hello again" })).error.code, "TERMINATION_FAILED");
  assert.equal(calls, 1);
});

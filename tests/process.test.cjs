"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { ProcessRunner, resolveDevinBin } = require("../dist/process.js");
const { ToolService, readConfig } = require("../dist/tools.js");
const fixture = path.join(__dirname, "fixtures", "cli.cjs");

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

async function waitUntil(check) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await delay(50);
  }
  assert.fail("Condition was not satisfied before the test deadline.");
}

async function setup(t) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "local-devin-process-"));
  const runner = new ProcessRunner({ bin: process.execPath, prefixArgs: [fixture] });
  const tools = new ToolService(readConfig({}), runner);
  const controller = new AbortController();
  t.after(async () => {
    controller.abort();
    await fs.rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { cwd, tools, controller, pidPath: path.join(cwd, "pids.json") };
}

test("cancellation terminates a real child process tree and releases workspace locks", { timeout: 20000 }, async (t) => {
  const { cwd, tools, controller, pidPath } = await setup(t);
  const running = tools.call("run_prompt", { cwd, prompt: `wait:${pidPath}` }, controller.signal);
  await waitUntil(() => fs.access(pidPath).then(() => true, () => false));
  const pids = JSON.parse(await fs.readFile(pidPath, "utf8"));
  assert.ok(alive(pids.parent));
  assert.ok(alive(pids.child));
  const busy = await tools.call("run_prompt", { cwd, prompt: "hello" });
  assert.equal(busy.error.code, "WORKSPACE_BUSY");
  controller.abort();
  const result = await running;
  assert.equal(result.error.code, "CANCELLED");
  await waitUntil(() => !alive(pids.parent) && !alive(pids.child));
  await assert.rejects(fs.access(pids.promptPath));
  const next = await tools.call("run_prompt", { cwd, prompt: "hello" });
  assert.equal(next.ok, true);
});

test("timeouts terminate a real child process tree", { timeout: 20000 }, async (t) => {
  const { cwd, tools, controller, pidPath } = await setup(t);
  const running = tools.call("run_prompt", { cwd, prompt: `wait:${pidPath}`, timeoutMs: 3000 }, controller.signal);
  await waitUntil(() => fs.access(pidPath).then(() => true, () => false));
  const pids = JSON.parse(await fs.readFile(pidPath, "utf8"));
  const result = await running;
  assert.equal(result.error.code, "TIMEOUT");
  await waitUntil(() => !alive(pids.parent) && !alive(pids.child));
});

test("an already cancelled request never starts a process", async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await new ProcessRunner({ bin: "does-not-exist" }).run([], {
    cwd: process.cwd(), timeoutMs: 1000, maxOutputBytes: 1024, signal: controller.signal,
  });
  assert.equal(result.error.code, "CANCELLED");
});

test("spawn failures are reported instead of hanging", async () => {
  const result = await new ProcessRunner({ bin: path.join(os.tmpdir(), "local-devin-missing-executable") }).run([], {
    cwd: process.cwd(), timeoutMs: 1000, maxOutputBytes: 1024,
  });
  assert.equal(result.error.code, "SPAWN_FAILED");
  assert.equal(result.exitCode, null);
});

test("binary resolution supports absolute overrides and PATHs containing spaces", async (t) => {
  assert.equal(resolveDevinBin({ DEVIN_BIN: process.execPath }), process.execPath);
  assert.throws(() => resolveDevinBin({ DEVIN_BIN: "devin" }), /absolute/);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "local devin bin "));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const binary = path.join(directory, process.platform === "win32" ? "devin.exe" : "devin");
  await fs.writeFile(binary, "");
  await fs.chmod(binary, 0o700);
  assert.equal(resolveDevinBin({ PATH: `"${directory}"` }), binary);
  assert.throws(() => resolveDevinBin({ DEVIN_BIN: directory }), /executable/);
});

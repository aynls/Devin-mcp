"use strict";
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "local-devin-package-"));
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("Run this script with npm run verify:package.");
const npm = (args, cwd = root) => execFileSync(process.execPath, [npmCli, ...args], {
  cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120000,
});

try {
  const [packed] = JSON.parse(npm(["pack", "--ignore-scripts", "--json", "--pack-destination", temp]));
  const names = packed.files.map((file) => file.path);
  for (const required of ["package.json", "README.md", "README.zh-CN.md", "README.ja.md", "LICENSE", "dist/index.js", "dist/process.js", "dist/protocol.js", "dist/tools.js", "assets/cover.png", "plugin.json", "mcp.json", "skills/local-devin/SKILL.md"]) {
    assert.ok(names.includes(required), `Missing packaged file: ${required}`);
  }
  assert.ok(names.every((name) => !/^(tests|server|node_modules|\.github|\.devin)\//.test(name)));
  const consumer = path.join(temp, "consumer");
  fs.mkdirSync(consumer);
  npm(["install", "--prefix", consumer, path.join(temp, packed.filename), "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], consumer);
  const installed = path.join(consumer, "node_modules", "local-devin");
  const metadata = JSON.parse(fs.readFileSync(path.join(installed, "package.json"), "utf8"));
  assert.equal(Object.keys(metadata.dependencies || {}).length, 0);
  assert.equal(metadata.bin["local-devin"], "dist/index.js");
  const version = execFileSync(process.execPath, [path.join(installed, "dist", "index.js"), "--version"], { encoding: "utf8" }).trim();
  assert.equal(version, metadata.version);
  assert.equal(npm(["exec", "--offline", "--", "local-devin", "--version"], consumer).trim(), metadata.version);
  const messages = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "package-test", version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
  ];
  const output = execFileSync(process.execPath, [path.join(installed, "dist", "index.js")], {
    cwd: consumer, input: messages.map(JSON.stringify).join("\n") + "\n", encoding: "utf8", timeout: 10000,
  }).trim().split(/\r?\n/).map(JSON.parse);
  assert.equal(output.find((response) => response.id === 2).result.tools.length, 4);
  console.log(`PASS: ${packed.filename} installs and serves MCP without runtime dependencies (${names.length} files).`);
} finally {
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 3 });
}

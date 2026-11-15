"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { TOOLS } = require("../dist/tools.js");
const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("all three READMEs contain valid JSON, working local links and the public contract", () => {
  const docs = ["README.md", "README.zh-CN.md", "README.ja.md"];
  const settings = ["DEVIN_BIN", "DEVIN_CWD", "DEVIN_MCP_TIMEOUT_MS", "DEVIN_MCP_MAX_OUTPUT_BYTES", "DEVIN_MCP_ALLOW_DANGEROUS", "DEVIN_MCP_ALLOW_UNTRUSTED"];
  for (const file of docs) {
    const text = read(file);
    for (const block of text.matchAll(/```json\r?\n([\s\S]*?)```/g)) assert.doesNotThrow(() => JSON.parse(block[1]), `${file}: invalid JSON`);
    for (const [, link] of text.matchAll(/\]\(([^)]+)\)/g)) {
      if (link.startsWith("https://") || link.startsWith("#")) continue;
      assert.ok(fs.existsSync(path.join(root, link.split("#")[0])), `${file}: missing ${link}`);
    }
    for (const other of docs.filter((other) => other !== file)) assert.ok(text.includes(`](${other})`));
    for (const { name } of TOOLS) assert.ok(text.includes(`\`${name}\``), `${file}: missing tool ${name}`);
    for (const setting of settings) assert.ok(text.includes(`\`${setting}\``), `${file}: missing setting ${setting}`);
    for (const command of ["npm ci", "npm run check", "npm run verify:package"]) assert.ok(text.includes(command));
    assert.ok(text.includes("assets/cover.png"));
  }
});

test("package, plugin and prebuilt entrypoint remain aligned", () => {
  const pkg = JSON.parse(read("package.json"));
  const plugin = JSON.parse(read("plugin.json"));
  const mcp = JSON.parse(read("mcp.json"));
  assert.equal(pkg.name, plugin.name);
  assert.equal(pkg.version, plugin.version);
  assert.equal(Object.keys(pkg.dependencies || {}).length, 0);
  assert.equal(pkg.bin["local-devin"], "dist/index.js");
  assert.ok(read(pkg.bin["local-devin"]).startsWith("#!/usr/bin/env node\n"));
  assert.ok(fs.existsSync(path.resolve(root, mcp.mcpServers["local-devin"].args[0])));
  assert.equal(mcp.mcpServers["local-devin"].cwd, "${PLUGIN_ROOT}");
  assert.equal(pkg.private, true);
});

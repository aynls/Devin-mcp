#!/usr/bin/env node
"use strict";
const { spawn } = require("child_process");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const serverPath = path.join(__dirname, "..", "dist", "index.js");
if (!fs.existsSync(serverPath)) {
  console.error(
    "FAIL: missing dist/index.js — run `npm run build` first (or `npm run smoke`)."
  );
  process.exit(1);
}

const child = spawn(process.execPath, [serverPath], {
  stdio: ["pipe", "pipe", "inherit"],
});

let out = "";
child.stdout.on("data", (c) => {
  out += c;
});
child.stdout.setEncoding("utf8");
child.on("error", (error) => {
  console.error("FAIL: cannot start server:", error.message);
  process.exitCode = 1;
});

const lines = [
  JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "smoke", version: "0" },
    },
  }),
  JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
];

child.stdin.write(lines.join("\n") + "\n");
child.stdin.end();
child.stdin.on("error", (error) => {
  console.error("FAIL: cannot write to server:", error.message);
  process.exitCode = 1;
});

const timer = setTimeout(() => {
  child.kill();
  console.error("smoke timeout");
  process.exit(1);
}, 10000);

child.on("close", (code) => {
  clearTimeout(timer);
  let responses;
  try {
    assert.equal(code, 0, "server exit code");
    assert.notEqual(process.exitCode, 1, "transport error");
    responses = out.split(/\r?\n/).filter((line) => line.trim()).map(JSON.parse);
    assert.equal(responses.length, 2, "response count");
    assert.ok(responses.every((response) => response.jsonrpc === "2.0" && !response.error));
  } catch (error) {
    console.error("FAIL:", error.message);
    process.exitCode = 1;
    return;
  }

  const init = responses.find((r) => r.id === 1);
  const tools = responses.find((r) => r.id === 2);
  if (!init || !init.result || !init.result.serverInfo || init.result.protocolVersion !== "2024-11-05") {
    console.error("FAIL: initialize", out);
    process.exit(1);
  }
  const names = ((tools && tools.result && tools.result.tools) || []).map(
    (t) => t.name
  );
  const expected = [
    "list_sessions",
    "run_prompt",
    "resume_session",
    "auth_status",
  ];
  const missing = expected.filter((n) => !names.includes(n));
  if (missing.length || names.length !== expected.length) {
    console.error("FAIL: missing tools", missing, names);
    process.exit(1);
  }
  console.log("PASS: initialize + tools/list");
  console.log("tools:", names.join(", "));
  console.log(
    "server:",
    init.result.serverInfo.name,
    init.result.serverInfo.version
  );
  process.exit(0);
});

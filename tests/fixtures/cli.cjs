"use strict";
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const args = process.argv.slice(2);
const value = (flag) => args.find((arg) => arg.startsWith(flag + "="))?.slice(flag.length + 1);

if (args[0] === "list") {
  process.stdout.write(process.env.FAKE_SESSIONS || JSON.stringify([
    { id: "session-123", working_directory: process.cwd(), title: "A previous task", last_activity_at: "2026-10-11T12:00:00Z" },
  ]));
} else if (args[0] === "auth") {
  process.stdout.write("Authenticated (fake CLI)");
} else {
  const promptPath = value("--prompt-file");
  const prompt = fs.readFileSync(promptPath, "utf8");
  const exportPath = value("--export");
  const sessionId = value("--resume") || "new-session-456";
  if (prompt !== "missing-export") {
    fs.writeFileSync(exportPath, JSON.stringify({ schema_version: "ATIF-v1.6", session_id: sessionId, steps: [] }));
  }
  if (prompt === "utf8") {
    const data = Buffer.from("你好，世界 𠮷");
    process.stdout.write(data.subarray(0, 1));
    setTimeout(() => process.stdout.end(data.subarray(1)), 30);
  } else if (prompt === "flood") {
    process.stdout.write("x".repeat(200000));
  } else if (prompt === "fail") {
    process.stderr.write("deliberate failure");
    process.exitCode = 7;
  } else if (prompt.startsWith("wait:")) {
    const pidPath = prompt.slice(5);
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" });
    fs.writeFileSync(pidPath, JSON.stringify({ parent: process.pid, child: child.pid, promptPath }));
    setInterval(() => {}, 1000);
  } else {
    process.stdout.write(JSON.stringify({ args, prompt, cwd: process.cwd(), stdinEnded: false }));
  }
}

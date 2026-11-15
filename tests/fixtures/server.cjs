"use strict";
const path = require("node:path");
const { ProcessRunner } = require("../../dist/process.js");
const { ToolService, readConfig } = require("../../dist/tools.js");
const { StdioServer } = require("../../dist/protocol.js");
const runner = new ProcessRunner({ bin: process.execPath, prefixArgs: [path.join(__dirname, "cli.cjs")] });
const server = new StdioServer(new ToolService(readConfig({}), runner), process.stdin, process.stdout, 50);
process.once("SIGTERM", () => server.stop());
server.start();

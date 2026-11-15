#!/usr/bin/env node
/**
 * Local Devin CLI → stdio MCP (zero npm runtime deps).
 * Spawns the user's local `devin` binary. Never talks to mcp.devin.ai.
 * Never reads credentials.toml.
 */
import { StdioServer } from "./protocol";
import { readConfig, ToolService } from "./tools";

export function main(): void {
  if (process.argv.includes("--version")) {
    process.stdout.write(require("../package.json").version + "\n");
    return;
  }
  if (process.argv.includes("--help")) {
    process.stdout.write("local-devin — unofficial stdio MCP bridge to the local Devin CLI\n\nUsage: local-devin [--help | --version]\n\nConfigure DEVIN_BIN if Devin is not on PATH, and pass an absolute cwd to tools\nor set DEVIN_CWD. See README.md for permissions, limits and client setup.\n");
    return;
  }
  if (process.argv.length > 2) {
    process.stderr.write("Unknown option. Run local-devin --help.\n");
    process.exitCode = 1;
    return;
  }
  try {
    const server = new StdioServer(new ToolService(readConfig()), process.stdin, process.stdout);
    const stop = (): void => {
      try {
        server.stop();
      } catch {
        /* ignore */
      }
      try {
        process.stdin.pause();
      } catch {
        /* ignore */
      }
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    server.start();
  } catch (error) {
    process.stderr.write(`local-devin: ${(error as Error).message}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

import { execFile, spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";

export interface Command {
  bin: string;
  prefixArgs?: string[];
}

export interface Failure {
  code: string;
  message: string;
}

export interface ProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error: Failure | null;
  durationMs: number;
}

export interface RunOptions {
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
}

export function resolveDevinBin(env: NodeJS.ProcessEnv = process.env): string {
  const usable = (file: string): boolean => {
    try {
      accessSync(file, constants.X_OK);
      return statSync(file).isFile() && (process.platform !== "win32" || /\.exe$/i.test(file));
    } catch {
      return false;
    }
  };
  if (env.DEVIN_BIN !== undefined) {
    const file = env.DEVIN_BIN.trim();
    if (!path.isAbsolute(file) || !usable(file)) {
      throw new Error("DEVIN_BIN must be an absolute path to an executable Devin binary (an .exe on Windows).");
    }
    return file;
  }
  const name = process.platform === "win32" ? "devin.exe" : "devin";
  const searchPath = env.PATH ?? env.Path ?? "";
  const candidates = searchPath.split(path.delimiter)
    .map((entry) => entry.replace(/^"(.*)"$/, "$1"))
    .filter((entry) => path.isAbsolute(entry))
    .map((entry) => path.join(entry, name));
  if (process.platform === "win32") {
    candidates.push(path.join(env.LOCALAPPDATA || path.join(homedir(), "AppData", "Local"), "devin", "cli", "bin", name));
  } else {
    candidates.push(path.join(homedir(), ".local", "bin", name));
  }
  const found = candidates.find(usable);
  if (!found) throw new Error("Devin CLI was not found. Install it on PATH or set DEVIN_BIN to its absolute executable path.");
  return found;
}

export class ProcessRunner {
  constructor(private readonly command?: Command) {}

  async run(args: string[], options: RunOptions): Promise<ProcessResult> {
    const startedAt = Date.now();
    const result: ProcessResult = {
      exitCode: null, signal: null, stdout: "", stderr: "", error: null, durationMs: 0,
    };
    const fail = (code: string, message: string): ProcessResult => ({
      ...result, error: { code, message }, durationMs: Date.now() - startedAt,
    });
    if (options.signal?.aborted) return fail("CANCELLED", "The request was cancelled before starting Devin.");
    let command: Command;
    try {
      command = this.command ?? { bin: resolveDevinBin() };
    } catch (error) {
      return fail("CLI_NOT_FOUND", (error as Error).message);
    }

    return new Promise((resolve) => {
      const child = spawn(command.bin, [...(command.prefixArgs ?? []), ...args], {
        cwd: options.cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
        shell: false,
        windowsHide: true,
      });
      const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
      let bytes = 0;
      let finished = false;
      let forceTimer: NodeJS.Timeout | undefined;
      let cleanupTimer: NodeJS.Timeout | undefined;
      let killer: ReturnType<typeof execFile> | undefined;

      const killGroup = (signal: NodeJS.Signals): void => {
        if (!child.pid) return;
        try {
          if (process.platform === "win32") child.kill(signal);
          else process.kill(-child.pid, signal);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
            result.stderr += "\nCould not signal the Devin process group.";
          }
        }
      };

      const finish = (): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        clearTimeout(forceTimer);
        clearTimeout(cleanupTimer);
        options.signal?.removeEventListener("abort", onAbort);
        if (result.error?.code !== "OUTPUT_LIMIT") {
          result.stdout += decoders.stdout.end();
          result.stderr += decoders.stderr.end();
        }
        result.durationMs = Date.now() - startedAt;
        resolve(result);
      };

      const stop = (code: string, message: string): void => {
        if (finished || result.error) return;
        result.error = { code, message };
        if (process.platform === "win32" && child.pid) {
          const taskkill = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe");
          killer = execFile(taskkill, ["/PID", String(child.pid), "/T", "/F"], {
            windowsHide: true, timeout: 5000,
          }, (error) => {
            killer = undefined;
            if (error && !finished) killGroup("SIGKILL");
          });
        } else {
          killGroup("SIGTERM");
          forceTimer = setTimeout(() => killGroup("SIGKILL"), 750);
        }
        cleanupTimer = setTimeout(() => {
          killGroup("SIGKILL");
          killer?.kill();
          child.stdout.destroy();
          child.stderr.destroy();
          child.unref();
          result.error = { code: "TERMINATION_FAILED", message: `${message} Process shutdown could not be confirmed; check for remaining Devin processes.` };
          finish();
        }, 6000);
      };
      const onAbort = (): void => stop("CANCELLED", "The request was cancelled; termination of the Devin process tree was requested.");
      const timer = setTimeout(() => stop("TIMEOUT", `Devin exceeded the ${options.timeoutMs} ms timeout; termination of its process tree was requested.`), options.timeoutMs);

      for (const stream of ["stdout", "stderr"] as const) {
        child[stream].on("data", (chunk: Buffer) => {
          if (finished || result.error?.code === "OUTPUT_LIMIT") return;
          const remaining = Math.max(0, options.maxOutputBytes - bytes);
          const accepted = chunk.subarray(0, remaining);
          bytes += accepted.length;
          result[stream] += decoders[stream].write(accepted);
          if (accepted.length < chunk.length) stop("OUTPUT_LIMIT", `Devin exceeded the ${options.maxOutputBytes} byte combined output limit; output is incomplete.`);
        });
      }
      child.on("error", (error) => {
        result.error ??= { code: "SPAWN_FAILED", message: `Could not start Devin: ${error.message}` };
      });
      child.on("close", (code, signal) => {
        result.exitCode = result.error?.code === "SPAWN_FAILED" ? null : code;
        result.signal = signal;
        if (result.error && process.platform !== "win32") killGroup("SIGKILL");
        if (!result.error && code !== 0) result.error = { code: "CLI_FAILED", message: `Devin exited with ${signal || `code ${code}`}. See stderr for details.` };
        finish();
      });
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.signal?.aborted) onAbort();
    });
  }
}

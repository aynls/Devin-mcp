"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProcessRunner = void 0;
exports.resolveDevinBin = resolveDevinBin;
const node_child_process_1 = require("node:child_process");
const node_fs_1 = require("node:fs");
const node_os_1 = require("node:os");
const path = __importStar(require("node:path"));
const node_string_decoder_1 = require("node:string_decoder");
function resolveDevinBin(env = process.env) {
    const usable = (file) => {
        try {
            (0, node_fs_1.accessSync)(file, node_fs_1.constants.X_OK);
            return (0, node_fs_1.statSync)(file).isFile() && (process.platform !== "win32" || /\.exe$/i.test(file));
        }
        catch {
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
        candidates.push(path.join(env.LOCALAPPDATA || path.join((0, node_os_1.homedir)(), "AppData", "Local"), "devin", "cli", "bin", name));
    }
    else {
        candidates.push(path.join((0, node_os_1.homedir)(), ".local", "bin", name));
    }
    const found = candidates.find(usable);
    if (!found)
        throw new Error("Devin CLI was not found. Install it on PATH or set DEVIN_BIN to its absolute executable path.");
    return found;
}
class ProcessRunner {
    command;
    constructor(command) {
        this.command = command;
    }
    async run(args, options) {
        const startedAt = Date.now();
        const result = {
            exitCode: null, signal: null, stdout: "", stderr: "", error: null, durationMs: 0,
        };
        const fail = (code, message) => ({
            ...result, error: { code, message }, durationMs: Date.now() - startedAt,
        });
        if (options.signal?.aborted)
            return fail("CANCELLED", "The request was cancelled before starting Devin.");
        let command;
        try {
            command = this.command ?? { bin: resolveDevinBin() };
        }
        catch (error) {
            return fail("CLI_NOT_FOUND", error.message);
        }
        return new Promise((resolve) => {
            const child = (0, node_child_process_1.spawn)(command.bin, [...(command.prefixArgs ?? []), ...args], {
                cwd: options.cwd,
                env: process.env,
                stdio: ["ignore", "pipe", "pipe"],
                detached: process.platform !== "win32",
                shell: false,
                windowsHide: true,
            });
            const decoders = { stdout: new node_string_decoder_1.StringDecoder("utf8"), stderr: new node_string_decoder_1.StringDecoder("utf8") };
            let bytes = 0;
            let finished = false;
            let forceTimer;
            let cleanupTimer;
            let killer;
            const killGroup = (signal) => {
                if (!child.pid)
                    return;
                try {
                    if (process.platform === "win32")
                        child.kill(signal);
                    else
                        process.kill(-child.pid, signal);
                }
                catch (error) {
                    if (error.code !== "ESRCH") {
                        result.stderr += "\nCould not signal the Devin process group.";
                    }
                }
            };
            const finish = () => {
                if (finished)
                    return;
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
            const stop = (code, message) => {
                if (finished || result.error)
                    return;
                result.error = { code, message };
                if (process.platform === "win32" && child.pid) {
                    const taskkill = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe");
                    killer = (0, node_child_process_1.execFile)(taskkill, ["/PID", String(child.pid), "/T", "/F"], {
                        windowsHide: true, timeout: 5000,
                    }, (error) => {
                        killer = undefined;
                        if (error && !finished)
                            killGroup("SIGKILL");
                    });
                }
                else {
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
            const onAbort = () => stop("CANCELLED", "The request was cancelled; termination of the Devin process tree was requested.");
            const timer = setTimeout(() => stop("TIMEOUT", `Devin exceeded the ${options.timeoutMs} ms timeout; termination of its process tree was requested.`), options.timeoutMs);
            for (const stream of ["stdout", "stderr"]) {
                child[stream].on("data", (chunk) => {
                    if (finished || result.error?.code === "OUTPUT_LIMIT")
                        return;
                    const remaining = Math.max(0, options.maxOutputBytes - bytes);
                    const accepted = chunk.subarray(0, remaining);
                    bytes += accepted.length;
                    result[stream] += decoders[stream].write(accepted);
                    if (accepted.length < chunk.length)
                        stop("OUTPUT_LIMIT", `Devin exceeded the ${options.maxOutputBytes} byte combined output limit; output is incomplete.`);
                });
            }
            child.on("error", (error) => {
                result.error ??= { code: "SPAWN_FAILED", message: `Could not start Devin: ${error.message}` };
            });
            child.on("close", (code, signal) => {
                result.exitCode = result.error?.code === "SPAWN_FAILED" ? null : code;
                result.signal = signal;
                if (result.error && process.platform !== "win32")
                    killGroup("SIGKILL");
                if (!result.error && code !== 0)
                    result.error = { code: "CLI_FAILED", message: `Devin exited with ${signal || `code ${code}`}. See stderr for details.` };
                finish();
            });
            options.signal?.addEventListener("abort", onAbort, { once: true });
            if (options.signal?.aborted)
                onAbort();
        });
    }
}
exports.ProcessRunner = ProcessRunner;
//# sourceMappingURL=process.js.map
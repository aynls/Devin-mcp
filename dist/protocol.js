"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.StdioServer = void 0;
const node_util_1 = require("node:util");
const tools_1 = require("./tools");
const isObject = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const isId = (value) => typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value));
const versions = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const maxFrameBytes = 1048576;
class StdioServer {
    tools;
    input;
    output;
    progressIntervalMs;
    initialized = false;
    ready = false;
    inputClosed = false;
    stopped = false;
    pending = new Map();
    fragments = [];
    frameBytes = 0;
    discarding = false;
    constructor(tools, input, output, progressIntervalMs = 5000) {
        this.tools = tools;
        this.input = input;
        this.output = output;
        this.progressIntervalMs = progressIntervalMs;
    }
    start() {
        this.input.on("data", (data) => this.receive(Buffer.isBuffer(data) ? data : Buffer.from(data)));
        this.input.once("end", () => {
            if (this.frameBytes && !this.discarding)
                this.frame();
            this.inputClosed = true;
            this.drain();
        });
        this.input.once("error", () => this.stop());
        this.output.once("error", () => this.stop());
        this.output.once("close", () => this.stop());
    }
    stop() {
        if (this.stopped)
            return;
        this.stopped = true;
        this.fragments = [];
        this.frameBytes = 0;
        this.input.pause();
        for (const controller of this.pending.values())
            controller.abort();
        this.inputClosed = true;
        this.drain();
    }
    drain() {
        if (this.inputClosed && this.pending.size === 0 && !this.output.writableEnded && !this.output.destroyed) {
            this.output.end();
        }
    }
    send(message) {
        if (this.stopped || this.output.destroyed || this.output.writableEnded)
            return;
        if (this.output.writableLength > 16777216) {
            this.stop();
            return;
        }
        this.output.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
    }
    error(id, code, message) {
        this.send({ id, error: { code, message } });
    }
    receive(chunk) {
        let offset = 0;
        while (offset < chunk.length && !this.stopped) {
            const newline = chunk.indexOf(10, offset);
            const end = newline < 0 ? chunk.length : newline;
            if (!this.discarding) {
                const part = chunk.subarray(offset, end);
                this.frameBytes += part.length;
                if (this.frameBytes > maxFrameBytes) {
                    this.discarding = true;
                    this.fragments = [];
                    this.error(null, -32600, "Request exceeds the 1 MiB frame limit.");
                }
                else {
                    this.fragments.push(part);
                }
            }
            if (newline < 0)
                break;
            if (!this.discarding)
                this.frame();
            this.fragments = [];
            this.frameBytes = 0;
            this.discarding = false;
            offset = newline + 1;
        }
    }
    frame() {
        const buffer = Buffer.concat(this.fragments);
        this.fragments = [];
        this.frameBytes = 0;
        let value;
        try {
            const text = new node_util_1.TextDecoder("utf-8", { fatal: true }).decode(buffer).trim();
            if (!text)
                return;
            value = JSON.parse(text);
        }
        catch {
            this.error(null, -32700, "Invalid JSON or UTF-8.");
            return;
        }
        if (!isObject(value) || value.jsonrpc !== "2.0" || typeof value.method !== "string" ||
            (Object.hasOwn(value, "id") && !isId(value.id)) ||
            (value.params !== undefined && !isObject(value.params))) {
            this.error(isObject(value) && isId(value.id) ? value.id : null, -32600, "Invalid JSON-RPC request.");
            return;
        }
        const params = (value.params ?? {});
        if (!Object.hasOwn(value, "id")) {
            if (value.method === "notifications/initialized" && this.initialized)
                this.ready = true;
            if (value.method === "notifications/cancelled" && isId(params.requestId))
                this.pending.get(params.requestId)?.abort();
            return;
        }
        const id = value.id;
        if (this.pending.has(id)) {
            this.error(id, -32600, "A request with this ID is already in flight.");
            return;
        }
        if (this.pending.size >= 16) {
            this.error(id, -32000, "Too many in-flight requests.");
            return;
        }
        if (value.method === "initialize") {
            if (this.initialized) {
                this.error(id, -32600, "Already initialized.");
                return;
            }
            if (typeof params.protocolVersion !== "string" || !isObject(params.capabilities) ||
                !isObject(params.clientInfo) || typeof params.clientInfo.name !== "string" || typeof params.clientInfo.version !== "string") {
                this.error(id, -32602, "initialize requires protocolVersion, capabilities and clientInfo.");
                return;
            }
            this.initialized = true;
            this.send({ id, result: {
                    protocolVersion: versions.includes(params.protocolVersion) ? params.protocolVersion : versions[0],
                    capabilities: { tools: {} },
                    serverInfo: { name: "local-devin", version: require("../package.json").version },
                    instructions: "Use an absolute cwd or configure DEVIN_CWD. Resume only an explicit sessionId. Task success means CLI exit success, not independent verification of its work. Never enable dangerous permissions or skip workspace trust without the user's explicit approval.",
                } });
            return;
        }
        if (value.method === "ping") {
            this.send({ id, result: {} });
            return;
        }
        if (!this.ready) {
            this.error(id, -32002, "Initialize the server and send notifications/initialized first.");
            return;
        }
        if (value.method === "tools/list") {
            if (params.cursor !== undefined)
                this.error(id, -32602, "This server does not paginate tools.");
            else
                this.send({ id, result: { tools: tools_1.TOOLS } });
            return;
        }
        if (value.method !== "tools/call") {
            this.error(id, -32601, `Method not found: ${value.method}`);
            return;
        }
        if (typeof params.name !== "string" || (params._meta !== undefined && !isObject(params._meta))) {
            this.error(id, -32602, "tools/call requires a string name and an optional object _meta.");
            return;
        }
        const token = isObject(params._meta) ? params._meta.progressToken : undefined;
        if (token !== undefined && !isId(token)) {
            this.error(id, -32602, "progressToken must be a string or integer.");
            return;
        }
        const controller = new AbortController();
        this.pending.set(id, controller);
        const started = Date.now();
        const progress = token === undefined ? undefined : setInterval(() => {
            if (!controller.signal.aborted)
                this.send({
                    method: "notifications/progress",
                    params: { progressToken: token, progress: Date.now() - started, message: "Waiting for the local Devin CLI." },
                });
        }, this.progressIntervalMs);
        Promise.resolve()
            .then(() => this.tools.call(params.name, Object.hasOwn(params, "arguments") ? params.arguments : {}, controller.signal))
            .then((result) => {
            if (!controller.signal.aborted)
                this.send({ id, result: {
                        content: [{ type: "text", text: JSON.stringify(result) }],
                        structuredContent: result,
                        isError: !result.ok,
                    } });
        })
            .catch((error) => {
            if (!controller.signal.aborted)
                this.error(id, error instanceof tools_1.InputError ? -32602 : -32603, error.message);
        })
            .finally(() => {
            clearInterval(progress);
            this.pending.delete(id);
            this.drain();
        });
    }
}
exports.StdioServer = StdioServer;
//# sourceMappingURL=protocol.js.map
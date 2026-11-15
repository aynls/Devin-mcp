import type { Readable, Writable } from "node:stream";
import { TextDecoder } from "node:util";
import { InputError, TOOLS, type ToolService } from "./tools";

type Id = string | number;
type ObjectValue = Record<string, unknown>;
const isObject = (value: unknown): value is ObjectValue => !!value && typeof value === "object" && !Array.isArray(value);
const isId = (value: unknown): value is Id => typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value));
const versions = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const maxFrameBytes = 1048576;

export class StdioServer {
  private initialized = false;
  private ready = false;
  private inputClosed = false;
  private stopped = false;
  private readonly pending = new Map<Id, AbortController>();
  private fragments: Buffer[] = [];
  private frameBytes = 0;
  private discarding = false;

  constructor(
    private readonly tools: Pick<ToolService, "call">,
    private readonly input: Readable,
    private readonly output: Writable,
    private readonly progressIntervalMs = 5000,
  ) {}

  start(): void {
    this.input.on("data", (data: Buffer | string) => this.receive(Buffer.isBuffer(data) ? data : Buffer.from(data)));
    this.input.once("end", () => {
      if (this.frameBytes && !this.discarding) this.frame();
      this.inputClosed = true;
      this.drain();
    });
    this.input.once("error", () => this.stop());
    this.output.once("error", () => this.stop());
    this.output.once("close", () => this.stop());
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.fragments = [];
    this.frameBytes = 0;
    this.input.pause();
    for (const controller of this.pending.values()) controller.abort();
    this.inputClosed = true;
    this.drain();
  }

  private drain(): void {
    if (this.inputClosed && this.pending.size === 0 && !this.output.writableEnded && !this.output.destroyed) {
      this.output.end();
    }
  }

  private send(message: ObjectValue): void {
    if (this.stopped || this.output.destroyed || this.output.writableEnded) return;
    if (this.output.writableLength > 16777216) {
      this.stop();
      return;
    }
    this.output.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
  }

  private error(id: Id | null, code: number, message: string): void {
    this.send({ id, error: { code, message } });
  }

  private receive(chunk: Buffer): void {
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
        } else {
          this.fragments.push(part);
        }
      }
      if (newline < 0) break;
      if (!this.discarding) this.frame();
      this.fragments = [];
      this.frameBytes = 0;
      this.discarding = false;
      offset = newline + 1;
    }
  }

  private frame(): void {
    const buffer = Buffer.concat(this.fragments);
    this.fragments = [];
    this.frameBytes = 0;
    let value: unknown;
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer).trim();
      if (!text) return;
      value = JSON.parse(text);
    } catch {
      this.error(null, -32700, "Invalid JSON or UTF-8.");
      return;
    }
    if (!isObject(value) || value.jsonrpc !== "2.0" || typeof value.method !== "string" ||
        (Object.hasOwn(value, "id") && !isId(value.id)) ||
        (value.params !== undefined && !isObject(value.params))) {
      this.error(isObject(value) && isId(value.id) ? value.id : null, -32600, "Invalid JSON-RPC request.");
      return;
    }
    const params = (value.params ?? {}) as ObjectValue;
    if (!Object.hasOwn(value, "id")) {
      if (value.method === "notifications/initialized" && this.initialized) this.ready = true;
      if (value.method === "notifications/cancelled" && isId(params.requestId)) this.pending.get(params.requestId)?.abort();
      return;
    }
    const id = value.id as Id;
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
      if (params.cursor !== undefined) this.error(id, -32602, "This server does not paginate tools.");
      else this.send({ id, result: { tools: TOOLS } });
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
      if (!controller.signal.aborted) this.send({
        method: "notifications/progress",
        params: { progressToken: token, progress: Date.now() - started, message: "Waiting for the local Devin CLI." },
      });
    }, this.progressIntervalMs);
    Promise.resolve()
      .then(() => this.tools.call(params.name as string, Object.hasOwn(params, "arguments") ? params.arguments : {}, controller.signal))
      .then((result) => {
        if (!controller.signal.aborted) this.send({ id, result: {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
          isError: !result.ok,
        } });
      })
      .catch((error: Error) => {
        if (!controller.signal.aborted) this.error(id, error instanceof InputError ? -32602 : -32603, error.message);
      })
      .finally(() => {
        clearInterval(progress);
        this.pending.delete(id);
        this.drain();
      });
  }
}

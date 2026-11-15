import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { ProcessRunner, type Failure, type ProcessResult } from "./process";

export interface Config {
  cwd?: string;
  timeoutMs: number;
  maxOutputBytes: number;
  allowDangerous: boolean;
  allowUntrusted: boolean;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const integer = (name: string, fallback: number, min: number, max: number): number => {
    if (env[name] === undefined) return fallback;
    const value = Number(env[name]);
    if (!/^\d+$/.test(env[name]!) || !Number.isSafeInteger(value) || value < min || value > max) {
      throw new Error(`${name} must be an integer between ${min} and ${max}.`);
    }
    return value;
  };
  const flag = (name: string): boolean => {
    if (env[name] === undefined || env[name] === "false") return false;
    if (env[name] === "true") return true;
    throw new Error(`${name} must be true or false.`);
  };
  const cwd = env.DEVIN_CWD;
  if (cwd !== undefined && (!path.isAbsolute(cwd) || cwd.includes("\0"))) {
    throw new Error("DEVIN_CWD must be an absolute workspace path.");
  }
  return {
    cwd,
    timeoutMs: integer("DEVIN_MCP_TIMEOUT_MS", 600000, 100, 3600000),
    maxOutputBytes: integer("DEVIN_MCP_MAX_OUTPUT_BYTES", 1048576, 1024, 16777216),
    allowDangerous: flag("DEVIN_MCP_ALLOW_DANGEROUS"),
    allowUntrusted: flag("DEVIN_MCP_ALLOW_UNTRUSTED"),
  };
}

interface Field {
  type: "string" | "boolean" | "integer";
  description: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  enum?: string[];
}

interface Tool {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, Field>; required: string[]; additionalProperties: false };
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
}

const cwdField: Field = { type: "string", minLength: 1, maxLength: 32768, description: "Absolute target workspace path. Required unless the server has DEVIN_CWD; never defaults to the plugin directory." };
const taskFields: Record<string, Field> = {
  cwd: cwdField,
  prompt: { type: "string", minLength: 1, maxLength: 131072, description: "Task instructions. Passed through a private temporary file, not shell interpolation." },
  model: { type: "string", minLength: 1, maxLength: 256, description: "Optional Devin model name or alias. Omit to use the CLI default or the resumed session's model." },
  permissionMode: { type: "string", enum: ["auto", "accept-edits", "smart", "dangerous"], description: "Defaults to auto, overriding inherited permission defaults. dangerous requires DEVIN_MCP_ALLOW_DANGEROUS=true and explicit user approval." },
  respectWorkspaceTrust: { type: "boolean", description: "Defaults to true. false requires DEVIN_MCP_ALLOW_UNTRUSTED=true and explicit user approval." },
  timeoutMs: { type: "integer", minimum: 100, maximum: 3600000, description: "Per-command timeout in ms; defaults to the server limit (10 minutes unless configured). Cannot exceed that limit." },
};

const tool = (name: string, description: string, properties: Record<string, Field>, required: string[], readOnly: boolean): Tool => ({
  name, description,
  inputSchema: { type: "object", properties, required, additionalProperties: false },
  annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: readOnly, openWorldHint: true },
});

export const TOOLS: Tool[] = [
  tool("list_sessions", "Discover local Devin sessions in an explicit workspace. Returns id, cwd, title and lastActivityAt; does not invent session status.", { cwd: cwdField }, [], true),
  tool("run_prompt", "Run a new local Devin task. May edit files and execute commands according to the selected permissions. Returns output, exit status and an ATIF-verified sessionId when available.", taskFields, ["prompt"], false),
  tool("resume_session", "Continue a specific local Devin session with a new prompt. Use an exact sessionId from list_sessions or run_prompt. Never selects the most recent session implicitly.", {
    ...taskFields,
    sessionId: { type: "string", minLength: 1, maxLength: 256, description: "Exact session ID in this workspace; abbreviations and implicit continuation are not supported." },
  }, ["prompt", "sessionId"], false),
  tool("auth_status", "Check Devin CLI authentication using devin auth status. The bridge never opens credential files; returned diagnostics may contain account information.", {}, [], true),
];

export class InputError extends Error {}

export interface Session {
  id: string;
  cwd: string;
  title: string | null;
  lastActivityAt: string | null;
}

export type ToolResult = Record<string, unknown> & { ok: boolean; error?: Failure | null };

function validate(name: string, input: unknown): Record<string, unknown> {
  const definition = TOOLS.find((entry) => entry.name === name);
  if (!definition) throw new InputError(`Unknown tool: ${name}`);
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new InputError("arguments must be an object.");
  const args = input as Record<string, unknown>;
  const schema = definition.inputSchema;
  for (const field of schema.required) if (!(field in args)) throw new InputError(`${field} is required.`);
  for (const [key, value] of Object.entries(args)) {
    if (!Object.hasOwn(schema.properties, key)) throw new InputError(`Unknown argument: ${key}`);
    const field = schema.properties[key];
    if (field.type === "integer") {
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < field.minimum! || value > field.maximum!) {
        throw new InputError(`${key} must be an integer between ${field.minimum} and ${field.maximum}.`);
      }
    } else if (typeof value !== field.type) {
      throw new InputError(`${key} must be a ${field.type}.`);
    }
    if (typeof value === "string") {
      if (!value.trim() || value.includes("\0") || value.length > (field.maxLength ?? 131072)) throw new InputError(`${key} must be nonempty, contain no NUL characters and fit its length limit.`);
      if (field.enum && !field.enum.includes(value)) throw new InputError(`${key} must be one of: ${field.enum.join(", ")}.`);
    }
  }
  return args;
}

const failure = (code: string, message: string): ToolResult => ({ ok: false, error: { code, message } });

export class ToolService {
  private readonly workspaces = new Set<string>();
  private active = 0;
  private terminationFailed = false;

  constructor(private readonly config: Config, private readonly runner = new ProcessRunner()) {}

  async call(name: string, input: unknown, signal?: AbortSignal): Promise<ToolResult> {
    const args = validate(name, input);
    if (this.terminationFailed) return failure("TERMINATION_FAILED", "A previous CLI process could not be confirmed stopped. Inspect remaining processes, then restart this MCP server before running more work.");
    if (this.active >= 4) return failure("BUSY", "Four CLI requests are already running. Wait for one to finish.");
    if (signal?.aborted) return failure("CANCELLED", "The request was cancelled.");
    if (args.permissionMode === "dangerous" && !this.config.allowDangerous) return failure("POLICY_DENIED", "dangerous requires the server owner to set DEVIN_MCP_ALLOW_DANGEROUS=true.");
    if (args.respectWorkspaceTrust === false && !this.config.allowUntrusted) return failure("POLICY_DENIED", "Skipping workspace trust requires the server owner to set DEVIN_MCP_ALLOW_UNTRUSTED=true.");
    if (typeof args.timeoutMs === "number" && args.timeoutMs > this.config.timeoutMs) throw new InputError(`timeoutMs cannot exceed the server limit of ${this.config.timeoutMs} ms.`);
    let workspaceKey: string | undefined;
    this.active += 1;
    try {
      const requestedCwd = name === "auth_status" ? undefined : (args.cwd as string | undefined ?? this.config.cwd);
      if (name !== "auth_status" && !requestedCwd) return failure("WORKSPACE_REQUIRED", "Pass an absolute cwd or configure DEVIN_CWD. The plugin directory is not a workspace default.");
      if (requestedCwd && !path.isAbsolute(requestedCwd)) return failure("INVALID_WORKSPACE", "cwd must be an absolute path.");
      let cwd: string;
      try {
        cwd = await fs.realpath(requestedCwd || process.cwd());
        if (!(await fs.stat(cwd)).isDirectory()) return failure("INVALID_WORKSPACE", "cwd must be an existing directory.");
      } catch {
        return failure("INVALID_WORKSPACE", "The workspace directory does not exist or is inaccessible.");
      }
      const task = name === "run_prompt" || name === "resume_session";
      if (task) {
        const key = process.platform === "win32" ? cwd.toLowerCase() : cwd;
        if (this.workspaces.has(key)) return failure("WORKSPACE_BUSY", "A task is already running in this workspace through this server. Wait before starting another.");
        workspaceKey = key;
        this.workspaces.add(key);
      }
      const options = {
        cwd, signal,
        timeoutMs: task ? (args.timeoutMs as number | undefined ?? this.config.timeoutMs) : Math.min(30000, this.config.timeoutMs),
        maxOutputBytes: this.config.maxOutputBytes,
      };
      if (name === "auth_status") return this.wrap(await this.runner.run(["auth", "status"], options), cwd);
      if (name === "list_sessions") return await this.list(cwd, signal);
      if (name === "resume_session") {
        const list = await this.list(cwd, signal);
        if (!list.ok) return list;
        if (!(list.sessions as Session[]).some((session) => session.id === args.sessionId)) {
          return failure("SESSION_NOT_FOUND", "The exact sessionId was not found in this workspace. Call list_sessions and use a returned id.");
        }
      }
      const directory = await fs.mkdtemp(path.join(tmpdir(), "local-devin-"));
      let result: ToolResult | undefined;
      try {
        await fs.chmod(directory, 0o700);
        const promptPath = path.join(directory, "prompt.txt");
        const exportPath = path.join(directory, "session.json");
        await fs.writeFile(promptPath, args.prompt as string, { mode: 0o600, flag: "wx" });
        await fs.writeFile(exportPath, "", { mode: 0o600, flag: "wx" });
        const cliArgs = [
          "--print",
          `--prompt-file=${promptPath}`,
          `--export=${exportPath}`,
          `--permission-mode=${args.permissionMode ?? "auto"}`,
          `--respect-workspace-trust=${args.respectWorkspaceTrust !== false}`,
        ];
        if (args.model) cliArgs.push(`--model=${args.model}`);
        if (name === "resume_session") cliArgs.push(`--resume=${args.sessionId}`);
        result = { ...this.wrap(await this.runner.run(cliArgs, options), cwd), sessionId: null, warnings: [] as string[] };
        try {
          const stat = await fs.stat(exportPath);
          if (stat.size > 16777216) throw new Error("Export too large.");
          const transcript: unknown = JSON.parse(await fs.readFile(exportPath, "utf8"));
          if (!transcript || typeof transcript !== "object" || !("session_id" in transcript) ||
              typeof transcript.session_id !== "string" || !transcript.session_id.trim() || transcript.session_id.length > 256) {
            throw new Error("Missing session ID.");
          }
          if (name === "resume_session" && transcript.session_id !== args.sessionId) throw new Error("Session ID mismatch.");
          result.sessionId = transcript.session_id;
        } catch {
          (result.warnings as string[]).push("Could not verify a session ID from the CLI export. Use list_sessions; do not repeat an executed task just to obtain an ID.");
        }
        return result;
      } finally {
        try {
          await fs.rm(directory, { recursive: true, force: true, maxRetries: 3 });
        } catch {
          if (result) (result.warnings as string[]).push(`Could not remove private temporary files at ${directory}. Remove them manually.`);
          else throw new Error(`Could not remove private temporary files at ${directory}. Remove them manually.`);
        }
      }
    } catch (error) {
      return failure("INTERNAL_ERROR", (error as Error).message);
    } finally {
      this.active -= 1;
      if (workspaceKey) this.workspaces.delete(workspaceKey);
    }
  }

  private wrap(result: ProcessResult, cwd: string): ToolResult {
    if (result.error?.code === "TERMINATION_FAILED") this.terminationFailed = true;
    return { ok: !result.error && result.exitCode === 0, cwd, ...result };
  }

  private async list(cwd: string, signal?: AbortSignal): Promise<ToolResult> {
    const result = this.wrap(await this.runner.run(["list", "--format", "json"], {
      cwd, signal, timeoutMs: Math.min(30000, this.config.timeoutMs), maxOutputBytes: this.config.maxOutputBytes,
    }), cwd);
    if (!result.ok) return result;
    try {
      const rows: unknown = JSON.parse(result.stdout as string);
      if (!Array.isArray(rows)) throw new Error("Expected an array.");
      const sessions: Session[] = rows.map((row: unknown) => {
        if (!row || typeof row !== "object" || !("id" in row) || typeof row.id !== "string" || !row.id ||
            !("working_directory" in row) || typeof row.working_directory !== "string") throw new Error("Unexpected session shape.");
        return {
          id: row.id,
          cwd: row.working_directory,
          title: "title" in row && typeof row.title === "string" ? row.title : null,
          lastActivityAt: "last_activity_at" in row && typeof row.last_activity_at === "string" ? row.last_activity_at : null,
        };
      });
      return { ...result, stdout: "", sessions };
    } catch {
      return { ...result, ...failure("INVALID_CLI_OUTPUT", "devin list did not return the expected JSON session array. Check the installed CLI version and stderr.") };
    }
  }
}

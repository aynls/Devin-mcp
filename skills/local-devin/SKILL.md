---
name: local-devin
description: >
  Use when the user wants an MCP client (or this agent) to control the LOCAL Devin CLI
  on their machine — start a non-interactive turn, list local sessions, resume
  or continue a session, or check Devin CLI auth status. Prefer these MCP tools
  over inventing session ids, guessing CLI flags, or calling the cloud
  mcp.devin.ai endpoint. Do not activate for pure cloud Devin API/MCP work
  unless the user explicitly asks to leave the local CLI.
---

# Local Devin CLI

Domain type: `LocalDevinSession = { id, cwd, title, lastActivityAt }`.
Task results include `ok`, `exitCode`, `stdout`, `stderr`, `sessionId`, and
`warnings`. A session ID is verified from the CLI export, not inferred.

## When to call which tool

| Intent | Tool | Notes |
| --- | --- | --- |
| What sessions exist here? | `list_sessions` | Pass an absolute `cwd`, unless the owner configured `DEVIN_CWD`. |
| Run one local Devin turn | `run_prompt` | Requires `prompt` and a workspace. Optional `model`, `permissionMode`, `timeoutMs`. |
| Continue / resume work | `resume_session` | Requires an exact `sessionId`, `prompt`, and workspace. Never implicitly continue the latest session. |
| Is the CLI logged in? | `auth_status` | Uses `devin auth status` only — never open credentials files. |

## Hard rules

1. **Never invent** session ids, status, stdout, or auth details. Always call the tool and report its result.
2. **Local only.** This plugin spawns the user's `devin` binary. It does not call `https://mcp.devin.ai/mcp`.
3. **Trust prompt.** Prefer having the user trust the workspace interactively. Only request `respectWorkspaceTrust: false` after explicit approval; the server also requires `DEVIN_MCP_ALLOW_UNTRUSTED=true`.
4. **Secrets.** Do not read, paste, or commit `credentials.toml`, API keys, or tokens.
5. **Permission modes.** Default to `auto`. Only request `dangerous` when the user explicitly asks for full auto-approval; the server also requires `DEVIN_MCP_ALLOW_DANGEROUS=true`. Never change server policy to get around a denial.
6. **Workspace.** Never use the plugin directory as the target workspace unless the user is actually working on the plugin.
7. **Results.** `ok` means CLI exit success, not verified task completion. If `sessionId` is null, use `list_sessions`; never repeat an executed task just to recover its ID.
8. **Cancellation.** Cancel the MCP request when asked to stop. Cancellation is not rollback; inspect partial changes before retrying a timeout or failure.

## Suggested flow

1. `auth_status` if login is unclear.
2. `list_sessions` with the target `cwd`.
3. `run_prompt` for a new turn, or `resume_session` for an existing one.
4. Inspect `ok`, `error`, and `warnings`; return relevant output and the verified session ID without fabricating a success narrative.
5. For follow-ups, use the exact ID in the same workspace. If `WORKSPACE_BUSY` is returned, wait rather than starting duplicate work.

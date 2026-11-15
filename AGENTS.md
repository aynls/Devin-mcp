# Project conventions

This is an unofficial local Devin CLI bridge, not the cloud Devin MCP service.
Keep runtime dependencies at zero. The official MCP SDK is a development-only
interoperability test client.

Use Node.js 22 or 24. Run `npm ci`, `npm run check`, and
`npm run verify:package` before committing. Tests use the fake CLI in
`tests/fixtures/cli.cjs`; do not replace it with real model calls or credentials.
For coverage, run `node --test --experimental-test-coverage` after building.

TypeScript source lives in `server/`. The committed `dist/` is the installation
artifact; run `npm run build` after source changes and commit matching output.
Keep package and plugin versions aligned. The package remains private to
prevent accidental npm publishing; tarball installation is supported.

Keep README.md (English), README.zh-CN.md, and README.ja.md in sync, including
tool schemas, defaults, safety boundaries, and runnable examples.

Never use the bridge directory as an implicit workspace, infer a session ID
from the most recent session, or auto-enable dangerous permissions.
Client cancellation must reach the child process tree, and EOF must drain
in-flight responses. Do not promise rollback or OS-level sandboxing.

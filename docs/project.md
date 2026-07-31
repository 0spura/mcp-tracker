# Project: mcp-tracker

## Stack

- **Runtime:** Node.js ≥ 18, TypeScript strict, ESM (`NodeNext`).
- **MCP:** `@modelcontextprotocol/sdk` over stdio transport only.
- **Validation:** `zod` — tool inputs (MCP boundary) and raw CLI/GraphQL outputs (provider boundary).
- **External CLIs:** `gh` (required for github providers) and `git` (context derivation). Auth is owned by `gh`; this project never handles tokens.
- **Tests:** `vitest` (devDependency). No other test frameworks.
- **Subprocess execution:** `node:child_process` `execFile` promisified in a single internal wrapper. `execSync`/`execFileSync` are banned in `src/`.

## Global constraints

- No HTTP clients, no token management (vision principle 1).
- No synchronous process execution (vision principle 2).
- No string interpolation into shell or GraphQL (vision principle 5).
- External MCP tool contract is frozen by RNF-CMP.1.

## Repo structure

```
src/            TypeScript source (ESM)
test/           vitest suites, including contract tests
docs/           vision, SRS, architecture, ADRs
dist/           build output (tsc), not committed
```

## Environments

- Single environment: the developer's machine, launched by an MCP client config with `CODE_PROVIDER` / `TASK_PROVIDER` env vars.
- Build: `npm run build` (tsc). Dev: `tsx`. Verify: `npm test` (vitest + typecheck).

# 0004: Replace the MCP server with the workctl Rust CLI

- Status: Accepted
- Date: 2026-10-01
- Tracker: none; the user confirmed this repository has no tracker and authorized direct implementation.
- Supersedes: MCP runtime and tool-contract requirements in ADR-0001 through ADR-0003 where they conflict with the workctl v0 scope. ADR-0001's `gh`-owned authentication and no-direct-HTTP boundary remain in force.

## Context

The user chose a clean start rather than porting the existing MCP feature set. The first delivery must be a distributable Rust CLI with no god files, beginning with the highest-priority work-item workflow. The approved first slice is GitHub Issues essential CRUD; GitLab, Projects/boards, status, and the remaining MCP tools are deferred.

## Decision

- Replace the MCP server with a single Rust binary named `workctl`; use the stable Rust toolchain and the latest released `clap` available when implementing (clap 4.6.7 was current on 2026-10-01).
- Ship `issue create`, `list`, `show`, and `edit` for GitHub Issues only. Do not ship delete or old MCP tool aliases.
- Keep modules cohesive by reason to change: CLI grammar, command orchestration, config/context, normalized issue domain, subprocess runner, GitHub adapter read/write/mapping, and output formatting. No omnibus entry point/provider files, empty GitLab modules, or dynamic plugin registry.
- Delegate GitHub API access/authentication to `gh`, pass argument arrays, send JSON request bodies over stdin, enforce process timeout/output bounds, and keep raw stderr and credentials out of user-facing errors.
- Use optional `.workctl.json` and `.workctl.local.json` at the Git root, with local field overrides. Resolve provider from explicit CLI/config before remote-host inference; resolve repository from `--repo` before `origin`. Unknown/unavailable providers fail closed. Do not read or migrate `.mcp-tracker*.json` files.
- Emit compact JSON by default, optional text success output, structured JSON errors on stderr, and nonzero exit on failure.

## Consequences

- The old TypeScript MCP runtime, tool contract, and tests are deleted after the Rust binary passes focused tests and an isolated CLI smoke run.
- Existing MCP behavior is not preserved in v0; the SRS is the active contract and records deferred capabilities as non-goals.
- GitLab may be added later behind the issue-provider boundary with its own verified capability and status contract; v0 contains no placeholder or fallback implementation.
- Existing `.mcp-tracker` project configs are ignored, not silently migrated. `.workctl.local.json` stays untracked.
- `gh` and `git` are runtime dependencies; no token management or direct HTTP client is introduced.

## Alternatives

- Preserve the existing MCP tool contract in Rust: rejected by the user's explicit clean-start/prioritized-scope decision.
- Port GitHub and GitLab together: rejected for v0; GitHub CRUD is the first delivery and GitLab is deferred.
- Keep Node.js and add a Rust wrapper: rejected; the deliverable is the native Rust binary.
- Add a generic plugin system: rejected; only GitHub is implemented in v0 and the provider seam is sufficient for the planned next adapter.
- Use direct HTTP credentials: rejected; `gh` already owns authentication and avoids token handling in `workctl`.

## Traceability

- Requirements: [docs/srs.md](../srs.md)
- Architecture: [docs/architecture.md](../architecture.md)
- Project stack: [docs/project.md](../project.md)

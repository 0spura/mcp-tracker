# Vision: mcp-tracker

## Purpose

mcp-tracker is an MCP server that gives a coding agent native access to issue trackers and code hosts: branches, PRs, issues, comments, boards, labels, and milestones. It exists so the agent works the tracker the way a developer does, with session context (repo, active issue, defaults) resolved once and reused, instead of repeating parameters on every call.

## Aspiration

The reference MCP server for tracker workflows: one stable external tool contract, provider implementations behind clean capability interfaces, and a local markdown provider that works with zero external accounts. Any new provider (GitLab, Jira, Linear) plugs in by implementing interfaces, without touching the tool layer.

## Users

A single developer running an agent locally against their own GitHub repos. They authenticate with the `gh` CLI, they want the agent to drive the full issue lifecycle (branch → PR → review → merge → status updates), and they occasionally work offline or without a tracker account via local markdown files.

## Principles

1. **CLI is the transport:** all GitHub/GitLab access goes through `gh`/`glab`, which own authentication. No token management in this project. This rules out direct HTTP clients.
2. **Async is real:** no synchronous subprocess calls (`execFileSync`, `execSync`). Every provider call is genuinely asynchronous so one slow CLI call never blocks the server.
3. **Capabilities are declarative:** a provider declares what it implements (code, issue, board, metadata, sub-issues, relationships). No duck-typing with `in`, no stateless delegator classes.
4. **One domain vocabulary:** providers normalize into shared types. States are `open | closed | merged`, never vendor casing. Vendor-specific mechanisms (labels vs. board fields vs. frontmatter) stay inside the provider.
5. **Never interpolate into shell or GraphQL:** subprocess calls use argument arrays; GraphQL uses variables. No string concatenation of untrusted or variable values.
6. **The external tool contract is stable:** tool names, parameters, and the session-context behavior documented in the README survive the rewrite unchanged.

## Anti-goals

- Not a generic GitHub/GitLab API client; only the tracker workflow the agent needs.
- Not multi-repo or multi-board concurrent sessions (one context per process).
- Not an HTTP/SSE server; stdio transport only.
- No GitLab providers in the rewrite (return later, once the architecture is validated).
- No broad test coverage now; contract tests for the provider interfaces only.

## Approved redesign decisions (2026-07-30)

- **Total rewrite** of `src/`, preserving the external MCP tool contract (tool names, parameters, context behavior).
- **Providers in scope:** `github` (CodeProvider), `github-projects` (Issue + Board + Metadata), `local` (Issue + Metadata, markdown files). GitLab providers are dropped from the tree.
- **Testing:** minimal — a shared contract test suite that runs against every IssueProvider implementation.
- Root causes being fixed: fake async (`execFileSync` everywhere), string interpolation into GraphQL/shell, triple-duplicated checklist logic, stateless delegator classes, vendor state leakage (`OPEN` vs `opened`), dead code, and silent best-effort automations.

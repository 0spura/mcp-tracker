# 0001: CLI transport via gh, never direct HTTP

- Status: Accepted
- Date: 2026-07-30

## Context

mcp-tracker needs to talk to GitHub (REST and GraphQL). The pre-rewrite code did this through the `gh` CLI but called it synchronously (`execFileSync`), blocking the server event loop, and interpolated variables into GraphQL strings. The rewrite needs a transport that is async, injection-safe, and simple to authenticate. Authentication is the deciding force: the target user already runs an authenticated `gh` CLI, and this project does not want to own token storage, refresh, or scoping.

## Decision

All GitHub access goes through the `gh` CLI, executed asynchronously via a single promisified `execFile` wrapper (`core/process.run`) with argument arrays and timeouts. GraphQL variables are passed as `gh api graphql -F` flags, never interpolated. No HTTP client library is added; no tokens are read, stored, or logged by this project.

## Alternatives Considered

- **Direct HTTP with Octokit/fetch and a user-supplied token:** real async and typed errors for free, but pushes token management onto the user config and onto this project's security surface, for a single-user local tool where `gh` is already authenticated. Rejected on vision principle 1.
- **Keep the CLI but synchronous:** smallest change, but a slow CLI call freezes the whole MCP server; this was the root defect motivating the rewrite. Rejected.
- **Hybrid (HTTP default, CLI fallback):** two transports to test and keep behaviorally identical, for a fallback scenario that may never occur. Rejected as overbuilt; can be revisited if token-based usage appears.

## Consequences

- Auth failures, rate limiting, and network retries are `gh`'s problem; this project maps its stderr into `CliError`.
- Error fidelity is limited to what `gh` prints; parsing raw output still requires zod validation at the provider boundary.
- `gh` becomes a hard runtime dependency for the github providers; startup should fail clearly when it is absent.
- Future providers with no capable CLI (e.g. Linear) will need this ADR revisited.

## Traceability

- Requirements: [RNF-ASY.1](../srs.md#rnf-asy1-no-blocking-calls), [RNF-ASY.2](../srs.md#rnf-asy2-timeouts), [RNF-SEC.1](../srs.md#rnf-sec1-no-string-interpolation-into-shell-or-graphql)
- Tracker: none

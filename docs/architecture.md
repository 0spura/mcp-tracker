# Architecture: mcp-tracker

> Stack: [docs/project.md](./project.md)
> Vision: [docs/product/vision.md](./product/vision.md)
> SRS: [docs/srs.md](./srs.md)

Full rewrite of `src/` preserving the external tool contract ([RNF-CMP.1](./srs.md#rnf-cmp1-stable-tool-contract)).

## Module map

```
src/
  index.ts               entry: stdio transport + createServer()
  server.ts              createServer: resolve provider bundle from env, register tools
  core/
    process.ts           run(): promisified execFile with timeout and typed errors (the only
                         place child_process is imported)
    errors.ts            TrackerError hierarchy: CliError, TimeoutError, ParseError,
                         ConfigError, UnsupportedError
  domain/
    types.ts             normalized shared types (Issue, PR, CheckRun, Label, Milestone,
                         ProjectItem, ProjectField); states are 'open' | 'closed' | 'merged'
    capabilities.ts      CodeProvider, IssueProvider, BoardProvider, MetadataProvider
                         interfaces; IssueProvider keeps optional checklist/relationship/
                         sub-issue methods
    checklist.ts         toggleChecklistItem markdown logic (single shared implementation)
  context/
    store.ts             ContextStore: session values + precedence resolution (async)
    config.ts            .mcp-tracker.json / .local loading, zod-validated, ConfigError on
                         invalid JSON
    git.ts               git derivation via core/process (repo from remote, issue from branch)
  providers/
    github/
      gh.ts              gh runner: REST (gh api) and GraphQL (gh api graphql -f query -F var)
                         built on core/process; raw responses validated with zod schemas
      code.ts            CodeProvider implementation + mappers to domain types
    github-projects/
      issues.ts          IssueProvider implementation
      boards.ts          BoardProvider implementation (paginates all items)
      metadata.ts        MetadataProvider implementation
      mappers.ts         raw → domain normalization (state casing, etc.)
    local/
      files.ts           markdown + frontmatter parse/serialize (symmetric escaping, rename
                         on title change)
      issues.ts          IssueProvider implementation
      metadata.ts        MetadataProvider; milestones → UnsupportedError
  tools/
    register.ts          registerTools(server, bundle, context): one registration function
                         per tool domain, each gated on bundle member presence
    context.ts  branches.ts  prs.ts  issues.ts  comments.ts  boards.ts  metadata.ts
test/
  contract/issue-provider.ts   shared IssueProvider contract suite
  helpers/fake-gh.ts           scripted GhRunner fake
```

## Provider composition

The central seam. Each provider module exports a factory returning a **bundle** — a plain object whose present members are the declared capabilities ([RF-PRV.2](./srs.md#rf-prv2-capability-based-tool-registration)):

```ts
interface ProviderBundle {
  code?: CodeProvider;
  issue?: IssueProvider;
  board?: BoardProvider;
  metadata?: MetadataProvider;
}
```

- `createGitHubProvider(gh)` → `{ code }`
- `createGitHubProjectsProvider(gh)` → `{ issue, board, metadata }`
- `createLocalProvider(dir)` → `{ issue, metadata }`

`server.ts` merges the code bundle (from `CODE_PROVIDER`) and the task bundle (from `TASK_PROVIDER`) and passes it to `registerTools`. Presence of a bundle member is static typing, not duck-typing; no classes, no `in` checks. A tool domain is registered only when its bundle member exists.

Sub-capabilities (checklist, sub-issues, relationships) remain optional methods on `IssueProvider`; registration of those tools checks for the method, as the SRS capability map requires.

## Integration patterns

**CLI execution (deep module).** `core/process.run(cmd, args, opts)` is the only import site of `child_process`. It takes an argument array (never a shell string), an optional stdin string, and a timeout (default 30s, ≤ 60s per [RNF-ASY.2](./srs.md#rnf-asy2-timeouts)), and returns stdout. Failures map to `CliError` (non-zero exit, carries stderr), `TimeoutError` (kill on deadline), never raw Node errors. Callers never see `execFile`.

**GitHub access.** `providers/github/gh.ts` exposes two functions over `run()`:

- `ghApi(path)` → REST via `gh api <path>`, output parsed by a zod schema supplied by the caller.
- `ghGraphQL(query, variables)` → variables travel as data, never interpolated into the query string ([RNF-SEC.1](./srs.md#rnf-sec1-no-string-interpolation-into-shell-or-graphql)). Scalar variables use `gh api graphql -f query=... -F key=value`; when any variable is a nested object or array (Projects V2 mutation `input` objects), the whole `{query, variables}` body is POSTed as JSON via `gh api graphql --input` on stdin.

Every raw response is validated by a caller-supplied zod schema; a mismatch raises `ParseError` naming the endpoint ([RNF-DOM.1](./srs.md#rnf-dom1-normalized-shared-types)). The `GhRunner` interface (`{ api, graphql }`) is injected into the provider factories; tests substitute a scripted fake fed by fixtures captured from real `gh` output — this is what makes the contract suite runnable without a network. An optional smoke test exercises the real `gh` when one is authenticated, and skips silently otherwise.

**Relationship mechanisms (github-projects).** `blocks`/`blocked_by` use the native issue-dependencies API (GA 2025-08): `addBlockedBy`/`removeBlockedBy` GraphQL mutations. `duplicate` posts a `Duplicate of #N` comment — a documented GitHub keyword that produces a native marked-as-duplicate timeline event. `related` posts a cross-reference comment. The tool response names the mechanism used ([RF-ISS.3](./srs.md#rf-iss3-checklist-sub-issues-relationships)).

**Pagination.** `boards.ts` follows `pageInfo.hasNextPage` until exhaustion; no fixed `first: 100` truncation ([RF-BRD.1](./srs.md#rf-brd1-board-tools-github-projects)).

**Local storage.** Markdown file per issue: YAML frontmatter (title, state, labels, assignees, milestone, relationships) + body + `## Comments` section. Serializer and parser are inverse functions covered by round-trip tests, including quotes in titles ([RF-PRV.3](./srs.md#rf-prv3-local-provider-storage)). Title change renames the file to keep the slug in sync. All writes go through a per-file async mutex and an atomic write (temp file + rename): genuine async reintroduces interleaving that the old synchronous code got for free, and two concurrent tool calls must never corrupt a file.

## Business rules

```
Rule: Context precedence | Source: RF-CTX.2
Given a value needed by a tool | When resolving | Then explicit argument wins over
session, session over config file, config over git derivation; each resolved value
knows its source for tracker_get_context.

Rule: Branch naming | Source: RF-BRN.1
Given create_branch with a resolvable issue | When the branch is created | Then the
name is <number>-<slug-of-title> and the branch is linked to the issue; without an
issue the caller's name is used verbatim. Existing linked branch → return it, no error.

Rule: PR body closes issue | Source: RF-PRS.1
Given an active issue | When create_pr builds the body | Then 'Closes #N' is appended
unless the body already references the issue.

Rule: Status mechanism is provider-internal | Source: RF-ISS.2
Given move_issue_status | When the provider applies it | Then github-projects writes the
board Status field (of the context board, never items[0]), local writes frontmatter; the
tool contract carries only the status string.

Rule: Automation failures are visible | Source: RF-BRN.1, RF-PRS.1
Given statusLabels configured | When a best-effort status automation fails | Then the
tool response includes a warnings array with the failure; success paths stay clean.

Rule: Partial failure keeps what succeeded | Source: RF-ISS.1
Given create_issue with board context | When the board add fails after the issue was
created | Then the response returns the created issue plus a warnings entry; the call
does not fail, because the issue already exists remotely.

Rule: Composite create and update | Source: RF-ISS.1, RF-PRS.1
Given a creation or update tool | When the caller passes the full desired state
(relationships, parent, status, board fields, closing issues, reviewer batches) | Then
the tool applies the primary change first and every secondary change best-effort,
collecting per-step failures into warnings; granular tools remain for incremental
changes, and no composite parameter replaces an existing one.

Rule: Unsupported is explicit | Source: RF-ISS.3, RF-MTD.1
Given a provider that cannot honor a field or concept | When called | Then it throws
UnsupportedError naming what is unsupported; silent degradation is a bug.
```

## Security model

- **Trust boundary 1 — MCP input:** zod schemas on every tool argument (SDK boundary). Unchanged from today.
- **Trust boundary 2 — subprocess:** argument arrays only; no shell is ever invoked. Hostile strings (quotes, `$()`, newlines) travel as data.
- **Trust boundary 3 — GraphQL:** variables via `-F` flags only.
- **Auth:** owned by `gh`. This project never reads, stores, or logs tokens. `gh` auth failures surface as `CliError` with stderr, which mentions `gh auth login` — acceptable to forward to the agent.
- **Local files:** the local provider reads/writes only inside `LOCAL_TASK_DIR`; paths are resolved and confined to that directory.

## Failure modes

| What fails | How | Agent sees | Recovery |
|---|---|---|---|
| `gh` missing/not authenticated | `CliError` on first call | stderr text (mentions auth) | `gh auth login`, retry |
| CLI hangs | killed at timeout | `TimeoutError` with cmd and deadline | retry; deadline is configurable |
| Malformed CLI/GraphQL output | zod mismatch | `ParseError` naming endpoint | bug report; no silent cast |
| Invalid `.mcp-tracker.json` | zod/JSON error at load | `ConfigError` with file path and issue | fix file |
| No resolvable issue for implicit-number tool | resolution chain exhausted | clear error "no active issue; pass number" | set context or pass number |
| Status automation fails | caught, collected | `warnings` field in response | manual status move |
| Unsupported capability called | — | tool not registered at all | choose a provider with the capability |

## Deployment

Single stdio process spawned by the MCP client. No services, no scaling. CI (to be added): typecheck + `npm test` + a grep check banning `execSync|execFileSync` in `src/` ([RNF-ASY.1](./srs.md#rnf-asy1-no-blocking-calls)).

## Deliberately not designed here

- GitLab providers: removed from the tree; the bundle seam is where they plug back in (ADR-002).
- Retry/rate-limit logic: `gh` already retries sensibly; revisit only if observed.

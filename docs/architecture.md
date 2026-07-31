# Architecture: mcp-tracker

> Stack: [docs/project.md](./project.md)
> Vision: [docs/product/vision.md](./product/vision.md)
> SRS: [docs/srs.md](./srs.md)

Full rewrite of `src/` preserving the external tool contract ([RNF-CMP.1](./srs.md#rnf-cmp1-stable-tool-contract)).

## Module map

Organized by domain, not by vendor (ADR-0002, ADR-0003). Each domain holds its interface, its implementations, and its tools.

```
src/
  index.ts               entry: stdio transport + createServer()
  server.ts              createServer: resolve provider bundle from env, register tools
  core/
    process.ts           run(): promisified execFile with timeout and typed errors (the only
                         place child_process is imported)
    errors.ts            TrackerError hierarchy: CliError, TimeoutError, ParseError,
                         ConfigError, UnsupportedError
  context/
    store.ts             ContextStore: session values + precedence resolution (async);
                         resolves Scope and validates bundle.requires
    config.ts            nested .mcp-tracker.json / .local schema, zod-validated,
                         ConfigError on invalid JSON
    git.ts               git derivation via core/process (repo from remote, item id from
                         branch: both 42 and PROJ-123 shapes)
  domain/
    types.ts             normalized shared types; identifiers are opaque strings (ItemId);
                         states are 'open' | 'closed' | 'merged'
    scope.ts             Scope { repo?, boardId? } and ScopeKey
    checklist.ts         toggleChecklistItem markdown logic (single shared implementation)
  domains/
    code/
      capabilities.ts    CodeProvider interface
      tools.ts           create_branch + PR tools (incl. get_pr_diff, submit_pr_review)
      github.ts          implementation over gh + mappers
    issues/
      capabilities.ts    IssueProvider interface (includes optional listLabels/
                         listMilestones and checklist/relationship/sub-issue methods)
      tools.ts           issue + metadata tools
      github-projects.ts implementation over gh + mappers
      local.ts           implementation over local/files.ts
    boards/
      capabilities.ts    BoardProvider interface
      tools.ts           board tools
      github-projects.ts implementation (paginates all items, caches field/option IDs)
      gitlab.ts          implementation over glab api (lists/labels as status)
    comments/
      tools.ts           comment tools (route to code or issue provider)
    local/
      files.ts           markdown + frontmatter parse/serialize (symmetric escaping, rename
                         on title change, per-file mutex, atomic write)
  transport/
    gh.ts                GhRunner: REST (gh api) and GraphQL (-F scalars, --input for
                         nested variables); raw responses validated with caller-supplied
                         zod schemas
    glab.ts              GlabRunner: REST (`glab api`) and GraphQL (`glab api graphql`)
                         with the same variable and validation patterns as gh.ts
test/
  contract/issue-provider.ts   shared IssueProvider contract suite
  helpers/fake-gh.ts           scripted GhRunner fake
  helpers/fake-glab.ts         scripted GlabRunner fake
```

## Provider composition

The central seam. Each provider factory returns a **bundle** — present members are the declared capabilities, and `requires` declares the scopes the provider needs ([RF-PRV.2](./srs.md#rf-prv2-capability-based-tool-registration), ADR-0003):

```ts
type ScopeKey = 'repo' | 'board';

interface ProviderBundle {
  requires: ScopeKey[];
  code?: CodeProvider;
  issue?: IssueProvider;
  board?: BoardProvider;
}
```

- `createGitHubCodeProvider(gh)` → `{ requires: ['repo'], code }`
- `createGitLabCodeProvider(glab)` → `{ requires: ['repo'], code }`
- `createGitHubProjectsIssueProvider(gh)` → `{ requires: ['repo'], issue, board }`
- `createGitLabIssueProvider(glab)` + `createGitLabBoardProvider(glab)` → `{ requires: ['repo'], issue, board }`
- `createLocalIssueProvider(dir)` → `{ requires: [], issue }`

`server.ts` merges the code bundle (from `CODE_PROVIDER`) and the task bundle (from `TASK_PROVIDER`) and passes it to `registerTools`. Presence of a bundle member is static typing, not duck-typing; no classes, no `in` checks. A tool domain is registered only when its bundle member exists; a tool errors clearly only when a required scope is unresolvable.

Sub-capabilities (checklist, sub-issues, relationships, labels, milestones) remain optional methods on `IssueProvider`; registration of those tools checks for the method. The same rule applies to `BoardProvider.addIssueToBoard`: only boards with explicit membership (GitHub Projects) implement it; GitLab boards show open issues implicitly and omit the method, so `add_issue_to_board` is not registered for them.

## Configuration

Nested schema, field-level deep merge of `.mcp-tracker.local.json` over `.mcp-tracker.json` ([RF-CTX.2](./srs.md#rf-ctx2-resolution-precedence)):

```json
{
  "codeProvider": "github",
  "taskProvider": "github-projects",
  "repo": "owner/repo",
  "boardId": "1",
  "defaults": {
    "baseBranch": "main", "mergeMethod": "squash",
    "reviewers": ["ana"], "assignee": "ana",
    "milestone": "Sprint 12", "labels": ["agent"]
  },
  "workflow": {
    "stages": [
      { "key": "design", "name": "In design" },
      { "key": "doing",  "name": "Doing" },
      { "key": "review", "name": "In Review" },
      { "key": "done",   "name": "Done" }
    ],
    "on": { "createIssue": "design", "createBranch": "doing", "createPr": "review" }
  }
}
```

- A stage is `{key, name}` or `{key, name, id}`. Name-based stages are resolved to native option IDs once per session and cached by the board provider; explicit `id` skips resolution. Magic strings in code are forbidden — automations read `workflow.on`.
- `codeProvider`, `taskProvider`, and `localTaskDir` may be set in the config file and take precedence over the env vars, so one user-level install behaves per project ([RF-PRV.1](./srs.md#rf-prv1-provider-selection)).
- `activeIssue` is valid only in `.mcp-tracker.local.json` (state, not config).
- The flat legacy config (`defaultBase`, `statusLabels`) was never documented and has no alias; the tool parameter surface (`tracker_set_context`) is unchanged. GitLab status moves use `workflow.stages` (`id` or `name`) as mutually-exclusive labels.

## Integration patterns

**CLI execution (deep module).** `core/process.run(cmd, args, opts)` is the only import site of `child_process`. It takes an argument array (never a shell string), an optional stdin string, and a timeout (default 30s, ≤ 60s per [RNF-ASY.2](./srs.md#rnf-asy2-timeouts)), and returns stdout. Failures map to `CliError` (non-zero exit, carries stderr), `TimeoutError` (kill on deadline), never raw Node errors. Callers never see `execFile`.

**GitHub access.** `transport/gh.ts` exposes two functions over `run()`:

- `ghApi(path)` → REST via `gh api <path>`, output parsed by a zod schema supplied by the caller.
- `ghGraphQL(query, variables)` → variables travel as data, never interpolated into the query string ([RNF-SEC.1](./srs.md#rnf-sec1-no-string-interpolation-into-shell-or-graphql)). Scalar variables use `gh api graphql -f query=... -F key=value`; when any variable is a nested object or array (Projects V2 mutation `input` objects), the whole `{query, variables}` body is POSTed as JSON via `gh api graphql --input` on stdin.

Every raw response is validated by a caller-supplied zod schema; a mismatch raises `ParseError` naming the endpoint ([RNF-DOM.1](./srs.md#rnf-dom1-normalized-shared-types)). The `GhRunner` and `GlabRunner` interfaces are injected into the provider factories; tests substitute a scripted fake fed by fixtures captured from real CLI output — this is what makes the contract suite runnable without a network. Optional smoke tests exercise the real `gh`/`glab` when one is authenticated, and skip silently otherwise.

**GitLab access.** `transport/glab.ts` mirrors `gh.ts`: REST via `glab api <path>` with `--method` and `--raw-field key=value`; GraphQL via `glab api graphql -f query=... -F key=value` for scalars and `--input` on stdin for nested variables. Array fields are sent as repeated `--raw-field key[]=value` flags. Auth is owned by `glab`; this project never reads, stores, or logs tokens.

**Relationship mechanisms (github-projects).** `blocks`/`blocked_by` use the native issue-dependencies API (GA 2025-08): `addBlockedBy`/`removeBlockedBy` GraphQL mutations. `duplicate` posts a `Duplicate of #N` comment — a documented GitHub keyword that produces a native marked-as-duplicate timeline event. `related` posts a cross-reference comment. The tool response names the mechanism used ([RF-ISS.3](./srs.md#rf-iss3-checklist-sub-issues-relationships)).

**Relationship mechanisms (gitlab).** All relationship types create native GitLab issue links via the REST API. GitLab CE only supports `relates_to`, so `blocks`/`blocked_by`/`related`/`duplicate` degrade to `relates_to` links; the tool still reports `native` because issue links are a native GitLab mechanism. Sub-issues use the GraphQL work item hierarchy widget.

**Pagination.** `domains/boards/github-projects.ts` follows `pageInfo.hasNextPage` until exhaustion; no fixed `first: 100` truncation ([RF-BRD.1](./srs.md#rf-brd1-board-tools-github-projects)).

**PR review (github).** `get_pr_diff` runs `gh pr diff <n>` and truncates to a bounded size, reporting truncation. `submit_pr_review` POSTs `/repos/{owner}/{repo}/pulls/{n}/reviews` via `gh api --input` with `{event, body, comments[]}`; inline comments use `{path, line, side}` positions taken from the diff ([RF-PRS.2](./srs.md#rf-prs2-pr-review-tools)).

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
Given workflow.on maps an event to a stage | When a best-effort status automation
fails | Then the tool response includes a warnings array with the failure; success
paths stay clean.

Rule: Workflow stages are ordered and configured | Source: RF-CTX.2
Given workflow.stages and workflow.on | When create_issue, create_branch,
create_pr, merge_pr, or an approving submit_pr_review runs | Then the item
moves to the stage key configured for that event (e.g. new issues land in
'design'), resolved by name-with-cache or explicit id; no stage string is
hardcoded.

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

- Retry/rate-limit logic: `gh` and `glab` already retry sensibly; revisit only if observed.

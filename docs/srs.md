# SRS: mcp-tracker

> Vision: [docs/product/vision.md](./product/vision.md)

Actors: the **agent** (MCP client, e.g. Claude Code) and the **developer** who configures the server via environment variables. The agent is the caller of every tool; observable behavior below is defined at the MCP tool boundary.

# 1. Functional Requirements

## RF-CTX: Session context

### RF-CTX.1: Set and read session context
**Priority:** Must Have | **Status:** Accepted | **Dependencies:** none
* `tracker_set_context` accepts `repo`, `board_id`, `active_issue`, `default_base`, `default_reviewers`, `default_merge_method`, `default_assignee`, `default_milestone`; omitted fields keep their current value.
* Setting `active_issue` to `null` clears it.
* `tracker_get_context` returns every resolved value with its source (`explicit`, `session`, `config`, `derived`).

### RF-CTX.2: Resolution precedence
**Priority:** Must Have | **Status:** Accepted | **Dependencies:** none
* Every context value resolves in this order: explicit tool argument > session value > config file > git derivation.
* Config is read from `.mcp-tracker.json` (versioned) with field-level overrides from `.mcp-tracker.local.json` (gitignored). The schema is nested: top-level `repo`, `boardId`; `defaults` (`baseBranch`, `mergeMethod`, `reviewers`, `assignee`, `milestone`, `labels`); `workflow` with an ordered `stages` list (`{key, name}` or `{key, name, id}`) and `on` automation triggers (`createIssue`, `createBranch`, `createPr`) referencing stage keys. `activeIssue` is valid only in `.mcp-tracker.local.json`.
* A stage value given as a name is resolved to the provider's native option ID once per session and cached; a stage given with an explicit `id` skips resolution.
* An invalid JSON config file produces a clear error in the tool response, not silent ignore.

### RF-CTX.3: Git derivation
**Priority:** Must Have | **Status:** Accepted | **Dependencies:** none
* When `repo` is not set anywhere, it is derived from `git remote get-url origin` (SSH and HTTPS forms, with or without `.git`).
* When `active_issue` is not set anywhere, it is derived from the current branch name matching `(?:feat|fix|chore|...)/<number>-...`.
* Derivation failures (no remote, no branch match) resolve to "unset" without error.

## RF-PRV: Provider model

### RF-PRV.1: Provider selection
**Priority:** Must Have | **Status:** Accepted | **Dependencies:** none
* Providers are selected with precedence: project config file (`.mcp-tracker.json` fields `codeProvider`, `taskProvider`, `localTaskDir`) > environment (`CODE_PROVIDER`, `TASK_PROVIDER`, `LOCAL_TASK_DIR`) > defaults (`CODE_PROVIDER` = `github`; no task provider).
* `TASK_PROVIDER` accepts `github-projects` and `local`; when unset everywhere, issue, comment, board, and metadata tools are not registered.
* `TRACKER_PROVIDER` remains accepted as a backwards-compatible alias for `CODE_PROVIDER` (env only).
* An unknown provider value fails server startup with an error naming the valid values.

### RF-PRV.2: Capability-based tool registration
**Priority:** Must Have | **Status:** Accepted | **Dependencies:** RF-PRV.1
* A provider bundle declares its capabilities by member presence (`code`, `issue`, `board`) plus the scopes it requires (`requires: ('repo' | 'board')[]`); tools are registered only for declared capabilities, and a tool fails with a clear error only when a scope its provider requires is unresolvable.
* Labels and milestones are optional sub-capability methods on the issue provider, not a separate capability.
* Capability map: `github` = code (requires repo); `github-projects` = issue + board + checklist + sub-issues + relationships (requires repo; board tools also require board); `local` = issue + checklist + relationships (requires no scope).
* Tools for an undeclared capability are absent from the tool list (not registered-and-failing).

### RF-PRV.3: Local provider storage
**Priority:** Must Have | **Status:** Accepted | **Dependencies:** RF-PRV.1
* `local` stores issues as markdown files with frontmatter in `LOCAL_TASK_DIR` (default `.tasks`).
* Renaming an issue title renames the file so the slug stays in sync.
* Titles containing double quotes round-trip unchanged through write and read.

## RF-BRN: Branches

### RF-BRN.1: Create branch
**Priority:** Must Have | **Status:** Accepted | **Dependencies:** RF-CTX.2
* `create_branch` creates a branch off the repo's default branch.
* With `issue_number` (or derived `active_issue`), the branch is linked to the issue and named `<number>-<slug>`; without it, the given name is used verbatim.
* Creating an already-existing linked branch returns the existing branch instead of failing (idempotent).
* When `statusLabels.doing` is configured, the issue status moves to that label; automation failures surface as a warning field in the response, never silently.

## RF-PRS: Pull requests

### RF-PRS.1: PR lifecycle tools
**Priority:** Must Have | **Status:** Accepted | **Dependencies:** RF-CTX.2
* `create_pr`, `update_pr`, `get_pr`, `list_prs`, `get_pr_checks`, `merge_pr` behave as documented in the README.
* `create_pr` applies `default_base` and `default_reviewers` from context, and injects `Closes #N` into the body when an active issue exists and the body lacks it.
* `create_pr` accepts an optional `issues` list; each becomes a closing keyword line (`Closes #N`) in the body, covering multiple issues in one call.
* `update_pr` is the generic PR edit tool: it accepts title, body, state (close/reopen), draft/ready, labels, milestone, and batch reviewer and assignee changes (`add_reviewers`, `remove_reviewers`, `add_assignees`, `remove_assignees`) in one call.

### RF-PRS.2: PR review tools
**Priority:** Should Have | **Status:** Accepted | **Dependencies:** RF-PRS.1
* `get_pr_diff` returns the PR's diff as the reviewer would see it remotely, truncated to a bounded size with the truncation reported.
* `submit_pr_review` submits a review with an event (`approve`, `request_changes`, `comment`), a body, and optional inline comments referencing `{path, line}` positions from the diff returned by `get_pr_diff`.
* Inline comment positions refer to the remote diff; comments that cannot be positioned produce a `warnings` entry while the rest of the review is submitted.
* `merge_pr` applies `default_merge_method` from context; the method is validated against `merge | squash | rebase` before the provider call.
* When `statusLabels.review` is configured, `create_pr` moves the active issue to that status; failures surface as warnings.
* `get_pr_checks` truncates long check logs to a bounded tail (never returns unbounded output).

## RF-ISS: Issues

### RF-ISS.1: Issue CRUD
**Priority:** Must Have | **Status:** Accepted | **Dependencies:** RF-CTX.3
* `list_issues`, `create_issue`, `get_issue`, `update_issue` behave as documented; `get_issue`/`update_issue` use the resolved active issue when `number` is omitted and error clearly when no issue is resolvable.
* `create_issue` auto-adds the issue to the board when `board_id` is in context.
* `create_issue` accepts the full desired initial state in one call: optional `blocks`, `blocked_by`, `related` (issue number lists), `duplicate_of`, `parent` (creates as sub-issue), `status` (initial board column), and `fields` (board field values). Post-creation steps (board add, fields, relationships, status) are best-effort; each failure adds a `warnings` entry and never fails the call.
* `update_issue` supports title, body, labels, assignees, and state; it also accepts batch relationship operations (`add_blocks`, `remove_blocks`, `add_blocked_by`, `remove_blocked_by`, `add_related`, `remove_related`, `duplicate_of`) applied in the same call, with per-operation failures reported in `warnings`.
* If the board add fails after the issue was created, the tool returns the created issue with a `warnings` entry describing the failure; it does not fail the whole call.
* `update_issue`: a provider that cannot honor a field returns an explicit error instead of silently dropping it.

### RF-ISS.2: Issue status
**Priority:** Must Have | **Status:** Accepted | **Dependencies:** RF-CTX.1
* `move_issue_status` sets the issue status; the status mechanism (board field, label set, frontmatter) is the provider's internal concern and is invisible in the tool contract.
* When a `board_id` is in context, the status change targets that board, never an arbitrary first board.

### RF-ISS.3: Checklist, sub-issues, relationships
**Priority:** Should Have | **Status:** Accepted | **Dependencies:** RF-PRV.2
* `toggle_checklist_item` marks/unmarks a checklist item matched by partial text; the matching logic lives in one shared place.
* `add_sub_issue` / `list_sub_issues` are registered only for providers declaring sub-issues (github-projects).
* `set_issue_relationship` supports blocks/blocked_by/related/duplicate. Mechanism per type on github-projects: blocks/blocked_by use the native issue-dependencies API (GA 2025-08); `duplicate` posts a `Duplicate of #N` comment (documented GitHub keyword); `related` posts a cross-reference comment. The tool response names the mechanism used.
* A provider with no mechanism for a relationship type returns an explicit error instead of degrading silently.

## RF-CMT: Comments

### RF-CMT.1: Comment tools
**Priority:** Must Have | **Status:** Accepted | **Dependencies:** RF-CTX.3
* `add_issue_comment`, `add_pr_comment`, `list_comments` (issue or PR target) behave as documented; issue comments route to the task provider, PR comments to the code provider.

## RF-BRD: Board

### RF-BRD.1: Board tools (github-projects)
**Priority:** Should Have | **Status:** Accepted | **Dependencies:** RF-CTX.1, RF-PRV.2
* `list_board_items`, `list_board_fields`, `add_issue_to_board`, `set_item_fields` behave as documented and are registered only when the task provider declares the board capability.
* Board item listing paginates through all items; results are never silently truncated at a fixed page size.

## RF-MTD: Metadata

### RF-MTD.1: Labels and milestones
**Priority:** Could Have | **Status:** Accepted | **Dependencies:** RF-PRV.2
* `list_labels` and `list_milestones` are registered when the issue provider implements the corresponding optional method.
* A provider without a real milestone concept returns an explicit "not supported" error instead of fabricated entries.

# 2. Non-Functional Requirements

## RNF-ASY: Asynchrony

### RNF-ASY.1: No blocking calls
**Priority:** Must Have | **Status:** Accepted | **Dependencies:** none
* No synchronous process execution (`execFileSync`, `execSync`) anywhere in `src/`; verifiable by a lint/grep check in CI or a test.
* One hung or slow CLI call does not block other tool calls (concurrent tool invocation completes while another is in flight).

### RNF-ASY.2: Timeouts
**Priority:** Should Have | **Status:** Accepted | **Dependencies:** RNF-ASY.1
* Every subprocess call has a timeout (default ≤ 60s) and surfaces a timeout error distinct from a CLI failure.

## RNF-SEC: Command and query safety

### RNF-SEC.1: No string interpolation into shell or GraphQL
**Priority:** Must Have | **Status:** Accepted | **Dependencies:** none
* Subprocess invocation uses argument arrays only; GraphQL uses variables only; verifiable by code review plus a test passing hostile strings (quotes, `$()`, newlines) through every input-accepting tool without injection.

## RNF-DOM: Domain normalization

### RNF-DOM.1: Normalized shared types
**Priority:** Must Have | **Status:** Accepted | **Dependencies:** none
* `Issue.state` and `PR.state` are `open | closed | merged` (as applicable) regardless of provider casing; verifiable in the contract test suite.
* Provider raw responses are validated (not blind-cast) at the provider boundary; malformed CLI output yields a descriptive error.

## RNF-TST: Testing

### RNF-TST.1: Contract test suite
**Priority:** Must Have | **Status:** Accepted | **Dependencies:** none
* One shared test suite encodes the `IssueProvider` contract and runs against every implementation (github-projects with mocked transport, local with a temp dir).
* `npm test` runs the suite plus typecheck.

## RNF-CMP: External compatibility

### RNF-CMP.1: Stable tool contract
**Priority:** Must Have | **Status:** Accepted | **Dependencies:** none
* Tool names, parameter names, and README-documented behaviors are unchanged by the rewrite; verifiable by a snapshot test of the registered tool list against the README table.
* Additive extensions approved 2026-07-30 (composite create/update parameters on issue and PR tools) do not violate this requirement: existing parameters keep their names and semantics.

# 3. Glossary

**Capability**: a named interface a provider may implement (code, issue, board, metadata) plus optional sub-capabilities (checklist, sub-issues, relationships).
**Context**: the per-session set of resolved values (repo, board, active issue, defaults) with explicit > session > config > derived precedence.
**Local provider**: task provider storing issues as markdown files on disk, requiring no external account.

# 4. References

- [docs/product/vision.md](./product/vision.md) — approved redesign decisions (2026-07-30)
- [README.md](../../README.md) — external tool contract being preserved

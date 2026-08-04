# SRS: mcp-tracker

> Vision: [docs/product/vision.md](./product/vision.md)

Actors: the **agent** (MCP client, e.g. Claude Code) and the **developer** who configures the server via environment variables. The agent is the caller of every tool; observable behavior below is defined at the MCP tool boundary.

# 1. Functional Requirements

## RF-CTX: Configuration and scope

### RF-CTX.1: Project configuration
**Priority:** Must Have | **Status:** Accepted | **Dependencies:** none
* Repository, board, defaults, providers, and workflow are configured per project; tools accept explicit overrides where applicable.
* Issue-targeting tools require an explicit issue number. Mutable session context is not exposed.

### RF-CTX.2: Resolution precedence
**Priority:** Must Have | **Status:** Accepted | **Dependencies:** none
* Values resolve in this order: explicit tool argument > config file > git derivation.
* Config is read from `.mcp-tracker.json` (versioned) with field-level overrides from `.mcp-tracker.local.json` (gitignored). The schema is nested: top-level `repo`, `boardId`; `defaults` (`baseBranch`, `mergeMethod`, `deleteBranchOnMerge`, `reviewers`, `assignee`, `milestone`, `labels`); `workflow` with ordered `stages` and `on` automation triggers.
* `create_issue` accepts the provider's native issue type through `type`.
* GitHub issue creation and update accept `issue_fields`, a name/value map for organization-level Issue Fields. The existing `fields` parameter remains scoped to Project V2 fields.
* Native issue types, labels, open milestones, and board fields are loaded once at startup and exposed in tool schemas.
* `defaults` fields merge with the local file winning per field, except `labels`, which concatenates versioned + local with dedupe: project labels stay in the versioned file, personal labels (team, own scope) in the gitignored local one, and issues get both.
* A stage value given as a name is resolved to the provider's native option ID once per server process and cached; an explicit `id` skips resolution.
* An invalid JSON config file produces a clear error in the tool response, not silent ignore.

### RF-CTX.3: Git derivation
**Priority:** Must Have | **Status:** Accepted | **Dependencies:** none
* When `repo` is not set anywhere, it is derived from `git remote get-url origin` (SSH and HTTPS forms, with or without `.git`).
* Repository derivation failure resolves to "unset" without error.

## RF-PRV: Provider model

### RF-PRV.1: Provider selection
**Priority:** Must Have | **Status:** Accepted | **Dependencies:** none
* Providers are selected with precedence: project config file (`.mcp-tracker.json` fields `codeProvider`, `taskProvider`, `localTaskDir`) > environment (`CODE_PROVIDER`, `TASK_PROVIDER`, `LOCAL_TASK_DIR`) > defaults (`CODE_PROVIDER` = `github`; no task provider).
* `CODE_PROVIDER` accepts `github` and `gitlab`.
* `TASK_PROVIDER` accepts `github-projects`, `gitlab`, and `local`; when unset everywhere, issue, comment, board, and metadata tools are not registered.
* `TRACKER_PROVIDER` remains accepted as a backwards-compatible alias for `CODE_PROVIDER` (env only).
* An unknown provider value fails server startup with an error naming the valid values.

### RF-PRV.2: Capability-based tool registration
**Priority:** Must Have | **Status:** Accepted | **Dependencies:** RF-PRV.1
* A provider bundle declares its capabilities by member presence (`code`, `issue`, `board`) plus the scopes it requires (`requires: ('repo' | 'board')[]`); tools are registered only for declared capabilities, and a tool fails with a clear error only when a scope its provider requires is unresolvable.
* Labels and milestones are optional sub-capability methods on the issue provider, not a separate capability.
* Capability map:
  * `github` = code (requires repo).
  * `gitlab` = code (requires repo).
  * `github-projects` = issue + board integration + checklist + sub-issues + relationships (requires repo).
  * `gitlab` = issue + board integration + checklist + sub-issues + relationships + labels + milestones + time tracking + attachments + related-issue/MR reads (requires repo).
  * `local` = issue + checklist + relationships + labels (requires no scope); milestones are explicitly unsupported.
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
* `issue_number` is required; the provider reads the title internally and creates `<number>-<slug>` without exposing a branch-name argument.
* Creating an already-existing linked branch returns the existing branch instead of failing (idempotent).
* When `statusLabels.doing` is configured, the issue status moves to that label; automation failures surface as a warning field in the response, never silently.

## RF-PRS: Pull requests

### RF-PRS.1: PR lifecycle tools
**Priority:** Must Have | **Status:** Accepted | **Dependencies:** RF-CTX.2
* `create_pr`, `update_pr`, `get_pr`, `list_prs`, `get_pr_checks`, `merge_pr` behave as documented in the README.
* `create_pr` applies configured `baseBranch` and `reviewers` and requires a non-empty `issues` list; each issue becomes a closing keyword line (`Closes #N`).
* `create_pr` accepts `attachments` (local file paths, uploaded via the task provider's `attachFile` and appended to the body); a call with attachments when no task provider is configured throws `UnsupportedError`.
* `update_pr` is the generic PR edit tool: it accepts title, body, state (close/reopen), draft/ready, labels, milestone, and batch reviewer and assignee changes (`add_reviewers`, `remove_reviewers`, `add_assignees`, `remove_assignees`) in one call.

### RF-PRS.2: PR review tools
**Priority:** Should Have | **Status:** Accepted | **Dependencies:** RF-PRS.1
* `get_pr_diff` returns the PR's diff as the reviewer would see it remotely, truncated to a bounded size with the truncation reported.
* `submit_pr_review` requires issue numbers and moves those issues through `workflow.on.reviewApproved` after approval.
* Inline comment positions refer to the remote diff; comments that cannot be positioned produce a `warnings` entry while the rest of the review is submitted.
* `merge_pr` requires issue numbers and moves those issues through `workflow.on.mergePr` after merge.
* `merge_pr` applies configured `deleteBranchOnMerge` (or explicit `delete_branch`) after a successful merge. A deletion failure surfaces as a warning and never fails the completed merge.
* `get_pr_checks` truncates long check logs to a bounded tail (never returns unbounded output).

## RF-ISS: Issues

### RF-ISS.1: Issue CRUD
**Priority:** Must Have | **Status:** Accepted | **Dependencies:** RF-CTX.3
* `list_issues` returns bounded summaries without bodies. `get_issue` returns the selected full item; issue reads and mutations require `number`.
* `create_issue` auto-adds the issue to the configured board.
* `create_issue` accepts relationships, parent, board fields, and attachments in one call. Initial status comes only from `workflow.on.createIssue`. Secondary failures are returned as warnings.
* `update_issue` consolidates metadata, attachments, relationships, parent assignment, and board fields. It adds the issue to an explicit-membership board when fields are supplied and membership is missing.
* The milestone title `"$current"` (config default or tool argument) resolves to the active/open milestone with the nearest upcoming due date; undated and past-due milestones are skipped and the call errors clearly when none qualifies.
* The assignee (or PR reviewer/assignee) username `"$current"` resolves to the authenticated account (GitLab `GET user`, GitHub `GET /user`), resolved once per provider instance and cached. Not resolved by the `local` provider, which has no authenticated account; `"$current"` there is stored as a literal string.
* If the board add fails after the issue was created, the tool returns the created issue with a `warnings` entry describing the failure; it does not fail the whole call.
* `update_issue`: a provider that cannot honor a field returns an explicit error instead of silently dropping it.

### RF-ISS.2: Issue status
**Priority:** Must Have | **Status:** Accepted | **Dependencies:** RF-CTX.1
* Status transitions are driven by configured workflow events during create, branch, PR, review, and merge operations.

### RF-ISS.3: Checklist, sub-issues, relationships
**Priority:** Should Have | **Status:** Accepted | **Dependencies:** RF-PRV.2
* `toggle_checklist_item` marks/unmarks a checklist item matched by partial text; the matching logic lives in one shared place.
* `update_issue.parent` assigns a parent; `list_sub_issues` reads children when supported.
* Relationship mutations are consolidated in `create_issue` and `update_issue`.
* A provider with no mechanism for a relationship type returns an explicit error instead of degrading silently.

## RF-CMT: Comments

### RF-CMT.1: Comment tools
**Priority:** Must Have | **Status:** Accepted | **Dependencies:** RF-CTX.3
* `add_issue_comment`, `add_pr_comment`, `list_comments` (issue or PR target) behave as documented; issue comments route to the task provider, PR comments to the code provider.
* `add_issue_comment` and `add_pr_comment` accept `attachments` (local file paths); each is uploaded via the task provider's `attachFile` (project-scoped, not issue-scoped, so it applies to PR comments too) and its markdown link is appended to the comment body before posting.

## RF-BRD: Board

### RF-BRD.1: Board integration
**Priority:** Should Have | **Status:** Accepted | **Dependencies:** RF-CTX.1, RF-PRV.2
* Board fields are loaded at startup and exposed in issue tool schemas.
* `create_issue` and `update_issue` own board membership and field updates; no standalone board tools are exposed.

## RF-MTD: Metadata

### RF-MTD.1: Labels and milestones
**Priority:** Could Have | **Status:** Accepted | **Dependencies:** RF-PRV.2
* Labels and open milestones are startup metadata, not standalone tools.
* A provider without a real milestone concept returns an explicit "not supported" error instead of fabricated entries.

### RF-MTD.2: Time tracking, attachments, and related-item reads (GitLab only)
**Priority:** Could Have | **Status:** Accepted | **Dependencies:** RF-PRV.2
* `log_time` logs spent and/or estimated time on an issue via GitLab's native time-tracking endpoints (`add_spent_time`, `time_estimate`), each call independent and best-effort with failures collected into `warnings`. Not implemented for GitHub, which has no native time tracking; the tool is absent for that provider.
* Attachments are accepted directly by create, update, and comment tools; no standalone upload tool is exposed.
* `list_linked_items` reads issues and/or merge requests linked to an issue (GitLab's `/links` and `/related_merge_requests` endpoints), filtered by a `type` argument (`issues` | `prs` | `all`, default `all`) so the two link kinds share one tool instead of two. Not implemented for GitHub in this pass; a reliable equivalent needs GraphQL timeline-event parsing, left as a documented gap rather than a partial implementation.
* These tools are absent from the tool list for providers that don't implement the underlying capability, consistent with RF-PRV.2's "tools for an undeclared capability are absent" rule — never registered-and-failing.

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
**Context**: project configuration and derived repository scope, with explicit > config > derived precedence.
**Local provider**: task provider storing issues as markdown files on disk, requiring no external account.

# 4. References

- [docs/product/vision.md](./product/vision.md) — approved redesign decisions (2026-07-30)
- [README.md](../../README.md) — external tool contract being preserved

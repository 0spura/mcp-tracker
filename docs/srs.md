# SRS: workctl v0

> Vision: [docs/product/vision.md](./product/vision.md)
> Architecture: [docs/architecture.md](./architecture.md)

Actors: a developer or coding agent running `workctl` locally. Observable behavior is defined at the CLI boundary: arguments, stdout, stderr, exit code, and remote GitHub issue state.

## 1. Functional requirements

### RF-CLI.1: Command surface
**Priority:** Must Have | **Status:** Implemented | **Dependencies:** none

- Command groups: `workctl issue create|list|show|edit` and `workctl pr create|list|show|diff|checks|review|merge|update|ready|close|reopen`.
- `--repo OWNER/REPO`, `--provider`, and `--format json|text` are global overrides accepted before or after the group.
- Help and version work without `git` or `gh` installed.
- Every flag carries a help description, and each subcommand prints usage examples for the behavior a caller cannot infer from flag names — for `issue edit` and `pr update`, the body-change set and the exact-match patch contract; for `pr list`, filter composition; for `pr merge`, when an explicit method is required.
- There is no delete command for issues or pull requests in v0.

**Acceptance:** `workctl issue --help` lists exactly the four supported issue subcommands and `workctl pr --help` lists exactly the eleven supported pull request subcommands; invoking an unknown command produces a structured JSON error on stderr and a nonzero exit. No flag in any subcommand help is printed without a description, and `workctl issue edit --help` documents the `patch_conflict` failure and exact-context matching.
**Verification:** CLI integration test.

### RF-WI.1: Create an issue
**Priority:** Must Have | **Status:** Implemented | **Dependencies:** RF-CFG.1, RF-PRV.1

- `create` requires a nonblank title and accepts an optional body from `--body` or `--body-file FILE`, where `-` reads standard input.
- `--attach FILE[#ALT]` may be repeated to upload files with optional alt text; every path must be an existing regular file.
- The command returns the created issue's number, title, body, state, URL, and timestamps.
- Missing body creates an issue with an empty body; no interactive prompt is opened.

**Acceptance:** A create request with a title and multiline body creates one GitHub issue; the returned JSON represents the provider response. Missing/blank title, a missing attachment file, and `--body` combined with `--body-file` fail before invoking `gh`. A request with attachments uploads them through the `gh issue` command and still returns the created issue.
**Verification:** Integration test with an isolated `gh` fixture, a payload-safety test, and an attachment-routing test.

### RF-WI.2: List issues
**Priority:** Must Have | **Status:** Implemented | **Dependencies:** RF-CFG.1, RF-PRV.1

- `list` returns summaries without issue bodies and never includes pull requests.
- State filter is `open`, `closed`, or `all`; default is `open`.
- `--limit` defaults to 30, accepts 1–1000, and bounds the number of returned issues.
- Filters pass through as fixed flags: `--label` (repeatable), `--assignee`, `--author`, `--mention`, `--milestone`, `--search`, and `--type`. Blank filter or label values are rejected; no raw provider arguments can be injected.

**Acceptance:** The output contains at most the requested limit, contains only issues, and omits body fields. Invalid state/limit values and blank filters fail before invoking `gh`; supplied filters appear in the provider invocation.
**Verification:** Integration tests for filters, bound edges, summary shape, and filter arguments.

### RF-WI.3: Show an issue
**Priority:** Must Have | **Status:** Implemented | **Dependencies:** RF-CFG.1, RF-PRV.1

- `show NUMBER` returns the selected issue with its body and normalized `open|closed` state.
- `NUMBER` must be a positive integer; a pull request number is not accepted as an issue.

**Acceptance:** Valid issue details are returned; zero, malformed identifiers, missing issues, and pull requests produce structured errors without leaking provider stderr.
**Verification:** Integration tests with provider fixtures.

### RF-WI.4: Edit an issue
**Priority:** Must Have | **Status:** Implemented | **Dependencies:** RF-CFG.1, RF-PRV.1

- `edit NUMBER` accepts a title change, one body change, attachments, or any combination; at least one change is required.
- Body changes never require the caller to reproduce the whole body: `--body`/`--body-file` replaces it, `--append-body`/`--append-body-file` appends, `--replace-section HEADING` with `--section-body`/`--section-body-file` replaces one ATX section, and `--patch-file` applies a unified diff.
- `--patch-file` applies hunks by exact context match. Unmatched context is a `patch_conflict` error and no PATCH is sent; line numbers are not trusted. Body text from a file or stdin is UTF-8 and capped at 1 MiB.
- At most one body-change flag may be supplied, and `--replace-section` requires its section body. Violations fail before invoking `gh`.
- `--attach FILE[#ALT]` may be repeated; the write goes through the `gh issue` command and the updated issue is returned.
- `--expect-updated-at TIMESTAMP` fails with `conflict` when the fetched issue's `updated_at` differs, before any PATCH.
- An omitted field remains unchanged. An explicitly empty body clears the body; a blank title is rejected.

**Acceptance:** Editing only the title preserves body; `--body ""` clears it; append, section replacement, and patch produce exactly the expected body in the PATCH payload while the issue is fetched once; a non-applying patch and a stale `--expect-updated-at` produce `patch_conflict`/`conflict` with no PATCH; no-field, blank-title, conflicting, and incomplete body-change requests fail before `gh`; pull-request numbers fail before any PATCH.
**Verification:** Integration tests for partial updates, body clearing, each body change, the concurrency guard, and attachment routing; unit tests for the body and patch policies.

### RF-PR.1: Create a pull request
**Priority:** Must Have | **Status:** Implemented | **Dependencies:** RF-CFG.1, RF-CFG.2

- `pr create` requires a nonblank `--title` and accepts an optional body from `--body` or `--body-file FILE`, where `-` reads standard input.
- `--base`, `--head`, and `--draft` select the merge target, source branch, and draft state; `gh` defaults apply when the branch flags are omitted.
- `--closes NUMBER` may be repeated and appends one `Closes #NUMBER` line per issue as a trailing block of the body; numbers must be positive.
- The command takes no attachments and returns the created pull request as a full record (see RNF-DOM.1).
- Errors: `invalid_input` for a blank title, `--body` combined with `--body-file`, or unreadable/oversized/non-UTF-8 body text; `github_cli` when the `gh pr create` call fails; `provider_response` when the created URL has no pull request number.

**Acceptance:** A create request with title, body, `--closes 7 --closes 9`, `--base`, `--head`, and `--draft` calls `gh pr create` with the body on stdin and returns the created pull request; the body carries the appended `Closes` lines. A blank title or `--body` combined with `--body-file` fails with `invalid_input` before invoking `gh`.
**Verification:** Integration test `create_sends_the_body_and_flags_to_gh`.

### RF-PR.2: List pull requests
**Priority:** Must Have | **Status:** Implemented | **Dependencies:** RF-CFG.1, RF-CFG.2

- `pr list` returns summaries without bodies, truncated to the requested limit.
- `--state open|closed|merged|all` defaults to `open`; `--limit` defaults to 30 and accepts 1–1000.
- Filters pass through as fixed flags: `--label` (repeatable), `--assignee`, `--author`, `--base`, `--head`, `--search`, and `--draft`. Blank filter or label values are rejected; no raw provider arguments can be injected.
- Each summary carries number, title, normalized `open|closed|merged` state, draft flag, URL, base ref, head ref, and `updated_at`.
- Errors: `invalid_input` for blank filter or label values; `github_cli` when the `gh pr list` call fails; `provider_response` for malformed summaries. Invalid `--state`/`--limit` values are usage errors.

**Acceptance:** The output contains at most the requested limit and omits body fields; supplied filters appear in the `gh pr list` invocation; blank filters and invalid state/limit values fail before invoking `gh`.
**Verification:** Integration test `list_forwards_filters_and_normalizes_summaries`.

### RF-PR.3: Show a pull request
**Priority:** Must Have | **Status:** Implemented | **Dependencies:** RF-CFG.1, RF-CFG.2

- `pr show NUMBER` returns the selected pull request with its body and normalized `open|closed|merged` state.
- `NUMBER` must be a positive integer; a number that is not a pull request is rejected.
- The record includes draft flag, base/head refs, author, `created_at`/`updated_at`/`merged_at`, `mergeable`, `review_decision`, labels, and assignees (see RNF-DOM.1).
- Errors: `not_pull_request` when `gh pr view` reports that the number is not a pull request; `provider_response` for a malformed payload; `github_cli` when the call fails.

**Acceptance:** Valid pull request details are returned; zero or malformed numbers fail before `gh`; a non-pull-request number produces `not_pull_request` without leaking provider stderr.
**Verification:** Integration test `show_returns_a_pull_request_or_reports_it_is_not_one`.

### RF-PR.4: Print a pull request diff
**Priority:** Must Have | **Status:** Implemented | **Dependencies:** RF-CFG.1, RF-CFG.2

- `pr diff NUMBER` prints the pull request's unified diff; `--name-only` prints only the names of changed files.
- JSON output wraps the patch as `{ "number", "diff" }`; `--format text` prints the raw diff.
- Errors: `github_cli` when the `gh pr diff` call fails.

**Acceptance:** The JSON `diff` field and the text output both contain the patch returned by `gh pr diff`; `--name-only` adds the corresponding flag.
**Verification:** Integration test `diff_prints_the_patch_as_json_or_raw_text`.

### RF-PR.5: Report pull request checks
**Priority:** Must Have | **Status:** Implemented | **Dependencies:** RF-CFG.1, RF-CFG.2

- `pr checks NUMBER` returns check runs as an array of `{name, state, bucket, description, link, workflow}`; `--required` limits the report to the checks the repository requires.
- A pull request with no checks returns an empty array, not an error, even though `gh pr checks` exits non-zero and writes `no checks reported` to stderr.
- Failing or pending checks are reported as data even though `gh pr checks` exits non-zero.
- Errors: `github_cli` when the `gh pr checks` call fails or its report cannot be parsed; the one exception is stderr containing `no checks reported`, which yields an empty array instead.

**Acceptance:** A failing report parses into checks with lowercased states; `no checks reported` yields an empty array; `--required` appears in the invocation.
**Verification:** Integration test `checks_parse_failing_reports_and_treat_missing_checks_as_empty`.

### RF-PR.6: Submit a review
**Priority:** Must Have | **Status:** Implemented | **Dependencies:** RF-CFG.1, RF-CFG.2

- `pr review NUMBER` requires exactly one of `--approve`, `--request-changes`, or `--comment`; an optional review body comes from `--body` or `--body-file FILE`, where `-` reads standard input.
- The result is `{ "number", "event" }` with event `approve`, `request_changes`, or `comment`.
- Only a top-level review event is submitted; inline line comments are not supported.
- Errors: `invalid_input` for `--body` combined with `--body-file` or unreadable/oversized/non-UTF-8 review text; `github_cli` when the call fails. Omitting the event is a usage error before `gh`.

**Acceptance:** Each event maps to the matching `gh pr review` flag and reports its event name; a review body travels on stdin; providing no event fails before `gh`; `--body` with `--body-file` fails with `invalid_input`.
**Verification:** Integration tests `review_merge_ready_close_and_reopen_use_the_gh_commands` and `review_without_an_event_is_a_usage_error`.

### RF-PR.7: Merge a pull request
**Priority:** Must Have | **Status:** Implemented | **Dependencies:** RF-CFG.1, RF-CFG.2

- `pr merge NUMBER` merges the pull request; `--method merge|squash|rebase` selects the method, `--delete-branch` deletes the local and remote branch after merging, and `--auto` queues the merge once the repository requirements are met.
- `--method` is passed to `gh` only when given: workctl applies no default merge policy, so an explicit method is required whenever `gh` cannot infer one.
- The result is `{ "number", "method": null|"merge"|"squash"|"rebase", "auto" }`.
- Errors: `github_cli` when the call fails.

**Acceptance:** `--method squash --delete-branch --auto` invokes `gh pr merge` with those flags and reports the method and auto state; omitting `--method` passes no method flag to `gh`.
**Verification:** Integration test `review_merge_ready_close_and_reopen_use_the_gh_commands`.

### RF-PR.8: Update a pull request
**Priority:** Must Have | **Status:** Implemented | **Dependencies:** RF-CFG.1, RF-CFG.2

- `pr update NUMBER` accepts a title change, one body change, a base-branch change, label/reviewer/assignee additions and removals, a milestone, or any combination; at least one change is required.
- Body changes reuse the same set and shared resolver as `issue edit`: `--body`/`--body-file` replaces the body, `--append-body`/`--append-body-file` appends, `--replace-section HEADING` with `--section-body`/`--section-body-file` replaces one ATX section, and `--patch-file` applies a unified diff. At most one body-change flag may be supplied, and `--replace-section` requires its section body.
- `--patch-file` locates hunks by exact context match; an unmatched hunk is `patch_conflict` and no write is sent. A missing `--replace-section` heading is `section_not_found`.
- `--add-label`/`--remove-label`, `--add-reviewer`/`--remove-reviewer`, and `--add-assignee`/`--remove-assignee` may be repeated; `--milestone NAME` sets the milestone.
- The pull request is fetched once; the change is applied to that text and one write is sent. `--expect-updated-at TIMESTAMP` fails with `conflict` before any write when the fetched `updated_at` differs.
- The updated pull request is returned as a full record; a target that is not a pull request fails with `not_pull_request` before any write.
- Errors: `invalid_input` for no change, a blank title, conflicting or incomplete body changes; `not_pull_request`; `conflict`; `patch_conflict`; `section_not_found`; `github_cli`.

**Acceptance:** An append or patch produces exactly the expected body in the `gh pr edit` payload while the pull request is fetched once; a stale `--expect-updated-at` and a non-applying patch fail with `conflict`/`patch_conflict` and no write; an invocation with no change fails with `invalid_input` before `gh`; supplied metadata flags appear in the invocation.
**Verification:** Integration tests `update_applies_a_body_change_and_rejects_a_stale_write` and `update_forwards_metadata_flags_and_requires_a_change`; unit tests for the body and patch policies.

### RF-PR.9: Mark a pull request ready or draft
**Priority:** Must Have | **Status:** Implemented | **Dependencies:** RF-CFG.1, RF-CFG.2

- `pr ready NUMBER` marks the pull request ready for review; `--undo` converts it back to a draft.
- The result is `{ "number", "draft" }`, where `draft` is true only with `--undo`.
- Errors: `github_cli` when the call fails.

**Acceptance:** `pr ready 42` and `pr ready 42 --undo` invoke `gh pr ready` with and without `--undo` and report the resulting draft state.
**Verification:** Integration test `review_merge_ready_close_and_reopen_use_the_gh_commands`.

### RF-PR.10: Close a pull request
**Priority:** Must Have | **Status:** Implemented | **Dependencies:** RF-CFG.1, RF-CFG.2

- `pr close NUMBER` closes the pull request; `--comment TEXT` leaves a closing comment and `--delete-branch` deletes the local and remote branch after closing.
- The result is `{ "number", "state": "closed" }`.
- Errors: `github_cli` when the call fails.

**Acceptance:** `pr close 42 --comment bye --delete-branch` invokes `gh pr close` with the comment and branch deletion and reports `state: closed`.
**Verification:** Integration test `review_merge_ready_close_and_reopen_use_the_gh_commands`.

### RF-PR.11: Reopen a pull request
**Priority:** Must Have | **Status:** Implemented | **Dependencies:** RF-CFG.1, RF-CFG.2

- `pr reopen NUMBER` reopens the pull request; `--comment TEXT` adds a reopening comment.
- The result is `{ "number", "state": "open" }`.
- Errors: `github_cli` when the call fails.

**Acceptance:** `pr reopen 42 --comment back` invokes `gh pr reopen` with the comment and reports `state: open`.
**Verification:** Integration test `review_merge_ready_close_and_reopen_use_the_gh_commands`.

### RF-CFG.1: Project configuration
**Priority:** Must Have | **Status:** Implemented | **Dependencies:** none

- Both optional files are discovered at the Git worktree root and validated on every command invocation, even when CLI flags override selected values. Local fields override shared fields.
- The v0 schema contains only `provider` and `workItemProvider`; each accepts `github` or `gitlab`. Files must be regular, non-symlink files no larger than 64 KiB. Unknown keys and invalid JSON fail closed.
- `.workctl.local.json` is gitignored. Old `.mcp-tracker*.json` files are not read or migrated.
- No configuration file is required when the provider and repository can be resolved from flags or the Git remote.

**Acceptance:** Local provider fields override shared fields; malformed, unknown, oversized, symlink, or non-regular configuration yields a safe JSON error even when flags provide the effective provider/repository; legacy filenames have no effect.
**Verification:** Configuration unit tests using temporary Git roots.

### RF-CFG.2: Provider and repository resolution
**Priority:** Must Have | **Status:** Implemented | **Dependencies:** RF-CFG.1

- Provider precedence: explicit `--provider` > `workItemProvider` > `provider` > known Git remote host.
- Repository precedence: explicit `--repo OWNER/REPO` > repository parsed from `origin` remote.
- v0 implements only GitHub. A GitLab selection or unknown remote host fails explicitly; it never falls back to GitHub.
- When outside a Git worktree, an explicit provider and repository are required.

**Acceptance:** HTTPS and SSH GitHub remotes resolve to the same `owner/repo`; GitLab/unknown hosts and missing scope fail closed; explicit overrides take precedence.
**Verification:** Unit tests for resolution and remote parsing.

### RF-OUT.1: Output contract
**Priority:** Must Have | **Status:** Implemented | **Dependencies:** RF-CLI.1

- Success output is compact JSON by default; `--format text` selects human-readable output.
- Text output escapes terminal control characters in provider values; issue-body newlines and tabs remain layout characters.
- Errors are one JSON object on stderr with a stable `code` and safe `message`; all failures exit nonzero and leave stdout empty.
- User-facing errors do not include raw `gh` stderr, credentials, stack traces, or internal paths.

**Acceptance:** Success and failure tests assert output stream, format, and exit status; raw fixture stderr never appears in the error response.
**Verification:** CLI integration tests.

## 2. Non-functional requirements

### RNF-SEC.1: Safe external command boundary
**Priority:** Must Have | **Status:** Implemented | **Dependencies:** none

- GitHub operations invoke the authenticated `gh` CLI with argument arrays; no shell is used.
- Create/edit payloads are JSON on stdin, not interpolated into a shell or URL.
- `workctl` never reads, stores, or logs GitHub tokens. It does not download `gh` automatically.

**Acceptance:** Hostile shell-like title/body text is preserved as data; code review confirms no shell invocation or token access.
**Verification:** Payload-safety test and source review.

### RNF-EXT.1: Bounded subprocess execution
**Priority:** Must Have | **Status:** Implemented | **Dependencies:** none

- One absolute 30-second deadline covers child completion and all pipe/input worker completion; a still-running direct child is killed at expiry.
- Captured stdout and drained stderr each have an 8 MiB upper bound; timeout and output-limit failures map to safe structured errors.

**Acceptance:** A hanging child or inherited pipe is reported as timeout; oversized stdout/stderr does not grow memory without bound.
**Verification:** Process-runner tests.

### RNF-DOM.1: Validated provider responses
**Priority:** Must Have | **Status:** Implemented | **Dependencies:** none

- Provider JSON is parsed into typed issue and pull request structures; required fields and allowed state values are validated.
- GitHub state casing is normalized to `open|closed` for issues and `open|closed|merged` for pull requests.
- A pull request record carries the draft flag (`isDraft`), `mergeable`, and `review_decision`; these optional provider fields are lowercased and empty strings dropped. Summaries exclude the body.
- Check runs are parsed into typed records with a lowercased state, a `bucket`, and optional `description`, `link`, and `workflow`.

**Acceptance:** Malformed JSON, missing required fields, and unknown states fail explicitly; valid provider records serialize with stable CLI field names.
**Verification:** Provider mapping tests.

### RNF-DIST.1: Native binary
**Priority:** Must Have | **Status:** Implemented | **Dependencies:** none

- The project builds as a Rust stable binary named `workctl`; `Cargo.lock` records resolved dependencies.
- The CLI parser uses the latest stable `clap` release selected for the implementation.

**Acceptance:** `cargo build --release` produces an executable `workctl` and `workctl --version` succeeds.
**Verification:** Release build and binary smoke run.

### RNF-TST.1: Isolated behavior verification
**Priority:** Must Have | **Status:** Implemented | **Dependencies:** RF-WI.1, RF-WI.2, RF-WI.3, RF-WI.4, RF-PR.1, RF-PR.2, RF-PR.3, RF-PR.4, RF-PR.5, RF-PR.6, RF-PR.7, RF-PR.8, RF-PR.9, RF-PR.10, RF-PR.11

- Tests exercise consumer-visible CLI output and provider boundaries without requiring network access or mutating a real repository.
- At least one built-binary smoke run exercises a successful command and a failure path.

**Acceptance:** `cargo test` passes and the smoke run observes the expected stdout/stderr and exit status.
**Verification:** Focused Cargo tests and isolated smoke fixture.

## 3. Non-goals for v0

- GitLab, Jira, local Markdown tracking, provider plugin systems.
- Branch creation, checkout, or standalone deletion: `git` owns branch lifecycle. `--head`/`--base` select existing branches, and `--delete-branch` asks `gh` to remove a branch only after a merge or close.
- Projects/board membership, workflow/status transitions, and label/assignee/milestone *management* on issues. Filtering an issue list by these values is supported, and `pr update` may change them on a pull request; changing them on an issue is not.
- Inline review comments: `pr review` submits one top-level approve, request-changes, or comment, and `pr close`/`pr reopen` accept a single comment.
- Listing the pull requests linked to an issue.
- Relationships, checklists, and issue-comment threads.
- Attachment listing, removal, or download, and attachments on pull requests. Uploading attachments on issue create/edit is supported; nothing else about attachments is.
- Issue deletion (there is no delete command for issues or pull requests), interactive prompts, MCP transport, direct HTTP, token management, retries, telemetry.
- Three-way merge or fuzzy patch application: a patch either matches the fetched body exactly or fails.

## 4. Glossary

- **Issue:** GitHub issue, excluding pull requests.
- **Pull request:** GitHub pull request addressed by number, with normalized `open|closed|merged` state, a separate draft flag, and merge/review metadata.
- **Check run:** one status check reported for a pull request's head commit; it carries a lowercased state, a `bucket` (`pass`, `fail`, `pending`, `skipping`, or `cancel`), and optional description, link, and workflow.
- **Review event:** the top-level review outcome submitted by `pr review` — `approve`, `request_changes`, or `comment`.
- **Merge method:** how a pull request is merged — `merge`, `squash`, or `rebase` — passed to `gh` only when the caller supplies `--method`.
- **Draft:** a pull request explicitly marked not ready for review; `pr ready` clears the flag and `pr ready --undo` sets it.
- **Repository target:** `owner/repo`, selected explicitly or from the Git `origin` remote.
- **Worktree config:** optional project configuration found at the Git root; local config is untracked and overrides the shared file.

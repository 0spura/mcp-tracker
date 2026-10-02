# SRS: workctl v0

> Vision: [docs/product/vision.md](./product/vision.md)
> Architecture: [docs/architecture.md](./architecture.md)

Actors: a developer or coding agent running `workctl` locally. Observable behavior is defined at the CLI boundary: arguments, stdout, stderr, exit code, and remote GitHub issue state.

## 1. Functional requirements

### RF-CLI.1: Issue command surface
**Priority:** Must Have | **Status:** Implemented | **Dependencies:** none

- Commands: `workctl issue create`, `list`, `show`, and `edit`.
- `--repo OWNER/REPO`, `--provider`, and `--format json|text` are global overrides.
- Help and version work without `git` or `gh` installed.
- Every flag carries a help description, and each subcommand prints usage examples for the behavior a caller cannot infer from flag names — for `edit`, the body-change set and the exact-match patch contract.
- There is no issue-delete command in v0.

**Acceptance:** `workctl issue --help` lists exactly the four supported subcommands; invoking an unknown command produces a structured JSON error on stderr and a nonzero exit. No flag in any subcommand help is printed without a description, and `workctl issue edit --help` documents the `patch_conflict` failure and exact-context matching.
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

- Provider JSON is parsed into typed issue structures; required fields and allowed state values are validated.
- GitHub state casing is normalized to `open|closed`.

**Acceptance:** Malformed JSON, missing required fields, and unknown states fail explicitly; valid provider records serialize with stable CLI field names.
**Verification:** Provider mapping tests.

### RNF-DIST.1: Native binary
**Priority:** Must Have | **Status:** Implemented | **Dependencies:** none

- The project builds as a Rust stable binary named `workctl`; `Cargo.lock` records resolved dependencies.
- The CLI parser uses the latest stable `clap` release selected for the implementation.

**Acceptance:** `cargo build --release` produces an executable `workctl` and `workctl --version` succeeds.
**Verification:** Release build and binary smoke run.

### RNF-TST.1: Isolated behavior verification
**Priority:** Must Have | **Status:** Implemented | **Dependencies:** RF-WI.1, RF-WI.2, RF-WI.3, RF-WI.4

- Tests exercise consumer-visible CLI output and provider boundaries without requiring network access or mutating a real repository.
- At least one built-binary smoke run exercises a successful command and a failure path.

**Acceptance:** `cargo test` passes and the smoke run observes the expected stdout/stderr and exit status.
**Verification:** Focused Cargo tests and isolated smoke fixture.

## 3. Non-goals for v0

- GitLab, Jira, local Markdown tracking, provider plugin systems.
- Projects/board membership, workflow/status transitions, and label/assignee/milestone *management*. Filtering a list by these values is supported; changing them is not.
- Branches, pull/merge requests, review, comments, relationships, checklists.
- Attachment listing, removal, or download. Uploading attachments on create/edit is supported; nothing else about them is.
- Issue deletion, interactive prompts, MCP transport, direct HTTP, token management, retries, telemetry.
- Three-way merge or fuzzy patch application: a patch either matches the fetched body exactly or fails.

## 4. Glossary

- **Issue:** GitHub issue, excluding pull requests.
- **Repository target:** `owner/repo`, selected explicitly or from the Git `origin` remote.
- **Worktree config:** optional project configuration found at the Git root; local config is untracked and overrides the shared file.

# Architecture: workctl

> Product scope: [docs/product/vision.md](./product/vision.md)
> Observable contract: [docs/srs.md](./srs.md)
> Accepted cutover decision: [ADR-0004](./adr/0004-workctl-rust-cli.md)
> Attachment and body-edit decision: [ADR-0005](./adr/0005-attachments-and-non-rewrite-body-edits.md)
> Pull request decision: [ADR-0006](./adr/0006-pull-request-operations.md)

`workctl` is a local Rust CLI. The first vertical slice manages GitHub issues and pull requests; no MCP server or GitLab implementation ships in v0.

## Module map

Modules are grouped by ownership and reason to change. A module can grow while its policy stays cohesive; split it when different policies or external contracts change independently. `main.rs`, command parsing, provider execution, and domain types remain separate.

```text
src/
  main.rs                     bootstrap, error-to-exit mapping only
  cli/
    mod.rs                    clap root command and global flags
    common.rs                 body-change flags and limit parsing shared by issue and pr
    issues.rs                 issue subcommand argument types
    prs.rs                    pull request subcommand argument types
  commands/
    mod.rs
    issues.rs                 issue use cases: resolve context, call the provider, select output
    prs.rs                    pull request use cases
    support.rs                shared context resolution, text reading, body-change setup, argument validation
  config/
    mod.rs
    discover.rs               Git-root and origin-remote discovery
    files.rs                  strict JSON parse and shared/local merge
    resolve.rs                provider and repository precedence
  domain/
    mod.rs
    body.rs                   append and section-replacement policy
    error.rs                  stable, safe user-facing errors
    issue.rs                  Issue and IssueSummary contracts
    pr.rs                     PullRequest, PullRequestSummary, PullRequestState, and CheckRun contracts
    patch.rs                  strict unified-diff application
  process/
    mod.rs
    runner.rs                 argument-array subprocess execution, stdin, timeout, limits, bounded stdout/stderr
  providers/
    mod.rs                    WorkItemProvider and PullRequestProvider seams, request types, shared body-change resolver
    github/
      mod.rs                  shared `gh` execution, authentication, and raw exit-status access
      issues/
        mod.rs                GitHub issue provider composition
        read.rs               list/show
        write.rs              create/edit
        mapping.rs            response validation and state normalization
      prs/
        mod.rs                GitHub pull request provider composition
        read.rs               list/show/diff/checks
        write.rs              create/edit/review/merge/ready/close/reopen
        mapping.rs            pull request and check-run validation and state normalization
  output/
    mod.rs
    json.rs                   compact success and structured error JSON
    text.rs                   optional human-readable success output

tests/
  common/mod.rs               shared isolated `gh` fixture and CLI helpers
  cli_issues.rs               built-binary issue provider-boundary behavior
  cli_prs.rs                  built-binary pull request provider-boundary behavior
  config.rs                   isolated config and Git-remote resolution
```

No empty GitLab module is added. When GitLab is scheduled, its adapter must implement the existing issue and pull request seams with its own cohesive files and contract tests; it must not expand `main.rs` or the GitHub adapter.

## Command flow

1. Clap parses the `issue` and `pr` groups, global `--provider`, `--repo`, and `--format`.
2. Help/version exit without external dependencies. Other commands load optional config from the Git worktree root.
3. Context resolves provider and repository using command-line overrides, merged config, then Git origin host/repository.
4. v0 rejects any provider except GitHub. A GitHub operation checks that `gh` is available and authenticated, then calls the GitHub adapter.
5. The adapter invokes `gh issue list` for bounded, PR-free issue summaries and `gh pr list` for pull request summaries, passing the requested filters through as fixed flags. Issue create/get/patch use `gh api`; pull request operations use the `gh pr` commands (`create`, `view`, `edit`, `diff`, `checks`, `review`, `merge`, `ready`, `close`, `reopen`), mirroring `gh`'s own surface. Create/edit bodies travel on stdin. An issue operation carrying attachments switches to `gh issue create|edit --attach` with the body on stdin, because GitHub documents no attachment upload endpoint.
6. Typed results are serialized by `output`; errors are mapped once to a safe JSON error on stderr and nonzero exit.

## Configuration and context

- Discover both config files at the Git worktree root on every command invocation, including when `--provider`/`--repo` override their values; never walk above the root.
- Both files are strict JSON, regular non-symlink files capped at 64 KiB. The local file overrides `provider` and `workItemProvider` individually; unknown keys and malformed files fail closed.
- Provider precedence: CLI `--provider`, local/shared `workItemProvider`, local/shared `provider`, then Git remote host.
- Repository precedence: CLI `--repo OWNER/REPO`, then the Git `origin` remote.
- `owner/repo` is validated before inclusion in any `gh` arguments or endpoint path. HTTPS and SCP-style SSH GitHub remotes are recognized; unknown hosts do not fall back.
- If no Git root exists, both explicit provider and repository are required. There is no persistent `repo` config pin.
- Legacy `.mcp-tracker.json` files are neither read nor migrated.

## Provider seams and models

`WorkItemProvider` owns issue create, list, show, and edit. The application/CLI layer receives normalized `Issue` or `IssueSummary`; GitHub numeric identifiers and provider response casing stay inside the GitHub adapter. `Issue.state` is `open|closed`; an issue summary excludes the body. The seam exists for the planned second provider, not for dynamic plugins or speculative providers.

`PullRequestProvider` is a second, narrow seam rather than an extension of `WorkItemProvider`. The two domains differ in nearly every operation — issues carry attachments and use a PATCH API, while pull requests add diff, checks, review, merge, ready, close, and reopen and normalize state to `open|closed|merged` — so widening the issue seam would force every provider and caller to carry capabilities neither needs. Each seam owns its request types: `NewPr`, `PrQuery`, `PrPatch`, plus `ReviewEvent` and `MergeMethod`. `PrPatch::is_empty` lets the caller reject an update that supplies only `expect_updated_at`, which guards a write rather than being one. The GitHub composition mirrors the issue adapter: `prs/mod.rs` wires the trait and `read.rs`/`write.rs`/`mapping.rs` split reads, writes, and validation.

Requests cross a seam as typed values, not loose strings: `NewIssue`, `IssueQuery` (state, limit, labels, assignee, author, mention, milestone, search, type), and `IssuePatch` (title, `BodyChange`, attachments, expected `updated_at`). `BodyChange` names the mutation the caller wants — replace, append, replace a section, or apply a unified diff — so the caller never reproduces the current body. `pr update` reuses that exact set: the CLI flattens the same `BodyChangeArgs`, and `resolve_body_change` in `providers/mod.rs` applies it for both adapters, so body-shape policy (`domain/body.rs`, `domain/patch.rs`) stays on the domain side and only the request shape sits on the seam.

GitHub response JSON is deserialized into typed response structs and validated for required fields. A response carrying `pull_request` is rejected by issue show/edit. The `edit` operation behind `issue edit` and `pr update` fetches and validates the target exactly once, then applies the body change and sends the write, so a body mutation never sees stale text it did not read; the fetch is also where `--expect-updated-at` is checked, failing with `conflict` before any write. Issue list uses `gh issue list`, whose contract returns issues only; pull request list uses `gh pr list`, whose summaries never carry a body. Pull request show additionally normalizes the draft flag, `mergeable`, and `review_decision`, and checks are validated into typed `CheckRun` records.

Pull request `show` and `checks` depend on the `gh` exit status instead of collapsing it into a generic failure: `gh pr view` exits non-zero when the number is not a pull request, and `gh pr checks` exits non-zero for failing (1) or pending (8) checks while still printing a valid report, and writes `no checks reported` to stderr when there are none. The adapter therefore calls `run_gh_raw`, which returns the raw `ProcessOutput` rather than mapping a non-zero exit to `github_cli`; `show` maps that failure to `not_pull_request`, and `checks` parses stdout while treating the `no checks reported` stderr as an empty report. To make the status interpretable, `ProcessOutput` also carries a bounded `stderr`, so the adapter can read provider diagnostics that never reach a user-facing error.

Provider asymmetry is expected. Keep only genuinely shared behavior on each seam; expose provider-specific capabilities through typed, provider-scoped arguments or configuration and reject unsupported choices explicitly. Never pass arbitrary raw command arguments through. The issue-only capabilities are the GitHub `--attach` flag and the `--type` list filter; their names and validation live in the CLI, the seam carries them as typed fields, and a provider that cannot honor one must reject it rather than ignore it. Attachments are likewise issue-only: `NewPr` has no attachments field, so `pr create` cannot upload files and the pull request path never needs the `--attach` fallback.

Attachment paths are caller-supplied command-line values, so the adapter follows symlinks and requires a regular file; the stricter regular-non-symlink rule belongs to repository content (config files), not to arguments a user typed. Only issue create/edit take attachments; `pr create` and `pr update` have no attachment flag, so the pull request path never touches the attachment machinery. Body text read from a file or stdin is capped at 1 MiB and must be valid UTF-8.

Patch application is exact-match and content-located: the line numbers in a hunk header are validated but not trusted, and unmatched context is a `patch_conflict` rather than a fuzzy placement. Both the issue and pull request adapters share this behavior through `resolve_body_change`. See [ADR-0005](./adr/0005-attachments-and-non-rewrite-body-edits.md).

Text output escapes terminal control characters in provider strings (titles, authors, labels, check names, and similar) while preserving body newlines and tabs; JSON output preserves the string data through JSON encoding.

## Process and security boundary

- One process runner owns all `git` and `gh` process creation. It accepts an executable and argument vector; it never invokes a shell.
- Request bodies are serialized JSON on stdin, not embedded in command text. Each output stream has an 8 MiB cap; one absolute 30-second deadline covers child completion and pipe/input workers, and a still-running direct child is killed on expiry.
- `gh` owns GitHub credentials. `workctl` checks `gh auth status` but discards its output; it never reads token environment variables, stores credentials, or downloads dependencies.
- Raw `gh` stderr, config contents, stack traces, and internal paths are not included in user-facing errors.
- Invalid config and provider payloads fail closed; no fallback fabricates records or silently drops requested fields.

## Failure behavior

| Failure | Observable result | Recovery |
|---|---|---|
| `gh` missing or unauthenticated | Safe `dependency`/`authentication` JSON error on stderr; nonzero exit | Install/authenticate `gh`, retry |
| Git remote missing or unsupported | `context`/`provider_unsupported` JSON error; no `gh` call | Provide explicit supported `--provider` and `--repo` |
| Invalid, oversized, linked, or non-regular config | `config` JSON error without path contents; overrides do not bypass validation | Correct/remove invalid config |
| Invalid arguments or a non-positive number | `invalid_input` or a clap usage error; no remote call | Correct arguments |
| Body-change flags combined or incomplete | `invalid_input` JSON error; no `gh` call | Supply one body change and its companion argument |
| Patch context absent from the current body | `patch_conflict` JSON error; no write | Regenerate the diff against the fetched body |
| `--replace-section` heading not found | `section_not_found` JSON error; no write | Correct the heading to match the fetched body |
| `--expect-updated-at` differs from the fetched issue or pull request | `conflict` JSON error; no write | Re-read with `issue show`/`pr show` and retry with the returned `updated_at` |
| A number given to a pull request command is not a pull request | `not_pull_request` JSON error; no write | Use a pull request number, or the `issue` group for issues |
| An issue command is given a pull request number | `not_issue` JSON error; no write | Use the issue number, or the `pr` group for pull requests |
| Provider command failure | Generic `github_cli` JSON error; raw stderr withheld | Check `gh` authentication/permissions and retry |
| Child timeout/output cap exceeded | `timeout`/`output_limit` JSON error | Retry after resolving remote/tool issue |
| Malformed provider response | `provider_response` JSON error | Report provider contract mismatch |

## Verification strategy

- Unit tests cover strict config merge, Git remote parsing, provider selection, issue and pull request state mapping, request serialization, body mutation, and patch application.
- Integration tests launch the compiled binary with a temporary `gh` fixture and verify observable stdout/stderr, exit status, request body safety, CRUD mapping, filter arguments, attachment routing, body-change payloads, concurrency-guard rejection, and bounds; `tests/cli_issues.rs` covers the issue surface and `tests/cli_prs.rs` the pull request surface, sharing one fixture in `tests/common/mod.rs`; no real GitHub issue or pull request is created or edited by tests.
- Release verification builds `workctl` and smoke-runs one success and one failure path against the isolated fixture.

# Architecture: workctl

> Product scope: [docs/product/vision.md](./product/vision.md)
> Observable contract: [docs/srs.md](./srs.md)
> Accepted cutover decision: [ADR-0004](./adr/0004-workctl-rust-cli.md)
> Attachment and body-edit decision: [ADR-0005](./adr/0005-attachments-and-non-rewrite-body-edits.md)

`workctl` is a local Rust CLI. The first vertical slice manages GitHub Issues; no MCP server or GitLab implementation ships in v0.

## Module map

Modules are grouped by ownership and reason to change. A module can grow while its policy stays cohesive; split it when different policies or external contracts change independently. `main.rs`, command parsing, provider execution, and domain types remain separate.

```text
src/
  main.rs                     bootstrap, error-to-exit mapping only
  cli/
    mod.rs                    clap root command and global flags
    issues.rs                 issue subcommand argument types
  commands/
    mod.rs
    issues.rs                 resolve context, call use cases, select output
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
    patch.rs                  strict unified-diff application
  process/
    mod.rs
    runner.rs                 argument-array subprocess execution, stdin, timeout, limits
  providers/
    mod.rs                    v0 WorkItemProvider interface
    github/
      mod.rs
      issues/
        mod.rs                GitHub issue provider composition
        read.rs               list/show
        write.rs              create/edit
        mapping.rs            response validation and state normalization
  output/
    mod.rs
    json.rs                   compact success and structured error JSON
    text.rs                   optional human-readable success output

tests/
  cli_issues.rs               built-binary provider-boundary behavior
  config.rs                   isolated config and Git-remote resolution
```

No empty GitLab module is added. When GitLab is scheduled, its adapter must implement the existing issue-provider seam with its own cohesive files and contract tests; it must not expand `main.rs` or the GitHub adapter.

## Command flow

1. Clap parses `issue create|list|show|edit`, global `--provider`, `--repo`, and `--format`.
2. Help/version exit without external dependencies. Other commands load optional config from the Git worktree root.
3. Context resolves provider and repository using command-line overrides, merged config, then Git origin host/repository.
4. v0 rejects any provider except GitHub. A GitHub operation checks that `gh` is available and authenticated, then calls the GitHub adapter.
5. The adapter invokes `gh issue list` for bounded, PR-free summaries, passing the requested filters through as fixed flags. It uses `gh api` for one-request create/get/patch operations; create/edit JSON travels on stdin. An operation carrying attachments switches to `gh issue create|edit --attach` with the body on stdin, because GitHub documents no attachment upload endpoint.
6. Typed results are serialized by `output`; errors are mapped once to a safe JSON error on stderr and nonzero exit.

## Configuration and context

- Discover both config files at the Git worktree root on every command invocation, including when `--provider`/`--repo` override their values; never walk above the root.
- Both files are strict JSON, regular non-symlink files capped at 64 KiB. The local file overrides `provider` and `workItemProvider` individually; unknown keys and malformed files fail closed.
- Provider precedence: CLI `--provider`, local/shared `workItemProvider`, local/shared `provider`, then Git remote host.
- Repository precedence: CLI `--repo OWNER/REPO`, then the Git `origin` remote.
- `owner/repo` is validated before inclusion in any `gh` arguments or endpoint path. HTTPS and SCP-style SSH GitHub remotes are recognized; unknown hosts do not fall back.
- If no Git root exists, both explicit provider and repository are required. There is no persistent `repo` config pin.
- Legacy `.mcp-tracker.json` files are neither read nor migrated.

## Provider seam and issue model

`WorkItemProvider` owns create, list, show, and edit. The application/CLI layer receives normalized `Issue` or `IssueSummary`; GitHub numeric identifiers and provider response casing stay inside the GitHub adapter. `Issue.state` is `open|closed`; an issue summary excludes the body. The seam exists for the planned second provider, not for dynamic plugins or speculative providers.

Requests cross the seam as typed values, not loose strings: `NewIssue`, `IssueQuery` (state, limit, labels, assignee, author, mention, milestone, search, type), and `IssuePatch` (title, `BodyChange`, attachments, expected `updated_at`). `BodyChange` names the mutation the caller wants — replace, append, replace a section, or apply a unified diff — so the caller never reproduces the current body. The adapter resolves the mutation against the body it fetched, which keeps body-shape policy (`domain/body.rs`, `domain/patch.rs`) on the domain side and the request shape on the seam.

GitHub response JSON is deserialized into typed response structs and validated for required fields. A response with `pull_request` is rejected by show/edit; `edit` fetches and validates the target exactly once, then applies the body change and sends the write, so a pull request is never mutated and a body mutation never sees stale text it did not read. The fetch is also where `--expect-updated-at` is checked, failing with `conflict` before any PATCH. List uses the `gh issue list` command, whose contract returns issues only.

Provider asymmetry is expected for a future provider. Keep only genuinely shared fields on common issue operations; expose provider-specific capabilities through typed, provider-scoped arguments or configuration and reject unsupported choices explicitly. Never pass arbitrary raw command arguments through. The first provider-specific capabilities are the GitHub-only `--attach` flag and the `--type` list filter: their names and validation live in the CLI, the seam carries them as typed fields, and a provider that cannot honor one must reject it rather than ignore it.

Attachment paths are caller-supplied command-line values, so the adapter follows symlinks and requires a regular file; the stricter regular-non-symlink rule belongs to repository content (config files), not to arguments a user typed. Body text read from a file or stdin is capped at 1 MiB and must be valid UTF-8.

Patch application is exact-match and content-located: the line numbers in a hunk header are validated but not trusted, and unmatched context is a `patch_conflict` rather than a fuzzy placement. See [ADR-0005](./adr/0005-attachments-and-non-rewrite-body-edits.md).

Text output escapes terminal control characters in provider strings while preserving body newlines and tabs; JSON output preserves the string data through JSON encoding.

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
| Invalid arguments/issue number | `invalid_input` JSON error; no remote call | Correct arguments |
| Body-change flags combined or incomplete | `invalid_input` JSON error; no `gh` call | Supply one body change and its companion argument |
| Patch context absent from the current body | `patch_conflict` JSON error; no PATCH | Regenerate the diff against the fetched body |
| `--expect-updated-at` differs from the fetched issue | `conflict` JSON error; no PATCH | Re-read the issue and retry with its `updated_at` |
| Provider command failure | Generic `github_cli` JSON error; raw stderr withheld | Check `gh` authentication/permissions and retry |
| Child timeout/output cap exceeded | `timeout`/`output_limit` JSON error | Retry after resolving remote/tool issue |
| Malformed provider response or PR passed as issue | `provider_response`/`not_issue` JSON error | Report provider contract mismatch or use an issue number |

## Verification strategy

- Unit tests cover strict config merge, Git remote parsing, provider selection, state mapping, request serialization, body mutation, and patch application.
- Integration tests launch the compiled binary with a temporary `gh` fixture and verify observable stdout/stderr, exit status, request body safety, CRUD mapping, filter arguments, attachment routing, body-change payloads, concurrency-guard rejection, and bounds; no real GitHub issue is created or edited by tests.
- Release verification builds `workctl` and smoke-runs one success and one failure path against the isolated fixture.

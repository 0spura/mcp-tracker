# workctl

`workctl` is a local Rust CLI for GitHub issue create, list, show, and edit. It uses the official `gh` CLI for authenticated GitHub operations; it does not access or store credentials itself.

## Requirements

- Stable Rust toolchain and Cargo
- `git` for repository and remote discovery
- GitHub CLI (`gh`) installed and authenticated for GitHub operations

Help and version do not require `git` or `gh`.

## Build and verify

```sh
cargo build --release
cargo test
./target/release/workctl --help
```

## Commands

```sh
workctl issue create --title "Fix the parser" --body "Details"
workctl issue create --title "Crash on save" --body "Screenshot attached" --attach shot.png#Screenshot
workctl issue list --state open --limit 30
workctl issue list --label bug --label p1 --assignee me --search "in:title fix"
workctl issue show 123
workctl issue edit 123 --title "Updated title"
workctl issue edit 123 --append-body "Reproduced on 1.4.2."
workctl issue edit 123 --replace-section "## Acceptance" --section-body "New criteria"
workctl issue edit 123 --patch-file body.patch
workctl issue edit 123 --attach shot.png
workctl issue edit 123 --title "Updated title" --expect-updated-at 2026-01-02T00:00:00Z
```

Output is compact JSON by default. Add `--format text` for human-readable output; terminal control characters in provider data are escaped, while issue-body newlines and tabs remain readable. Errors are JSON on stderr with a nonzero exit code. `issue list` returns summaries without bodies; `show`, `create`, and `edit` return full issue data. There is no delete command in this release.

Global options apply before or after the issue subcommand:

```sh
workctl --repo owner/repo issue list
workctl issue list --provider github --format text
```

The default list state is `open`; accepted states are `open`, `closed`, and `all`. The limit defaults to 30 and accepts values from 1 through 1000. Create and edit do not prompt interactively. An explicit empty edit body clears the issue body.

## Editing without rewriting the body

An edit never requires the whole new body. Pick at most one body change per invocation:

| Flag | Effect |
| --- | --- |
| `--body TEXT` / `--body-file FILE` | Replaces the body (`-` reads stdin) |
| `--append-body TEXT` / `--append-body-file FILE` | Appends a new block, keeping one separating newline |
| `--replace-section HEADING --section-body TEXT` / `--section-body-file FILE` | Replaces the content of one ATX section (`## Heading`), leaving other sections alone |
| `--patch-file FILE` | Applies a unified diff to the current body (`-` reads stdin) |

`--patch-file` takes standard `git diff` output. Hunks are located by exact context match, not by line number, so a patch applies to the right place or fails with `patch_conflict`; there is no fuzzy matching and no PATCH is sent on failure. Generate the diff against the body `workctl issue show` just returned, and use `--expect-updated-at` with that issue's `updated_at` to refuse the write if someone edited it in between.

`--attach FILE[#ALT]` uploads a file on create or edit; GitHub exposes attachment upload only through the `gh issue` command, so a request carrying attachments uses that path and the body still travels on stdin. Alt text is optional and follows `#`.

This reference is duplicated by `workctl issue --help` and `workctl issue edit --help`, which are generated from the same definitions that parse the flags. For an agent, `--help` is the cheaper and safer source: it is read only when needed and cannot drift from the binary.

## Repository context

Inside a Git worktree, `workctl` resolves the repository from the `origin` remote and infers GitHub from its host. Outside a Git worktree, pass both `--provider github` and `--repo owner/repo`. The CLI never assumes GitHub for an unknown or GitLab remote.

Provider precedence is `--provider`, project configuration, then the Git remote host. Repository precedence is `--repo`, then the `origin` remote. Only GitHub is implemented in v0.

Optional strict JSON configuration files are discovered at the Git root and validated on every command, even when CLI flags override provider/repository values:

- `.workctl.json` can be committed for project-wide defaults.
- `.workctl.local.json` overrides fields locally and is gitignored.

Both files must be regular, non-symlink files no larger than 64 KiB. The only supported fields are `provider` and `workItemProvider`, each with value `github` or `gitlab`. A GitLab selection fails explicitly because GitLab support is not part of v0. Unknown fields and malformed JSON fail closed. Legacy `.mcp-tracker*.json` configuration is not read or migrated.

Example:

```json
{
  "workItemProvider": "github"
}
```

## Safety and scope

GitHub requests use `gh` argument arrays; create and edit request bodies are sent as JSON on stdin, except when attachments require the `gh issue` command, which still receives the body on stdin. No shell, direct HTTP client, token management, or automatic download of `gh` is used. One absolute 30-second deadline covers each child process and its pipe workers; captured stdout and drained stderr are capped at 8 MiB each. Body text read from a file or stdin is capped at 1 MiB. Provider diagnostics and internal paths are not copied into user-facing errors.

The first release does not include GitLab, pull requests, boards, comments, relationships, checklists, attachment management beyond uploading, issue deletion, or MCP transport. See [vision](docs/product/vision.md), [requirements](docs/srs.md), [architecture](docs/architecture.md), [ADR-0004](docs/adr/0004-workctl-rust-cli.md), and [ADR-0005](docs/adr/0005-attachments-and-non-rewrite-body-edits.md).

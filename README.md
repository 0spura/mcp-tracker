# workctl

`workctl` is a local Rust CLI for GitHub issues and pull requests: create, list, show, and edit issues, and create, list, show, diff, check, review, merge, update, ready, close, and reopen pull requests. It uses the official `gh` CLI for authenticated GitHub operations; it does not access or store credentials itself.

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

Output is compact JSON by default. Add `--format text` for human-readable output; terminal control characters in provider data are escaped, while body newlines and tabs remain readable. Errors are JSON on stderr with a nonzero exit code. `issue list` returns summaries without bodies; `show`, `create`, and `edit` return full issue data. There is no delete command in this release.

Global options apply before or after the group subcommand:

```sh
workctl --repo owner/repo issue list
workctl issue list --provider github --format text
```

The default list state is `open`; accepted states are `open`, `closed`, and `all`. The limit defaults to 30 and accepts values from 1 through 1000. Create and edit do not prompt interactively. An explicit empty edit body clears the issue body.

## Editing without rewriting the body

An `issue edit` — or a `pr update` — never requires the whole new body. Pick at most one body change per invocation:

| Flag | Effect |
| --- | --- |
| `--body TEXT` / `--body-file FILE` | Replaces the body (`-` reads stdin) |
| `--append-body TEXT` / `--append-body-file FILE` | Appends a new block, keeping one separating newline |
| `--replace-section HEADING --section-body TEXT` / `--section-body-file FILE` | Replaces the content of one ATX section (`## Heading`), leaving other sections alone |
| `--patch-file FILE` | Applies a unified diff to the current body (`-` reads stdin) |

The same table and the same resolver back `pr update`: it fetches the pull request once, applies the change to that text, and sends one write. `issue edit` and `pr update` differ only in the metadata flags they accept.

`--patch-file` takes standard `git diff` output. Hunks are located by exact context match, not by line number, so a patch applies to the right place or fails with `patch_conflict`; there is no fuzzy matching and no write on failure. Generate the diff against the body `workctl issue show` or `workctl pr show` just returned, and use `--expect-updated-at` with that item's `updated_at` to refuse the write if someone edited it in between.

`--attach FILE[#ALT]` uploads a file on issue create or edit; GitHub exposes attachment upload only through the `gh issue` command, so a request carrying attachments uses that path and the body still travels on stdin. Alt text is optional and follows `#`. Pull requests take no attachments.

This reference is duplicated by `workctl issue --help` and `workctl issue edit --help`, which are generated from the same definitions that parse the flags. For an agent, `--help` is the cheaper and safer source: it is read only when needed and cannot drift from the binary.

## Pull requests

```sh
workctl pr create --title "Add pull request support" --body "Implements #12" --base main --closes 12
workctl pr create --title "WIP: parser" --body "Draft" --draft --head feature-x
workctl pr list --state open --limit 30
workctl pr list --state merged --author me --label bug --draft --search "in:title workctl"
workctl pr show 42
workctl pr diff 42
workctl pr diff 42 --name-only
workctl pr checks 42
workctl pr checks 42 --required
workctl pr review 42 --approve --body "Looks good"
workctl pr review 42 --request-changes --body-file review.md
workctl pr review 42 --comment
workctl pr merge 42 --method squash --delete-branch
workctl pr merge 42 --auto --method squash
workctl pr update 42 --title "Updated title"
workctl pr update 42 --append-body "Reproduced on 1.4.2."
workctl pr update 42 --replace-section "## Acceptance" --section-body "New criteria"
workctl pr update 42 --patch-file body.patch
workctl pr update 42 --add-label bug --remove-label stale --add-reviewer hubot --remove-reviewer octocat
workctl pr update 42 --title "Updated title" --expect-updated-at 2026-01-02T00:00:00Z
workctl pr ready 42
workctl pr ready 42 --undo
workctl pr close 42 --comment "Superseded by #43" --delete-branch
workctl pr reopen 42 --comment "Reopening"
```

`pr list` returns summaries without bodies; `show`, `create`, and `update` return full pull request data. List states are `open`, `closed`, `merged`, and `all`, and the default is `open`. `pr diff` prints the patch and `--name-only` limits it to changed file names. `pr checks` returns the check runs and reports `[]` when the pull request has none. `pr review` requires exactly one of `--approve`, `--request-changes`, or `--comment`, and only a top-level review is submitted.

`pr merge` accepts `--method merge|squash|rebase`, `--delete-branch`, and `--auto`. `gh pr merge` needs a merge method, and `workctl` passes none unless you give `--method`, so supply an explicit method whenever `gh` cannot infer one. `pr update` reuses the body-change table above and adds `--base`, `--add-label`/`--remove-label`, `--add-reviewer`/`--remove-reviewer`, `--add-assignee`/`--remove-assignee`, and `--milestone`. `pr ready` marks the pull request ready for review, and `--undo` converts it back to a draft.

Output shape per command: `create`, `show`, and `update` return a pull request object; `list` returns an array of summaries; `diff` returns `{"number", "diff"}`; `checks` returns an array of `{name, state, bucket, description, link, workflow}`; `review` returns `{"number", "event"}`; `merge` returns `{"number", "method", "auto"}`; `ready` returns `{"number", "draft"}`; `close` and `reopen` return `{"number", "state"}`.

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

GitHub requests use `gh` argument arrays; issue requests use `gh api` for single-item reads and writes, and pull request requests use the `gh pr` commands (`create`, `view`, `edit`, `diff`, `checks`, `review`, `merge`, `ready`, `close`, `reopen`). Create and edit bodies are sent as JSON on stdin, except when attachments require the `gh issue` command, which still receives the body on stdin. No shell, direct HTTP client, token management, or automatic download of `gh` is used. One absolute 30-second deadline covers each child process and its pipe workers; captured stdout and drained stderr are capped at 8 MiB each. Body text read from a file or stdin is capped at 1 MiB. Provider diagnostics and internal paths are not copied into user-facing errors.

The release covers GitHub issues and pull requests only. It does not include GitLab, board/project membership, workflow transitions, inline review comments, listing the pull requests linked to an issue, issue-comment threads, relationships or checklists, label/assignee/milestone management on issues, branch creation or checkout, attachments on pull requests or attachment management beyond uploading, deletion, or MCP transport. See [vision](docs/product/vision.md), [requirements](docs/srs.md), [architecture](docs/architecture.md), [ADR-0004](docs/adr/0004-workctl-rust-cli.md), [ADR-0005](docs/adr/0005-attachments-and-non-rewrite-body-edits.md), and [ADR-0006](docs/adr/0006-pull-request-operations.md).

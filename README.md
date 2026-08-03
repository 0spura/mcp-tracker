# mcp-tracker

MCP server for coding agents to interact with code hosts and issue trackers. Install it once for your user, then configure behavior per project.

## How it works

- The server runs as a stdio process started by your MCP client (Cursor, Claude Code, etc).
- All GitHub/GitLab communication goes through the `gh`/`glab` CLIs, which own authentication. This project never reads or stores tokens.
- Install once at user level: point your MCP client at `dist/index.js`.
- Behavior is defined per project via `.mcp-tracker.json` (versioned) and `.mcp-tracker.local.json` (gitignored).
- Value precedence: explicit tool argument > session (`tracker_set_context`) > project config > git derivation.

## Setup

### 1. External dependencies

- Node.js ≥ 18
- `gh` CLI authenticated (for GitHub providers)
- `glab` CLI authenticated (for GitLab providers, optional)
- `git`

### 2. Configure the MCP client at user level

Minimal example:

```json
{
  "mcpServers": {
    "tracker": {
      "command": "node",
      "args": ["/path/to/mcp-tracker/dist/index.js"],
      "env": {}
    }
  }
}
```

> Do not set `CODE_PROVIDER`/`TASK_PROVIDER` in the client env unless you want a global fallback. Each project picks its own providers in `.mcp-tracker.json`.

### 3. Configure per project

Create `.mcp-tracker.json` at the repo root. See the sections below for each field.

## Project configuration

`.mcp-tracker.json` and `.mcp-tracker.local.json` share the same schema. The local file overrides the versioned one field by field, with one exception: `defaults.labels` is concatenated and deduplicated across both files.

### Providers

```json
{
  "codeProvider": "github",
  "taskProvider": "github-projects",
  "localTaskDir": ".tasks"
}
```

- `codeProvider`: `github` | `gitlab`
- `taskProvider`: `github-projects` | `gitlab` | `local`
- `localTaskDir`: directory for local tasks when `taskProvider` is `local` (default: `.tasks`)

Use `taskProvider: "local"` for file-based tracking with markdown files and no external account.

### Repo and board

```json
{
  "repo": "owner/repo",
  "boardId": "1"
}
```

- `repo`: `owner/repo`. Optional when derived from the git remote.
- `boardId`: GitHub Projects V2 number. Only needed for boards.

### Defaults

Values applied automatically when a tool does not receive the argument explicitly:

```json
{
  "defaults": {
    "baseBranch": "main",
    "mergeMethod": "squash",
    "deleteBranchOnMerge": true,
    "reviewers": ["ana"],
    "assignee": "ana",
    "milestone": "Sprint 12",
    "labels": ["agent"]
  }
}
```

- `mergeMethod`: `merge` | `squash` | `rebase`
- `deleteBranchOnMerge`: delete the source branch after `merge_pr`. GitLab does this in the merge call itself; GitHub does an extra ref-delete call after a successful merge, best-effort (failure surfaces as a warning, the merge itself is unaffected).
- `assignee`: use `"$current"` to resolve to the authenticated account (GitLab: `GET user`, GitHub: `gh api /user`). Not resolved by the `local` provider — there is no authenticated account to resolve against, so `"$current"` is stored as a literal string.
- `milestone`: use `"$current"` to dynamically resolve to the active milestone with the nearest upcoming due date
- `labels`: labels applied on issue/PR creation

### Type labels

```json
{
  "typeLabels": {
    "feat": "feature",
    "fix": "bug"
  }
}
```

When configured, `create_issue` accepts a `type` argument. The mapped label is added alongside `defaults.labels`. Unknown types return an error listing the valid keys.

### Workflow

Defines status columns and the automations that move issues between them:

```json
{
  "workflow": {
    "stages": [
      { "key": "design", "name": "In design" },
      { "key": "doing",  "name": "Doing" },
      { "key": "review", "name": "In Review" },
      { "key": "done",   "name": "Done" }
    ],
    "on": {
      "createIssue": "design",
      "createBranch": "doing",
      "createPr": "review",
      "reviewApproved": "done",
      "mergePr": "done"
    }
  }
}
```

- `stages`: ordered list of columns. Each stage is `{ key, name }` or `{ key, name, id }` (fixed native id, no resolution).
- `on`: maps events to stage keys:
  - `createIssue`: new issues land in this stage
  - `createBranch`: creating a branch moves the active issue to this stage
  - `createPr`: creating a PR moves the active issue to this stage
  - `reviewApproved`: approving a PR moves the active issue to this stage
  - `mergePr`: a successful merge moves the active issue to this stage

### Id or name

Most identifiers accept a human-readable name and fall back to the native id when needed:

- `boardId` (GitHub Projects): opaque project node id or `owner/repo/project-number`.
- `workflow.stages`: each stage is `{ key, name }` or `{ key, name, id }`.
- Labels (GitHub): name or numeric label id.
- Milestones: title, `"$current"`, or the native number/id.
- Assignees/reviewers: username, or `"$current"` for the authenticated account.

Names are preferred in versioned configs because they stay readable across renames. Use ids when names are ambiguous.

### Local configuration

`.mcp-tracker.local.json` is useful for personal preferences. The project automatically adds the entry to `.gitignore`.

```json
{
  "activeIssue": "42",
  "defaults": {
    "assignee": "me",
    "labels": ["my-team"]
  }
}
```

- `activeIssue` only makes sense in the local file (it is session state, not config).
- `defaults` fields override the versioned file, except `labels`, which is concatenated.

## Session context

Use `tracker_set_context` to set values that last for the whole session:

- `repo`: `owner/repo` (auto-detected from git when omitted)
- `board_id`: board number
- `active_issue`: issue being worked on; issue tools use it when no number is passed. Pass `null` to clear.
- `default_base`: base branch for new PRs
- `default_reviewers`: default list of reviewers
- `default_merge_method`: `merge` | `squash` | `rebase`
- `default_merge_delete_branch`: delete the source branch on `merge_pr`
- `default_assignee`: default assignee. `"$current"` resolves to the authenticated account.
- `default_milestone`: default milestone

Use `tracker_get_context` to see current values and their sources.

## Complete example

```json
{
  "codeProvider": "github",
  "taskProvider": "github-projects",
  "repo": "my-org/my-repo",
  "boardId": "1",
  "defaults": {
    "baseBranch": "main",
    "mergeMethod": "squash",
    "reviewers": ["ana"],
    "assignee": "ana",
    "milestone": "$current",
    "labels": ["agent"]
  },
  "typeLabels": {
    "feat": "feature",
    "fix": "bug"
  },
  "workflow": {
    "stages": [
      { "key": "backlog", "name": "Backlog" },
      { "key": "doing", "name": "Doing" },
      { "key": "review", "name": "In Review" },
      { "key": "done", "name": "Done" }
    ],
    "on": {
      "createIssue": "backlog",
      "createBranch": "doing",
      "createPr": "review",
      "mergePr": "done"
    }
  }
}
```

## GitLab-only capabilities

A few tools are only registered when the issue provider is `gitlab` — they simply don't appear for other providers, per the "unsupported is explicit" rule (see `docs/architecture.md`):

- `log_time`: logs spent/estimated time on an issue via GitLab's native time-tracking endpoints. No GitHub equivalent exists.
- `upload_attachment`: uploads a local file to the project and returns its markdown link, optionally posting it as a comment right away. GitHub has no stable public REST endpoint for arbitrary issue attachments (the web UI's upload path is undocumented), so this isn't available for GitHub. `create_issue`, `update_issue`, `add_issue_comment`, `add_pr_comment`, and `create_pr` also accept an `attachments` (file paths) argument that uploads and appends the markdown links in the same call, instead of a separate `upload_attachment` round trip.
- `list_linked_items`: reads issues and/or merge requests linked to an issue, filtered by `type` (`issues` | `prs` | `all`) — one tool, not two, so the two link kinds don't need separate calls. GitHub would need GraphQL timeline-event parsing to do this reliably; left out of this pass rather than shipped half-working.

## Development

```bash
npm install
npm run build   # compile to dist/
npm test        # vitest + typecheck
```

## Documentation

- `docs/architecture.md`: architecture decisions, business rules, and internal flows
- `docs/srs.md`: detailed functional and non-functional requirements

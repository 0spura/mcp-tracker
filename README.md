# mcp-tracker

MCP server for interacting with code hosts and issue trackers from agentic coding tools. Everything goes through the `gh` CLI (which owns authentication) and `git`, fully asynchronously.

"Issue" means the generic work item: a GitHub issue, a card, a ticket. Providers map the concept to their native model.

## Architecture

Two independent provider types, selected by environment:

```
CODE_PROVIDER   github                              # branches, PRs, CI checks, reviews
TASK_PROVIDER   github-projects | local             # issues, comments, boards, metadata
```

`CODE_PROVIDER` defaults to `github`. `TASK_PROVIDER` is optional — when unset, issue and board tools are not registered.

Each provider declares a bundle of capabilities and the scopes it needs:

| Bundle member | Tools | Registered when |
|---|---|---|
| `code` | branch, PR, review tools | always |
| `issue` | issue, comment, label, milestone tools | TASK_PROVIDER is set |
| `board` | board tools | TASK_PROVIDER supports boards (github-projects only) |

Optional sub-capabilities on the issue provider (tools registered only when implemented):

| Method | github-projects | local |
|---|---|---|
| `toggleChecklistItem` | ✓ | ✓ |
| `setRelationship` | ✓ | ✓ |
| `addSubIssue` / `listSubIssues` | ✓ | ✓ |
| `listLabels` | ✓ | ✓ |
| `listMilestones` | ✓ | errors explicitly (unsupported) |

Relationship mechanisms on github-projects: `blocks`/`blocked_by` use the native issue-dependencies API; `duplicate` posts a `Duplicate of #N` comment (documented GitHub keyword); `related` posts a cross-reference comment. The tool response names the mechanism used.

## Configuration

Set environment variables in your MCP client config:

```json
{
  "mcpServers": {
    "tracker": {
      "command": "node",
      "args": ["/path/to/mcp-tracker/dist/index.js"],
      "env": {
        "CODE_PROVIDER": "github",
        "TASK_PROVIDER": "github-projects"
      }
    }
  }
}
```

For local file-based tracking (no external account needed):

```json
{
  "env": {
    "CODE_PROVIDER": "github",
    "TASK_PROVIDER": "local",
    "LOCAL_TASK_DIR": ".tasks"
  }
}
```

`TRACKER_PROVIDER` is a backwards-compatible alias for `CODE_PROVIDER`.

The server is installed once at user level; behavior is configured per project. The config file fields `codeProvider`, `taskProvider`, and `localTaskDir` override the env vars, so each project picks its own providers:

```json
{
  "codeProvider": "github",
  "taskProvider": "local",
  "localTaskDir": ".tasks"
}
```

Precedence: project config file > env > default. Cross-project work needs no cwd change: `gh` operates remotely, so `tracker_set_context { repo: "owner/other-project" }` points every issue/PR tool at the other repo.

### Config file

`.mcp-tracker.json` (versioned) with field-level overrides from `.mcp-tracker.local.json` (gitignored):

```json
{
  "repo": "owner/repo",
  "boardId": "1",
  "defaults": {
    "baseBranch": "main",
    "mergeMethod": "squash",
    "reviewers": ["ana"],
    "assignee": "ana",
    "milestone": "Sprint 12",
    "labels": ["agent"]
  },
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
      "createPr": "review"
    }
  }
}
```

- `workflow.stages` is an ordered list of status columns. A stage is `{key, name}` (resolved to native IDs once per session, cached) or `{key, name, id}` (uses the native option ID directly).
- `workflow.on` maps events to stage keys: new issues land in `createIssue`'s stage, branch creation moves the issue to `createBranch`'s, PR creation to `createPr`'s.
- `activeIssue` is valid only in `.mcp-tracker.local.json` (state, not config).

## Context

Set once per session — tools pick it up automatically:

```
tracker_set_context
  repo            owner/repo          auto-detected from git remote when omitted
  board_id        string              GitHub Projects V2 number
  active_issue    number | null       issue being worked on; clears when null
  default_base    branch name         base branch for new PRs
  default_reviewers  [usernames]      added to every PR
  default_merge_method  merge|squash|rebase
  default_assignee  username
  default_milestone  milestone title
```

Resolution precedence for every value: explicit argument > session > config file > git derivation. `tracker_get_context` shows each value with its source.

When `active_issue` is set, these tools use it without requiring an explicit number:
`get_issue`, `update_issue`, `move_issue_status`, `toggle_checklist_item`, `add_issue_comment`, `list_comments` (issue type), `add_sub_issue` (parent), `list_sub_issues`, `set_issue_relationship`.

## Tools

### Context
| Tool | Description |
|---|---|
| `tracker_set_context` | Set repo, board, active issue, and defaults |
| `tracker_get_context` | Show current context with per-value source |

### Branches
| Tool | Description |
|---|---|
| `create_branch` | Create branch off default; linked to issue and idempotent when an issue is resolvable |

### Pull Requests
| Tool | Description |
|---|---|
| `create_pr` | Create PR; applies defaults, appends `Closes #N` for active/listed issues |
| `update_pr` | Generic edit: title, body, state, draft, labels, milestone, reviewer/assignee batches |
| `get_pr` | Get PR details |
| `list_prs` | List PRs by state |
| `get_pr_checks` | Get CI check results (failing logs truncated to a bounded tail) |
| `merge_pr` | Merge PR; applies default_merge_method from context |
| `get_pr_diff` | Get the remote diff; positions for inline review comments |
| `submit_pr_review` | Submit approve/request_changes/comment review with optional inline comments |

### Issues
| Tool | Description |
|---|---|
| `list_issues` | List issues by state, labels, assignee |
| `create_issue` | Create with full initial state: labels, assignees, milestone, status, board fields, relationships, parent |
| `get_issue` | Get issue details |
| `update_issue` | Update title, body, labels, assignees, state, and batch relationship ops |
| `move_issue_status` | Move issue to a status column (stage key or name) |
| `toggle_checklist_item` | Mark/unmark a checklist item by partial text |
| `add_sub_issue` | Add child issue to parent |
| `list_sub_issues` | List child issues |
| `set_issue_relationship` | Set blocks/blocked_by/related/duplicate; response names the mechanism used |

Composite creates and updates apply the primary change first and every secondary change best-effort; failures come back in a `warnings` array, never silently.

### Comments
| Tool | Description |
|---|---|
| `add_issue_comment` | Add comment to issue |
| `add_pr_comment` | Add comment to PR |
| `list_comments` | List comments on issue or PR |

### Board (github-projects only)
| Tool | Description |
|---|---|
| `list_board_items` | List all items on the board (full pagination) |
| `list_board_fields` | List custom fields and options |
| `add_issue_to_board` | Add issue to board; returns item ID |
| `set_item_fields` | Set field values (Size, Priority, Sprint, etc.) |

### Metadata
| Tool | Description |
|---|---|
| `list_labels` | List repository labels |
| `list_milestones` | List milestones |

## Working on an issue

Set `active_issue` once — all issue tools use it automatically for the rest of the session:

```
tracker_set_context { active_issue: 42 }
get_issue                                      # reads #42
toggle_checklist_item { item_text: "tests" }   # marks progress on #42
move_issue_status { status: "Done" }           # closes the loop
```

The issue body (Goal, Acceptance, Verification) is the goal spec. The checklist is the state. Parent/child relationships are the execution graph.

## Development

```
npm run build     # tsc
npm test          # vitest + typecheck
```

## Source layout

Organized by domain: each domain holds its interface, implementations, and tools.

```
src/
  core/          process (async execFile, the only child_process site), errors,
                 types, scope, bundle, checklist
  context/       store, config (nested schema), git derivation, context tools
  transport/     gh.ts — validated REST/GraphQL runner (injectable GhRunner)
  domains/
    code/        CodeProvider + github impl + branch/PR/review tools
    issues/      IssueProvider + github-projects and local impls + tools
    boards/      BoardProvider + github-projects impl + tools
    comments/    comment tools
    local/       markdown file storage engine
  server.ts      provider resolution + tool registration
  index.ts       stdio entry
test/
  contract/      shared IssueProvider contract suite
  helpers/       scripted GhRunner fake
```

Design docs live in `docs/` (vision, SRS, architecture, ADRs).

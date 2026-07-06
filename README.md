# mcp-tracker

MCP server for interacting with code hosts and issue trackers from Claude Code.

## Architecture

Two independent provider types, both optional depending on what you need:

```
CODE_PROVIDER   github | gitlab                          # branches, PRs, CI checks
TASK_PROVIDER   github-projects | gitlab-boards | local  # issues, comments, metadata
```

`CODE_PROVIDER` defaults to `github`. `TASK_PROVIDER` is optional — when unset, issue and board tools are not registered.

Each provider type maps to a focused interface:

| Interface | Methods | Registered when |
|---|---|---|
| `CodeProvider` | createBranch, createPR, updatePR, getPR, listPRs, mergePR, getPRChecks, requestReviewers, addPRComment, listPRComments | always |
| `IssueProvider` | listIssues, createIssue, getIssue, updateIssue, setIssueStatus, addIssueComment, listIssueComments | TASK_PROVIDER is set |
| `BoardProvider` | listBoardItems, listBoardFields, addIssueToBoard, setItemFields | TASK_PROVIDER supports boards (github-projects only) |
| `MetadataProvider` | listLabels, listMilestones | TASK_PROVIDER is set |

Optional sub-capabilities on `IssueProvider` (only registered if the provider implements them):

| Method | github-projects | gitlab-boards | local |
|---|---|---|---|
| `toggleChecklistItem` | ✓ | ✓ | ✓ |
| `setRelationship` | ✓ | ✓ | ✓ |
| `addSubIssue` / `listSubIssues` | ✓ | — | — |

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

When `active_issue` is set, these tools use it without requiring an explicit number:
`get_issue`, `update_issue`, `move_issue_status`, `toggle_checklist_item`, `add_issue_comment`, `list_comments` (issue type), `add_sub_issue` (parent), `list_sub_issues`, `set_issue_relationship`.

## Tools

### Context
| Tool | Description |
|---|---|
| `tracker_set_context` | Set repo, board, active issue, and defaults |
| `tracker_get_context` | Show current context |

### Branches (CodeProvider)
| Tool | Description |
|---|---|
| `create_branch` | Create branch off default; optionally link to issue |

### Pull Requests (CodeProvider)
| Tool | Description |
|---|---|
| `create_pr` | Create PR; applies default_base and default_reviewers from context |
| `update_pr` | Update title or body |
| `get_pr` | Get PR details |
| `list_prs` | List PRs by state |
| `get_pr_checks` | Get CI check results |
| `merge_pr` | Merge PR; applies default_merge_method from context |

### Issues (IssueProvider)
| Tool | Description |
|---|---|
| `list_issues` | List issues by state, labels, assignee |
| `create_issue` | Create issue; auto-adds to board when board context is set |
| `get_issue` | Get issue details |
| `update_issue` | Update title, body, labels, assignees, or state |
| `move_issue_status` | Move issue to a status column |
| `toggle_checklist_item` | Mark/unmark a checklist item by partial text |
| `add_sub_issue` | Add child issue to parent (GitHub only) |
| `list_sub_issues` | List child issues (GitHub only) |
| `set_issue_relationship` | Set blocks/blocked_by/related/duplicate relationship |

### Comments (CodeProvider + IssueProvider)
| Tool | Description |
|---|---|
| `add_issue_comment` | Add comment to issue |
| `add_pr_comment` | Add comment to PR |
| `list_comments` | List comments on issue or PR |

### Board (BoardProvider — github-projects only)
| Tool | Description |
|---|---|
| `list_board_items` | List all items on the board |
| `list_board_fields` | List custom fields and options |
| `add_issue_to_board` | Add issue to board; returns item ID |
| `set_item_fields` | Set field values (Size, Priority, Sprint, etc.) |

### Metadata (MetadataProvider)
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

## Source layout

```
src/
  interfaces/
    code.ts          CodeProvider
    issue.ts         IssueProvider + ListIssuesOptions
    board.ts         BoardProvider
    metadata.ts      MetadataProvider
    types.ts         shared types
  providers/
    github/          CodeProvider — gh CLI + GraphQL
    github-projects/ IssueProvider + BoardProvider + MetadataProvider — gh CLI + GraphQL
    gitlab/          CodeProvider — glab CLI
    gitlab-boards/   IssueProvider + MetadataProvider — glab CLI
    local/           IssueProvider + MetadataProvider — markdown files in .tasks/
  tools/
    branches.ts, prs.ts, issues.ts, comments.ts, boards.ts, metadata.ts, context.ts
  context.ts         ContextStore
  server.ts          provider resolution + tool registration
```

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ContextStore } from "../context.js";
import type { IssueProvider } from "../interfaces/issue.js";
import type { BoardProvider } from "../interfaces/board.js";
import { REPO_PARAM, json, text } from "./helpers.js";

export function registerIssueTools(server: McpServer, issue: IssueProvider, board: BoardProvider | null, ctx: ContextStore): void {
  server.tool(
    "list_issues",
    "List issues in a repository",
    {
      repo: REPO_PARAM,
      state: z.enum(["open", "closed", "all"]).optional().describe("Defaults to open"),
      labels: z.array(z.string()).optional(),
      assignee: z.string().optional(),
      limit: z.number().int().positive().optional().describe("Max results, defaults to 50"),
    },
    async ({ repo, state, labels, assignee, limit }) =>
      json(await issue.listIssues(ctx.resolveRepo(repo), { state, labels, assignee, limit }))
  );

  server.tool(
    "create_issue",
    board
      ? "Create a new issue. When board context is set, automatically adds the issue to the board and sets any provided field values."
      : "Create a new issue.",
    {
      repo: REPO_PARAM,
      title: z.string(),
      body: z.string(),
      labels: z.array(z.string()).optional(),
      assignees: z.array(z.string()).optional().describe("Defaults to default_assignee from context if set"),
      milestone: z.string().optional().describe("Milestone title"),
      ...(board ? { fields: z.record(z.string()).optional().describe("Board field values, e.g. { \"Size\": \"M\", \"Priority\": \"High\" }. Requires board context.") } : {}),
    },
    async ({ repo, title, body, labels, assignees, milestone, ...rest }) => {
      const resolvedRepo = ctx.resolveRepo(repo);
      const resolvedAssignees = assignees ?? (ctx.defaultAssignee ? [ctx.defaultAssignee] : undefined);
      const resolvedMilestone = milestone ?? ctx.defaultMilestone ?? undefined;
      const resolvedLabels = [...(ctx.defaultLabels ?? []), ...(labels ?? [])];
      const created = await issue.createIssue(resolvedRepo, title, body, {
        labels: resolvedLabels.length ? resolvedLabels : undefined,
        assignees: resolvedAssignees,
        milestone: resolvedMilestone,
      });

      const fields = (rest as { fields?: Record<string, string> }).fields;
      if (board && ctx.boardId) {
        const itemId = await board.addIssueToBoard(resolvedRepo, created.number, ctx.boardId);
        if (fields && Object.keys(fields).length > 0) {
          await board.setItemFields(resolvedRepo, ctx.boardId, itemId, fields);
        }
        return json({ ...created, board_item_id: itemId });
      }

      return json(created);
    }
  );

  server.tool(
    "get_issue",
    "Get issue details. Targets the active issue (current branch, or a set_context override) when issue_number is omitted.",
    {
      repo: REPO_PARAM,
      issue_number: z.number().int().positive().optional().describe("Defaults to the active issue derived from the current branch"),
    },
    async ({ repo, issue_number }) =>
      json(await issue.getIssue(ctx.resolveRepo(repo), ctx.resolveIssue(issue_number)))
  );

  server.tool(
    "update_issue",
    "Update an issue — title, body, labels, assignees, or state",
    {
      repo: REPO_PARAM,
      issue_number: z.number().int().positive().optional().describe("Defaults to the active issue derived from the current branch"),
      title: z.string().optional(),
      body: z.string().optional(),
      labels: z.array(z.string()).optional(),
      assignees: z.array(z.string()).optional(),
      state: z.enum(["open", "closed"]).optional(),
    },
    async ({ repo, issue_number, ...opts }) =>
      json(await issue.updateIssue(ctx.resolveRepo(repo), ctx.resolveIssue(issue_number), opts))
  );

  server.tool(
    "move_issue_status",
    "Move an issue to a status column on the board. Targets the active issue (current branch, or a set_context override) when issue_number is omitted.",
    {
      repo: REPO_PARAM,
      issue_number: z.number().int().positive().optional().describe("Defaults to the active issue derived from the current branch"),
      status: z.string().describe("Status column name, e.g. 'In Progress', 'In Review', 'Done'"),
    },
    async ({ repo, issue_number, status }) => {
      const n = ctx.resolveIssue(issue_number);
      const resolvedStatus = ctx.statusLabels[status] ?? status;
      const allLabels = Object.values(ctx.statusLabels);
      await issue.setIssueStatus(ctx.resolveRepo(repo), n, resolvedStatus, allLabels.length ? allLabels : undefined);
      return text(`Issue #${n} moved to "${status}"`);
    }
  );

  if (issue.toggleChecklistItem) {
    server.tool(
      "toggle_checklist_item",
      "Mark or unmark a checklist item in an issue body. Targets the active issue (current branch, or a set_context override) when issue_number is omitted.",
      {
        repo: REPO_PARAM,
        issue_number: z.number().int().positive().optional().describe("Defaults to the active issue derived from the current branch"),
        item_text: z.string().describe("Partial or full text of the checklist item to toggle"),
        checked: z.boolean().optional().describe("Force to checked (true) or unchecked (false). Omit to toggle."),
      },
      async ({ repo, issue_number, item_text, checked }) => {
        const result = await issue.toggleChecklistItem!(ctx.resolveRepo(repo), ctx.resolveIssue(issue_number), item_text, checked);
        return text(`"${result.matched}" → ${result.checked ? "[x]" : "[ ]"}`);
      }
    );
  }

  if (issue.addSubIssue) {
    server.tool(
      "add_sub_issue",
      "Add a child (sub) issue to a parent issue",
      {
        repo: REPO_PARAM,
        parent_number: z.number().int().positive().optional().describe("Defaults to the active issue derived from the current branch"),
        child_number: z.number().int().positive(),
      },
      async ({ repo, parent_number, child_number }) => {
        const parent = ctx.resolveIssue(parent_number);
        await issue.addSubIssue!(ctx.resolveRepo(repo), parent, child_number);
        return text(`Issue #${child_number} added as sub-issue of #${parent}`);
      }
    );
  }

  if (issue.listSubIssues) {
    server.tool(
      "list_sub_issues",
      "List sub-issues of a parent issue. Targets the active issue (current branch, or a set_context override) when issue_number is omitted.",
      {
        repo: REPO_PARAM,
        issue_number: z.number().int().positive().optional().describe("Defaults to the active issue derived from the current branch"),
      },
      async ({ repo, issue_number }) =>
        json(await issue.listSubIssues!(ctx.resolveRepo(repo), ctx.resolveIssue(issue_number)))
    );
  }

  if (issue.setRelationship) {
    server.tool(
      "set_issue_relationship",
      "Set a relationship between two issues. The source defaults to the active issue (current branch, or a set_context override) when issue_number is omitted.",
      {
        repo: REPO_PARAM,
        issue_number: z.number().int().positive().optional().describe("Defaults to the active issue derived from the current branch"),
        type: z.enum(["blocks", "blocked_by", "related", "duplicate"]),
        target_number: z.number().int().positive(),
      },
      async ({ repo, issue_number, type, target_number }) => {
        const n = ctx.resolveIssue(issue_number);
        await issue.setRelationship!(ctx.resolveRepo(repo), n, type, target_number);
        return text(`Issue #${n} ${type} #${target_number}`);
      }
    );
  }
}

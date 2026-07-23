import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ContextStore } from "../context.js";
import type { IssueProvider } from "../interfaces/issue.js";
import type { BoardProvider } from "../interfaces/board.js";
import { REPO_PARAM, ISSUE_NUMBER_PARAM, json, text } from "./helpers.js";

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
      type: z.string().optional().describe("Issue type, e.g. 'feature', 'bug'. Resolved to a label via typeLabels in .mcp-tracker.json; passed through as-is if not mapped."),
      labels: z.array(z.string()).optional(),
      assignees: z.array(z.string()).optional().describe("Defaults to default_assignee from context if set"),
      milestone: z.string().optional().describe("Milestone title"),
      ...(board ? { fields: z.record(z.string()).optional().describe("Board field values, e.g. { \"Size\": \"M\", \"Priority\": \"High\" }. Requires board context.") } : {}),
    },
    async ({ repo, title, body, type, labels, assignees, milestone, ...rest }) => {
      const resolvedRepo = ctx.resolveRepo(repo);
      const resolvedAssignees = assignees ?? (ctx.defaultAssignee ? [ctx.defaultAssignee] : undefined);
      const resolvedMilestone = milestone ?? ctx.defaultMilestone ?? undefined;
      const resolvedType = type ? (ctx.typeLabels[type] ?? type) : undefined;
      const resolvedLabels = [...(ctx.defaultLabels ?? []), ...(resolvedType ? [resolvedType] : []), ...(labels ?? [])];
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
    "Get issue details.",
    {
      repo: REPO_PARAM,
      issue_number: ISSUE_NUMBER_PARAM,
    },
    async ({ repo, issue_number }) =>
      json(await issue.getIssue(ctx.resolveRepo(repo), ctx.resolveIssue(issue_number)))
  );

  server.tool(
    "update_issue",
    "Update an issue's title, body, labels, assignees, state, or board status.",
    {
      repo: REPO_PARAM,
      issue_number: ISSUE_NUMBER_PARAM,
      title: z.string().optional(),
      body: z.string().optional(),
      labels: z.array(z.string()).optional(),
      assignees: z.array(z.string()).optional(),
      state: z.enum(["open", "closed"]).optional(),
      status: z.string().optional().describe("Board status, e.g. 'In Progress'. Resolved via statusLabels in .mcp-tracker.json."),
    },
    async ({ repo, issue_number, status, ...opts }) => {
      const resolvedRepo = ctx.resolveRepo(repo);
      const n = ctx.resolveIssue(issue_number);
      const hasFieldEdits = Object.values(opts).some((v) => v !== undefined);
      const result = hasFieldEdits ? await issue.updateIssue(resolvedRepo, n, opts) : await issue.getIssue(resolvedRepo, n);

      if (status !== undefined) {
        const resolvedStatus = ctx.statusLabels[status] ?? status;
        const allLabels = Object.values(ctx.statusLabels);
        await issue.setIssueStatus(resolvedRepo, n, resolvedStatus, allLabels.length ? allLabels : undefined);
      }

      return json(result);
    }
  );

  if (issue.toggleChecklistItem) {
    server.tool(
      "toggle_checklist_item",
      "Mark or unmark a checklist item in an issue body.",
      {
        repo: REPO_PARAM,
        issue_number: ISSUE_NUMBER_PARAM,
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
        parent_number: ISSUE_NUMBER_PARAM,
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
      "List sub-issues of a parent issue.",
      {
        repo: REPO_PARAM,
        issue_number: ISSUE_NUMBER_PARAM,
      },
      async ({ repo, issue_number }) =>
        json(await issue.listSubIssues!(ctx.resolveRepo(repo), ctx.resolveIssue(issue_number)))
    );
  }

  if (issue.setRelationship) {
    server.tool(
      "set_issue_relationship",
      "Set a relationship between two issues.",
      {
        repo: REPO_PARAM,
        issue_number: ISSUE_NUMBER_PARAM,
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

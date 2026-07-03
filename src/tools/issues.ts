import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ContextStore } from "../context.js";
import type { TrackerProvider } from "../provider.js";
import { REPO_PARAM, json, text } from "./helpers.js";

export function registerIssueTools(server: McpServer, provider: TrackerProvider, ctx: ContextStore): void {
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
      json(await provider.listIssues(ctx.resolveRepo(repo), { state, labels, assignee, limit }))
  );

  server.tool(
    "create_issue",
    "Create a new issue. When board context is set, automatically adds the issue to the board and sets any provided field values.",
    {
      repo: REPO_PARAM,
      title: z.string(),
      body: z.string(),
      labels: z.array(z.string()).optional(),
      assignees: z.array(z.string()).optional().describe("Defaults to default_assignee from context if set"),
      milestone: z.string().optional().describe("Milestone title"),
      fields: z.record(z.string()).optional().describe("Board field values, e.g. { \"Size\": \"M\", \"Priority\": \"High\" }. Requires board context."),
    },
    async ({ repo, title, body, labels, assignees, milestone, fields }) => {
      const resolvedRepo = ctx.resolveRepo(repo);
      const resolvedAssignees = assignees ?? (ctx.defaultAssignee ? [ctx.defaultAssignee] : undefined);
      const resolvedMilestone = milestone ?? ctx.defaultMilestone ?? undefined;
      const issue = await provider.createIssue(resolvedRepo, title, body, {
        labels,
        assignees: resolvedAssignees,
        milestone: resolvedMilestone,
      });

      if (ctx.boardId) {
        const itemId = await provider.addIssueToBoard(resolvedRepo, issue.number, ctx.boardId);
        if (fields && Object.keys(fields).length > 0) {
          await provider.setItemFields(resolvedRepo, ctx.boardId, itemId, fields);
        }
        return json({ ...issue, board_item_id: itemId });
      }

      return json(issue);
    }
  );

  server.tool(
    "get_issue",
    "Get issue details",
    {
      repo: REPO_PARAM,
      number: z.number().int().positive(),
    },
    async ({ repo, number }) => json(await provider.getIssue(ctx.resolveRepo(repo), number))
  );

  server.tool(
    "update_issue",
    "Update an issue — title, body, labels, assignees, or state",
    {
      repo: REPO_PARAM,
      number: z.number().int().positive(),
      title: z.string().optional(),
      body: z.string().optional(),
      labels: z.array(z.string()).optional(),
      assignees: z.array(z.string()).optional(),
      state: z.enum(["open", "closed"]).optional(),
    },
    async ({ repo, number, ...opts }) =>
      json(await provider.updateIssue(ctx.resolveRepo(repo), number, opts))
  );

  server.tool(
    "move_issue_status",
    "Move an issue to a status column on the board",
    {
      repo: REPO_PARAM,
      issue_number: z.number().int().positive(),
      status: z.string().describe("Status column name, e.g. 'In Progress', 'In Review', 'Done'"),
    },
    async ({ repo, issue_number, status }) => {
      await provider.setIssueStatus(ctx.resolveRepo(repo), issue_number, status);
      return text(`Issue #${issue_number} moved to "${status}"`);
    }
  );

  server.tool(
    "toggle_checklist_item",
    "Mark or unmark a checklist item in an issue body. Matches by substring — no need for the exact full text.",
    {
      repo: REPO_PARAM,
      issue_number: z.number().int().positive(),
      item_text: z.string().describe("Partial or full text of the checklist item to toggle"),
      checked: z.boolean().optional().describe("Force to checked (true) or unchecked (false). Omit to toggle."),
    },
    async ({ repo, issue_number, item_text, checked }) => {
      const result = await provider.toggleChecklistItem(ctx.resolveRepo(repo), issue_number, item_text, checked);
      return text(`"${result.matched}" → ${result.checked ? "[x]" : "[ ]"}`);
    }
  );

  server.tool(
    "add_sub_issue",
    "Add a child (sub) issue to a parent issue",
    {
      repo: REPO_PARAM,
      parent_number: z.number().int().positive(),
      child_number: z.number().int().positive(),
    },
    async ({ repo, parent_number, child_number }) => {
      await provider.addSubIssue(ctx.resolveRepo(repo), parent_number, child_number);
      return text(`Issue #${child_number} added as sub-issue of #${parent_number}`);
    }
  );

  server.tool(
    "list_sub_issues",
    "List sub-issues of a parent issue",
    {
      repo: REPO_PARAM,
      parent_number: z.number().int().positive(),
    },
    async ({ repo, parent_number }) =>
      json(await provider.listSubIssues(ctx.resolveRepo(repo), parent_number))
  );

  server.tool(
    "set_issue_relationship",
    "Set a relationship between two issues",
    {
      repo: REPO_PARAM,
      issue_number: z.number().int().positive(),
      type: z.enum(["blocks", "blocked_by", "related", "duplicate"]),
      target_number: z.number().int().positive(),
    },
    async ({ repo, issue_number, type, target_number }) => {
      await provider.setRelationship(ctx.resolveRepo(repo), issue_number, type, target_number);
      return text(`Issue #${issue_number} ${type} #${target_number}`);
    }
  );
}

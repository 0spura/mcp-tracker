import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ContextStore } from "./context.js";
import { GitHubProvider } from "./github/provider.js";
import type { TrackerProvider } from "./provider.js";

const REPO_PARAM = z
  .string()
  .optional()
  .describe("Repository as owner/repo. Omit to use current git remote or context set via tracker_set_context.");

function json(value: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function text(message: string): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: message }] };
}

export function createServer(): McpServer {
  const provider: TrackerProvider = new GitHubProvider();
  const ctx = new ContextStore();
  const server = new McpServer({ name: "tracker", version: "1.0.0" });

  // --- Context management ---

  server.tool(
    "tracker_set_context",
    "Set project context so you don't have to repeat repo/project in every call. Detected automatically from git remote when omitted.",
    {
      repo: z.string().optional().describe("Repository as owner/repo"),
      project_number: z.number().int().positive().optional().describe("GitHub Projects V2 number"),
      default_assignee: z.string().optional().describe("GitHub username to assign by default"),
      default_base: z.string().optional().describe("Default base branch for PRs, e.g. dev or main"),
      default_merge_method: z.enum(["merge", "squash", "rebase"]).optional().describe("Default merge method for merge_pr"),
      default_reviewers: z.array(z.string()).optional().describe("GitHub usernames to request review from on every PR"),
      default_milestone: z.string().optional().describe("Milestone title to apply to new issues by default"),
    },
    async ({ repo, project_number, default_assignee, default_base, default_merge_method, default_reviewers, default_milestone }) => {
      ctx.set({
        repo,
        projectNumber: project_number,
        defaultAssignee: default_assignee,
        defaultBase: default_base,
        defaultMergeMethod: default_merge_method,
        defaultReviewers: default_reviewers,
        defaultMilestone: default_milestone,
      });
      return json(ctx.snapshot());
    }
  );

  server.tool(
    "tracker_get_context",
    "Show the current project context (repo, project number, default assignee).",
    {},
    async () => json(ctx.snapshot())
  );

  // --- Issues ---

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
    "Create a new issue. When project context is set, automatically adds the issue to the project and sets any provided field values (Size, Priority, etc.).",
    {
      repo: REPO_PARAM,
      title: z.string(),
      body: z.string(),
      labels: z.array(z.string()).optional(),
      assignees: z.array(z.string()).optional().describe("Defaults to default_assignee from context if set"),
      milestone: z.string().optional().describe("Milestone title"),
      project_fields: z.record(z.string()).optional().describe("Custom project field values, e.g. { \"Size\": \"M\", \"Priority\": \"High\" }. Requires project context."),
    },
    async ({ repo, title, body, labels, assignees, milestone, project_fields }) => {
      const resolvedRepo = ctx.resolveRepo(repo);
      const resolvedAssignees = assignees ?? (ctx.defaultAssignee ? [ctx.defaultAssignee] : undefined);
      const resolvedMilestone = milestone ?? ctx.defaultMilestone ?? undefined;
      const issue = await provider.createIssue(resolvedRepo, title, body, {
        labels,
        assignees: resolvedAssignees,
        milestone: resolvedMilestone,
      });

      if (ctx.projectNumber) {
        const itemId = await provider.addIssueToProject(resolvedRepo, issue.number, ctx.projectNumber);
        if (project_fields && Object.keys(project_fields).length > 0) {
          await provider.setProjectItemFields(resolvedRepo, ctx.projectNumber, itemId, project_fields);
        }
        return json({ ...issue, project_item_id: itemId });
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
    "Move an issue's project card to a status column",
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

  // --- Branches ---

  server.tool(
    "create_linked_branch",
    "Create a new branch off the default branch and link it to an issue",
    {
      repo: REPO_PARAM,
      issue_number: z.number().int().positive(),
      branch_name: z.string(),
    },
    async ({ repo, issue_number, branch_name }) => {
      const branch = await provider.createLinkedBranch(ctx.resolveRepo(repo), issue_number, branch_name);
      return text(`Branch "${branch.name}" created and linked to issue #${issue_number}`);
    }
  );

  server.tool(
    "link_branch",
    "Link an existing branch to an issue",
    {
      repo: REPO_PARAM,
      issue_number: z.number().int().positive(),
      branch_name: z.string(),
    },
    async ({ repo, issue_number, branch_name }) => {
      await provider.linkBranch(ctx.resolveRepo(repo), issue_number, branch_name);
      return text(`Branch "${branch_name}" linked to issue #${issue_number}`);
    }
  );

  // --- Pull Requests ---

  server.tool(
    "create_pr",
    "Create a pull request. Uses default_base and default_reviewers from context when set.",
    {
      repo: REPO_PARAM,
      title: z.string(),
      body: z.string(),
      head: z.string().describe("Head branch"),
      base: z.string().optional().describe("Base branch. Falls back to default_base from context, then repo default branch."),
      reviewers: z.array(z.string()).optional().describe("Reviewers to request. Merged with default_reviewers from context."),
    },
    async ({ repo, title, body, head, base, reviewers }) => {
      const resolvedRepo = ctx.resolveRepo(repo);
      const resolvedBase = base ?? ctx.defaultBase ?? undefined;
      const pr = await provider.createPR(resolvedRepo, title, body, head, resolvedBase);

      const allReviewers = [...new Set([...(ctx.defaultReviewers ?? []), ...(reviewers ?? [])])];
      if (allReviewers.length > 0) {
        await provider.requestReviewers(resolvedRepo, pr.number, allReviewers);
      }

      return json(pr);
    }
  );

  server.tool(
    "update_pr",
    "Update a pull request's title or body",
    {
      repo: REPO_PARAM,
      number: z.number().int().positive(),
      title: z.string().optional(),
      body: z.string().optional(),
    },
    async ({ repo, number, title, body }) =>
      json(await provider.updatePR(ctx.resolveRepo(repo), number, { title, body }))
  );

  server.tool(
    "get_pr_checks",
    "Get CI check results for a pull request",
    {
      repo: REPO_PARAM,
      number: z.number().int().positive(),
    },
    async ({ repo, number }) => json(await provider.getPRChecks(ctx.resolveRepo(repo), number))
  );

  server.tool(
    "list_prs",
    "List pull requests in a repository",
    {
      repo: REPO_PARAM,
      state: z.enum(["open", "closed", "all"]).optional().describe("Defaults to open"),
      limit: z.number().int().positive().optional().describe("Max results, defaults to 50"),
    },
    async ({ repo, state, limit }) => json(await provider.listPRs(ctx.resolveRepo(repo), { state, limit }))
  );

  server.tool(
    "get_pr",
    "Get pull request details",
    {
      repo: REPO_PARAM,
      number: z.number().int().positive(),
    },
    async ({ repo, number }) => json(await provider.getPR(ctx.resolveRepo(repo), number))
  );

  server.tool(
    "add_issue_comment",
    "Add a comment to an issue",
    {
      repo: REPO_PARAM,
      number: z.number().int().positive(),
      body: z.string(),
    },
    async ({ repo, number, body }) => {
      await provider.addIssueComment(ctx.resolveRepo(repo), number, body);
      return text(`Comment added to issue #${number}`);
    }
  );

  server.tool(
    "list_labels",
    "List all labels in a repository",
    { repo: REPO_PARAM },
    async ({ repo }) => json(await provider.listLabels(ctx.resolveRepo(repo)))
  );

  server.tool(
    "list_milestones",
    "List milestones in a repository",
    {
      repo: REPO_PARAM,
      state: z.enum(["open", "closed", "all"]).optional().describe("Defaults to open"),
    },
    async ({ repo, state }) => json(await provider.listMilestones(ctx.resolveRepo(repo), state))
  );

  server.tool(
    "list_project_items",
    "List all items in a GitHub Project V2",
    {
      repo: REPO_PARAM,
      project_number: z.number().int().positive().optional().describe("Project number. Uses context if set."),
    },
    async ({ repo, project_number }) => {
      const pn = project_number ?? ctx.projectNumber;
      if (!pn) throw new Error("project_number is required. Set it via tracker_set_context or pass it explicitly.");
      return json(await provider.listProjectItems(ctx.resolveRepo(repo), pn));
    }
  );

  server.tool(
    "list_project_fields",
    "List all custom fields and their options for a GitHub Project V2. Call this before creating issues to know which fields (Size, Effort, Priority, etc.) are available.",
    {
      repo: REPO_PARAM,
      project_number: z.number().int().positive().optional().describe("Project number. Uses context if set."),
    },
    async ({ repo, project_number }) => {
      const pn = project_number ?? ctx.projectNumber;
      if (!pn) throw new Error("project_number is required. Set it via tracker_set_context or pass it explicitly.");
      return json(await provider.listProjectFields(ctx.resolveRepo(repo), pn));
    }
  );

  server.tool(
    "add_issue_to_project",
    "Add an existing issue to a GitHub Project V2. Returns the project item ID needed for set_issue_fields.",
    {
      repo: REPO_PARAM,
      issue_number: z.number().int().positive(),
      project_number: z.number().int().positive().optional().describe("Project number. Uses context if set."),
    },
    async ({ repo, issue_number, project_number }) => {
      const pn = project_number ?? ctx.projectNumber;
      if (!pn) throw new Error("project_number is required. Set it via tracker_set_context or pass it explicitly.");
      const itemId = await provider.addIssueToProject(ctx.resolveRepo(repo), issue_number, pn);
      return json({ item_id: itemId });
    }
  );

  server.tool(
    "set_issue_fields",
    "Set custom field values (Size, Effort, Priority, Sprint, etc.) on an issue's project card. Use list_project_fields first to see available fields and options.",
    {
      repo: REPO_PARAM,
      project_number: z.number().int().positive().optional().describe("Project number. Uses context if set."),
      item_id: z.string().describe("Project item ID returned by add_issue_to_project or list_project_items"),
      fields: z.record(z.string()).describe("Field name → value pairs, e.g. { \"Size\": \"M\", \"Priority\": \"High\" }"),
    },
    async ({ repo, project_number, item_id, fields }) => {
      const pn = project_number ?? ctx.projectNumber;
      if (!pn) throw new Error("project_number is required. Set it via tracker_set_context or pass it explicitly.");
      await provider.setProjectItemFields(ctx.resolveRepo(repo), pn, item_id, fields);
      return text(`Fields updated: ${Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(", ")}`);
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
    "merge_pr",
    "Merge a pull request. Uses default_merge_method from context when set.",
    {
      repo: REPO_PARAM,
      number: z.number().int().positive(),
      method: z.enum(["merge", "squash", "rebase"]).optional().describe("Merge method. Falls back to default_merge_method from context, then squash."),
    },
    async ({ repo, number, method }) => {
      const resolvedMethod = method ?? ctx.defaultMergeMethod ?? "squash";
      await provider.mergePR(ctx.resolveRepo(repo), number, resolvedMethod);
      return text(`PR #${number} merged via ${resolvedMethod}`);
    }
  );

  server.tool(
    "add_pr_comment",
    "Add a comment to a pull request",
    {
      repo: REPO_PARAM,
      number: z.number().int().positive(),
      body: z.string(),
    },
    async ({ repo, number, body }) => {
      await provider.addPRComment(ctx.resolveRepo(repo), number, body);
      return text(`Comment added to PR #${number}`);
    }
  );

  server.tool(
    "list_comments",
    "List comments on an issue or pull request",
    {
      repo: REPO_PARAM,
      type: z.enum(["issue", "pr"]).describe("Whether the number refers to an issue or a PR"),
      number: z.number().int().positive(),
    },
    async ({ repo, type, number }) =>
      json(await provider.listComments(ctx.resolveRepo(repo), type, number))
  );

  server.tool(
    "list_sub_issues",
    "List sub-issues of a parent issue",
    {
      repo: REPO_PARAM,
      parent_number: z.number().int().positive(),
    },
    async ({ repo, parent_number }) => json(await provider.listSubIssues(ctx.resolveRepo(repo), parent_number))
  );

  // --- Relationships ---

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

  return server;
}

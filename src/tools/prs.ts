import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ContextStore } from "../context.js";
import type { CodeProvider } from "../interfaces/code.js";
import type { IssueProvider } from "../interfaces/issue.js";
import { REPO_PARAM, json, text } from "./helpers.js";

export function registerPRTools(server: McpServer, code: CodeProvider, ctx: ContextStore, issue?: IssueProvider): void {
  server.tool(
    "create_pr",
    "Create a pull request. Uses default_base and default_reviewers from context when set. When the issue is derivable from the head branch, the description gets a \"Closes #N\" so GitLab/GitHub close the issue automatically on merge, and the issue moves to the configured \"In Review\" status now.",
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

      // Auto-link: close the issue on merge when derivable from branch, following
      // GitLab/GitHub's closing-pattern convention (Closes #N / Fixes #N).
      let resolvedBody = body;
      const issueMatch = head.match(/(?:^|\/)(\d+)(?:-|$)/);
      if (issueMatch && !body.includes(`#${issueMatch[1]}`)) {
        resolvedBody = `${body}\n\nCloses #${issueMatch[1]}`;
      }

      const pr = await code.createPR(resolvedRepo, title, resolvedBody, head, resolvedBase);

      const allReviewers = [...new Set([...(ctx.defaultReviewers ?? []), ...(reviewers ?? [])])];
      if (allReviewers.length > 0) {
        await code.requestReviewers(resolvedRepo, pr.number, allReviewers);
      }

      // Auto-move issue to "In Review" when opening a PR for it, if configured
      const reviewLabel = ctx.statusLabels["In Review"];
      if (issueMatch && issue && reviewLabel) {
        try {
          const allLabels = Object.values(ctx.statusLabels);
          await issue.setIssueStatus(resolvedRepo, parseInt(issueMatch[1], 10), reviewLabel, allLabels);
        } catch {
          // best-effort: don't fail PR creation if status move fails
        }
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
      json(await code.updatePR(ctx.resolveRepo(repo), number, { title, body }))
  );

  server.tool(
    "get_pr",
    "Get pull request details",
    {
      repo: REPO_PARAM,
      number: z.number().int().positive(),
    },
    async ({ repo, number }) => json(await code.getPR(ctx.resolveRepo(repo), number))
  );

  server.tool(
    "list_prs",
    "List pull requests in a repository",
    {
      repo: REPO_PARAM,
      state: z.enum(["open", "closed", "all"]).optional().describe("Defaults to open"),
      limit: z.number().int().positive().optional().describe("Max results, defaults to 50"),
    },
    async ({ repo, state, limit }) =>
      json(await code.listPRs(ctx.resolveRepo(repo), { state, limit }))
  );

  server.tool(
    "get_pr_checks",
    "Get CI check results for a pull request. Failed checks include the tail of their failing job log inline.",
    {
      repo: REPO_PARAM,
      number: z.number().int().positive(),
    },
    async ({ repo, number }) => json(await code.getPRChecks(ctx.resolveRepo(repo), number))
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
      const resolvedRepo = ctx.resolveRepo(repo);

      // Issue closing is left to GitLab/GitHub's own "Closes #N" pattern in the MR/PR
      // description (see create_pr) — merging here does not move any status label.
      await code.mergePR(resolvedRepo, number, resolvedMethod);

      return text(`PR #${number} merged via ${resolvedMethod}`);
    }
  );
}

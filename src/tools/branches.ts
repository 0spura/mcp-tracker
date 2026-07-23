import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ContextStore } from "../context.js";
import type { CodeProvider } from "../interfaces/code.js";
import type { IssueProvider } from "../interfaces/issue.js";
import { REPO_PARAM, text } from "./helpers.js";

export function registerBranchTools(server: McpServer, code: CodeProvider, ctx: ContextStore, issue?: IssueProvider): void {
  server.tool(
    "create_branch",
    "Create a branch off the base branch (default_base from context, falling back to the repo's default branch). When issue_number is set, the returned branch name may differ from branch_name: on GitLab it is rewritten to \"<issue>-<slug-of-issue-title>\" (or the project's issue_branch_template) so the issue's UI shows the branch as related — always use the returned name, not the requested one, for local checkout. Moves the issue to the configured \"Doing\" status. If the branch already exists, links it without recreating.",
    {
      repo: REPO_PARAM,
      issue_number: z.number().int().positive().optional().describe("Issue to link the branch to. Omit to create a plain branch."),
      branch_name: z.string().describe("Requested branch name, e.g. feat/42-refresh-token. On GitLab, when issue_number is set, this is overridden to match GitLab's own issue-branch naming — use the name in the response, not this value."),
      base: z.string().optional().describe("Branch to create from. Falls back to default_base from context, then the repo's default branch."),
    },
    async ({ repo, issue_number, branch_name, base }) => {
      const resolvedRepo = ctx.resolveRepo(repo);
      const resolvedBase = base ?? ctx.defaultBase ?? undefined;
      const branch = await code.createBranch(resolvedRepo, issue_number ?? null, branch_name, resolvedBase);

      // Auto-move issue to "Doing" when work starts, if configured
      const doingLabel = ctx.statusLabels["Doing"];
      if (issue_number != null && issue && doingLabel) {
        try {
          const allLabels = Object.values(ctx.statusLabels);
          await issue.setIssueStatus(resolvedRepo, issue_number, doingLabel, allLabels);
        } catch {
          // best-effort: don't fail branch creation if status move fails
        }
      }

      const linked = issue_number != null ? ` linked to issue #${issue_number}` : "";
      return text(`Branch "${branch.name}" created${linked}`);
    }
  );
}

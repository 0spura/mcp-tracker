import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ContextStore } from "../context.js";
import type { CodeProvider } from "../interfaces/code.js";
import type { IssueProvider } from "../interfaces/issue.js";
import { REPO_PARAM, json, text } from "./helpers.js";

export function registerCommentTools(server: McpServer, code: CodeProvider, issue: IssueProvider, ctx: ContextStore): void {
  server.tool(
    "add_issue_comment",
    "Add a comment to an issue. Targets the active issue (from the current branch, or a set_context override) when number is omitted.",
    {
      repo: REPO_PARAM,
      number: z.number().int().positive().optional().describe("Defaults to the active issue derived from the current branch"),
      body: z.string(),
    },
    async ({ repo, number, body }) => {
      const n = ctx.resolveIssue(number);
      await issue.addIssueComment(ctx.resolveRepo(repo), n, body);
      return text(`Comment added to issue #${n}`);
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
      await code.addPRComment(ctx.resolveRepo(repo), number, body);
      return text(`Comment added to PR #${number}`);
    }
  );

  server.tool(
    "list_comments",
    "List comments on an issue or pull request. For issues, targets the active issue (current branch, or a set_context override) when number is omitted.",
    {
      repo: REPO_PARAM,
      type: z.enum(["issue", "pr"]).describe("Whether the number refers to an issue or a PR"),
      number: z.number().int().positive().optional().describe("For issues, defaults to the active issue derived from the current branch"),
    },
    async ({ repo, type, number }) => {
      const resolvedRepo = ctx.resolveRepo(repo);
      if (type === "issue") {
        return json(await issue.listIssueComments(resolvedRepo, ctx.resolveIssue(number)));
      }
      if (!number) throw new Error("number is required for PR comments");
      return json(await code.listPRComments(resolvedRepo, number));
    }
  );
}

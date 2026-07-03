import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ContextStore } from "../context.js";
import type { TrackerProvider } from "../provider.js";
import { REPO_PARAM, json, text } from "./helpers.js";

export function registerCommentTools(server: McpServer, provider: TrackerProvider, ctx: ContextStore): void {
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
}

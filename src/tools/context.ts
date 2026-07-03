import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ContextStore } from "../context.js";
import { json } from "./helpers.js";

export function registerContextTools(server: McpServer, ctx: ContextStore): void {
  server.tool(
    "tracker_set_context",
    "Set project context so you don't have to repeat repo/project in every call. Detected automatically from git remote when omitted.",
    {
      repo: z.string().optional().describe("Repository as owner/repo"),
      board_id: z.string().optional().describe("Board, project, or cycle identifier. Used to add issues automatically and resolve status fields. For GitHub this is the Projects V2 number as a string."),
      default_assignee: z.string().optional().describe("Username to assign by default"),
      default_base: z.string().optional().describe("Default base branch for PRs, e.g. dev or main"),
      default_merge_method: z.enum(["merge", "squash", "rebase"]).optional().describe("Default merge method"),
      default_reviewers: z.array(z.string()).optional().describe("Usernames to request review from on every PR"),
      default_milestone: z.string().optional().describe("Milestone title to apply to new issues by default"),
    },
    async ({ repo, board_id, default_assignee, default_base, default_merge_method, default_reviewers, default_milestone }) => {
      ctx.set({
        repo,
        boardId: board_id,
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
    "Show the current project context (repo, board, defaults).",
    {},
    async () => json(ctx.snapshot())
  );
}

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ContextStore } from "../context.js";
import { json } from "./helpers.js";

export function registerContextTools(server: McpServer, ctx: ContextStore): void {
  server.tool(
    "tracker_set_context",
    "Override auto-resolved context. Usually unnecessary: repo comes from the git remote, the active issue from the current branch (<type>/<issue>-<slug>), and defaults from .mcp-tracker.json. Use this only to target a repo or issue that differs from the current git state.",
    {
      repo: z.string().optional().describe("Repository as owner/repo. Override the git remote."),
      board_id: z.string().optional().describe("Board, project, or cycle identifier. Overrides .mcp-tracker.json. For GitHub this is the Projects V2 number as a string."),
      active_issue: z.number().int().positive().nullable().optional().describe("Issue to target explicitly, overriding the one derived from the current branch. Pass null to clear and fall back to branch derivation."),
      default_assignee: z.string().optional().describe("Username to assign by default"),
      default_base: z.string().optional().describe("Default base branch for PRs, e.g. dev or main"),
      default_merge_method: z.enum(["merge", "squash", "rebase"]).optional().describe("Default merge method"),
      default_reviewers: z.array(z.string()).optional().describe("Usernames to request review from on every PR"),
      default_milestone: z.string().optional().describe("Milestone title to apply to new issues by default"),
    },
    async ({ repo, board_id, active_issue, default_assignee, default_base, default_merge_method, default_reviewers, default_milestone }) => {
      ctx.set({
        repo,
        boardId: board_id,
        activeIssue: active_issue,
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
    "Inspect the effective context (repo, active issue, board, defaults) and where each value came from — session override, .mcp-tracker.json, or git. Only needed to debug or confirm what is resolved; tools resolve context on their own.",
    {},
    async () => json(ctx.snapshot())
  );
}

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ContextStore } from "../context.js";
import type { TrackerProvider } from "../provider.js";
import { REPO_PARAM, text } from "./helpers.js";

export function registerBranchTools(server: McpServer, provider: TrackerProvider, ctx: ContextStore): void {
  server.tool(
    "create_branch",
    "Create a branch and link it to an issue. If the branch already exists, links it; if not, creates it off the default branch.",
    {
      repo: REPO_PARAM,
      issue_number: z.number().int().positive(),
      branch_name: z.string(),
    },
    async ({ repo, issue_number, branch_name }) => {
      const branch = await provider.createBranch(ctx.resolveRepo(repo), issue_number, branch_name);
      return text(`Branch "${branch.name}" linked to issue #${issue_number}`);
    }
  );
}

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ContextStore } from "../context.js";
import type { CodeProvider } from "../interfaces/code.js";
import { REPO_PARAM, text } from "./helpers.js";

export function registerBranchTools(server: McpServer, code: CodeProvider, ctx: ContextStore): void {
  server.tool(
    "create_branch",
    "Create a branch off the default branch. Pass issue_number to link it to an issue (provider-specific). If the branch already exists, links it without recreating.",
    {
      repo: REPO_PARAM,
      issue_number: z.number().int().positive().optional().describe("Issue to link the branch to. Omit to create a plain branch."),
      branch_name: z.string(),
    },
    async ({ repo, issue_number, branch_name }) => {
      const branch = await code.createBranch(ctx.resolveRepo(repo), issue_number ?? null, branch_name);
      const linked = issue_number != null ? ` linked to issue #${issue_number}` : "";
      return text(`Branch "${branch.name}" created${linked}`);
    }
  );
}

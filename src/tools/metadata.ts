import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ContextStore } from "../context.js";
import type { TrackerProvider } from "../provider.js";
import { REPO_PARAM, json } from "./helpers.js";

export function registerMetadataTools(server: McpServer, provider: TrackerProvider, ctx: ContextStore): void {
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
}

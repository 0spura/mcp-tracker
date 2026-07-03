import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ContextStore } from "./context.js";
import { GitHubProvider } from "./github/index.js";
import type { TrackerProvider } from "./provider.js";
import { registerContextTools } from "./tools/context.js";
import { registerIssueTools } from "./tools/issues.js";
import { registerBranchTools } from "./tools/branches.js";
import { registerPRTools } from "./tools/prs.js";
import { registerCommentTools } from "./tools/comments.js";
import { registerBoardTools } from "./tools/board.js";
import { registerMetadataTools } from "./tools/metadata.js";

function resolveProvider(): TrackerProvider {
  const name = process.env.TRACKER_PROVIDER ?? "github";
  if (name === "github") return new GitHubProvider();
  throw new Error(`Unknown TRACKER_PROVIDER "${name}". Supported: github`);
}

export function createServer(): McpServer {
  const provider = resolveProvider();
  const ctx = new ContextStore();
  const server = new McpServer({ name: "tracker", version: "1.0.0" });

  registerContextTools(server, ctx);
  registerIssueTools(server, provider, ctx);
  registerBranchTools(server, provider, ctx);
  registerPRTools(server, provider, ctx);
  registerCommentTools(server, provider, ctx);
  registerBoardTools(server, provider, ctx);
  registerMetadataTools(server, provider, ctx);

  return server;
}

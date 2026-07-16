import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GitHubCodeProvider } from "./providers/github/index.js";
import { GitHubTaskProvider } from "./providers/github-projects/index.js";
import { GitLabCodeProvider } from "./providers/gitlab/index.js";
import { GitLabTaskProvider } from "./providers/gitlab-boards/index.js";
import { LocalTaskProvider } from "./providers/local/index.js";
import type { CodeProvider } from "./interfaces/code.js";
import type { IssueProvider } from "./interfaces/issue.js";
import type { BoardProvider } from "./interfaces/board.js";
import type { MetadataProvider } from "./interfaces/metadata.js";
import { ContextStore } from "./context.js";
import { registerContextTools } from "./tools/context.js";
import { registerBranchTools } from "./tools/branches.js";
import { registerPRTools } from "./tools/prs.js";
import { registerIssueTools } from "./tools/issues.js";
import { registerCommentTools } from "./tools/comments.js";
import { registerBoardTools } from "./tools/boards.js";
import { registerMetadataTools } from "./tools/metadata.js";

function isBoardProvider(p: unknown): p is BoardProvider {
  return typeof p === "object" && p !== null && "listBoardItems" in p;
}

function isMetadataProvider(p: unknown): p is MetadataProvider {
  return typeof p === "object" && p !== null && "listLabels" in p;
}

function resolveCode(name: string): CodeProvider {
  if (name === "github") return new GitHubCodeProvider();
  if (name === "gitlab") return new GitLabCodeProvider();
  throw new Error(`Unknown CODE_PROVIDER "${name}". Valid values: github, gitlab`);
}

function resolveTask(name: string): IssueProvider {
  if (name === "github-projects") return new GitHubTaskProvider();
  if (name === "gitlab-boards") return new GitLabTaskProvider();
  if (name === "local") return new LocalTaskProvider();
  throw new Error(`Unknown TASK_PROVIDER "${name}". Valid values: github-projects, gitlab-boards, local`);
}

export function createServer(): McpServer {
  const codeName = process.env.CODE_PROVIDER ?? process.env.TRACKER_PROVIDER ?? "github";
  const taskName = process.env.TASK_PROVIDER;

  const code = resolveCode(codeName);
  const task = taskName ? resolveTask(taskName) : null;
  const board = task && isBoardProvider(task) ? task : null;
  const metadata = task && isMetadataProvider(task) ? task : null;

  const ctx = new ContextStore();
  const server = new McpServer({ name: "tracker", version: "1.0.0" });

  registerContextTools(server, ctx);
  registerBranchTools(server, code, ctx);
  registerPRTools(server, code, ctx, task ?? undefined);

  if (task) {
    registerIssueTools(server, task, board, ctx);
    registerCommentTools(server, code, task, ctx);
  }
  if (board) registerBoardTools(server, board, ctx);
  if (metadata) registerMetadataTools(server, metadata, ctx);

  return server;
}

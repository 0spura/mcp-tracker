import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ContextStore } from './context/store.js';
import { registerContextTools } from './context/tools.js';
import type { ProviderBundle } from './core/bundle.js';
import { createGhRunner, type GhRunner } from './transport/gh.js';
import { createGitHubCodeProvider } from './domains/code/github.js';
import { registerCodeTools } from './domains/code/tools.js';
import { createGitHubProjectsIssueProvider } from './domains/issues/github-projects.js';
import { createLocalIssueProvider } from './domains/issues/local.js';
import { registerIssueTools } from './domains/issues/tools.js';
import { createGitHubProjectsBoardProvider } from './domains/boards/github-projects.js';
import { registerBoardTools } from './domains/boards/tools.js';
import { registerCommentTools } from './domains/comments/tools.js';

function resolveCodeBundle(name: string, gh: GhRunner): ProviderBundle {
  if (name === 'github') {
    return { requires: ['repo'], code: createGitHubCodeProvider(gh) };
  }
  throw new Error(`Unknown CODE_PROVIDER "${name}". Valid values: github`);
}

function resolveTaskBundle(name: string, gh: GhRunner): ProviderBundle {
  if (name === 'github-projects') {
    return {
      requires: ['repo'],
      issue: createGitHubProjectsIssueProvider(gh),
      board: createGitHubProjectsBoardProvider(gh),
    };
  }
  if (name === 'local') {
    return { requires: [], issue: createLocalIssueProvider(process.env.LOCAL_TASK_DIR ?? '.tasks') };
  }
  throw new Error(
    `Unknown TASK_PROVIDER "${name}". Valid values: github-projects, local`
  );
}

export function createServer(): McpServer {
  const codeName = process.env.CODE_PROVIDER ?? process.env.TRACKER_PROVIDER ?? 'github';
  const taskName = process.env.TASK_PROVIDER;

  const gh = createGhRunner();
  const code = resolveCodeBundle(codeName, gh);
  const task = taskName ? resolveTaskBundle(taskName, gh) : null;

  const requires = [...new Set([...code.requires, ...(task?.requires ?? [])])];
  const bundle: ProviderBundle = {
    requires,
    code: code.code,
    issue: task?.issue,
    board: task?.board,
  };

  const ctx = ContextStore.create();
  const server = new McpServer({ name: 'tracker', version: '1.0.0' });
  const taskRequires = task?.requires ?? [];

  registerContextTools(server, ctx);
  if (bundle.code) registerCodeTools(server, bundle.code, ctx, bundle.issue);
  if (bundle.issue) registerIssueTools(server, bundle.issue, ctx, taskRequires);
  if (bundle.issue && bundle.code) {
    registerCommentTools(server, bundle.code, bundle.issue, ctx, taskRequires);
  }
  if (bundle.board) registerBoardTools(server, bundle.board, ctx, taskRequires);

  return server;
}

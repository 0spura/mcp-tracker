import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ContextStore } from './context/store.js';
import { loadConfig } from './context/config.js';
import type { ProviderBundle } from './core/bundle.js';
import { createGhRunner, type GhRunner } from './transport/gh.js';
import { createGlabRunner, type GlabRunner } from './transport/glab.js';
import { createGitHubCodeProvider } from './domains/code/github.js';
import { createGitLabCodeProvider } from './domains/code/gitlab.js';
import { registerCodeTools } from './domains/code/tools.js';
import { createGitHubProjectsIssueProvider } from './domains/issues/github-projects.js';
import { createGitLabIssueProvider } from './domains/issues/gitlab.js';
import { createLocalIssueProvider } from './domains/issues/local.js';
import { registerIssueTools } from './domains/issues/tools.js';
import { createGitHubProjectsBoardProvider } from './domains/boards/github-projects.js';
import { createGitLabBoardProvider } from './domains/boards/gitlab.js';
import { registerCommentTools } from './domains/comments/tools.js';
import type { IssueCatalog } from './domains/issues/capabilities.js';

function resolveCodeBundle(
  name: string,
  gh: GhRunner,
  glab: GlabRunner
): ProviderBundle {
  if (name === 'github') {
    return { requires: ['repo'], code: createGitHubCodeProvider(gh) };
  }
  if (name === 'gitlab') {
    return { requires: ['repo'], code: createGitLabCodeProvider(glab) };
  }
  throw new Error(
    `Unknown CODE_PROVIDER "${name}". Valid values: github, gitlab`
  );
}

function resolveTaskBundle(
  name: string,
  gh: GhRunner,
  glab: GlabRunner,
  localTaskDir: string,
  stages?: Array<{ key: string; name: string; id?: string }>
): ProviderBundle {
  if (name === 'github-projects') {
    return {
      requires: ['repo'],
      issue: createGitHubProjectsIssueProvider(gh),
      board: createGitHubProjectsBoardProvider(gh),
    };
  }
  if (name === 'gitlab') {
    return {
      requires: ['repo'],
      issue: createGitLabIssueProvider(glab, { stages }),
      board: createGitLabBoardProvider(glab),
    };
  }
  if (name === 'local') {
    return { requires: [], issue: createLocalIssueProvider(localTaskDir) };
  }
  throw new Error(
    `Unknown TASK_PROVIDER "${name}". Valid values: github-projects, gitlab, local`
  );
}

/**
 * Provider selection precedence: project config file > env > default. The
 * env vars are the global fallback; a project overrides them in its own
 * .mcp-tracker.json, so one user-level install serves every project.
 */
export async function createServer(): Promise<McpServer> {
  const config = await loadConfig();

  const codeName =
    config.codeProvider ?? process.env.CODE_PROVIDER ?? process.env.TRACKER_PROVIDER ?? 'github';
  const taskName = config.taskProvider ?? process.env.TASK_PROVIDER;
  const localTaskDir = config.localTaskDir ?? process.env.LOCAL_TASK_DIR ?? '.tasks';

  const gh = createGhRunner();
  const glab = createGlabRunner();
  const code = resolveCodeBundle(codeName, gh, glab);
  const task = taskName
    ? resolveTaskBundle(taskName, gh, glab, localTaskDir, config.workflow?.stages)
    : null;

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
  let catalog: IssueCatalog | undefined;

  if (bundle.issue) {
    const resolvedRepo = await ctx.resolveRepo();
    const resolvedBoard = await ctx.resolveBoardId();
    const scope = resolvedRepo.value === 'unset'
      ? undefined
      : {
          repo: resolvedRepo.value,
          ...(resolvedBoard.value === 'unset' ? {} : { boardId: resolvedBoard.value }),
        };
    const [issueTypes, labels, milestones, boardFields] = await Promise.all([
      scope && bundle.issue.listIssueTypes
        ? bundle.issue.listIssueTypes(scope).catch(() => [])
        : [],
      scope && bundle.issue.listLabels
        ? bundle.issue.listLabels(scope).then(
            (items) => items.map((item) => item.name),
            () => []
          )
        : [],
      scope && bundle.issue.listMilestones
        ? bundle.issue.listMilestones(scope, 'open').then(
            (items) => items.map((item) => item.title),
            () => []
          )
        : [],
      scope?.boardId && bundle.board
        ? bundle.board.listBoardFields(scope).catch(() => [])
        : [],
    ]);
    catalog = { issueTypes, labels, milestones, boardFields };
  }

  if (bundle.code) registerCodeTools(server, bundle.code, ctx, bundle.issue, catalog);
  if (bundle.issue) {
    registerIssueTools(server, bundle.issue, ctx, taskRequires, catalog, bundle.board);
  }
  if (bundle.issue && bundle.code) {
    registerCommentTools(server, bundle.code, bundle.issue, ctx, taskRequires);
  }
  return server;
}

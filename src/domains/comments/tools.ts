import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ContextStore } from '../../context/store.js';
import type { CodeProvider } from '../code/capabilities.js';
import type { IssueProvider } from '../issues/capabilities.js';
import {
  json,
  text,
  REPO_PARAM,
  ISSUE_NUMBER_PARAM,
  resolveIssueId,
  resolveScope,
} from '../../tools/helpers.js';

export function registerCommentTools(
  server: McpServer,
  code: CodeProvider,
  issue: IssueProvider,
  ctx: ContextStore,
  requires: Array<'repo' | 'board'>
): void {
  server.tool(
    'add_issue_comment',
    'Add a comment to an issue. Defaults to the active issue.',
    { body: z.string(), number: ISSUE_NUMBER_PARAM, repo: REPO_PARAM },
    async (args) => {
      const scope = await resolveScope(ctx, requires, args.repo);
      await issue.addIssueComment(scope, await resolveIssueId(ctx, args.number), args.body);
      return text('comment added');
    }
  );

  server.tool(
    'add_pr_comment',
    'Add a comment to a pull request.',
    { number: z.number().int().positive(), body: z.string(), repo: REPO_PARAM },
    async (args) => {
      const scope = await resolveScope(ctx, ['repo'], args.repo);
      await code.addPRComment(scope.repo!, args.number, args.body);
      return text('comment added');
    }
  );

  server.tool(
    'list_comments',
    'List comments on an issue or pull request. Issue type defaults to the active issue.',
    {
      type: z.enum(['issue', 'pr']),
      number: ISSUE_NUMBER_PARAM.describe('Required for pr; defaults to active issue for issue.'),
      repo: REPO_PARAM,
    },
    async (args) => {
      if (args.type === 'pr') {
        if (args.number === undefined) throw new Error('number is required for pr comments');
        const scope = await resolveScope(ctx, ['repo'], args.repo);
        return json(await code.listPRComments(scope.repo!, args.number));
      }
      const scope = await resolveScope(ctx, requires, args.repo);
      return json(await issue.listIssueComments(scope, await resolveIssueId(ctx, args.number)));
    }
  );
}

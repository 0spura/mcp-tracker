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
  ATTACHMENTS_PARAM,
  appendAttachments,
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
    'Add a comment to an issue, with optional file attachments appended as markdown links. Defaults to the active issue.',
    {
      body: z.string(),
      attachments: ATTACHMENTS_PARAM,
      number: ISSUE_NUMBER_PARAM,
      repo: REPO_PARAM,
    },
    async (args) => {
      const scope = await resolveScope(ctx, requires, args.repo);
      const { body, warnings } = await appendAttachments(issue, scope, args.body, args.attachments);
      await issue.addIssueComment(scope, await resolveIssueId(ctx, args.number), body);
      return warnings.length > 0 ? json({ warnings }) : text('comment added');
    }
  );

  server.tool(
    'add_pr_comment',
    'Add a comment to a pull request, with optional file attachments appended as markdown links.',
    {
      number: z.number().int().positive(),
      body: z.string(),
      attachments: ATTACHMENTS_PARAM,
      repo: REPO_PARAM,
    },
    async (args) => {
      const scope = await resolveScope(ctx, ['repo'], args.repo);
      const { body, warnings } = await appendAttachments(issue, scope, args.body, args.attachments);
      await code.addPRComment(scope.repo!, args.number, body);
      return warnings.length > 0 ? json({ warnings }) : text('comment added');
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

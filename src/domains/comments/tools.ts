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
    'Comment on an issue.',
    {
      body: z.string(),
      attachments: ATTACHMENTS_PARAM,
      number: ISSUE_NUMBER_PARAM,
      repo: REPO_PARAM,
    },
    async (args) => {
      const scope = await resolveScope(ctx, requires, args.repo);
      const { body, warnings } = await appendAttachments(issue, scope, args.body, args.attachments);
      await issue.addIssueComment(scope, String(args.number), body);
      return warnings.length > 0 ? json({ warnings }) : text('comment added');
    }
  );

  server.tool(
    'add_pr_comment',
    'Comment on a pull request.',
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
    'List issue or pull request comments.',
    {
      type: z.enum(['issue', 'pr']),
      number: ISSUE_NUMBER_PARAM,
      repo: REPO_PARAM,
    },
    async (args) => {
      if (args.type === 'pr') {
        const scope = await resolveScope(ctx, ['repo'], args.repo);
        return json(await code.listPRComments(scope.repo!, args.number));
      }
      const scope = await resolveScope(ctx, requires, args.repo);
      return json(await issue.listIssueComments(scope, String(args.number)));
    }
  );
}

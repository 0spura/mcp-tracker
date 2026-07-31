import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ContextStore } from './store.js';
import { json } from '../tools/helpers.js';

export function registerContextTools(server: McpServer, ctx: ContextStore): void {
  server.tool(
    'tracker_set_context',
    'Set session context: repo, board, active issue, and PR/issue defaults. Omitted fields keep their current value. Values set here override config file and git-derived values.',
    {
      repo: z.string().optional().describe('owner/repo. Auto-detected from git remote when omitted.'),
      board_id: z.string().optional().describe('GitHub Projects V2 board number.'),
      active_issue: z
        .number()
        .int()
        .positive()
        .nullable()
        .optional()
        .describe('Issue being worked on; pass null to clear. Issue tools use it when no number is given.'),
      default_base: z.string().optional().describe('Base branch for new PRs.'),
      default_reviewers: z.array(z.string()).optional().describe('Reviewers added to every PR.'),
      default_merge_method: z
        .enum(['merge', 'squash', 'rebase'])
        .optional()
        .describe('Merge method for merge_pr.'),
      default_assignee: z.string().optional().describe('Default assignee.'),
      default_milestone: z.string().optional().describe('Default milestone title.'),
    },
    async (args) => {
      ctx.setContext({
        repo: args.repo,
        board_id: args.board_id,
        active_issue:
          args.active_issue === undefined
            ? undefined
            : args.active_issue === null
              ? null
              : String(args.active_issue),
        default_base: args.default_base,
        default_reviewers: args.default_reviewers,
        default_merge_method: args.default_merge_method,
        default_assignee: args.default_assignee,
        default_milestone: args.default_milestone,
      });
      return json(await ctx.snapshot());
    }
  );

  server.tool(
    'tracker_get_context',
    'Show current context with the source of each value (explicit, session, config, derived).',
    {},
    async () => json(await ctx.snapshot())
  );
}

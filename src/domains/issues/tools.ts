import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ContextStore } from '../../context/store.js';
import type { IssueProvider } from './capabilities.js';
import type { BoardProvider } from '../boards/capabilities.js';
import type { Issue, PR } from '../../core/types.js';
import type { IssueCatalog } from './capabilities.js';
import { UnsupportedError } from '../../core/errors.js';
import {
  json,
  text,
  REPO_PARAM,
  ISSUE_NUMBER_PARAM,
  ATTACHMENTS_PARAM,
  appendAttachments,
  resolveScope,
} from '../../tools/helpers.js';

export function registerIssueTools(
  server: McpServer,
  issue: IssueProvider,
  ctx: ContextStore,
  requires: Array<'repo' | 'board'>,
  catalog?: IssueCatalog,
  board?: BoardProvider
): void {
  const scopeOf = (repo?: string) => resolveScope(ctx, requires, repo);

  server.tool(
    'list_issues',
    'Find issues.',
    {
      state: z.enum(['open', 'closed', 'all']).optional(),
      labels: z.array(z.string()).optional(),
      assignee: z.string().optional(),
      limit: z.number().int().positive().max(100).default(10),
      repo: REPO_PARAM,
    },
    async (args) =>
      json(
        await issue.listIssues(await scopeOf(args.repo), {
          state: args.state,
          labels: args.labels,
          assignee: args.assignee,
          limit: args.limit,
        })
      )
  );

  const typeKeys = catalog?.issueTypes.map((type) => type.name) ?? [];
  const typeSchema = typeKeys.length > 0
    ? z.enum(typeKeys as [string, ...string[]])
    : z.string();
  const typeParam = {
    type: typeSchema.optional().describe('Native issue type.'),
  };

  const knownLabels = catalog?.labels ?? [];
  const labelSchema = knownLabels.length > 0
    ? z.enum(knownLabels as [string, ...string[]])
    : z.string();

  const knownMilestones = catalog?.milestones ?? [];
  const milestoneSchema = knownMilestones.length > 0
    ? z.enum(knownMilestones as [string, ...string[]])
    : z.string();

  const boardFields = catalog?.boardFields ?? [];
  const fieldShape = Object.fromEntries(
    boardFields
      .filter((field) => field.name.toLowerCase() !== 'status')
      .map((field) => {
        const options = field.options?.map((option) => option.name) ?? [];
        const value = options.length > 0
          ? z.enum(options as [string, ...string[]])
          : z.string();
        return [field.name, value.optional()];
      })
  );
  const fieldsSchema = Object.keys(fieldShape).length > 0
    ? z.object(fieldShape).strict()
    : z.record(z.string());

  server.tool(
    'create_issue',
    'Create an issue with metadata, board fields, and relationships.',
    {
      title: z.string(),
      body: z.string(),
      ...typeParam,
      labels: z.array(labelSchema).optional().describe('Issue labels.'),
      assignees: z.array(z.string()).optional(),
      milestone: milestoneSchema.optional(),
      fields: fieldsSchema.optional(),
      issue_fields: z.record(z.unknown()).optional().describe('Native issue fields.'),
      blocks: z.array(z.number().int().positive()).optional(),
      blocked_by: z.array(z.number().int().positive()).optional(),
      related: z.array(z.number().int().positive()).optional(),
      duplicate_of: z.number().int().positive().optional(),
      parent: z.number().int().positive().optional().describe('Parent issue; creates as sub-issue.'),
      attachments: ATTACHMENTS_PARAM,
      repo: REPO_PARAM,
    },
    async ({ repo: repoArg, ...args }) => {
      const scope = await scopeOf(repoArg);
      const config = await ctx.getConfig();
      const { body, warnings: attachmentWarnings } = await appendAttachments(
        issue,
        scope,
        args.body,
        args.attachments
      );
      const defaultAssignee = (await ctx.resolveDefaultAssignee()).value;
      const defaultMilestone = (await ctx.resolveDefaultMilestone()).value;
      const labels = [
        ...(args.labels ?? config.defaults?.labels ?? []),
      ];
      const toIds = (list?: number[]) => list?.map(String);
      let status: string | undefined;
      if (config.workflow?.on?.createIssue) {
        const stage = config.workflow.stages?.find(
          (s) => s.key === config.workflow!.on!.createIssue
        );
        status = stage ? (stage.id ?? stage.name) : undefined;
      }
      const result = await issue.createIssue(scope, args.title, body, {
        labels: labels.length > 0 ? labels : undefined,
        assignees:
          args.assignees ??
          (defaultAssignee === 'unset' ? undefined : [defaultAssignee]),
        milestone: args.milestone ?? (defaultMilestone === 'unset' ? undefined : defaultMilestone),
        status,
        fields: args.fields as Record<string, string> | undefined,
        type: args.type,
        issueFields: args.issue_fields,
        blocks: toIds(args.blocks),
        blocked_by: toIds(args.blocked_by),
        related: toIds(args.related),
        duplicate_of: args.duplicate_of !== undefined ? String(args.duplicate_of) : undefined,
        parent: args.parent !== undefined ? String(args.parent) : undefined,
      });
      return json({
        ...result,
        warnings: [...result.warnings, ...attachmentWarnings],
      });
    }
  );

  server.tool(
    'get_issue',
    'Get an issue.',
    { number: ISSUE_NUMBER_PARAM, repo: REPO_PARAM },
    async (args) =>
      json(await issue.getIssue(await scopeOf(args.repo), String(args.number)))
  );

  server.tool(
    'update_issue',
    'Update an issue and its relationships.',
    {
      number: ISSUE_NUMBER_PARAM,
      title: z.string().optional(),
      body: z.string().optional(),
      labels: z.array(z.string()).optional(),
      assignees: z.array(z.string()).optional(),
      milestone: milestoneSchema.nullable().optional(),
      type: typeSchema.nullable().optional(),
      issue_fields: z.record(z.unknown()).optional().describe('Native issue fields.'),
      fields: fieldsSchema.optional(),
      parent: z.number().int().positive().optional(),
      state: z.enum(['open', 'closed']).optional(),
      add_blocks: z.array(z.number().int().positive()).optional(),
      remove_blocks: z.array(z.number().int().positive()).optional(),
      add_blocked_by: z.array(z.number().int().positive()).optional(),
      remove_blocked_by: z.array(z.number().int().positive()).optional(),
      add_related: z.array(z.number().int().positive()).optional(),
      remove_related: z.array(z.number().int().positive()).optional(),
      duplicate_of: z.number().int().positive().nullable().optional(),
      attachments: ATTACHMENTS_PARAM,
      repo: REPO_PARAM,
    },
    async ({ repo: repoArg, number, ...opts }) => {
      const scope = await scopeOf(repoArg);
      const id = String(number);
      const toIds = (list?: number[]) => list?.map(String);

      let body = opts.body;
      let attachmentWarnings: string[] = [];
      let attachmentComment: string | undefined;
      if (opts.attachments && opts.attachments.length > 0) {
        if (opts.body !== undefined) {
          const result = await appendAttachments(issue, scope, opts.body, opts.attachments);
          body = result.body;
          attachmentWarnings = result.warnings;
        } else {
          const result = await appendAttachments(issue, scope, '', opts.attachments);
          attachmentComment = result.body || undefined;
          attachmentWarnings = result.warnings;
        }
      }

      const result = await issue.updateIssue(scope, id, {
        title: opts.title,
        body,
        labels: opts.labels,
        assignees: opts.assignees,
        milestone: opts.milestone,
        type: opts.type,
        issueFields: opts.issue_fields,
        state: opts.state,
        add_blocks: toIds(opts.add_blocks),
        remove_blocks: toIds(opts.remove_blocks),
        add_blocked_by: toIds(opts.add_blocked_by),
        remove_blocked_by: toIds(opts.remove_blocked_by),
        add_related: toIds(opts.add_related),
        remove_related: toIds(opts.remove_related),
        duplicate_of:
          opts.duplicate_of === undefined
            ? undefined
            : opts.duplicate_of === null
              ? null
              : String(opts.duplicate_of),
      });

      const warnings = [...result.warnings, ...attachmentWarnings];

      if (opts.parent !== undefined) {
        if (!issue.addSubIssue) {
          warnings.push('parent is not supported by this provider');
        } else {
          try {
            await issue.addSubIssue(scope, String(opts.parent), id);
          } catch (err) {
            warnings.push(`set parent failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }

      if (opts.fields && Object.keys(opts.fields).length > 0) {
        if (!board || !scope.boardId) {
          warnings.push('board fields require a configured board');
        } else {
          try {
            const items = await board.listBoardItems(scope);
            let itemId = items.find(
              (item) => item.content?.type === 'issue' && item.content.id === id
            )?.id;
            if (!itemId && board.addIssueToBoard) {
              itemId = await board.addIssueToBoard(scope, id);
            }
            if (!itemId) throw new Error(`issue #${id} is not on the configured board`);
            await board.setItemFields(
              scope,
              itemId,
              opts.fields as Record<string, string>
            );
          } catch (err) {
            warnings.push(`set board fields failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }

      if (attachmentComment) {
        await issue.addIssueComment(scope, id, attachmentComment);
      }

      return json({
        ...result,
        warnings,
      });
    }
  );

  if (issue.toggleChecklistItem) {
    const toggle = issue.toggleChecklistItem.bind(issue);
    server.tool(
      'toggle_checklist_item',
      'Set an issue checklist item.',
      {
        item_text: z.string().describe('Partial text of the checklist item.'),
        checked: z.boolean().optional().describe('Explicit state; toggles when omitted.'),
        number: ISSUE_NUMBER_PARAM,
        repo: REPO_PARAM,
      },
      async (args) =>
        json(
          await toggle(
            await scopeOf(args.repo),
            String(args.number),
            args.item_text,
            args.checked
          )
        )
    );
  }

  if (issue.addSubIssue && issue.listSubIssues) {
    const listSubs = issue.listSubIssues.bind(issue);
    server.tool(
      'list_sub_issues',
      'List child issues.',
      { number: ISSUE_NUMBER_PARAM, repo: REPO_PARAM },
      async (args) =>
        json(await listSubs(await scopeOf(args.repo), String(args.number)))
    );
  }

  if (issue.logTime) {
    const logTime = issue.logTime.bind(issue);
    server.tool(
      'log_time',
      'Log time on an issue.',
      {
        spend: z.string().optional().describe('Time spent, e.g. "1h30m".'),
        estimate: z.string().optional().describe('Time estimate, e.g. "2h".'),
        number: ISSUE_NUMBER_PARAM,
        repo: REPO_PARAM,
      },
      async (args) =>
        json(
          await logTime(await scopeOf(args.repo), String(args.number), {
            spend: args.spend,
            estimate: args.estimate,
          })
        )
    );
  }

  if (issue.listRelatedIssues || issue.listLinkedPRs) {
    const listRelated = issue.listRelatedIssues?.bind(issue);
    const listLinked = issue.listLinkedPRs?.bind(issue);
    server.tool(
      'list_linked_items',
      'List items linked to an issue.',
      {
        type: z
          .enum(['issues', 'prs', 'all'])
          .optional()
          .describe('Which linked items to fetch; defaults to "all".'),
        number: ISSUE_NUMBER_PARAM,
        repo: REPO_PARAM,
      },
      async (args) => {
        const scope = await scopeOf(args.repo);
        const id = String(args.number);
        const type = args.type ?? 'all';
        const result: { issues?: Issue[]; prs?: PR[] } = {};

        if (type !== 'prs') {
          if (!listRelated) throw new UnsupportedError('list_linked_items with type "issues"');
          result.issues = await listRelated(scope, id);
        }
        if (type !== 'issues') {
          if (!listLinked) throw new UnsupportedError('list_linked_items with type "prs"');
          result.prs = await listLinked(scope, id);
        }
        return json(result);
      }
    );
  }
}

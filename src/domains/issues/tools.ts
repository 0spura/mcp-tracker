import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ContextStore } from '../../context/store.js';
import type { IssueProvider } from './capabilities.js';
import type { BoardProvider } from '../boards/capabilities.js';
import type { Issue, ProjectFieldValue } from '../../core/types.js';
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

export function summarizeIssue(issue: Issue): Omit<Issue, 'body'> {
  const { body: _body, ...summary } = issue;
  return summary;
}

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
    'Find issue summaries.',
    {
      state: z.enum(['open', 'closed', 'all']).optional(),
      labels: z.array(z.string()).optional(),
      assignee: z.string().optional(),
      parent: z.number().int().positive().optional().describe('Return direct sub-issues of this issue.'),
      linked_to: z.number().int().positive().optional().describe('Return issues linked to this issue.'),
      limit: z.number().int().positive().max(100).default(10),
      repo: REPO_PARAM,
    },
    async (args) => {
      const scope = await scopeOf(args.repo);
      if (args.parent !== undefined && args.linked_to !== undefined) {
        throw new Error('parent and linked_to cannot be combined');
      }
      if (
        (args.parent !== undefined || args.linked_to !== undefined) &&
        (args.state !== undefined || args.labels !== undefined || args.assignee !== undefined)
      ) {
        throw new Error('parent or linked_to cannot be combined with state, labels, or assignee');
      }

      if (args.parent !== undefined) {
        if (!issue.listSubIssues) throw new UnsupportedError('list_issues with parent');
        return json((await issue.listSubIssues(scope, String(args.parent)))
          .slice(0, args.limit)
          .map(summarizeIssue));
      }
      if (args.linked_to !== undefined) {
        if (!issue.listRelatedIssues) throw new UnsupportedError('list_issues with linked_to');
        return json((await issue.listRelatedIssues(scope, String(args.linked_to)))
          .slice(0, args.limit)
          .map(summarizeIssue));
      }

      const issues = await issue.listIssues(scope, {
          state: args.state,
          labels: args.labels,
          assignee: args.assignee,
          limit: args.limit,
        });
      return json(issues.map(summarizeIssue));
    }
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
  const fieldShape: Record<string, z.ZodTypeAny> = {};
  for (const field of boardFields) {
    if (field.name.toLowerCase() === 'status') continue;

    const options = field.options?.map((option) => option.name) ?? [];
    const value = options.length > 0
      ? field.type === 'multiselect'
        ? z.array(z.enum(options as [string, ...string[]]))
        : z.enum(options as [string, ...string[]])
      : field.type === 'number'
        ? z.number().finite()
        : field.type === 'date'
          ? z.string().date()
          : field.type === 'text'
            ? z.string()
            : undefined;
    if (value) fieldShape[field.name] = value.optional();
  }
  const fieldsSchema = catalog?.boardFields
    ? z.object(fieldShape).strict()
    : z.record(z.string());

  server.tool(
    'create_issue',
    'Create an issue with metadata and supported relationships.',
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
        status = stage?.name;
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
    'Get a full issue.',
    { number: ISSUE_NUMBER_PARAM, repo: REPO_PARAM },
    async (args) =>
      json(await issue.getIssue(await scopeOf(args.repo), String(args.number)))
  );

  server.tool(
    'update_issue',
    'Update an issue\'s metadata, relationships, or attachments.',
    {
      number: ISSUE_NUMBER_PARAM,
      title: z.string().optional(),
      body: z.string().optional(),
      labels: z.array(labelSchema).optional().describe('Issue labels.'),
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
              opts.fields as Record<string, ProjectFieldValue>
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

}

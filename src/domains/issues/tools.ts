import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ContextStore } from '../../context/store.js';
import type { IssueProvider } from './capabilities.js';
import type { Issue, PR } from '../../core/types.js';
import { UnsupportedError } from '../../core/errors.js';
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

export function registerIssueTools(
  server: McpServer,
  issue: IssueProvider,
  ctx: ContextStore,
  requires: Array<'repo' | 'board'>,
  typeLabels?: Record<string, string>
): void {
  const scopeOf = (repo?: string) => resolveScope(ctx, requires, repo);

  server.tool(
    'list_issues',
    'List issues by state, labels, and assignee.',
    {
      state: z.enum(['open', 'closed', 'all']).optional(),
      labels: z.array(z.string()).optional(),
      assignee: z.string().optional(),
      limit: z.number().int().positive().optional(),
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

  const typeKeys = Object.keys(typeLabels ?? {});
  const typeParam: { type?: z.ZodOptional<z.ZodString> } =
    typeKeys.length > 0
      ? {
          type: z
            .string()
            .optional()
            .describe(
              `Issue type, mapped to the project type label. One of: ${typeKeys.join(', ')}.`
            ),
        }
      : {};

  server.tool(
    'create_issue',
    'Create an issue with its full initial state in one call: labels, assignees, milestone, board status, board fields, relationships (blocks/blocked_by/related/duplicate_of), parent, and attachments. When board context is set, the issue is added to the board automatically. Secondary-step failures are reported in warnings, never thrown.',
    {
      title: z.string(),
      body: z.string(),
      ...typeParam,
      labels: z.array(z.string()).optional(),
      assignees: z.array(z.string()).optional(),
      milestone: z.string().optional(),
      status: z.string().optional().describe('Initial status column (stage key or name).'),
      fields: z.record(z.string()).optional().describe('Board field values, e.g. {"Size": "M"}.'),
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
      let typeLabel: string | undefined;
      if (args.type !== undefined) {
        typeLabel = config.typeLabels?.[args.type];
        if (typeLabel === undefined) {
          throw new Error(
            `unknown issue type "${args.type}"; valid types: ${
              Object.keys(config.typeLabels ?? {}).join(', ') || 'none configured'
            }`
          );
        }
      }
      const labels = [
        ...(typeLabel !== undefined ? [typeLabel] : []),
        ...(args.labels ?? config.defaults?.labels ?? []),
      ];
      const toIds = (list?: number[]) => list?.map(String);
      let status = args.status;
      if (!status && config.workflow?.on?.createIssue) {
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
        fields: args.fields,
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
    'Get issue details. Defaults to the active issue.',
    { number: ISSUE_NUMBER_PARAM, repo: REPO_PARAM },
    async (args) =>
      json(await issue.getIssue(await scopeOf(args.repo), await resolveIssueId(ctx, args.number)))
  );

  server.tool(
    'update_issue',
    'Update title, body, labels, assignees, milestone, state, batch relationship operations, and attachments in one call. Defaults to the active issue. Attachments are appended to the body when a new body is given, otherwise posted as a comment.',
    {
      number: ISSUE_NUMBER_PARAM,
      title: z.string().optional(),
      body: z.string().optional(),
      labels: z.array(z.string()).optional(),
      assignees: z.array(z.string()).optional(),
      milestone: z.string().nullable().optional().describe('Milestone title; null clears it.'),
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
      const id = await resolveIssueId(ctx, number);
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

      if (attachmentComment) {
        await issue.addIssueComment(scope, id, attachmentComment);
      }

      return json({
        ...result,
        warnings: [...result.warnings, ...attachmentWarnings],
      });
    }
  );

  server.tool(
    'move_issue_status',
    'Move an issue to a status column (stage key or name). Uses the board in context; the status mechanism is the provider\u2019s concern. Defaults to the active issue.',
    {
      status: z.string().describe('Target status column.'),
      number: ISSUE_NUMBER_PARAM,
      repo: REPO_PARAM,
    },
    async (args) => {
      const scope = await scopeOf(args.repo);
      await issue.setIssueStatus(scope, await resolveIssueId(ctx, args.number), args.status);
      return text(`status set to "${args.status}"`);
    }
  );

  if (issue.toggleChecklistItem) {
    const toggle = issue.toggleChecklistItem.bind(issue);
    server.tool(
      'toggle_checklist_item',
      'Mark or unmark a checklist item in the issue body by partial text match. Defaults to the active issue.',
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
            await resolveIssueId(ctx, args.number),
            args.item_text,
            args.checked
          )
        )
    );
  }

  if (issue.setRelationship) {
    const setRel = issue.setRelationship.bind(issue);
    server.tool(
      'set_issue_relationship',
      'Set a blocks/blocked_by/related/duplicate relationship between issues. blocks and blocked_by are native; duplicate uses the documented "Duplicate of #N" keyword comment; related posts a cross-reference. The response names the mechanism used.',
      {
        type: z.enum(['blocks', 'blocked_by', 'related', 'duplicate']),
        target: z.number().int().positive().describe('The other issue.'),
        number: ISSUE_NUMBER_PARAM,
        repo: REPO_PARAM,
      },
      async (args) =>
        json(
          await setRel(
            await scopeOf(args.repo),
            await resolveIssueId(ctx, args.number),
            args.type,
            String(args.target)
          )
        )
    );
  }

  if (issue.addSubIssue && issue.listSubIssues) {
    const addSub = issue.addSubIssue.bind(issue);
    const listSubs = issue.listSubIssues.bind(issue);
    server.tool(
      'add_sub_issue',
      'Add a child issue to a parent. Defaults the parent to the active issue.',
      {
        parent: ISSUE_NUMBER_PARAM.describe('Parent issue; defaults to active issue.'),
        child: z.number().int().positive().describe('Child issue to add.'),
        repo: REPO_PARAM,
      },
      async (args) => {
        const scope = await scopeOf(args.repo);
        await addSub(scope, await resolveIssueId(ctx, args.parent), String(args.child));
        return text(`#${args.child} added as sub-issue`);
      }
    );
    server.tool(
      'list_sub_issues',
      'List child issues of a parent. Defaults to the active issue.',
      { number: ISSUE_NUMBER_PARAM, repo: REPO_PARAM },
      async (args) =>
        json(await listSubs(await scopeOf(args.repo), await resolveIssueId(ctx, args.number)))
    );
  }

  if (issue.listLabels) {
    const listLabels = issue.listLabels.bind(issue);
    server.tool('list_labels', 'List repository labels.', { repo: REPO_PARAM }, async (args) =>
      json(await listLabels(await scopeOf(args.repo)))
    );
  }

  if (issue.listMilestones) {
    const listMilestones = issue.listMilestones.bind(issue);
    server.tool(
      'list_milestones',
      'List milestones.',
      { state: z.enum(['open', 'closed', 'all']).optional(), repo: REPO_PARAM },
      async (args) => json(await listMilestones(await scopeOf(args.repo), args.state))
    );
  }

  if (issue.logTime) {
    const logTime = issue.logTime.bind(issue);
    server.tool(
      'log_time',
      'Log spent and/or estimated time on an issue, using GitLab duration syntax (e.g. "1h30m", "30m", "2h"). Defaults to the active issue.',
      {
        spend: z.string().optional().describe('Time spent, e.g. "1h30m".'),
        estimate: z.string().optional().describe('Time estimate, e.g. "2h".'),
        number: ISSUE_NUMBER_PARAM,
        repo: REPO_PARAM,
      },
      async (args) =>
        json(
          await logTime(await scopeOf(args.repo), await resolveIssueId(ctx, args.number), {
            spend: args.spend,
            estimate: args.estimate,
          })
        )
    );
  }

  if (issue.attachFile) {
    const attachFile = issue.attachFile.bind(issue);
    server.tool(
      'upload_attachment',
      'Upload a local file to the issue tracker and return its markdown link. Optionally post that link as a comment on the issue right away. Defaults to the active issue.',
      {
        file_path: z.string().describe('Path to the local file to upload.'),
        post_as_comment: z
          .boolean()
          .optional()
          .describe('Post the markdown link as a comment on the issue.'),
        number: ISSUE_NUMBER_PARAM,
        repo: REPO_PARAM,
      },
      async (args) => {
        const scope = await scopeOf(args.repo);
        const id = await resolveIssueId(ctx, args.number);
        const result = await attachFile(scope, args.file_path);
        if (args.post_as_comment) {
          await issue.addIssueComment(scope, id, result.markdown);
        }
        return json(result);
      }
    );
  }

  if (issue.listRelatedIssues || issue.listLinkedPRs) {
    const listRelated = issue.listRelatedIssues?.bind(issue);
    const listLinked = issue.listLinkedPRs?.bind(issue);
    server.tool(
      'list_linked_items',
      'List issues and/or merge/pull requests linked to this issue. Defaults to the active issue.',
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
        const id = await resolveIssueId(ctx, args.number);
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

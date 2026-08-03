import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ContextStore } from '../../context/store.js';
import type { Scope } from '../../core/scope.js';
import type { ItemId } from '../../core/types.js';
import type { IssueProvider } from '../issues/capabilities.js';
import type { CodeProvider } from './capabilities.js';
import { UnsupportedError } from '../../core/errors.js';
import {
  json,
  text,
  REPO_PARAM,
  ATTACHMENTS_PARAM,
  appendAttachments,
  resolveScope,
} from '../../tools/helpers.js';

/** Best-effort status automation driven by config workflow.on triggers. */
async function applyStageTrigger(
  ctx: ContextStore,
  issue: IssueProvider | undefined,
  scope: Scope,
  issueId: ItemId | null,
  event: 'createBranch' | 'createPr' | 'mergePr' | 'reviewApproved',
  warnings: string[]
): Promise<void> {
  if (!issue || issueId === null) return;
  const config = await ctx.getConfig();
  const stageKey = config.workflow?.on?.[event];
  if (!stageKey) return;
  const stage = config.workflow?.stages?.find((s) => s.key === stageKey);
  if (!stage) {
    warnings.push(`workflow.on.${event} points to unknown stage "${stageKey}"`);
    return;
  }
  try {
    await issue.setIssueStatus(scope, issueId, stage.id ?? stage.name);
  } catch (err) {
    warnings.push(`could not move issue #${issueId} to "${stage.name}": ${(err as Error).message}`);
  }
}

export function registerCodeTools(
  server: McpServer,
  code: CodeProvider,
  ctx: ContextStore,
  issue?: IssueProvider
): void {
  const repoOf = async (explicit?: string) => {
    const scope = await resolveScope(ctx, ['repo'], explicit);
    return scope.repo!;
  };

  server.tool(
    'create_branch',
    'Create a branch off the default branch. With an issue (explicit or active), the branch is named <number>-<slug> and linked to the issue. Idempotent: an existing branch is returned, not an error.',
    {
      name: z.string().describe('Branch name when not linked to an issue; base of the slug when linked.'),
      issue_number: z.number().int().positive().optional().describe('Issue to link; defaults to active issue.'),
      base: z.string().optional().describe('Base branch; defaults to the repo default branch.'),
      repo: REPO_PARAM,
    },
    async (args) => {
      const repo = await repoOf(args.repo);
      const resolvedIssue = await ctx.resolveActiveIssue(
        args.issue_number !== undefined ? String(args.issue_number) : undefined
      );
      const issueId = resolvedIssue.value === 'unset' ? null : resolvedIssue.value;
      const result = await code.createBranch(repo, issueId, args.name, args.base);
      const warnings: string[] = [];
      const scope = await resolveScope(ctx, []);
      await applyStageTrigger(ctx, issue, scope, issueId, 'createBranch', warnings);
      return json({ ...result, warnings });
    }
  );

  server.tool(
    'create_pr',
    'Create a pull request. Applies default_base and default_reviewers from context, appends "Closes #N" for the active issue (and any issues list) when the body does not reference it, and appends attachment markdown links to the body when given.',
    {
      title: z.string(),
      body: z.string().describe('PR body. "Closes #N" is appended for the active issue when missing.'),
      head: z.string().describe('Head branch.'),
      base: z.string().optional().describe('Base branch; defaults to context default_base.'),
      draft: z.boolean().optional(),
      issues: z.array(z.number().int().positive()).optional().describe('Issues to close; each gets a "Closes #N" line.'),
      attachments: ATTACHMENTS_PARAM,
      repo: REPO_PARAM,
    },
    async (args) => {
      const repo = await repoOf(args.repo);
      const base = args.base ?? (await ctx.resolveDefaultBase()).value;
      const resolvedIssue = await ctx.resolveActiveIssue();
      const activeId = resolvedIssue.value === 'unset' ? null : resolvedIssue.value;
      const closing = new Set<string>((args.issues ?? []).map(String));
      if (activeId !== null && !new RegExp(`#${activeId}\\b`).test(args.body)) {
        closing.add(activeId);
      }

      const warnings: string[] = [];
      let body = args.body;
      if (args.attachments && args.attachments.length > 0) {
        if (!issue) throw new UnsupportedError('attachments (requires a task/issue provider)');
        const result = await appendAttachments(issue, { repo }, args.body, args.attachments);
        body = result.body;
        warnings.push(...result.warnings);
      }

      const pr = await code.createPR(
        repo,
        args.title,
        body,
        args.head,
        base === 'unset' ? undefined : base,
        { issues: [...closing] }
      );
      const reviewers = (await ctx.resolveDefaultReviewers()).value;
      if (reviewers !== 'unset' && reviewers.length > 0) {
        const updated = await code.updatePR(repo, pr.number, { add_reviewers: reviewers });
        warnings.push(...updated.warnings);
      }
      const scope = await resolveScope(ctx, []);
      await applyStageTrigger(ctx, issue, scope, activeId, 'createPr', warnings);
      return json({ ...pr, warnings });
    }
  );

  server.tool(
    'update_pr',
    'Generic PR edit: title, body, state, draft, labels, milestone, and batch reviewer/assignee changes in one call. Batch failures are reported in warnings, not thrown.',
    {
      number: z.number().int().positive(),
      title: z.string().optional(),
      body: z.string().optional(),
      state: z.enum(['open', 'closed']).optional(),
      draft: z.boolean().optional().describe('true = convert to draft; false = mark ready for review.'),
      labels: z.array(z.string()).optional().describe('Replaces the label set.'),
      milestone: z.string().optional(),
      add_reviewers: z.array(z.string()).optional(),
      remove_reviewers: z.array(z.string()).optional(),
      add_assignees: z.array(z.string()).optional(),
      remove_assignees: z.array(z.string()).optional(),
      repo: REPO_PARAM,
    },
    async ({ repo: repoArg, number, ...opts }) => {
      const repo = await repoOf(repoArg);
      return json(await code.updatePR(repo, number, opts));
    }
  );

  server.tool('get_pr', 'Get pull request details.', { number: z.number().int().positive(), repo: REPO_PARAM }, async (args) =>
    json(await code.getPR(await repoOf(args.repo), args.number))
  );

  server.tool(
    'list_prs',
    'List pull requests by state.',
    {
      state: z.enum(['open', 'closed', 'all']).optional(),
      limit: z.number().int().positive().optional(),
      repo: REPO_PARAM,
    },
    async (args) => json(await code.listPRs(await repoOf(args.repo), { state: args.state, limit: args.limit }))
  );

  server.tool(
    'get_pr_checks',
    'Get CI check results for a PR. Failing logs are truncated to a bounded tail.',
    { number: z.number().int().positive(), repo: REPO_PARAM },
    async (args) => json(await code.getPRChecks(await repoOf(args.repo), args.number))
  );

  server.tool(
    'merge_pr',
    'Merge a pull request. Applies default_merge_method and default_merge_delete_branch from context when omitted, and moves the active issue to the workflow.on.mergePr stage when set.',
    {
      number: z.number().int().positive(),
      method: z.enum(['merge', 'squash', 'rebase']).optional(),
      delete_branch: z.boolean().optional().describe('Delete the source branch after merge.'),
      repo: REPO_PARAM,
    },
    async (args) => {
      const repo = await repoOf(args.repo);
      const method = args.method ?? (await ctx.resolveDefaultMergeMethod()).value;
      const deleteBranch =
        args.delete_branch ?? (await ctx.resolveDefaultMergeDeleteBranch()).value;
      const { warnings } = await code.mergePR(
        repo,
        args.number,
        method === 'unset' ? undefined : method,
        { deleteBranch: deleteBranch === 'unset' ? false : deleteBranch }
      );
      const resolvedIssue = await ctx.resolveActiveIssue();
      const issueId = resolvedIssue.value === 'unset' ? null : resolvedIssue.value;
      const scope = await resolveScope(ctx, []);
      await applyStageTrigger(ctx, issue, scope, issueId, 'mergePr', warnings);
      return json({ number: args.number, merged: true, warnings });
    }
  );

  server.tool(
    'get_pr_diff',
    'Get the PR diff as seen remotely. Use these exact positions for submit_pr_review inline comments. Truncated diffs are marked.',
    { number: z.number().int().positive(), repo: REPO_PARAM },
    async (args) => text(await code.getPRDiff(await repoOf(args.repo), args.number))
  );

  server.tool(
    'submit_pr_review',
    'Submit a PR review: approve, request_changes, or comment, with a body and optional inline comments. Inline comments use {path, line} positions from get_pr_diff. An approve moves the active issue to the workflow.on.reviewApproved stage when set.',
    {
      number: z.number().int().positive(),
      event: z.enum(['approve', 'request_changes', 'comment']),
      body: z.string().optional(),
      comments: z
        .array(z.object({ path: z.string(), line: z.number().int().positive(), body: z.string() }))
        .optional(),
      repo: REPO_PARAM,
    },
    async (args) => {
      const repo = await repoOf(args.repo);
      await code.submitPRReview(repo, args.number, {
        event: args.event,
        body: args.body,
        comments: args.comments,
      });
      const warnings: string[] = [];
      if (args.event === 'approve') {
        const resolvedIssue = await ctx.resolveActiveIssue();
        const issueId = resolvedIssue.value === 'unset' ? null : resolvedIssue.value;
        const scope = await resolveScope(ctx, []);
        await applyStageTrigger(ctx, issue, scope, issueId, 'reviewApproved', warnings);
      }
      return json({ number: args.number, reviewed: args.event, warnings });
    }
  );
}

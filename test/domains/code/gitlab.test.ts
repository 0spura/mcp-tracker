import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createGlabRunner } from '../../../src/transport/glab.js';
import { createGitLabCodeProvider } from '../../../src/domains/code/gitlab.js';
import { createFakeGlab } from '../../helpers/fake-glab.js';
import { CliError, UnsupportedError } from '../../../src/core/errors.js';

const repo = { owner: 'acme', repo: 'widget' };

function makeProvider(responses: Parameters<typeof createFakeGlab>[0]) {
  const fake = createFakeGlab(responses);
  const runner = createGlabRunner(fake.run);
  return { provider: createGitLabCodeProvider(runner), fake };
}

function mrFixture(overrides: Record<string, unknown> = {}) {
  const iid = (overrides.iid as number | undefined) ?? 3;
  return {
    iid,
    title: 'title',
    description: 'body',
    state: 'opened',
    web_url: `https://gitlab.com/acme/widget/-/merge_requests/${iid}`,
    source_branch: 'feature',
    target_branch: 'main',
    ...overrides,
  };
}

function projectFixture(overrides: Record<string, unknown> = {}) {
  return {
    default_branch: 'main',
    issue_branch_template: null,
    ...overrides,
  };
}

function branchFixture(sha = 'abc123') {
  return { commit: { id: sha } };
}

function restFields(call: { input?: string }) {
  return JSON.parse(call.input ?? '{}') as Record<string, unknown>;
}

describe('createGitLabCodeProvider', () => {
  describe('createBranch', () => {
    it('creates a linked branch from the project template', async () => {
      const { provider, fake } = makeProvider([
        { stdout: JSON.stringify(projectFixture({ issue_branch_template: '%{id}-%{title}' })) },
        { stdout: JSON.stringify({ title: 'Fix the bug' }) },
        { stdout: JSON.stringify(projectFixture()) },
        { stdout: JSON.stringify(branchFixture('defabc')) },
        { error: new CliError(1, 'Not Found', 'glab') },
        { stdout: JSON.stringify({}) },
      ]);

      const result = await provider.createBranch(repo, '42', 'ignored', undefined);

      expect(result).toEqual({ name: '42-fix-the-bug' });
      expect(fake.calls[4].args.join(' ')).toContain(
        'repository/branches/42-fix-the-bug'
      );
      expect(fake.calls[5].args).toContain('--method');
      expect(fake.calls[5].args).toContain('POST');
      expect(restFields(fake.calls[5])).toEqual({
        branch: '42-fix-the-bug',
        ref: 'defabc',
      });
    });

    it('falls back to <number>-<slug> when no template is set', async () => {
      const { provider, fake } = makeProvider([
        { stdout: JSON.stringify(projectFixture()) },
        { stdout: JSON.stringify({ title: 'Fix the bug' }) },
        { stdout: JSON.stringify(projectFixture()) },
        { stdout: JSON.stringify(branchFixture()) },
        { error: new CliError(1, 'Not Found', 'glab') },
        { stdout: JSON.stringify({}) },
      ]);

      const result = await provider.createBranch(repo, '42', 'ignored', undefined);

      expect(result).toEqual({ name: '42-fix-the-bug' });
      expect(fake.calls[4].args.join(' ')).toContain(
        'repository/branches/42-fix-the-bug'
      );
    });

    it('returns an existing linked branch without creating a new one', async () => {
      const { provider, fake } = makeProvider([
        { stdout: JSON.stringify(projectFixture()) },
        { stdout: JSON.stringify({ title: 'Fix the bug' }) },
        { stdout: JSON.stringify(projectFixture()) },
        { stdout: JSON.stringify(branchFixture()) },
        { stdout: JSON.stringify({ name: '42-fix-the-bug' }) },
      ]);

      const result = await provider.createBranch(repo, '42', 'other', undefined);

      expect(result).toEqual({ name: '42-fix-the-bug' });
      expect(fake.calls).toHaveLength(5);
    });

    it('creates a plain branch when no issue is given', async () => {
      const { provider, fake } = makeProvider([
        { stdout: JSON.stringify(branchFixture('defabc')) },
        { error: new CliError(1, 'Not Found', 'glab') },
        { stdout: JSON.stringify({}) },
      ]);

      const result = await provider.createBranch(repo, null, 'feature-x', 'main');

      expect(result).toEqual({ name: 'feature-x' });
      expect(fake.calls[0].args.join(' ')).toContain('repository/branches/main');
      expect(fake.calls[2].args).toContain('POST');
      expect(restFields(fake.calls[2])).toEqual({
        branch: 'feature-x',
        ref: 'defabc',
      });
    });

    it('rejects non-numeric issue ids for linked branches', async () => {
      const { provider } = makeProvider([]);

      await expect(
        provider.createBranch(repo, 'PROJ-42', 'x', undefined)
      ).rejects.toBeInstanceOf(UnsupportedError);
    });
  });

  describe('createPR', () => {
    it('uses the provided base branch', async () => {
      const { provider, fake } = makeProvider([
        { stdout: JSON.stringify(mrFixture({ target_branch: 'develop' })) },
      ]);

      const pr = await provider.createPR(
        repo,
        'title',
        'body',
        'feature',
        'develop',
        undefined
      );

      expect(pr.baseBranch).toBe('develop');
      expect(fake.calls[0].args.some((a) => a.includes('merge_requests'))).toBe(true);
      expect(restFields(fake.calls[0])).toMatchObject({
        target_branch: 'develop',
      });
    });

    it('fetches the default branch when base is omitted', async () => {
      const { provider, fake } = makeProvider([
        { stdout: JSON.stringify(projectFixture()) },
        { stdout: JSON.stringify(mrFixture()) },
      ]);

      const pr = await provider.createPR(
        repo,
        'title',
        'body',
        'feature',
        undefined,
        undefined
      );

      expect(pr.baseBranch).toBe('main');
      expect(fake.calls[0].args.join(' ')).toContain('projects/acme%2Fwidget');
      expect(fake.calls[1].args.join(' ')).toContain('merge_requests');
      expect(restFields(fake.calls[1])).toMatchObject({
        target_branch: 'main',
      });
    });

    it('appends Closes #N lines for linked issues', async () => {
      const { provider, fake } = makeProvider([
        { stdout: JSON.stringify(mrFixture()) },
      ]);

      await provider.createPR(repo, 'title', 'Initial', 'feature', 'main', {
        issues: ['42', '7'],
      });

      expect(restFields(fake.calls[0]).description).toBe(
        'Initial\n\nCloses #42\nCloses #7\n'
      );
    });

    it('skips closing lines already present in the body', async () => {
      const { provider, fake } = makeProvider([
        { stdout: JSON.stringify(mrFixture()) },
      ]);

      await provider.createPR(repo, 'title', 'This fixes #42', 'feature', 'main', {
        issues: ['42', '7'],
      });

      expect(restFields(fake.calls[0]).description).toBe(
        'This fixes #42\n\nCloses #7\n'
      );
    });
  });

  describe('getPR / listPRs', () => {
    it('normalizes an opened MR state', async () => {
      const { provider } = makeProvider([{ stdout: JSON.stringify(mrFixture()) }]);

      const pr = await provider.getPR(repo, 3);

      expect(pr.state).toBe('open');
      expect(pr.number).toBe(3);
    });

    it('normalizes a merged MR state', async () => {
      const { provider } = makeProvider([
        { stdout: JSON.stringify(mrFixture({ state: 'merged' })) },
      ]);

      const pr = await provider.getPR(repo, 3);

      expect(pr.state).toBe('merged');
    });

    it('normalizes a locked MR to open', async () => {
      const { provider } = makeProvider([
        { stdout: JSON.stringify(mrFixture({ state: 'locked' })) },
      ]);

      const pr = await provider.getPR(repo, 3);

      expect(pr.state).toBe('open');
    });

    it('lists and normalizes MRs', async () => {
      const { provider, fake } = makeProvider([
        {
          stdout: JSON.stringify([
            mrFixture({ iid: 1, state: 'merged' }),
            mrFixture({ iid: 2, state: 'closed' }),
          ]),
        },
      ]);

      const prs = await provider.listPRs(repo, { state: 'all', limit: 10 });

      expect(prs).toHaveLength(2);
      expect(prs[0].state).toBe('merged');
      expect(prs[1].state).toBe('closed');
      expect(fake.calls[0].args.join(' ')).toContain('state=all');
      expect(fake.calls[0].args.join(' ')).toContain('per_page=10');
    });
  });

  describe('updatePR', () => {
    it('patches title, body and state', async () => {
      const { provider, fake } = makeProvider([
        { stdout: JSON.stringify(mrFixture({ state: 'closed' })) },
      ]);

      const { pr, warnings } = await provider.updatePR(repo, 3, {
        title: 'new title',
        body: 'new body',
        state: 'closed',
      });

      expect(pr.state).toBe('closed');
      expect(warnings).toEqual([]);
      expect(fake.calls[0].args).toContain('--method');
      expect(fake.calls[0].args).toContain('PUT');
      expect(restFields(fake.calls[0])).toEqual({
        title: 'new title',
        description: 'new body',
        state_event: 'close',
      });
    });

    it('reports draft as unsupported', async () => {
      const { provider, fake } = makeProvider([
        { stdout: JSON.stringify(mrFixture()) },
      ]);

      const { warnings } = await provider.updatePR(repo, 3, { draft: true });

      expect(warnings).toEqual([
        'draft update is not supported by the GitLab provider',
      ]);
      expect(fake.calls).toHaveLength(1);
    });

    it('resolves milestone by title', async () => {
      const { provider, fake } = makeProvider([
        { stdout: JSON.stringify(mrFixture()) },
        {
          stdout: JSON.stringify([
            { id: 5, title: 'Sprint 1' },
            { id: 6, title: 'Sprint 2' },
          ]),
        },
        { stdout: JSON.stringify({}) },
      ]);

      const { warnings } = await provider.updatePR(repo, 3, {
        milestone: 'Sprint 2',
      });

      expect(warnings).toEqual([]);
      expect(fake.calls[1].args.join(' ')).toContain('milestones');
      expect(fake.calls[2].args.join(' ')).toContain(
        'merge_requests/3'
      );
      expect(restFields(fake.calls[2])).toEqual({ milestone_id: 6 });
    });

    it('batches reviewer and assignee changes', async () => {
      const { provider, fake } = makeProvider([
        { stdout: JSON.stringify(mrFixture()) },
        { stdout: JSON.stringify([{ id: 11 }]) },
        { stdout: JSON.stringify({}) },
        { stdout: JSON.stringify({ reviewers: [{ id: 11 }] }) },
        { stdout: JSON.stringify([{ id: 11 }]) },
        { stdout: JSON.stringify({}) },
        { stdout: JSON.stringify([{ id: 21 }]) },
        { stdout: JSON.stringify({}) },
        { stdout: JSON.stringify({ assignees: [{ id: 21 }] }) },
        { stdout: JSON.stringify([{ id: 21 }]) },
        { stdout: JSON.stringify({}) },
      ]);

      const { warnings } = await provider.updatePR(repo, 3, {
        add_reviewers: ['ana'],
        remove_reviewers: ['ana'],
        add_assignees: ['bob'],
        remove_assignees: ['bob'],
      });

      expect(warnings).toEqual([]);
      expect(fake.calls[1].args.join(' ')).toContain('users?username=ana');
      expect(fake.calls[3].args.join(' ')).toContain('merge_requests/3');
      expect(fake.calls[6].args.join(' ')).toContain('users?username=bob');
    });

    it('resolves $current to the authenticated user for add_reviewers', async () => {
      const { provider, fake } = makeProvider([
        { stdout: JSON.stringify(mrFixture()) },
        { stdout: JSON.stringify({ username: 'ana' }) },
        { stdout: JSON.stringify([{ id: 11 }]) },
        { stdout: JSON.stringify({}) },
      ]);

      const { warnings } = await provider.updatePR(repo, 3, {
        add_reviewers: ['$current'],
      });

      expect(warnings).toEqual([]);
      expect(fake.calls[1].args.join(' ')).toBe('api user');
      expect(fake.calls[2].args.join(' ')).toContain('users?username=ana');
    });

    it('returns warnings for secondary failures and keeps the primary edit', async () => {
      const { provider, fake } = makeProvider([
        { stdout: JSON.stringify(mrFixture()) },
        { error: new CliError(1, 'not found', 'glab') },
      ]);

      const { pr, warnings } = await provider.updatePR(repo, 3, {
        labels: ['bug'],
      });

      expect(pr.number).toBe(3);
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain('labels');
      expect(fake.calls).toHaveLength(2);
    });

    it('throws when the primary edit fails', async () => {
      const { provider } = makeProvider([
        { error: new CliError(1, 'not found', 'glab') },
      ]);

      await expect(
        provider.updatePR(repo, 3, { title: 'x' })
      ).rejects.toBeInstanceOf(CliError);
    });

    it('throws when trying to set state to merged', async () => {
      const { provider } = makeProvider([]);

      await expect(
        provider.updatePR(repo, 3, { state: 'merged' })
      ).rejects.toBeInstanceOf(UnsupportedError);
    });
  });

  describe('getPRChecks', () => {
    it('fetches jobs from the latest pipeline and includes bounded logs', async () => {
      const lines = Array.from({ length: 250 }, (_, i) => `line ${i + 1}`);
      const log = lines.join('\n');
      const { provider, fake } = makeProvider([
        {
          stdout: JSON.stringify([
            { id: 10, status: 'success', web_url: 'https://pipeline/10' },
          ]),
        },
        {
          stdout: JSON.stringify([
            {
              id: 101,
              name: 'ci',
              status: 'failed',
              web_url: 'https://job/101',
            },
          ]),
        },
        { stdout: log },
      ]);

      const checks = await provider.getPRChecks(repo, 3);

      expect(checks).toHaveLength(1);
      expect(checks[0].name).toBe('ci');
      expect(checks[0].conclusion).toBe('failure');
      expect(checks[0].logs).toMatch(/^line 51\n/);
      expect(checks[0].logs).not.toMatch(/\nline 1\n/);
      expect(checks[0].logs).toContain('line 250');
      expect(fake.calls[2].args.join(' ')).toContain('jobs/101/trace');
    });
  });

  describe('mergePR', () => {
    it('merges with the requested method', async () => {
      const { provider, fake } = makeProvider([
        { stdout: JSON.stringify({}) },
      ]);

      await provider.mergePR(repo, 3, 'squash');

      expect(fake.calls[0].args).toContain('--method');
      expect(fake.calls[0].args).toContain('PUT');
      expect(fake.calls[0].args.join(' ')).toContain(
        'merge_requests/3/merge'
      );
      expect(restFields(fake.calls[0])).toEqual({ squash: true });
    });

    it('uses the rebase endpoint for rebase merges', async () => {
      const { provider, fake } = makeProvider([
        { stdout: JSON.stringify({}) },
      ]);

      await provider.mergePR(repo, 3, 'rebase');

      expect(fake.calls[0].args.join(' ')).toContain(
        'merge_requests/3/rebase'
      );
    });

    it('requests source branch removal when deleteBranch is set', async () => {
      const { provider, fake } = makeProvider([
        { stdout: JSON.stringify({}) },
      ]);

      const { warnings } = await provider.mergePR(repo, 3, 'squash', { deleteBranch: true });

      expect(warnings).toEqual([]);
      expect(restFields(fake.calls[0])).toEqual({
        squash: true,
        should_remove_source_branch: true,
      });
    });

    it('warns when deleteBranch is requested on a rebase merge', async () => {
      const { provider, fake } = makeProvider([
        { stdout: JSON.stringify({}) },
      ]);

      const { warnings } = await provider.mergePR(repo, 3, 'rebase', { deleteBranch: true });

      expect(warnings).toEqual([
        'deleteBranch is not supported by the rebase-only merge path',
      ]);
      expect(fake.calls[0].args.join(' ')).toContain('merge_requests/3/rebase');
    });
  });

  describe('getPRDiff', () => {
    it('returns glab mr diff output', async () => {
      const { provider, fake } = makeProvider([{ stdout: 'diff content' }]);

      const diff = await provider.getPRDiff(repo, 3);

      expect(diff).toBe('diff content');
      expect(fake.calls[0].args).toEqual([
        'mr',
        'diff',
        '3',
        '-R',
        'acme/widget',
      ]);
    });

    it('truncates long diffs with markers', async () => {
      const long = 'a'.repeat(50001);
      const { provider } = makeProvider([{ stdout: long }]);

      const diff = await provider.getPRDiff(repo, 3);

      expect(diff.length).toBeLessThan(long.length + 100);
      expect(diff.startsWith('... (truncated) ...')).toBe(true);
      expect(diff.endsWith('... (truncated) ...')).toBe(true);
    });
  });

  describe('submitPRReview', () => {
    it('approves via the approve endpoint', async () => {
      const { provider, fake } = makeProvider([{ stdout: JSON.stringify({}) }]);

      await provider.submitPRReview(repo, 3, { event: 'approve' });

      expect(fake.calls[0].args.join(' ')).toContain(
        'merge_requests/3/approve'
      );
      expect(fake.calls[0].args).toContain('POST');
    });

    it('posts a comment note', async () => {
      const { provider, fake } = makeProvider([{ stdout: JSON.stringify({}) }]);

      await provider.submitPRReview(repo, 3, {
        event: 'comment',
        body: 'nice',
      });

      expect(fake.calls[0].args.join(' ')).toContain(
        'merge_requests/3/notes'
      );
      expect(restFields(fake.calls[0])).toEqual({ body: 'nice' });
    });

    it('posts a note and unapproves for request_changes', async () => {
      const { provider, fake } = makeProvider([
        { stdout: JSON.stringify({}) },
        { stdout: JSON.stringify({}) },
      ]);

      await provider.submitPRReview(repo, 3, {
        event: 'request_changes',
        body: 'please fix',
      });

      expect(fake.calls[0].args.join(' ')).toContain('merge_requests/3/notes');
      expect(fake.calls[1].args.join(' ')).toContain(
        'merge_requests/3/unapprove'
      );
    });

    it('rejects inline comments as unsupported', async () => {
      const { provider } = makeProvider([]);

      await expect(
        provider.submitPRReview(repo, 3, {
          event: 'comment',
          comments: [{ path: 'a.ts', line: 1, body: 'x' }],
        })
      ).rejects.toBeInstanceOf(UnsupportedError);
    });
  });

  describe('addPRComment / listPRComments', () => {
    it('adds and lists MR notes', async () => {
      const { provider, fake } = makeProvider([
        { stdout: JSON.stringify({}) },
        {
          stdout: JSON.stringify([
            {
              id: 123,
              author: { username: 'ana' },
              body: 'nice',
              created_at: '2026-01-01T00:00:00Z',
            },
          ]),
        },
      ]);

      await provider.addPRComment(repo, 3, 'nice');
      const comments = await provider.listPRComments(repo, 3);

      expect(fake.calls[0].args.join(' ')).toContain(
        'merge_requests/3/notes'
      );
      expect(comments).toEqual([
        {
          id: '123',
          author: 'ana',
          body: 'nice',
          createdAt: '2026-01-01T00:00:00Z',
        },
      ]);
    });
  });
});

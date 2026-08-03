import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createGhRunner } from '../../../src/transport/gh.js';
import { createGitHubCodeProvider } from '../../../src/domains/code/github.js';
import { createFakeGh } from '../../helpers/fake-gh.js';
import { CliError } from '../../../src/core/errors.js';

const repo = { owner: 'acme', repo: 'widget' };

function makeProvider(responses: Parameters<typeof createFakeGh>[0]) {
  const fake = createFakeGh(responses);
  const runner = createGhRunner(fake.run);
  return { provider: createGitHubCodeProvider(runner), fake };
}

function prFixture(overrides: Record<string, unknown> = {}) {
  return {
    number: 3,
    title: 'title',
    body: 'body',
    state: 'open',
    html_url: 'https://github.com/acme/widget/pull/3',
    head: { ref: 'feature', sha: 'abc123' },
    base: { ref: 'main' },
    node_id: 'PR_3',
    ...overrides,
  };
}

describe('createGitHubCodeProvider', () => {
  describe('createBranch', () => {
    it('creates a linked branch when an issue id is given', async () => {
      const { provider, fake } = makeProvider([
        {
          stdout: JSON.stringify({
            data: {
              repository: {
                id: 'R_1',
                issue: {
                  id: 'I_42',
                  title: 'Fix the bug',
                  linkedBranches: { nodes: [] },
                },
                defaultBranchRef: { target: { oid: 'defabc' } },
                baseRef: null,
              },
            },
          }),
        },
        {
          stdout: JSON.stringify({
            data: {
              createLinkedBranch: {
                linkedBranch: { ref: { name: '42-fix-the-bug' } },
              },
            },
          }),
        },
      ]);

      const result = await provider.createBranch(
        repo,
        '42',
        '42-fix-the-bug',
        undefined
      );

      expect(result).toEqual({ name: '42-fix-the-bug' });
      expect(fake.calls).toHaveLength(2);
      expect(fake.calls[0].args[0]).toBe('api');
      expect(fake.calls[0].args[1]).toBe('graphql');
      expect(fake.calls[1].args[1]).toBe('graphql');
      expect(fake.calls[1].input).toBeUndefined();
      expect(fake.calls[1].args).toContain('name=42-fix-the-bug');
      expect(fake.calls[1].args).toContain('oid=defabc');
    });

    it('returns an existing linked branch without creating a new one', async () => {
      const { provider, fake } = makeProvider([
        {
          stdout: JSON.stringify({
            data: {
              repository: {
                id: 'R_1',
                issue: {
                  id: 'I_42',
                  title: 'Fix the bug',
                  linkedBranches: {
                    nodes: [
                      { ref: { name: '42-fix-the-bug', target: { oid: 'aaa' } } },
                    ],
                  },
                },
                defaultBranchRef: { target: { oid: 'defabc' } },
                baseRef: null,
              },
            },
          }),
        },
      ]);

      const result = await provider.createBranch(repo, '42', 'other', undefined);

      expect(result).toEqual({ name: '42-fix-the-bug' });
      expect(fake.calls).toHaveLength(1);
    });

    it('creates a plain branch when no issue is given', async () => {
      const { provider, fake } = makeProvider([
        {
          stdout: JSON.stringify({
            data: {
              repository: {
                id: 'R_1',
                defaultBranchRef: { target: { oid: 'defabc' } },
                baseRef: null,
                ref: null,
              },
            },
          }),
        },
        {
          stdout: JSON.stringify({
            data: {
              createRef: { ref: { name: 'refs/heads/feature-x' } },
            },
          }),
        },
      ]);

      const result = await provider.createBranch(
        repo,
        null,
        'feature-x',
        undefined
      );

      expect(result).toEqual({ name: 'feature-x' });
      expect(fake.calls).toHaveLength(2);
    });

    it('returns an existing plain branch without creating a new one', async () => {
      const { provider, fake } = makeProvider([
        {
          stdout: JSON.stringify({
            data: {
              repository: {
                id: 'R_1',
                defaultBranchRef: { target: { oid: 'defabc' } },
                baseRef: null,
                ref: { target: { oid: 'bbb' } },
              },
            },
          }),
        },
      ]);

      const result = await provider.createBranch(
        repo,
        null,
        'feature-x',
        undefined
      );

      expect(result).toEqual({ name: 'feature-x' });
      expect(fake.calls).toHaveLength(1);
    });
  });

  describe('createPR', () => {
    it('uses the provided base branch', async () => {
      const { provider, fake } = makeProvider([
        {
          stdout: JSON.stringify(prFixture({ base: { ref: 'develop' } })),
        },
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
      const input = JSON.parse(fake.calls[0].input ?? '{}');
      expect(fake.calls[0].args).toContain('/repos/acme/widget/pulls');
      expect(input.base).toBe('develop');
    });

    it('fetches the default branch when base is omitted', async () => {
      const { provider, fake } = makeProvider([
        { stdout: JSON.stringify({ default_branch: 'main' }) },
        { stdout: JSON.stringify(prFixture()) },
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
      expect(fake.calls[0].args).toContain('/repos/acme/widget');
      expect(fake.calls[1].args).toContain('/repos/acme/widget/pulls');
      const input = JSON.parse(fake.calls[1].input ?? '{}');
      expect(input.base).toBe('main');
    });

    it('appends Closes #N lines for linked issues', async () => {
      const { provider, fake } = makeProvider([
        { stdout: JSON.stringify(prFixture()) },
      ]);

      await provider.createPR(
        repo,
        'title',
        'Initial',
        'feature',
        'main',
        { issues: ['42', '7'] }
      );

      const input = JSON.parse(fake.calls[0].input ?? '{}');
      expect(input.body).toBe('Initial\n\nCloses #42\nCloses #7\n');
    });

    it('skips closing lines already present in the body', async () => {
      const { provider, fake } = makeProvider([
        { stdout: JSON.stringify(prFixture()) },
      ]);

      await provider.createPR(
        repo,
        'title',
        'This fixes #42',
        'feature',
        'main',
        { issues: ['42', '7'] }
      );

      const input = JSON.parse(fake.calls[0].input ?? '{}');
      expect(input.body).toBe('This fixes #42\n\nCloses #7\n');
    });
  });

  describe('getPR / listPRs', () => {
    it('normalizes a merged PR state', async () => {
      const { provider } = makeProvider([
        {
          stdout: JSON.stringify(
            prFixture({ state: 'closed', merged: true })
          ),
        },
      ]);

      const pr = await provider.getPR(repo, 3);

      expect(pr.state).toBe('merged');
    });

    it('normalizes an open PR state', async () => {
      const { provider } = makeProvider([
        { stdout: JSON.stringify(prFixture()) },
      ]);

      const pr = await provider.getPR(repo, 3);

      expect(pr.state).toBe('open');
    });

    it('lists and normalizes PRs', async () => {
      const { provider, fake } = makeProvider([
        {
          stdout: JSON.stringify([
            prFixture({ number: 1, state: 'closed', merged: true }),
            prFixture({ number: 2, state: 'open' }),
          ]),
        },
      ]);

      const prs = await provider.listPRs(repo, { state: 'all', limit: 10 });

      expect(prs).toHaveLength(2);
      expect(prs[0].state).toBe('merged');
      expect(prs[1].state).toBe('open');
      expect(fake.calls[0].args.join(' ')).toContain('state=all');
      expect(fake.calls[0].args.join(' ')).toContain('per_page=10');
    });
  });

  describe('updatePR', () => {
    it('patches title, body and state', async () => {
      const { provider, fake } = makeProvider([
        { stdout: JSON.stringify(prFixture({ state: 'closed' })) },
      ]);

      const { pr, warnings } = await provider.updatePR(repo, 3, {
        title: 'new title',
        body: 'new body',
        state: 'closed',
      });

      expect(pr.state).toBe('closed');
      expect(warnings).toEqual([]);
      expect(fake.calls[0].args).toContain('--method');
      expect(fake.calls[0].args).toContain('PATCH');
      const input = JSON.parse(fake.calls[0].input ?? '{}');
      expect(input).toEqual({
        title: 'new title',
        body: 'new body',
        state: 'closed',
      });
    });

    it('converts a PR to draft and back', async () => {
      const { provider, fake } = makeProvider([
        { stdout: JSON.stringify(prFixture()) },
        { stdout: JSON.stringify({ data: { convertPullRequestToDraft: { pullRequest: { id: 'PR_3' } } } }) },
      ]);

      const { pr } = await provider.updatePR(repo, 3, { draft: true });

      expect(pr.number).toBe(3);
      expect(fake.calls[1].args[1]).toBe('graphql');
      expect(fake.calls[1].input).toBeUndefined();
      expect(fake.calls[1].args).toContain('pullRequestId=PR_3');
      const queryArg = fake.calls[1].args[
        fake.calls[1].args.indexOf('-f') + 1
      ];
      expect(queryArg).toContain('convertPullRequestToDraft');
    });

    it('replaces labels via the issue endpoint', async () => {
      const { provider, fake } = makeProvider([
        { stdout: JSON.stringify(prFixture()) },
        { stdout: JSON.stringify({}) },
      ]);

      const { warnings } = await provider.updatePR(repo, 3, {
        labels: ['bug', 'agent'],
      });

      expect(warnings).toEqual([]);
      expect(fake.calls[1].args).toContain('/repos/acme/widget/issues/3/labels');
      const input = JSON.parse(fake.calls[1].input ?? '{}');
      expect(input.labels).toEqual(['bug', 'agent']);
    });

    it('resolves milestone by title', async () => {
      const { provider, fake } = makeProvider([
        { stdout: JSON.stringify(prFixture()) },
        {
          stdout: JSON.stringify([
            { number: 5, title: 'Sprint 1' },
            { number: 6, title: 'Sprint 2' },
          ]),
        },
        { stdout: JSON.stringify({}) },
      ]);

      const { warnings } = await provider.updatePR(repo, 3, {
        milestone: 'Sprint 2',
      });

      expect(warnings).toEqual([]);
      expect(fake.calls[2].args).toContain('/repos/acme/widget/issues/3');
      const input = JSON.parse(fake.calls[2].input ?? '{}');
      expect(input.milestone).toBe(6);
    });

    it('resolves milestone by number string', async () => {
      const { provider, fake } = makeProvider([
        { stdout: JSON.stringify(prFixture()) },
        { stdout: JSON.stringify({}) },
      ]);

      const { warnings } = await provider.updatePR(repo, 3, {
        milestone: '6',
      });

      expect(warnings).toEqual([]);
      expect(fake.calls[1].args).toContain('/repos/acme/widget/issues/3');
      const input = JSON.parse(fake.calls[1].input ?? '{}');
      expect(input.milestone).toBe(6);
    });

    it('resolves numeric label ids to names', async () => {
      const { provider, fake } = makeProvider([
        { stdout: JSON.stringify(prFixture()) },
        {
          stdout: JSON.stringify([
            { id: 123, name: 'bug', color: 'ff0000', description: '' },
          ]),
        },
        { stdout: JSON.stringify({}) },
      ]);

      const { warnings } = await provider.updatePR(repo, 3, {
        labels: ['123'],
      });

      expect(warnings).toEqual([]);
      expect(fake.calls[1].args.join(' ')).toContain('/repos/acme/widget/labels');
      expect(fake.calls[2].args).toContain('/repos/acme/widget/issues/3/labels');
      const input = JSON.parse(fake.calls[2].input ?? '{}');
      expect(input.labels).toEqual(['bug']);
    });

    it('batches reviewer and assignee changes', async () => {
      const { provider, fake } = makeProvider([
        { stdout: JSON.stringify(prFixture()) },
        { stdout: JSON.stringify({}) },
        { stdout: JSON.stringify({}) },
        { stdout: JSON.stringify({}) },
        { stdout: JSON.stringify({}) },
      ]);

      const { warnings } = await provider.updatePR(repo, 3, {
        add_reviewers: ['ana'],
        remove_reviewers: ['bob'],
        add_assignees: ['cal'],
        remove_assignees: ['deb'],
      });

      expect(warnings).toEqual([]);
      expect(fake.calls[1].args.join(' ')).toContain(
        '/repos/acme/widget/pulls/3/requested_reviewers'
      );
      expect(fake.calls[3].args.join(' ')).toContain(
        '/repos/acme/widget/issues/3/assignees'
      );
    });

    it('resolves $current to the authenticated login for add_reviewers', async () => {
      const { provider, fake } = makeProvider([
        { stdout: JSON.stringify(prFixture()) },
        { stdout: JSON.stringify({ login: 'ana' }) },
        { stdout: JSON.stringify({}) },
      ]);

      const { warnings } = await provider.updatePR(repo, 3, {
        add_reviewers: ['$current'],
      });

      expect(warnings).toEqual([]);
      expect(fake.calls[1].args.join(' ')).toContain('/user');
      const input = JSON.parse(fake.calls[2].input ?? '{}');
      expect(input.reviewers).toEqual(['ana']);
    });

    it('returns warnings for secondary failures and keeps the primary edit', async () => {
      const { provider, fake } = makeProvider([
        { stdout: JSON.stringify(prFixture()) },
        { error: new CliError(1, 'not found', 'gh') },
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
        { error: new CliError(1, 'not found', 'gh') },
      ]);

      await expect(
        provider.updatePR(repo, 3, { title: 'x' })
      ).rejects.toBeInstanceOf(CliError);
    });
  });

  describe('getPRChecks', () => {
    it('fetches check runs for the PR head and includes bounded logs', async () => {
      const lines = Array.from({ length: 250 }, (_, i) => `line ${i + 1}`);
      const log = lines.join('\n');
      const { provider, fake } = makeProvider([
        { stdout: JSON.stringify({ head: { sha: 'sha1' } }) },
        {
          stdout: JSON.stringify({
            check_runs: [
              {
                id: 101,
                name: 'ci',
                status: 'completed',
                conclusion: 'failure',
                html_url: 'https://checks/101',
              },
            ],
          }),
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
      expect(fake.calls[2].args.join(' ')).toContain('actions/jobs/101/logs');
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
      const input = JSON.parse(fake.calls[0].input ?? '{}');
      expect(input.merge_method).toBe('squash');
    });

    it('deletes the head branch after merge when deleteBranch is set', async () => {
      const { provider, fake } = makeProvider([
        { stdout: JSON.stringify(prFixture({ head: { ref: 'feature', sha: 'abc123' } })) },
        { stdout: JSON.stringify({}) },
        { stdout: JSON.stringify({}) },
      ]);

      const { warnings } = await provider.mergePR(repo, 3, 'squash', { deleteBranch: true });

      expect(warnings).toEqual([]);
      expect(fake.calls[2].args.join(' ')).toContain(
        '/repos/acme/widget/git/refs/heads/feature'
      );
      expect(fake.calls[2].args).toContain('DELETE');
    });

    it('reports a branch-delete failure as a warning without failing the merge', async () => {
      const { provider, fake } = makeProvider([
        { stdout: JSON.stringify(prFixture({ head: { ref: 'feature', sha: 'abc123' } })) },
        { stdout: JSON.stringify({}) },
        { error: new CliError(1, 'not found', 'gh') },
      ]);

      const { warnings } = await provider.mergePR(repo, 3, 'squash', { deleteBranch: true });

      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('delete branch failed');
      expect(fake.calls).toHaveLength(3);
    });
  });

  describe('getPRDiff', () => {
    it('returns gh pr diff output', async () => {
      const { provider, fake } = makeProvider([{ stdout: 'diff content' }]);

      const diff = await provider.getPRDiff(repo, 3);

      expect(diff).toBe('diff content');
      expect(fake.calls[0].args).toEqual([
        'pr',
        'diff',
        '3',
        '--repo',
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
    it('posts a review with uppercase event and shaped comments', async () => {
      const { provider, fake } = makeProvider([{ stdout: JSON.stringify({}) }]);

      await provider.submitPRReview(repo, 3, {
        event: 'request_changes',
        body: 'please fix',
        comments: [{ path: 'src/a.ts', line: 5, body: 'typo' }],
      });

      expect(fake.calls[0].args).toContain(
        '/repos/acme/widget/pulls/3/reviews'
      );
      const input = JSON.parse(fake.calls[0].input ?? '{}');
      expect(input.event).toBe('REQUEST_CHANGES');
      expect(input.comments).toEqual([
        { path: 'src/a.ts', line: 5, side: 'RIGHT', body: 'typo' },
      ]);
    });
  });

  describe('addPRComment / listPRComments', () => {
    it('adds and lists PR comments through the issue endpoint', async () => {
      const { provider, fake } = makeProvider([
        { stdout: JSON.stringify({}) },
        {
          stdout: JSON.stringify([
            {
              id: 123,
              user: { login: 'ana' },
              body: 'nice',
              created_at: '2026-01-01T00:00:00Z',
            },
          ]),
        },
      ]);

      await provider.addPRComment(repo, 3, 'nice');
      const comments = await provider.listPRComments(repo, 3);

      expect(fake.calls[0].args).toContain(
        '/repos/acme/widget/issues/3/comments'
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

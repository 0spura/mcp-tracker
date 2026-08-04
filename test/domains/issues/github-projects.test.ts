import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createGhRunner } from '../../../src/transport/gh.js';
import { createGitHubProjectsIssueProvider } from '../../../src/domains/issues/github-projects.js';
import type { IssueProvider } from '../../../src/domains/issues/capabilities.js';
import { createFakeGh } from '../../helpers/fake-gh.js';
import { CliError } from '../../../src/core/errors.js';

const repo = { owner: 'acme', repo: 'widget' };

function makeProvider(responses: Parameters<typeof createFakeGh>[0]) {
  const fake = createFakeGh(responses);
  const runner = createGhRunner(fake.run);
  const provider = createGitHubProjectsIssueProvider(runner) as Required<IssueProvider>;
  return { provider, fake };
}

function issueFixture(overrides: Record<string, unknown> = {}) {
  const number = (overrides.number as number | undefined) ?? 42;
  return {
    number,
    title: 'A bug',
    body: 'details',
    state: 'open',
    html_url: `https://github.com/acme/widget/issues/${number}`,
    node_id: `I_${number}`,
    labels: [{ name: 'bug' }],
    assignees: [{ login: 'ana' }],
    milestone: null,
    ...overrides,
  };
}

function graphqlOk(data: unknown) {
  return { stdout: JSON.stringify({ data }) };
}

function restInput(call: { input?: string }) {
  return JSON.parse(call.input ?? '{}');
}

function daysAhead(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

function graphqlQuery(call: { args: string[]; input?: string }) {
  if (call.input) {
    const parsed = JSON.parse(call.input);
    return parsed.query as string;
  }
  const idx = call.args.indexOf('-f');
  if (idx === -1) return '';
  const value = call.args[idx + 1];
  return value.startsWith('query=') || value.startsWith('mutation=')
    ? value.replace(/^query=|^mutation=/, '')
    : value;
}

function graphqlVariables(call: { args: string[]; input?: string }) {
  if (call.input) {
    const parsed = JSON.parse(call.input);
    return parsed.variables as Record<string, unknown>;
  }
  const vars: Record<string, unknown> = {};
  for (let i = 0; i < call.args.length; i++) {
    if (call.args[i] === '-F') {
      const [key, ...rest] = call.args[i + 1].split('=');
      vars[key] = rest.join('=');
    }
  }
  return vars;
}

describe('createGitHubProjectsIssueProvider', () => {
  describe('listIssueTypes', () => {
    it('lists and caches repository issue types', async () => {
      const { provider, fake } = makeProvider([
        {
          stdout: JSON.stringify([
            { id: 1, name: 'Bug', description: 'Unexpected behavior', color: 'red' },
          ]),
        },
      ]);

      const first = await provider.listIssueTypes!({ repo });
      const second = await provider.listIssueTypes!({ repo });

      expect(first).toEqual([
        { id: 1, name: 'Bug', description: 'Unexpected behavior', color: 'red' },
      ]);
      expect(second).toEqual(first);
      expect(fake.calls).toHaveLength(1);
      expect(fake.calls[0].args.join(' ')).toContain('/repos/acme/widget/issue-types');
    });
  });

  describe('listIssues', () => {
    it('lists issues and normalizes ids and state', async () => {
      const { provider, fake } = makeProvider([
        {
          stdout: JSON.stringify([
            issueFixture({ number: 1, state: 'closed' }),
            { ...issueFixture({ number: 2 }), pull_request: { url: 'https://github.com/acme/widget/pull/2' } },
          ]),
        },
      ]);

      const issues = await provider.listIssues({ repo });

      expect(issues).toHaveLength(1);
      expect(issues[0]).toEqual({
        id: '1',
        title: 'A bug',
        body: 'details',
        state: 'closed',
        url: 'https://github.com/acme/widget/issues/1',
        labels: ['bug'],
        assignees: ['ana'],
        milestone: null,
      });
      expect(fake.calls[0].args.join(' ')).toContain('/repos/acme/widget/issues?');
      expect(fake.calls[0].args.join(' ')).toContain('state=open');
      expect(fake.calls[0].args.join(' ')).toContain('per_page=50');
    });

    it('passes labels, assignee and limit', async () => {
      const { provider, fake } = makeProvider([
        { stdout: JSON.stringify([]) },
      ]);

      await provider.listIssues({ repo }, {
        state: 'all',
        labels: ['bug', 'agent'],
        assignee: 'ana',
        limit: 10,
      });

      const url = fake.calls[0].args.find((a) => a.includes('/issues?'))!;
      expect(url).toContain('state=all');
      expect(url).toContain('per_page=10');
      expect(url).toContain('labels=bug%2Cagent');
      expect(url).toContain('assignee=ana');
    });
  });

  describe('getIssue', () => {
    it('fetches and normalizes an issue', async () => {
      const { provider, fake } = makeProvider([
        { stdout: JSON.stringify(issueFixture({ number: 7, state: 'closed' })) },
      ]);

      const issue = await provider.getIssue({ repo }, '7');

      expect(issue.id).toBe('7');
      expect(issue.state).toBe('closed');
      expect(fake.calls[0].args.join(' ')).toContain('/repos/acme/widget/issues/7');
    });

    it('rejects non-numeric ids', async () => {
      const { provider } = makeProvider([]);
      await expect(provider.getIssue({ repo }, 'PROJ-123')).rejects.toThrow('non-numeric GitHub issue id');
    });
  });

  describe('createIssue', () => {
    it('creates a plain issue via REST', async () => {
      const { provider, fake } = makeProvider([
        { stdout: JSON.stringify(issueFixture()) },
      ]);

      const { issue, warnings } = await provider.createIssue(
        { repo },
        'A bug',
        'details',
        { labels: ['bug'], assignees: ['ana'] }
      );

      expect(issue.id).toBe('42');
      expect(warnings).toEqual([]);
      expect(fake.calls[0].args).toContain('/repos/acme/widget/issues');
      expect(fake.calls[0].args).toContain('--method');
      expect(fake.calls[0].args).toContain('POST');
      expect(restInput(fake.calls[0])).toEqual({
        title: 'A bug',
        body: 'details',
        labels: ['bug'],
        assignees: ['ana'],
      });
    });

    it('sets the native issue type and organization issue fields', async () => {
      const { provider, fake } = makeProvider([
        { stdout: JSON.stringify(issueFixture({ type: 'Infrastructure' })) },
        {
          stdout: JSON.stringify([
            { id: 10, name: 'Priority', data_type: 'single_select' },
            { id: 11, name: 'Effort', data_type: 'single_select' },
          ]),
        },
        { stdout: JSON.stringify({}) },
      ]);

      await provider.createIssue({ repo }, 'An issue', 'details', {
        type: 'Infrastructure',
        issueFields: { Priority: 'Urgent', Effort: 'High' },
      });

      expect(restInput(fake.calls[0])).toMatchObject({
        type: 'Infrastructure',
      });
      expect(fake.calls[1].args.join(' ')).toContain('/orgs/acme/issue-fields');
      expect(restInput(fake.calls[2])).toEqual({
        issue_field_values: [
          { field_id: 10, value: 'Urgent' },
          { field_id: 11, value: 'High' },
        ],
      });
    });

    it('resolves $current to the authenticated login', async () => {
      const { provider, fake } = makeProvider([
        { stdout: JSON.stringify({ login: 'ana' }) },
        { stdout: JSON.stringify(issueFixture()) },
      ]);

      const { issue, warnings } = await provider.createIssue(
        { repo },
        'A bug',
        'details',
        { assignees: ['$current'] }
      );

      expect(issue.id).toBe('42');
      expect(warnings).toEqual([]);
      expect(fake.calls[0].args.join(' ')).toContain('/user');
      expect(restInput(fake.calls[1])).toMatchObject({ assignees: ['ana'] });
    });

    it('resolves numeric label ids to names', async () => {
      const { provider, fake } = makeProvider([
        {
          stdout: JSON.stringify([
            { id: 123, name: 'bug', color: 'ff0000', description: '' },
          ]),
        },
        { stdout: JSON.stringify(issueFixture()) },
      ]);

      const { issue, warnings } = await provider.createIssue(
        { repo },
        'A bug',
        'details',
        { labels: ['123'] }
      );

      expect(issue.id).toBe('42');
      expect(warnings).toEqual([]);
      expect(fake.calls[0].args.join(' ')).toContain('/repos/acme/widget/labels');
      expect(restInput(fake.calls[1])).toEqual({
        title: 'A bug',
        body: 'details',
        labels: ['bug'],
        assignees: [],
      });
    });

    it('composites board add, status, parent and relationships in order', async () => {
      const { provider, fake } = makeProvider([
        { stdout: JSON.stringify(issueFixture()) },
        graphqlOk({
          addProjectV2ItemById: { item: { id: 'PI_42' } },
        }),
        graphqlOk({
          node: {
            fields: {
              nodes: [
                {
                  __typename: 'ProjectV2SingleSelectField',
                  id: 'F_status',
                  name: 'Status',
                  options: [{ id: 'O_progress', name: 'In Progress' }],
                },
              ],
            },
          },
        }),
        graphqlOk({
          updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PI_42' } },
        }),
        { stdout: JSON.stringify({}) },
        graphqlOk({ repository: { issue: { id: 'I_7' } } }),
        graphqlOk({ addBlockedBy: { blockingIssue: { id: 'I_42' }, issue: { id: 'I_7' } } }),
      ]);

      const { issue, warnings } = await provider.createIssue(
        { repo, boardId: 'P_1' },
        'A bug',
        'details',
        {
          status: 'In Progress',
          parent: '5',
          blocks: ['7'],
        }
      );

      expect(issue.id).toBe('42');
      expect(warnings).toEqual([]);
      expect(fake.calls).toHaveLength(7);

      expect(fake.calls[0].args.join(' ')).toContain('/repos/acme/widget/issues');
      expect(graphqlQuery(fake.calls[1])).toContain('addProjectV2ItemById');
      expect(graphqlVariables(fake.calls[1])).toEqual({
        projectId: 'P_1',
        contentId: 'I_42',
      });

      expect(graphqlQuery(fake.calls[2])).toContain('ProjectV2SingleSelectField');
      expect(graphqlQuery(fake.calls[3])).toContain('updateProjectV2ItemFieldValue');
      const statusVars = graphqlVariables(fake.calls[3]);
      expect((statusVars.input as Record<string, unknown>).projectId).toBe('P_1');
      expect((statusVars.input as Record<string, unknown>).itemId).toBe('PI_42');

      expect(fake.calls[4].args.join(' ')).toContain('/repos/acme/widget/issues/5/sub_issues');
      expect(restInput(fake.calls[4])).toEqual({ sub_issue_id: 42 });

      expect(graphqlQuery(fake.calls[5])).toContain('issue(number: $number)');
      expect(graphqlQuery(fake.calls[5])).toContain('repository(owner: $owner, name: $repo)');
      expect(graphqlQuery(fake.calls[6])).toContain('addBlockedBy');
      const relVars = graphqlVariables(fake.calls[6]);
      expect(relVars).toEqual({ blockingIssueId: 'I_42', issueId: 'I_7' });
    });

    it('returns the issue with a warning when board add fails', async () => {
      const { provider, fake } = makeProvider([
        { stdout: JSON.stringify(issueFixture()) },
        { error: new CliError(1, 'project not found', 'gh') },
      ]);

      const { issue, warnings } = await provider.createIssue(
        { repo, boardId: 'P_MISSING' },
        'A bug',
        'details',
        { status: 'In Progress' }
      );

      expect(issue.id).toBe('42');
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('add to board failed');
      expect(fake.calls).toHaveLength(2);
    });
  });

  describe('updateIssue', () => {
    it('updates the native issue type and organization issue fields', async () => {
      const { provider, fake } = makeProvider([
        { stdout: JSON.stringify(issueFixture()) },
        { stdout: JSON.stringify([{ id: 10, name: 'Priority', data_type: 'single_select' }]) },
        { stdout: JSON.stringify({}) },
      ]);

      await provider.updateIssue({ repo }, '42', {
        type: 'Bug',
        issueFields: { Priority: 'Urgent' },
      });

      expect(restInput(fake.calls[0])).toEqual({ type: 'Bug' });
      expect(restInput(fake.calls[2])).toEqual({
        issue_field_values: [{ field_id: 10, value: 'Urgent' }],
      });
    });

    it('patches primary fields and returns warnings for secondary failures', async () => {
      const { provider, fake } = makeProvider([
        { stdout: JSON.stringify(issueFixture()) },
        { error: new CliError(1, 'not found', 'gh') },
      ]);

      const { issue, warnings } = await provider.updateIssue(
        { repo },
        '42',
        {
          title: 'Updated',
          labels: ['bug'],
          add_related: ['7'],
        }
      );

      expect(issue.id).toBe('42');
      expect(fake.calls[0].args).toContain('/repos/acme/widget/issues/42');
      expect(fake.calls[0].args).toContain('PATCH');
      expect(restInput(fake.calls[0])).toEqual({ title: 'Updated', labels: ['bug'] });
      expect(fake.calls[1].args.join(' ')).toContain('/repos/acme/widget/issues/42/comments');
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('add related #7 failed');
    });

    it('resolves milestone by title on update', async () => {
      const { provider, fake } = makeProvider([
        {
          stdout: JSON.stringify([
            { number: 5, title: 'Sprint 1' },
            { number: 6, title: 'Sprint 2' },
          ]),
        },
        { stdout: JSON.stringify(issueFixture()) },
      ]);

      const { issue, warnings } = await provider.updateIssue(
        { repo },
        '42',
        { milestone: 'Sprint 2' }
      );

      expect(issue.id).toBe('42');
      expect(warnings).toEqual([]);
      expect(fake.calls[0].args.join(' ')).toContain('milestones');
      expect(fake.calls[1].args).toContain('/repos/acme/widget/issues/42');
      expect(restInput(fake.calls[1])).toEqual({ milestone: 6 });
    });

    it('resolves milestone by number string', async () => {
      const { provider, fake } = makeProvider([
        { stdout: JSON.stringify(issueFixture()) },
      ]);

      const { issue } = await provider.updateIssue(
        { repo },
        '42',
        { milestone: '6' }
      );

      expect(issue.id).toBe('42');
      expect(fake.calls[0].args).toContain('/repos/acme/widget/issues/42');
      expect(restInput(fake.calls[0])).toEqual({ milestone: 6 });
    });

    it('resolves numeric label ids to names on update', async () => {
      const { provider, fake } = makeProvider([
        {
          stdout: JSON.stringify([
            { id: 123, name: 'bug', color: 'ff0000', description: '' },
          ]),
        },
        { stdout: JSON.stringify(issueFixture()) },
      ]);

      const { issue } = await provider.updateIssue(
        { repo },
        '42',
        { labels: ['123'] }
      );

      expect(issue.id).toBe('42');
      expect(fake.calls[0].args.join(' ')).toContain('/repos/acme/widget/labels');
      expect(restInput(fake.calls[1])).toEqual({ labels: ['bug'] });
    });

    it('clears milestone with null', async () => {
      const { provider, fake } = makeProvider([
        { stdout: JSON.stringify(issueFixture()) },
      ]);

      const { issue } = await provider.updateIssue(
        { repo },
        '42',
        { milestone: null }
      );

      expect(issue.id).toBe('42');
      expect(restInput(fake.calls[0])).toEqual({ milestone: null });
    });

    it('resolves $current to the open milestone with the nearest upcoming due date', async () => {
      const { provider, fake } = makeProvider([
        {
          stdout: JSON.stringify([
            { number: 5, title: 'Expired', due_on: daysAgo(7) },
            { number: 6, title: 'Soon', due_on: daysAhead(7) },
            { number: 7, title: 'Later', due_on: daysAhead(30) },
            { number: 8, title: 'Undated', due_on: null },
          ]),
        },
        { stdout: JSON.stringify(issueFixture()) },
      ]);

      const { issue } = await provider.updateIssue(
        { repo },
        '42',
        { milestone: '$current' }
      );

      expect(issue.id).toBe('42');
      expect(fake.calls[0].args.join(' ')).toContain('milestones?state=open');
      expect(restInput(fake.calls[1])).toEqual({ milestone: 6 });
    });

    it('errors when no open milestone has an upcoming due date', async () => {
      const { provider } = makeProvider([
        { stdout: JSON.stringify([{ number: 5, title: 'Expired', due_on: daysAgo(7) }]) },
      ]);

      await expect(
        provider.updateIssue({ repo }, '42', { milestone: '$current' })
      ).rejects.toThrow('no open milestone with an upcoming due date');
    });

    it('throws when the primary edit fails', async () => {
      const { provider } = makeProvider([
        { error: new CliError(1, 'not found', 'gh') },
      ]);

      await expect(
        provider.updateIssue({ repo }, '42', { title: 'x' })
      ).rejects.toBeInstanceOf(CliError);
    });
  });

  describe('setIssueStatus', () => {
    it('requires board context', async () => {
      const { provider } = makeProvider([]);
      await expect(
        provider.setIssueStatus({ repo }, '42', 'Done')
      ).rejects.toThrow('board context is required');
    });

    it('sets status using the configured board and caches field lookup', async () => {
      const { provider, fake } = makeProvider([
        graphqlOk({
          node: {
            fields: {
              nodes: [
                {
                  __typename: 'ProjectV2SingleSelectField',
                  id: 'F_status',
                  name: 'Status',
                  options: [
                    { id: 'O_doing', name: 'Doing' },
                    { id: 'O_done', name: 'Done' },
                  ],
                },
              ],
            },
          },
        }),
        graphqlOk({
          repository: {
            issue: {
              projectItems: {
                nodes: [{ id: 'PI_42', project: { id: 'P_1' } }],
              },
            },
          },
        }),
        graphqlOk({
          updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PI_42' } },
        }),
        graphqlOk({
          repository: {
            issue: {
              projectItems: {
                nodes: [{ id: 'PI_42', project: { id: 'P_1' } }],
              },
            },
          },
        }),
        graphqlOk({
          updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PI_42' } },
        }),
      ]);

      await provider.setIssueStatus({ repo, boardId: 'P_1' }, '42', 'Done');
      await provider.setIssueStatus({ repo, boardId: 'P_1' }, '42', 'Doing');

      const fieldFetches = fake.calls.filter((c) =>
        graphqlQuery(c).includes('ProjectV2SingleSelectField')
      );
      expect(fieldFetches).toHaveLength(1);
      expect(fake.calls).toHaveLength(5);

      const vars = graphqlVariables(fake.calls[2]);
      expect((vars.input as Record<string, unknown>).value).toEqual({
        singleSelectOptionId: 'O_done',
      });
    });
  });

  describe('addIssueComment / listIssueComments', () => {
    it('adds and lists comments through the issue endpoint', async () => {
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

      await provider.addIssueComment({ repo }, '42', 'nice');
      const comments = await provider.listIssueComments({ repo }, '42');

      expect(fake.calls[0].args.join(' ')).toContain('/repos/acme/widget/issues/42/comments');
      expect(fake.calls[0].args).toContain('POST');
      expect(restInput(fake.calls[0])).toEqual({ body: 'nice' });
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

  describe('toggleChecklistItem', () => {
    it('uses the shared checklist logic and writes the body back', async () => {
      const { provider, fake } = makeProvider([
        {
          stdout: JSON.stringify(
            issueFixture({ body: '- [ ] fix typo\n- [ ] add test' })
          ),
        },
        { stdout: JSON.stringify(issueFixture({ body: '- [x] fix typo\n- [ ] add test' })) },
      ]);

      const result = await provider.toggleChecklistItem({ repo }, '42', 'fix typo');

      expect(result.matched).toBe('fix typo');
      expect(result.checked).toBe(true);
      expect(fake.calls[1].args).toContain('/repos/acme/widget/issues/42');
      expect(fake.calls[1].args).toContain('PATCH');
      expect(restInput(fake.calls[1])).toEqual({
        body: '- [x] fix typo\n- [ ] add test',
      });
    });

    it('throws when no item matches', async () => {
      const { provider } = makeProvider([
        { stdout: JSON.stringify(issueFixture({ body: '- [ ] other' })) },
      ]);

      await expect(
        provider.toggleChecklistItem({ repo }, '42', 'missing')
      ).rejects.toThrow('no checklist item matching');
    });
  });

  describe('setRelationship', () => {
    it('maps blocks to native addBlockedBy', async () => {
      const { provider, fake } = makeProvider([
        graphqlOk({ repository: { issue: { id: 'I_42' } } }),
        graphqlOk({ repository: { issue: { id: 'I_7' } } }),
        graphqlOk({ addBlockedBy: { blockingIssue: { id: 'I_42' }, issue: { id: 'I_7' } } }),
      ]);

      const result = await provider.setRelationship({ repo }, '42', 'blocks', '7');

      expect(result.mechanism).toBe('native');
      expect(graphqlQuery(fake.calls[2])).toContain('addBlockedBy');
      expect(graphqlVariables(fake.calls[2])).toEqual({
        blockingIssueId: 'I_42',
        issueId: 'I_7',
      });
    });

    it('maps blocked_by to native addBlockedBy with swapped ids', async () => {
      const { provider, fake } = makeProvider([
        graphqlOk({ repository: { issue: { id: 'I_42' } } }),
        graphqlOk({ repository: { issue: { id: 'I_7' } } }),
        graphqlOk({ addBlockedBy: { blockingIssue: { id: 'I_7' }, issue: { id: 'I_42' } } }),
      ]);

      const result = await provider.setRelationship({ repo }, '42', 'blocked_by', '7');

      expect(result.mechanism).toBe('native');
      expect(graphqlVariables(fake.calls[2])).toEqual({
        blockingIssueId: 'I_7',
        issueId: 'I_42',
      });
    });

    it('maps duplicate to a keyword comment', async () => {
      const { provider, fake } = makeProvider([{ stdout: JSON.stringify({}) }]);

      const result = await provider.setRelationship({ repo }, '42', 'duplicate', '7');

      expect(result.mechanism).toBe('keyword-comment');
      expect(fake.calls[0].args.join(' ')).toContain('/repos/acme/widget/issues/42/comments');
      expect(restInput(fake.calls[0])).toEqual({ body: 'Duplicate of #7' });
    });

    it('maps related to a reference comment', async () => {
      const { provider, fake } = makeProvider([{ stdout: JSON.stringify({}) }]);

      const result = await provider.setRelationship({ repo }, '42', 'related', '7');

      expect(result.mechanism).toBe('reference-comment');
      expect(restInput(fake.calls[0])).toEqual({ body: 'Related: #7' });
    });
  });

  describe('addSubIssue / listSubIssues', () => {
    it('adds a sub-issue via the REST endpoint', async () => {
      const { provider, fake } = makeProvider([{ stdout: JSON.stringify({}) }]);

      await provider.addSubIssue({ repo }, '5', '6');

      expect(fake.calls[0].args.join(' ')).toContain('/repos/acme/widget/issues/5/sub_issues');
      expect(fake.calls[0].args).toContain('POST');
      expect(restInput(fake.calls[0])).toEqual({ sub_issue_id: 6 });
    });

    it('lists sub-issues', async () => {
      const { provider, fake } = makeProvider([
        { stdout: JSON.stringify([issueFixture({ number: 6 })]) },
      ]);

      const issues = await provider.listSubIssues({ repo }, '5');

      expect(issues).toHaveLength(1);
      expect(issues[0].id).toBe('6');
      expect(fake.calls[0].args.join(' ')).toContain('/repos/acme/widget/issues/5/sub_issues');
    });
  });

  describe('listLabels / listMilestones', () => {
    it('lists labels', async () => {
      const { provider, fake } = makeProvider([
        {
          stdout: JSON.stringify([
            { id: 1, name: 'bug', color: 'ff0000', description: 'Bug' },
          ]),
        },
      ]);

      const labels = await provider.listLabels({ repo });

      expect(labels).toEqual([{ name: 'bug', color: 'ff0000', description: 'Bug' }]);
      expect(fake.calls[0].args.join(' ')).toContain('/repos/acme/widget/labels');
    });

    it('lists milestones normalized', async () => {
      const { provider, fake } = makeProvider([
        {
          stdout: JSON.stringify([
            { number: 5, title: 'Sprint 1', state: 'open', due_on: '2026-01-01T00:00:00Z' },
          ]),
        },
      ]);

      const milestones = await provider.listMilestones({ repo }, 'open');

      expect(milestones).toEqual([
        { id: '5', title: 'Sprint 1', state: 'open', dueOn: '2026-01-01T00:00:00Z' },
      ]);
      expect(fake.calls[0].args.join(' ')).toContain('/repos/acme/widget/milestones?state=open');
    });
  });
});

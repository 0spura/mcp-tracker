import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createGlabRunner } from '../../../src/transport/glab.js';
import { createGitLabIssueProvider } from '../../../src/domains/issues/gitlab.js';
import type { IssueProvider } from '../../../src/domains/issues/capabilities.js';
import { createFakeGlab } from '../../helpers/fake-glab.js';
import { CliError, UnsupportedError } from '../../../src/core/errors.js';

const repo = { owner: 'acme', repo: 'widget' };

function makeProvider(
  responses: Parameters<typeof createFakeGlab>[0],
  stages?: Array<{ key: string; name: string; id?: string }>
) {
  const fake = createFakeGlab(responses);
  const runner = createGlabRunner(fake.run);
  const provider = createGitLabIssueProvider(runner, { stages }) as Required<IssueProvider>;
  return { provider, fake };
}

function issueFixture(overrides: Record<string, unknown> = {}) {
  const number = (overrides.iid as number | undefined) ?? 42;
  return {
    iid: number,
    title: 'A bug',
    description: 'details',
    state: 'opened',
    web_url: `https://gitlab.com/acme/widget/-/issues/${number}`,
    labels: ['bug'],
    assignees: [{ username: 'ana' }],
    milestone: null,
    ...overrides,
  };
}

function graphqlOk(data: unknown) {
  return { stdout: JSON.stringify({ data }) };
}

function restFields(call: { input?: string }) {
  return JSON.parse(call.input ?? '{}') as Record<string, unknown>;
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

describe('createGitLabIssueProvider', () => {
  describe('listIssues', () => {
    it('lists issues and normalizes ids and state', async () => {
      const { provider, fake } = makeProvider([
        {
          stdout: JSON.stringify([
            issueFixture({ iid: 1, state: 'closed' }),
            issueFixture({ iid: 2 }),
          ]),
        },
      ]);

      const issues = await provider.listIssues({ repo });

      expect(issues).toHaveLength(2);
      expect(issues[0]).toEqual({
        id: '1',
        title: 'A bug',
        body: 'details',
        state: 'closed',
        url: 'https://gitlab.com/acme/widget/-/issues/1',
        labels: ['bug'],
        assignees: ['ana'],
        milestone: null,
      });
      expect(fake.calls[0].args.join(' ')).toContain('projects/acme%2Fwidget/issues?');
      expect(fake.calls[0].args.join(' ')).toContain('state=opened');
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
      expect(url).toContain('assignee_username=ana');
    });
  });

  describe('getIssue', () => {
    it('fetches and normalizes an issue', async () => {
      const { provider, fake } = makeProvider([
        { stdout: JSON.stringify(issueFixture({ iid: 7, state: 'closed' })) },
      ]);

      const issue = await provider.getIssue({ repo }, '7');

      expect(issue.id).toBe('7');
      expect(issue.state).toBe('closed');
      expect(fake.calls[0].args.join(' ')).toContain('projects/acme%2Fwidget/issues/7');
    });

    it('rejects non-numeric ids', async () => {
      const { provider } = makeProvider([]);
      await expect(provider.getIssue({ repo }, 'PROJ-123')).rejects.toThrow('non-numeric GitLab issue id');
    });
  });

  describe('createIssue', () => {
    it('creates a plain issue via REST', async () => {
      const { provider, fake } = makeProvider([
        { stdout: JSON.stringify([{ id: 1, username: 'ana' }]) },
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
      expect(fake.calls[1].args).toContain('projects/acme%2Fwidget/issues');
      expect(fake.calls[1].args).toContain('--method');
      expect(fake.calls[1].args).toContain('POST');
      expect(restFields(fake.calls[1])).toMatchObject({
        title: 'A bug',
        description: 'details',
        labels: 'bug',
      });
      expect(fake.calls[0].args.join(' ')).toContain('users?username=ana');
    });

    it('sets initial status and relationships', async () => {
      const { provider, fake } = makeProvider([
        { stdout: JSON.stringify(issueFixture()) },
        { stdout: JSON.stringify({}) },
        { stdout: JSON.stringify({ id: 1 }) },
        { stdout: JSON.stringify({}) },
      ], [
        { key: 'doing', name: 'Doing' },
        { key: 'done', name: 'Done' },
      ]);

      const { issue, warnings } = await provider.createIssue(
        { repo },
        'A bug',
        'details',
        { status: 'Doing', blocks: ['7'] }
      );

      expect(issue.id).toBe('42');
      expect(warnings).toEqual([]);
      expect(fake.calls).toHaveLength(4);

      expect(fake.calls[0].args.join(' ')).toContain('projects/acme%2Fwidget/issues');
      expect(fake.calls[1].args.join(' ')).toContain('projects/acme%2Fwidget/issues/42');
      expect(restFields(fake.calls[1])).toEqual({
        add_labels: 'Doing',
        remove_labels: 'Done',
      });

      expect(fake.calls[2].args.join(' ')).toContain('projects/acme%2Fwidget');
      expect(fake.calls[3].args.join(' ')).toContain('issues/42/links');
      expect(restFields(fake.calls[3])).toMatchObject({
        target_issue_iid: 7,
        link_type: 'relates_to',
      });
    });

    it('returns the issue with a warning when status set fails', async () => {
      const { provider, fake } = makeProvider([
        { stdout: JSON.stringify(issueFixture()) },
        { error: new CliError(1, 'not found', 'glab') },
      ], [{ key: 'doing', name: 'Doing' }]);

      const { issue, warnings } = await provider.createIssue(
        { repo },
        'A bug',
        'details',
        { status: 'Doing' }
      );

      expect(issue.id).toBe('42');
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('set status failed');
      expect(fake.calls).toHaveLength(2);
    });
  });

  describe('updateIssue', () => {
    it('patches primary fields and returns warnings for secondary failures', async () => {
      const { provider, fake } = makeProvider([
        { stdout: JSON.stringify(issueFixture()) },
        { stdout: JSON.stringify({ id: 1 }) },
        { error: new CliError(1, 'not found', 'glab') },
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
      expect(fake.calls[0].args.join(' ')).toContain('projects/acme%2Fwidget/issues/42');
      expect(fake.calls[0].args).toContain('PUT');
      expect(restFields(fake.calls[0])).toEqual({
        title: 'Updated',
        labels: 'bug',
      });
      expect(fake.calls[2].args.join(' ')).toContain('issues/42/links');
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('add related #7 failed');
    });

    it('resolves milestone by title on update', async () => {
      const { provider, fake } = makeProvider([
        {
          stdout: JSON.stringify([
            { id: 5, title: 'Sprint 1' },
            { id: 6, title: 'Sprint 2' },
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
      expect(fake.calls[1].args.join(' ')).toContain('projects/acme%2Fwidget/issues/42');
      expect(restFields(fake.calls[1])).toEqual({ milestone_id: 6 });
    });

    it('resolves milestone by id string', async () => {
      const { provider, fake } = makeProvider([
        { stdout: JSON.stringify({ id: 6, title: 'Sprint 2' }) },
        { stdout: JSON.stringify(issueFixture()) },
      ]);

      const { issue, warnings } = await provider.updateIssue(
        { repo },
        '42',
        { milestone: '6' }
      );

      expect(issue.id).toBe('42');
      expect(warnings).toEqual([]);
      expect(fake.calls[0].args.join(' ')).toContain('milestones/6');
      expect(restFields(fake.calls[1])).toEqual({ milestone_id: 6 });
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
      expect(restFields(fake.calls[0])).toEqual({ milestone_id: 0 });
    });

    it('resolves $current to the active milestone with the nearest upcoming due date', async () => {
      const { provider, fake } = makeProvider([
        {
          stdout: JSON.stringify([
            { id: 5, title: 'Expired', due_date: daysAgo(7) },
            { id: 6, title: 'Soon', due_date: daysAhead(7) },
            { id: 7, title: 'Later', due_date: daysAhead(30) },
            { id: 8, title: 'Undated', due_date: null },
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
      expect(fake.calls[0].args.join(' ')).toContain('milestones?state=active');
      expect(restFields(fake.calls[1])).toEqual({ milestone_id: 6 });
    });

    it('errors when no active milestone has an upcoming due date', async () => {
      const { provider } = makeProvider([
        { stdout: JSON.stringify([{ id: 5, title: 'Expired', due_date: daysAgo(7) }]) },
      ]);

      await expect(
        provider.updateIssue({ repo }, '42', { milestone: '$current' })
      ).rejects.toThrow('no active milestone with an upcoming due date');
    });

    it('throws when the primary edit fails', async () => {
      const { provider } = makeProvider([
        { error: new CliError(1, 'not found', 'glab') },
      ]);

      await expect(
        provider.updateIssue({ repo }, '42', { title: 'x' })
      ).rejects.toBeInstanceOf(CliError);
    });
  });

  describe('setIssueStatus', () => {
    it('adds the target label and removes other configured status labels', async () => {
      const { provider, fake } = makeProvider([
        { stdout: JSON.stringify({}) },
      ], [
        { key: 'doing', name: 'Doing' },
        { key: 'done', name: 'Done' },
      ]);

      await provider.setIssueStatus({ repo }, '42', 'Done');

      expect(fake.calls[0].args.join(' ')).toContain('projects/acme%2Fwidget/issues/42');
      expect(restFields(fake.calls[0])).toEqual({
        add_labels: 'Done',
        remove_labels: 'Doing',
      });
    });

    it('uses stage id when present', async () => {
      const { provider, fake } = makeProvider([
        { stdout: JSON.stringify({}) },
      ], [
        { key: 'doing', name: 'Doing', id: 'status-doing' },
        { key: 'done', name: 'Done', id: 'status-done' },
      ]);

      await provider.setIssueStatus({ repo }, '42', 'done');

      expect(restFields(fake.calls[0])).toEqual({
        add_labels: 'status-done',
        remove_labels: 'status-doing',
      });
    });

    it('falls back to the literal status when no stage matches', async () => {
      const { provider, fake } = makeProvider([
        { stdout: JSON.stringify({}) },
      ]);

      await provider.setIssueStatus({ repo }, '42', 'custom');

      expect(restFields(fake.calls[0])).toEqual({ add_labels: 'custom' });
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
              author: { username: 'ana' },
              body: 'nice',
              created_at: '2026-01-01T00:00:00Z',
            },
          ]),
        },
      ]);

      await provider.addIssueComment({ repo }, '42', 'nice');
      const comments = await provider.listIssueComments({ repo }, '42');

      expect(fake.calls[0].args.join(' ')).toContain('projects/acme%2Fwidget/issues/42/notes');
      expect(fake.calls[0].args).toContain('POST');
      expect(restFields(fake.calls[0])).toEqual({ body: 'nice' });
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
            issueFixture({ description: '- [ ] fix typo\n- [ ] add test' })
          ),
        },
        { stdout: JSON.stringify(issueFixture({ description: '- [x] fix typo\n- [ ] add test' })) },
      ]);

      const result = await provider.toggleChecklistItem({ repo }, '42', 'fix typo');

      expect(result.matched).toBe('fix typo');
      expect(result.checked).toBe(true);
      expect(fake.calls[1].args.join(' ')).toContain('projects/acme%2Fwidget/issues/42');
      expect(fake.calls[1].args).toContain('PUT');
      expect(restFields(fake.calls[1])).toEqual({
        description: '- [x] fix typo\n- [ ] add test',
      });
    });

    it('throws when no item matches', async () => {
      const { provider } = makeProvider([
        { stdout: JSON.stringify(issueFixture({ description: '- [ ] other' })) },
      ]);

      await expect(
        provider.toggleChecklistItem({ repo }, '42', 'missing')
      ).rejects.toThrow('no checklist item matching');
    });
  });

  describe('setRelationship', () => {
    it('creates a relates_to link for blocks', async () => {
      const { provider, fake } = makeProvider([
        { stdout: JSON.stringify({ id: 99 }) },
        { stdout: JSON.stringify({}) },
      ]);

      const result = await provider.setRelationship({ repo }, '42', 'blocks', '7');

      expect(result.mechanism).toBe('native');
      expect(fake.calls[1].args.join(' ')).toContain('issues/42/links');
      expect(restFields(fake.calls[1])).toMatchObject({
        target_project_id: 99,
        target_issue_iid: 7,
        link_type: 'relates_to',
      });
    });
  });

  describe('addSubIssue / listSubIssues', () => {
    it('adds a sub-issue via GraphQL work items', async () => {
      const { provider, fake } = makeProvider([
        graphqlOk({ project: { workItems: { nodes: [{ id: 'PARENT_GID' }] } } }),
        graphqlOk({ project: { workItems: { nodes: [{ id: 'CHILD_GID' }] } } }),
        graphqlOk({ workItemUpdate: { workItem: { id: 'CHILD_GID' }, errors: [] } }),
      ]);

      await provider.addSubIssue({ repo }, '5', '6');

      expect(graphqlQuery(fake.calls[2])).toContain('workItemUpdate');
      expect(graphqlVariables(fake.calls[2])).toMatchObject({
        id: 'CHILD_GID',
        parentId: 'PARENT_GID',
      });
    });

    it('lists sub-issues from the hierarchy widget', async () => {
      const { provider, fake } = makeProvider([
        graphqlOk({
          project: {
            workItem: {
              widgets: [
                {
                  children: {
                    nodes: [{ id: 'gid://', iid: '6', title: 'Child', state: 'OPEN' }],
                  },
                },
              ],
            },
          },
        }),
      ]);

      const issues = await provider.listSubIssues({ repo }, '5');

      expect(issues).toHaveLength(1);
      expect(issues[0].id).toBe('6');
      expect(fake.calls[0].args).toContain('graphql');
      expect(graphqlQuery(fake.calls[0])).toContain('workItem(iid:');
    });
  });

  describe('listLabels / listMilestones', () => {
    it('lists labels', async () => {
      const { provider, fake } = makeProvider([
        {
          stdout: JSON.stringify([
            { name: 'bug', color: 'ff0000', description: 'Bug' },
          ]),
        },
      ]);

      const labels = await provider.listLabels({ repo });

      expect(labels).toEqual([{ name: 'bug', color: 'ff0000', description: 'Bug' }]);
      expect(fake.calls[0].args.join(' ')).toContain('projects/acme%2Fwidget/labels');
    });

    it('lists milestones normalized', async () => {
      const { provider, fake } = makeProvider([
        {
          stdout: JSON.stringify([
            { id: 5, title: 'Sprint 1', state: 'active', due_date: '2026-01-01' },
          ]),
        },
      ]);

      const milestones = await provider.listMilestones({ repo }, 'open');

      expect(milestones).toEqual([
        { id: '5', title: 'Sprint 1', state: 'open', dueOn: '2026-01-01' },
      ]);
      expect(fake.calls[0].args.join(' ')).toContain('projects/acme%2Fwidget/milestones');
      expect(fake.calls[0].args.join(' ')).toContain('state=open');
    });
  });
});

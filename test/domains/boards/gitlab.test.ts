import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createGlabRunner } from '../../../src/transport/glab.js';
import { createGitLabBoardProvider } from '../../../src/domains/boards/gitlab.js';
import { createFakeGlab } from '../../helpers/fake-glab.js';
import { UnsupportedError } from '../../../src/core/errors.js';

const repo = { owner: 'acme', repo: 'widget' };

function makeProvider(responses: Parameters<typeof createFakeGlab>[0]) {
  const fake = createFakeGlab(responses);
  const runner = createGlabRunner(fake.run);
  return { provider: createGitLabBoardProvider(runner), fake };
}

function listFixture(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: 1,
    label: { id: 10, name: 'Doing', color: '#000000', description: null },
    position: 1,
    ...overrides,
  };
}

function issueFixture(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  const iid = (overrides.iid as number | undefined) ?? 42;
  return {
    iid,
    title: 'A bug',
    state: 'opened',
    web_url: `https://gitlab.com/acme/widget/-/issues/${iid}`,
    labels: ['Doing'],
    ...overrides,
  };
}

function restFields(call: { input?: string }) {
  return JSON.parse(call.input ?? '{}') as Record<string, unknown>;
}

describe('createGitLabBoardProvider', () => {
  describe('listBoardItems', () => {
    it('aggregates issues from all lists and normalizes status and state', async () => {
      const { provider, fake } = makeProvider([
        {
          stdout: JSON.stringify([
            listFixture({ id: 1, label: { id: 10, name: 'Doing' }, position: 0 }),
            listFixture({ id: 2, label: null, position: 1 }),
            listFixture({ id: 3, label: { id: 11, name: 'Done' }, position: 2 }),
          ]),
        },
        {
          stdout: JSON.stringify([issueFixture({ iid: 1, title: 'First' })]),
        },
        { stdout: JSON.stringify([]) },
        {
          stdout: JSON.stringify([
            issueFixture({ iid: 2, title: 'Second', state: 'closed' }),
          ]),
        },
        { stdout: JSON.stringify([issueFixture({ iid: 7, title: 'Backlog', labels: [] })]) },
        { stdout: JSON.stringify([issueFixture({ iid: 8, title: 'Old', state: 'closed', labels: [] })]) },
      ]);

      const items = await provider.listBoardItems({ repo, boardId: '5' });

      expect(items).toHaveLength(4);
      expect(items[0]).toEqual({
        id: '1',
        status: 'Doing',
        content: {
          type: 'issue',
          id: '1',
          title: 'First',
          state: 'open',
          url: 'https://gitlab.com/acme/widget/-/issues/1',
        },
      });
      expect(items[1]).toEqual({
        id: '2',
        status: 'Done',
        content: {
          type: 'issue',
          id: '2',
          title: 'Second',
          state: 'closed',
          url: 'https://gitlab.com/acme/widget/-/issues/2',
        },
      });
      expect(items[2]).toEqual({
        id: '7',
        status: null,
        content: {
          type: 'issue',
          id: '7',
          title: 'Backlog',
          state: 'open',
          url: 'https://gitlab.com/acme/widget/-/issues/7',
        },
      });
      expect(items[3]).toEqual({
        id: '8',
        status: null,
        content: {
          type: 'issue',
          id: '8',
          title: 'Old',
          state: 'closed',
          url: 'https://gitlab.com/acme/widget/-/issues/8',
        },
      });

      expect(fake.calls[0].args.join(' ')).toContain(
        'projects/acme%2Fwidget/boards/5/lists'
      );
      expect(fake.calls[2].args.join(' ')).toContain(
        'boards/5/lists/2/issues'
      );
      expect(fake.calls[3].args.join(' ')).toContain(
        'boards/5/lists/3/issues'
      );
      expect(fake.calls[4].args.join(' ')).toContain('issues?state=opened');
      expect(fake.calls[5].args.join(' ')).toContain('issues?state=closed');
    });

    it('synthesizes the implicit backlog when the board has no lists', async () => {
      const { provider } = makeProvider([
        { stdout: JSON.stringify([]) },
        { stdout: JSON.stringify([issueFixture({ iid: 1, title: 'Test', labels: [] })]) },
        { stdout: JSON.stringify([]) },
      ]);

      const items = await provider.listBoardItems({ repo, boardId: '5' });

      expect(items).toHaveLength(1);
      expect(items[0].status).toBeNull();
      expect(items[0].content).toMatchObject({ id: '1', title: 'Test', state: 'open' });
    });

    it('does not duplicate list issues in the synthesized backlog', async () => {
      const { provider } = makeProvider([
        { stdout: JSON.stringify([listFixture()]) },
        { stdout: JSON.stringify([issueFixture({ iid: 1 })]) },
        { stdout: JSON.stringify([issueFixture({ iid: 1 }), issueFixture({ iid: 2, labels: [] })]) },
        { stdout: JSON.stringify([]) },
      ]);

      const items = await provider.listBoardItems({ repo, boardId: '5' });

      expect(items).toHaveLength(2);
      expect(items.map((item) => item.id)).toEqual(['1', '2']);
      expect(items[0].status).toBe('Doing');
      expect(items[1].status).toBeNull();
    });

    it('requires board context', async () => {
      const { provider } = makeProvider([]);
      await expect(provider.listBoardItems({ repo })).rejects.toThrow(
        'board context is required'
      );
    });
  });

  describe('listBoardFields', () => {
    it('returns a single Status field with label-backed options', async () => {
      const { provider, fake } = makeProvider([
        {
          stdout: JSON.stringify([
            listFixture({ id: 1, label: { id: 10, name: 'Doing' }, position: 1 }),
            listFixture({ id: 2, label: { id: 11, name: 'Done' }, position: 2 }),
            listFixture({ id: 3, label: null, position: 0 }),
          ]),
        },
      ]);

      const fields = await provider.listBoardFields({ repo, boardId: '5' });

      expect(fields).toEqual([
        {
          id: 'status',
          name: 'Status',
          type: 'single_select',
          options: [
            { id: 'Doing', name: 'Doing' },
            { id: 'Done', name: 'Done' },
          ],
        },
      ]);
      expect(fake.calls[0].args.join(' ')).toContain(
        'projects/acme%2Fwidget/boards/5/lists'
      );
    });

    it('requires board context', async () => {
      const { provider } = makeProvider([]);
      await expect(provider.listBoardFields({ repo })).rejects.toThrow(
        'board context is required'
      );
    });
  });

  describe('addIssueToBoard', () => {
    it('is not implemented: open issues appear on GitLab boards implicitly', async () => {
      const { provider } = makeProvider([]);
      expect(provider.addIssueToBoard).toBeUndefined();
    });
  });

  describe('setItemFields', () => {
    it('swaps status labels', async () => {
      const { provider, fake } = makeProvider([
        {
          stdout: JSON.stringify([
            listFixture({ id: 1, label: { id: 10, name: 'Doing' }, position: 1 }),
            listFixture({ id: 2, label: { id: 11, name: 'Done' }, position: 2 }),
          ]),
        },
        { stdout: JSON.stringify({}) },
      ]);

      await provider.setItemFields({ repo, boardId: '5' }, '42', {
        Status: 'Done',
      });

      expect(fake.calls[1].args.join(' ')).toContain(
        'projects/acme%2Fwidget/issues/42'
      );
      expect(fake.calls[1].args).toContain('PUT');
      expect(restFields(fake.calls[1])).toEqual({
        add_labels: 'Done',
        remove_labels: 'Doing',
      });
    });

    it('is case-insensitive for the status name', async () => {
      const { provider, fake } = makeProvider([
        {
          stdout: JSON.stringify([
            listFixture({ id: 1, label: { id: 10, name: 'Doing' }, position: 1 }),
          ]),
        },
        { stdout: JSON.stringify({}) },
      ]);

      await provider.setItemFields({ repo, boardId: '5' }, '42', {
        Status: 'doing',
      });

      expect(restFields(fake.calls[1])).toEqual({
        add_labels: 'Doing',
      });
    });

    it('throws UnsupportedError for unknown fields', async () => {
      const { provider } = makeProvider([
        {
          stdout: JSON.stringify([
            listFixture({ id: 1, label: { id: 10, name: 'Doing' }, position: 1 }),
          ]),
        },
      ]);

      await expect(
        provider.setItemFields({ repo, boardId: '5' }, '42', {
          Priority: 'High',
        })
      ).rejects.toThrow(
        'field "Priority" is not supported by this provider'
      );
    });

    it('throws UnsupportedError listing valid options for unknown status', async () => {
      const { provider } = makeProvider([
        {
          stdout: JSON.stringify([
            listFixture({ id: 1, label: { id: 10, name: 'Doing' }, position: 1 }),
          ]),
        },
      ]);

      await expect(
        provider.setItemFields({ repo, boardId: '5' }, '42', {
          Status: 'Missing',
        })
      ).rejects.toThrow('status "Missing" not found; available: Doing');
    });

    it('requires board context', async () => {
      const { provider } = makeProvider([]);
      await expect(
        provider.setItemFields({ repo }, '42', { Status: 'Done' })
      ).rejects.toThrow('board context is required');
    });
  });
});

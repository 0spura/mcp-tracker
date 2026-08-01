import { describe, it, expect } from 'vitest';
import { createGhRunner } from '../../../src/transport/gh.js';
import { createGitHubProjectsBoardProvider } from '../../../src/domains/boards/github-projects.js';
import { createFakeGh } from '../../helpers/fake-gh.js';

const repo = { owner: 'acme', repo: 'widget' };

function makeProvider(responses: Parameters<typeof createFakeGh>[0]) {
  const fake = createFakeGh(responses);
  const runner = createGhRunner(fake.run);
  return { provider: createGitHubProjectsBoardProvider(runner), fake };
}

function graphqlOk(data: unknown) {
  return { stdout: JSON.stringify({ data }) };
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

function itemPage(
  items: unknown[],
  hasNextPage: boolean,
  endCursor: string | null
) {
  return graphqlOk({
    node: {
      items: {
        pageInfo: { hasNextPage, endCursor },
        nodes: items,
      },
    },
  });
}

describe('createGitHubProjectsBoardProvider', () => {
  describe('listBoardItems', () => {
    it('paginates through all items and uses endCursor', async () => {
      const page1 = [
        {
          id: 'PI_1',
          fieldValues: {
            nodes: [
              {
                __typename: 'ProjectV2ItemFieldSingleSelectValue',
                name: 'Doing',
                field: { name: 'Status' },
              },
            ],
          },
          content: {
            __typename: 'Issue',
            id: 'I_1',
            number: 1,
            title: 'First',
            state: 'OPEN',
            url: 'https://github.com/acme/widget/issues/1',
          },
        },
      ];
      const page2 = [
        {
          id: 'PI_2',
          fieldValues: { nodes: [] },
          content: {
            __typename: 'PullRequest',
            id: 'PR_2',
            number: 2,
            title: 'Second',
            state: 'MERGED',
            url: 'https://github.com/acme/widget/pull/2',
          },
        },
      ];

      const { provider, fake } = makeProvider([
        itemPage(page1, true, 'CURSOR_1'),
        itemPage(page2, false, null),
      ]);

      const items = await provider.listBoardItems({ repo, boardId: 'P_1' });

      expect(items).toHaveLength(2);
      expect(items[0]).toEqual({
        id: 'PI_1',
        status: 'Doing',
        content: {
          type: 'issue',
          id: '1',
          title: 'First',
          state: 'open',
          url: 'https://github.com/acme/widget/issues/1',
        },
      });
      expect(items[1]).toEqual({
        id: 'PI_2',
        status: null,
        content: {
          type: 'pr',
          id: '2',
          title: 'Second',
          state: 'merged',
          url: 'https://github.com/acme/widget/pull/2',
        },
      });

      expect(fake.calls).toHaveLength(2);
      const vars1 = graphqlVariables(fake.calls[0]);
      expect(vars1.after).toBeUndefined();
      const vars2 = graphqlVariables(fake.calls[1]);
      expect(vars2.after).toBe('CURSOR_1');
    });

    it('maps draft issues and null content', async () => {
      const { provider } = makeProvider([
        itemPage(
          [
            {
              id: 'PI_3',
              fieldValues: { nodes: [] },
              content: {
                __typename: 'DraftIssue',
                id: 'DI_3',
                title: 'Draft',
              },
            },
            {
              id: 'PI_4',
              fieldValues: { nodes: [] },
              content: null,
            },
          ],
          false,
          null
        ),
      ]);

      const items = await provider.listBoardItems({ repo, boardId: 'P_1' });

      expect(items[0].content).toEqual({
        type: 'issue',
        id: 'DI_3',
        title: 'Draft',
        state: 'open',
        url: '',
      });
      expect(items[1].content).toBeNull();
    });

    it('requires board context', async () => {
      const { provider } = makeProvider([]);
      await expect(provider.listBoardItems({ repo })).rejects.toThrow(
        'board context is required'
      );
    });
  });

  describe('listBoardFields', () => {
    it('returns fields and caches the lookup', async () => {
      const { provider, fake } = makeProvider([
        graphqlOk({
          node: {
            fields: {
              nodes: [
                {
                  __typename: 'ProjectV2SingleSelectField',
                  id: 'F_status',
                  name: 'Status',
                  options: [{ id: 'O_done', name: 'Done' }],
                },
                {
                  __typename: 'ProjectV2Field',
                  id: 'F_note',
                  name: 'Note',
                },
              ],
            },
          },
        }),
      ]);

      const fields1 = await provider.listBoardFields({ repo, boardId: 'P_1' });
      const fields2 = await provider.listBoardFields({ repo, boardId: 'P_1' });

      expect(fields1).toEqual([
        {
          id: 'F_status',
          name: 'Status',
          type: 'singleselect',
          options: [{ id: 'O_done', name: 'Done' }],
        },
        { id: 'F_note', name: 'Note', type: 'text' },
      ]);
      expect(fields2).toEqual(fields1);
      expect(fake.calls).toHaveLength(1);
    });

    it('requires board context', async () => {
      const { provider } = makeProvider([]);
      await expect(provider.listBoardFields({ repo })).rejects.toThrow(
        'board context is required'
      );
    });
  });

  describe('addIssueToBoard', () => {
    it('resolves the issue node id and adds it to the board', async () => {
      const { provider, fake } = makeProvider([
        graphqlOk({ repository: { issue: { id: 'I_42' } } }),
        graphqlOk({
          addProjectV2ItemById: { item: { id: 'PI_42' } },
        }),
      ]);

      const itemId = await provider.addIssueToBoard(
        { repo, boardId: 'P_1' },
        '42'
      );

      expect(itemId).toBe('PI_42');
      expect(fake.calls).toHaveLength(2);
      expect(graphqlQuery(fake.calls[1])).toContain('addProjectV2ItemById');
      const vars = graphqlVariables(fake.calls[1]);
      expect(vars).toEqual({ projectId: 'P_1', contentId: 'I_42' });
    });

    it('rejects non-numeric issue ids', async () => {
      const { provider } = makeProvider([]);
      await expect(
        provider.addIssueToBoard({ repo, boardId: 'P_1' }, 'PROJ-123')
      ).rejects.toThrow('non-numeric GitHub issue id');
    });

    it('requires board context', async () => {
      const { provider } = makeProvider([]);
      await expect(
        provider.addIssueToBoard({ repo }, '42')
      ).rejects.toThrow('board context is required');
    });
  });

  describe('setItemFields', () => {
    it('resolves field and option ids and updates values', async () => {
      const { provider, fake } = makeProvider([
        graphqlOk({
          node: {
            fields: {
              nodes: [
                {
                  __typename: 'ProjectV2SingleSelectField',
                  id: 'F_status',
                  name: 'Status',
                  options: [{ id: 'O_done', name: 'Done' }],
                },
                {
                  __typename: 'ProjectV2Field',
                  id: 'F_note',
                  name: 'Note',
                },
              ],
            },
          },
        }),
        graphqlOk({
          updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PI_1' } },
        }),
        graphqlOk({
          updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PI_1' } },
        }),
      ]);

      await provider.setItemFields(
        { repo, boardId: 'P_1' },
        'PI_1',
        {
          Status: 'Done',
          Note: 'hello',
        }
      );

      expect(fake.calls).toHaveLength(3);
      const vars1 = graphqlVariables(fake.calls[1]);
      expect((vars1.input as Record<string, unknown>).value).toEqual({
        singleSelectOptionId: 'O_done',
      });
      const vars2 = graphqlVariables(fake.calls[2]);
      expect((vars2.input as Record<string, unknown>).value).toEqual({
        text: 'hello',
      });
    });

    it('throws UnsupportedError listing valid options for unknown option', async () => {
      const { provider } = makeProvider([
        graphqlOk({
          node: {
            fields: {
              nodes: [
                {
                  __typename: 'ProjectV2SingleSelectField',
                  id: 'F_status',
                  name: 'Status',
                  options: [{ id: 'O_done', name: 'Done' }],
                },
              ],
            },
          },
        }),
      ]);

      await expect(
        provider.setItemFields(
          { repo, boardId: 'P_1' },
          'PI_1',
          { Status: 'Missing' }
        )
      ).rejects.toThrow(
        'option "Missing" not found for field "Status"; available: Done'
      );
    });

    it('throws UnsupportedError listing valid fields for unknown field', async () => {
      const { provider } = makeProvider([
        graphqlOk({
          node: {
            fields: {
              nodes: [
                {
                  __typename: 'ProjectV2SingleSelectField',
                  id: 'F_status',
                  name: 'Status',
                  options: [{ id: 'O_done', name: 'Done' }],
                },
              ],
            },
          },
        }),
      ]);

      await expect(
        provider.setItemFields(
          { repo, boardId: 'P_1' },
          'PI_1',
          { Missing: 'Done' }
        )
      ).rejects.toThrow('field "Missing" not found; available: Status');
    });

    it('requires board context', async () => {
      const { provider } = makeProvider([]);
      await expect(
        provider.setItemFields({ repo }, 'PI_1', { Status: 'Done' })
      ).rejects.toThrow('board context is required');
    });
  });

  describe('boardId resolution', () => {
    it('resolves owner/repo/number to the project node id', async () => {
      const { provider, fake } = makeProvider([
        graphqlOk({
          repository: { projectV2: { id: 'PVT_resolved' } },
        }),
        itemPage([], false, null),
      ]);

      await provider.listBoardItems({ repo, boardId: 'acme/widget/5' });

      const vars = graphqlVariables(fake.calls[1]);
      expect(vars.projectId).toBe('PVT_resolved');
    });

    it('caches the resolved board id', async () => {
      const { provider, fake } = makeProvider([
        graphqlOk({
          repository: { projectV2: { id: 'PVT_resolved' } },
        }),
        itemPage([], false, null),
        itemPage([], false, null),
      ]);

      await provider.listBoardItems({ repo, boardId: 'acme/widget/5' });
      await provider.listBoardItems({ repo, boardId: 'acme/widget/5' });

      expect(fake.calls).toHaveLength(3);
      expect(graphqlQuery(fake.calls[0])).toContain('projectV2');
    });

    it('passes opaque node ids through unchanged', async () => {
      const { provider, fake } = makeProvider([itemPage([], false, null)]);

      await provider.listBoardItems({ repo, boardId: 'PVT_opaque' });

      const vars = graphqlVariables(fake.calls[0]);
      expect(vars.projectId).toBe('PVT_opaque');
    });

    it('errors when the project is not found', async () => {
      const { provider } = makeProvider([
        graphqlOk({ repository: { projectV2: null } }),
      ]);

      await expect(
        provider.listBoardItems({ repo, boardId: 'acme/widget/99' })
      ).rejects.toThrow('project "acme/widget/99" not found');
    });
  });
});

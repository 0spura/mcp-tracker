import { z } from 'zod';
import type { GhRunner } from '../../transport/gh.js';
import type { Scope } from '../../core/scope.js';
import type { BoardProvider } from './capabilities.js';
import type { ItemId, ProjectItem, ProjectField } from '../../core/types.js';
import { UnsupportedError } from '../../core/errors.js';

export type BoardField =
  | {
      kind: 'single_select';
      id: string;
      name: string;
      type: string;
      options: Map<string, { id: string; name: string }>;
    }
  | { kind: 'text'; id: string; name: string; type: string }
  | { kind: 'other'; id: string; name: string; type: string };

export type BoardFields = BoardField[];

function requireRepo(scope: Scope): NonNullable<Scope['repo']> {
  if (!scope.repo) {
    throw new Error('repo scope is required');
  }
  return scope.repo;
}

function requireBoard(scope: Scope): string {
  if (!scope.boardId) {
    throw new Error('board context is required');
  }
  return scope.boardId;
}

function toIssueNumber(id: ItemId): number {
  const n = Number(id);
  if (Number.isNaN(n)) {
    throw new UnsupportedError('non-numeric GitHub issue id');
  }
  return n;
}

function normalizeState(state: string): 'open' | 'closed' | 'merged' {
  const lowered = state.toLowerCase();
  if (lowered === 'open' || lowered === 'closed' || lowered === 'merged') {
    return lowered;
  }
  throw new UnsupportedError(`unknown GitHub content state "${state}"`);
}

export function createCaches() {
  const nodeIdCache = new Map<ItemId, Promise<string>>();
  const fieldCache = new Map<string, Promise<BoardFields>>();
  const boardIdCache = new Map<string, Promise<string>>();

  function resolveBoardId(
    gh: GhRunner,
    boardId: string,
    repo?: NonNullable<Scope['repo']>
  ): Promise<string> {
    const cacheKey = repo && /^\d+$/.test(boardId)
      ? `${repo.owner}/${repo.repo}/${boardId}`
      : boardId;
    const cached = boardIdCache.get(cacheKey);
    if (cached) return cached;

    if (!boardId.includes('/')) {
      if (!repo || !/^\d+$/.test(boardId)) {
        boardIdCache.set(cacheKey, Promise.resolve(boardId));
        return boardIdCache.get(cacheKey)!;
      }
      boardId = `${repo.owner}/${repo.repo}/${boardId}`;
    }

    const parts = boardId.split('/').filter(Boolean);
    if (parts.length !== 3) {
      throw new Error(
        `invalid board id "${boardId}": expected "owner/repo/number" or a project node id`
      );
    }
    const [owner, repoName, numberStr] = parts;
    const number = Number(numberStr);
    if (Number.isNaN(number)) {
      throw new Error(
        `invalid board id "${boardId}": project number must be numeric`
      );
    }

    const query = `
      query($owner: String!, $repo: String!, $number: Int!) {
        repository(owner: $owner, name: $repo) {
          projectV2(number: $number) { id }
        }
      }`;

    const schema = z.object({
      repository: z.object({
        projectV2: z.object({ id: z.string() }).nullable(),
      }),
    });

    const promise = gh.graphql(
      query,
      { owner: owner!, repo: repoName!, number },
      schema
    );
    boardIdCache.set(
      cacheKey,
      promise.then((data) => {
        if (!data.repository.projectV2) {
          throw new Error(`project "${boardId}" not found`);
        }
        return data.repository.projectV2.id;
      })
    );
    return boardIdCache.get(cacheKey)!;
  }

  function getIssueNodeId(
    gh: GhRunner,
    repo: NonNullable<Scope['repo']>,
    id: ItemId
  ): Promise<string> {
    const cached = nodeIdCache.get(id);
    if (cached) return cached;

    const query = `
      query($owner: String!, $repo: String!, $number: Int!) {
        repository(owner: $owner, name: $repo) {
          issue(number: $number) { id }
        }
      }`;

    const schema = z.object({
      repository: z.object({
        issue: z.object({ id: z.string() }),
      }),
    });

    const promise = gh.graphql(
      query,
      { owner: repo.owner, repo: repo.repo, number: toIssueNumber(id) },
      schema
    );
    nodeIdCache.set(
      id,
      promise.then((data) => data.repository.issue.id)
    );
    return nodeIdCache.get(id)!;
  }

  function primeIssueNodeId(id: ItemId, nodeId: string): void {
    nodeIdCache.set(id, Promise.resolve(nodeId));
  }

  async function getBoardFields(
    gh: GhRunner,
    boardId: string
  ): Promise<BoardFields> {
    const cached = fieldCache.get(boardId);
    if (cached) return cached;

    const query = `
      query($projectId: ID!) {
        node(id: $projectId) {
          ... on ProjectV2 {
            fields(first: 50) {
              nodes {
                __typename
                ... on ProjectV2SingleSelectField { id name options { id name } }
                ... on ProjectV2Field { id name }
              }
            }
          }
        }
      }`;

    const schema = z.object({
      node: z.object({
        fields: z.object({
          nodes: z.array(
            z.object({
              __typename: z.string(),
              id: z.string(),
              name: z.string(),
              options: z
                .array(z.object({ id: z.string(), name: z.string() }))
                .optional(),
            })
          ),
        }),
      }),
    });

    const promise = gh.graphql(query, { projectId: boardId }, schema);
    fieldCache.set(
      boardId,
      promise.then((data) => {
        const list: BoardFields = [];
        for (const field of data.node.fields.nodes) {
          const type = deriveFieldType(field.__typename);
          if (field.__typename === 'ProjectV2SingleSelectField' && field.options) {
            const options = new Map<string, { id: string; name: string }>();
            for (const opt of field.options) {
              options.set(opt.name.toLowerCase(), opt);
            }
            list.push({
              kind: 'single_select',
              id: field.id,
              name: field.name,
              type,
              options,
            });
          } else if (field.__typename === 'ProjectV2Field') {
            list.push({ kind: 'text', id: field.id, name: field.name, type });
          } else {
            list.push({ kind: 'other', id: field.id, name: field.name, type });
          }
        }
        return list;
      })
    );
    return fieldCache.get(boardId)!;
  }

  return { getIssueNodeId, primeIssueNodeId, getBoardFields, resolveBoardId };
}

function deriveFieldType(typename: string): string {
  const stripped = typename.replace(/^ProjectV2/, '').replace(/Field$/, '');
  if (stripped === '') return 'text';
  return stripped.toLowerCase();
}

export function findField(fields: BoardFields, name: string): BoardField {
  const needle = name.toLowerCase();
  const matches = fields.filter((field) => field.name.toLowerCase() === needle);

  if (matches.length === 0) {
    const available = fields.map((field) => field.name).join(', ');
    throw new UnsupportedError(
      `field "${name}" not found; available: ${available}`
    );
  }

  if (matches.length > 1) {
    const matched = matches.map((field) => field.name).join(', ');
    throw new UnsupportedError(
      `ambiguous field name "${name}" matches: ${matched}`
    );
  }

  return matches[0];
}

export async function addProjectV2ItemByContentId(
  gh: GhRunner,
  boardId: string,
  contentId: string
): Promise<string> {
  const mutation = `
    mutation($projectId: ID!, $contentId: ID!) {
      addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
        item { id }
      }
    }`;

  const schema = z.object({
    addProjectV2ItemById: z.object({
      item: z.object({ id: z.string() }),
    }),
  });

  const result = await gh.graphql(
    mutation,
    { projectId: boardId, contentId },
    schema
  );
  return result.addProjectV2ItemById.item.id;
}

export async function updateProjectField(
  gh: GhRunner,
  boardId: string,
  itemId: string,
  field: BoardField,
  value: string
): Promise<void> {
  let fieldValue: Record<string, unknown>;

  if (field.kind === 'single_select') {
    const option = field.options.get(value.toLowerCase());
    if (!option) {
      const available = Array.from(field.options.values())
        .map((o) => o.name)
        .join(', ');
      throw new UnsupportedError(
        `option "${value}" not found for field "${field.name}"; available: ${available}`
      );
    }
    fieldValue = { singleSelectOptionId: option.id };
  } else if (field.kind === 'text') {
    fieldValue = { text: value };
  } else {
    throw new UnsupportedError(
      `project field "${field.name}" of type "${field.type}"`
    );
  }

  const mutation = `
    mutation($input: UpdateProjectV2ItemFieldValueInput!) {
      updateProjectV2ItemFieldValue(input: $input) {
        projectV2Item { id }
      }
    }`;

  const schema = z.object({
    updateProjectV2ItemFieldValue: z.object({
      projectV2Item: z.object({ id: z.string() }),
    }),
  });

  await gh.graphql(
    mutation,
    {
      input: {
        projectId: boardId,
        itemId,
        fieldId: field.id,
        value: fieldValue,
      },
    },
    schema
  );
}

export async function setProjectFieldByName(
  gh: GhRunner,
  boardId: string,
  itemId: string,
  fields: BoardFields,
  name: string,
  value: string
): Promise<void> {
  const field = findField(fields, name);
  await updateProjectField(gh, boardId, itemId, field, value);
}

export async function setItemStatus(
  gh: GhRunner,
  boardId: string,
  itemId: string,
  status: string,
  fields: BoardFields
): Promise<void> {
  const field = findField(fields, 'status');
  await updateProjectField(gh, boardId, itemId, field, status);
}

const issueContentSchema = z.object({
  __typename: z.literal('Issue'),
  id: z.string(),
  number: z.number(),
  title: z.string(),
  state: z.enum(['OPEN', 'CLOSED']),
  url: z.string(),
});

const pullRequestContentSchema = z.object({
  __typename: z.literal('PullRequest'),
  id: z.string(),
  number: z.number(),
  title: z.string(),
  state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
  url: z.string(),
});

const draftIssueContentSchema = z.object({
  __typename: z.literal('DraftIssue'),
  id: z.string(),
  title: z.string(),
});

const projectItemsPageSchema = z.object({
  node: z.object({
    items: z.object({
      pageInfo: z.object({
        hasNextPage: z.boolean(),
        endCursor: z.string().nullable().optional(),
      }),
      nodes: z.array(
        z.object({
          id: z.string(),
          fieldValues: z.object({
            nodes: z.array(
              z.object({
                __typename: z.string(),
                name: z.string().optional(),
                field: z.object({ name: z.string() }).optional(),
              })
            ),
          }),
          content: z
            .union([
              issueContentSchema,
              pullRequestContentSchema,
              draftIssueContentSchema,
              z.null(),
            ])
            .nullable(),
        })
      ),
    }),
  }),
});

type RawProjectItem = z.infer<
  typeof projectItemsPageSchema
>['node']['items']['nodes'][number];

function mapProjectItem(raw: RawProjectItem): ProjectItem {
  const statusField = raw.fieldValues.nodes.find(
    (fieldValue) =>
      fieldValue.__typename === 'ProjectV2ItemFieldSingleSelectValue' &&
      fieldValue.field?.name === 'Status'
  );

  return {
    id: raw.id,
    status: statusField?.name ?? null,
    content: mapProjectItemContent(raw.content),
  };
}

function mapProjectItemContent(
  content: RawProjectItem['content']
): ProjectItem['content'] {
  if (!content) return null;

  if (content.__typename === 'DraftIssue') {
    return {
      type: 'issue',
      id: content.id,
      title: content.title,
      state: 'open',
      url: '',
    };
  }

  return {
    type: content.__typename === 'Issue' ? 'issue' : 'pr',
    id: String(content.number),
    title: content.title,
    state: normalizeState(content.state),
    url: content.url,
  };
}

async function fetchProjectItemsPage(
  gh: GhRunner,
  boardId: string,
  after: string | null
): Promise<z.infer<typeof projectItemsPageSchema>['node']['items']> {
  const query = `
    query($projectId: ID!, $after: String) {
      node(id: $projectId) {
        ... on ProjectV2 {
          items(first: 100, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id
              fieldValues(first: 20) {
                nodes {
                  __typename
                  ... on ProjectV2ItemFieldSingleSelectValue {
                    name
                    field { ... on ProjectV2SingleSelectField { name } }
                  }
                }
              }
              content {
                __typename
                ... on Issue { id number title state url }
                ... on PullRequest { id number title state url }
                ... on DraftIssue { id title }
              }
            }
          }
        }
      }
    }`;

  const variables: Record<string, unknown> = { projectId: boardId };
  if (after) {
    variables.after = after;
  }

  const result = await gh.graphql(query, variables, projectItemsPageSchema);
  return result.node.items;
}

export function createGitHubProjectsBoardProvider(
  gh: GhRunner
): BoardProvider {
  const { getIssueNodeId, getBoardFields, resolveBoardId } = createCaches();

  async function requireResolvedBoard(scope: Scope): Promise<string> {
    return resolveBoardId(gh, requireBoard(scope), requireRepo(scope));
  }

  async function listBoardItems(scope: Scope): Promise<ProjectItem[]> {
    const boardId = await requireResolvedBoard(scope);
    const items: ProjectItem[] = [];
    let after: string | null = null;

    while (true) {
      const page = await fetchProjectItemsPage(gh, boardId, after);
      items.push(...page.nodes.map(mapProjectItem));

      if (!page.pageInfo.hasNextPage) {
        break;
      }
      after = page.pageInfo.endCursor ?? null;
    }

    return items;
  }

  async function listBoardFields(scope: Scope): Promise<ProjectField[]> {
    const boardId = await requireResolvedBoard(scope);
    const fields = await getBoardFields(gh, boardId);
    return fields.map((field) => ({
      id: field.id,
      name: field.name,
      type: field.type,
      ...(field.kind === 'single_select'
        ? { options: Array.from(field.options.values()) }
        : {}),
    }));
  }

  async function addIssueToBoard(
    scope: Scope,
    issueId: ItemId
  ): Promise<string> {
    const boardId = await requireResolvedBoard(scope);
    const repo = requireRepo(scope);
    const contentId = await getIssueNodeId(gh, repo, issueId);
    return addProjectV2ItemByContentId(gh, boardId, contentId);
  }

  async function setItemFields(
    scope: Scope,
    itemId: ItemId,
    fields: Record<string, string>
  ): Promise<void> {
    const boardId = await requireResolvedBoard(scope);
    const boardFields = await getBoardFields(gh, boardId);

    for (const [name, value] of Object.entries(fields)) {
      const field = findField(boardFields, name);
      await updateProjectField(gh, boardId, itemId, field, value);
    }
  }

  return {
    listBoardItems,
    listBoardFields,
    addIssueToBoard,
    setItemFields,
  };
}

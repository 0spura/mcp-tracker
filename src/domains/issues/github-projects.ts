import { z } from 'zod';
import type { GhRunner } from '../../transport/gh.js';
import type { Scope } from '../../core/scope.js';
import type { IssueProvider, ListIssuesOptions } from './capabilities.js';
import type {
  Issue,
  ItemId,
  RelationshipType,
  CreateIssueOptions,
  UpdateIssueOptions,
  Comment,
  Label,
  Milestone,
} from '../../core/types.js';
import { toggleChecklistItem as toggleChecklistItemInBody } from '../../core/checklist.js';
import { UnsupportedError } from '../../core/errors.js';

function repoPath(repo: NonNullable<Scope['repo']>): string {
  return `${repo.owner}/${repo.repo}`;
}

function requireRepo(scope: Scope): NonNullable<Scope['repo']> {
  if (!scope.repo) {
    throw new Error('repo scope is required');
  }
  return scope.repo;
}

function toIssueNumber(id: ItemId): number {
  const n = Number(id);
  if (Number.isNaN(n)) {
    throw new UnsupportedError('non-numeric GitHub issue id');
  }
  return n;
}

const labelSchema = z.object({
  name: z.string(),
});

const assigneeSchema = z.object({
  login: z.string(),
});

const milestoneSchema = z.object({
  title: z.string(),
});

const issueSchema = z.object({
  number: z.number(),
  title: z.string(),
  body: z.string().nullable(),
  state: z.enum(['open', 'closed']),
  html_url: z.string(),
  node_id: z.string().optional(),
  labels: z.array(labelSchema),
  assignees: z.array(assigneeSchema),
  milestone: milestoneSchema.nullable().optional(),
  pull_request: z.object({ url: z.string() }).optional().nullable(),
});

function mapIssue(raw: z.infer<typeof issueSchema>): Issue {
  return {
    id: String(raw.number),
    title: raw.title,
    body: raw.body ?? '',
    state: raw.state,
    url: raw.html_url,
    labels: raw.labels.map((l) => l.name),
    assignees: raw.assignees.map((a) => a.login),
    milestone: raw.milestone?.title ?? null,
  };
}

const commentSchema = z.object({
  id: z.number(),
  user: z.object({ login: z.string() }).nullable(),
  body: z.string(),
  created_at: z.string(),
});

function mapComment(raw: z.infer<typeof commentSchema>): Comment {
  return {
    id: String(raw.id),
    author: raw.user?.login ?? '',
    body: raw.body,
    createdAt: raw.created_at,
  };
}

const repoLabelSchema = z.object({
  name: z.string(),
  color: z.string(),
  description: z.string().nullable().optional(),
});

function mapRepoLabel(raw: z.infer<typeof repoLabelSchema>): Label {
  return {
    name: raw.name,
    color: raw.color,
    description: raw.description ?? '',
  };
}

const repoMilestoneSchema = z.object({
  number: z.number(),
  title: z.string(),
  state: z.enum(['open', 'closed']),
  due_on: z.string().nullable().optional(),
});

function mapRepoMilestone(raw: z.infer<typeof repoMilestoneSchema>): Milestone {
  return {
    id: String(raw.number),
    title: raw.title,
    state: raw.state,
    dueOn: raw.due_on ?? null,
  };
}

type BoardField =
  | { kind: 'single_select'; id: string; name: string; options: Map<string, { id: string; name: string }> }
  | { kind: 'text'; id: string; name: string }
  | { kind: 'other'; id: string; name: string };

type BoardFields = Map<string, BoardField>;

function createCaches() {
  const nodeIdCache = new Map<ItemId, Promise<string>>();
  const fieldCache = new Map<string, Promise<BoardFields>>();

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

  async function getBoardFields(gh: GhRunner, boardId: string): Promise<BoardFields> {
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
              options: z.array(z.object({ id: z.string(), name: z.string() })).optional(),
            })
          ),
        }),
      }),
    });

    const promise = gh.graphql(query, { projectId: boardId }, schema);
    fieldCache.set(
      boardId,
      promise.then((data) => {
        const map: BoardFields = new Map();
        for (const field of data.node.fields.nodes) {
          if (field.__typename === 'ProjectV2SingleSelectField' && field.options) {
            const options = new Map<string, { id: string; name: string }>();
            for (const opt of field.options) {
              options.set(opt.name.toLowerCase(), opt);
            }
            map.set(field.name.toLowerCase(), {
              kind: 'single_select',
              id: field.id,
              name: field.name,
              options,
            });
          } else if (field.__typename === 'ProjectV2Field') {
            map.set(field.name.toLowerCase(), {
              kind: 'text',
              id: field.id,
              name: field.name,
            });
          } else {
            map.set(field.name.toLowerCase(), {
              kind: 'other',
              id: field.id,
              name: field.name,
            });
          }
        }
        return map;
      })
    );
    return fieldCache.get(boardId)!;
  }

  return { getIssueNodeId, primeIssueNodeId, getBoardFields };
}

async function resolveMilestoneNumber(
  gh: GhRunner,
  repo: NonNullable<Scope['repo']>,
  title: string
): Promise<number> {
  const milestones = await gh.api(
    `/repos/${repoPath(repo)}/milestones?state=all`,
    z.array(z.object({ number: z.number(), title: z.string() }))
  );
  const match = milestones.find((m) => m.title === title);
  if (!match) {
    throw new Error(`milestone "${title}" not found`);
  }
  return match.number;
}

async function addIssueToBoard(
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

  const result = await gh.graphql(mutation, { projectId: boardId, contentId }, schema);
  return result.addProjectV2ItemById.item.id;
}

async function updateProjectField(
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
      const available = Array.from(field.options.values()).map((o) => o.name).join(', ');
      throw new Error(`option "${value}" not found; available: ${available}`);
    }
    fieldValue = { singleSelectOptionId: option.id };
  } else if (field.kind === 'text') {
    fieldValue = { text: value };
  } else {
    throw new UnsupportedError(`project field "${field.name}" of type "${field.kind}"`);
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

async function setItemStatus(
  gh: GhRunner,
  boardId: string,
  itemId: string,
  status: string,
  fields: BoardFields
): Promise<void> {
  const field = fields.get('status');
  if (!field) {
    throw new Error('project has no Status field');
  }
  await updateProjectField(gh, boardId, itemId, field, status);
}

async function setProjectFieldByName(
  gh: GhRunner,
  boardId: string,
  itemId: string,
  fields: BoardFields,
  name: string,
  value: string
): Promise<void> {
  const field = fields.get(name.toLowerCase());
  if (!field) {
    throw new Error(`project field "${name}" not found`);
  }
  await updateProjectField(gh, boardId, itemId, field, value);
}

async function findProjectItemId(
  gh: GhRunner,
  repo: NonNullable<Scope['repo']>,
  boardId: string,
  id: ItemId
): Promise<string> {
  const query = `
    query($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        issue(number: $number) {
          projectItems(first: 20) {
            nodes { id project { id } }
          }
        }
      }
    }`;

  const schema = z.object({
    repository: z.object({
      issue: z.object({
        projectItems: z.object({
          nodes: z.array(
            z.object({
              id: z.string(),
              project: z.object({ id: z.string() }),
            })
          ),
        }),
      }),
    }),
  });

  const data = await gh.graphql(
    query,
    { owner: repo.owner, repo: repo.repo, number: toIssueNumber(id) },
    schema
  );

  const item = data.repository.issue.projectItems.nodes.find(
    (n) => n.project.id === boardId
  );
  if (!item) {
    throw new Error(`issue #${id} is not on the configured board`);
  }
  return item.id;
}

export function createGitHubProjectsIssueProvider(gh: GhRunner): IssueProvider {
  const { getIssueNodeId, primeIssueNodeId, getBoardFields } = createCaches();

  async function createIssue(
    scope: Scope,
    title: string,
    body: string,
    opts?: CreateIssueOptions
  ): Promise<{ issue: Issue; warnings: string[] }> {
    const repo = requireRepo(scope);
    const warnings: string[] = [];

    const input: Record<string, unknown> = {
      title,
      body,
      labels: opts?.labels ?? [],
      assignees: opts?.assignees ?? [],
    };

    if (opts?.milestone) {
      input.milestone = await resolveMilestoneNumber(gh, repo, opts.milestone);
    }

    const raw = await gh.api(
      `/repos/${repoPath(repo)}/issues`,
      issueSchema,
      { method: 'POST', input }
    );
    const issue = mapIssue(raw);
    if (raw.node_id) {
      primeIssueNodeId(issue.id, raw.node_id);
    }

    let boardItemId: string | undefined;
    if (scope.boardId) {
      try {
        const contentId = raw.node_id ?? (await getIssueNodeId(gh, repo, issue.id));
        boardItemId = await addIssueToBoard(gh, scope.boardId, contentId);
      } catch (err) {
        warnings.push(
          `add to board failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    if (boardItemId && scope.boardId) {
      if (opts?.fields && Object.keys(opts.fields).length > 0) {
        try {
          const fields = await getBoardFields(gh, scope.boardId);
          for (const [name, value] of Object.entries(opts.fields)) {
            try {
              await setProjectFieldByName(gh, scope.boardId, boardItemId, fields, name, value);
            } catch (err) {
              warnings.push(
                `set field "${name}" failed: ${err instanceof Error ? err.message : String(err)}`
              );
            }
          }
        } catch (err) {
          warnings.push(
            `load board fields failed: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }

      if (opts?.status) {
        try {
          const fields = await getBoardFields(gh, scope.boardId);
          await setItemStatus(gh, scope.boardId, boardItemId, opts.status, fields);
        } catch (err) {
          warnings.push(
            `set status failed: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    }

    if (opts?.parent) {
      try {
        await addSubIssue(scope, opts.parent, issue.id);
      } catch (err) {
        warnings.push(
          `add parent failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    const relationshipArrays: Array<{
      type: RelationshipType;
      targets: ItemId[];
    }> = [
      { type: 'blocks', targets: opts?.blocks ?? [] },
      { type: 'blocked_by', targets: opts?.blocked_by ?? [] },
      { type: 'related', targets: opts?.related ?? [] },
    ];

    for (const { type, targets } of relationshipArrays) {
      for (const targetId of targets) {
        try {
          await setRelationship(scope, issue.id, type, targetId);
        } catch (err) {
          warnings.push(
            `set ${type} #${targetId} failed: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    }

    if (opts?.duplicate_of) {
      try {
        await setRelationship(scope, issue.id, 'duplicate', opts.duplicate_of);
      } catch (err) {
        warnings.push(
          `set duplicate_of #${opts.duplicate_of} failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    return { issue, warnings };
  }

  async function listIssues(
    scope: Scope,
    opts?: ListIssuesOptions
  ): Promise<Issue[]> {
    const repo = requireRepo(scope);
    const state = opts?.state ?? 'open';
    const perPage = opts?.limit ?? 50;

    const params = new URLSearchParams({ state, per_page: String(perPage) });
    if (opts?.labels && opts.labels.length > 0) {
      params.set('labels', opts.labels.join(','));
    }
    if (opts?.assignee) {
      params.set('assignee', opts.assignee);
    }

    const raw = await gh.api(
      `/repos/${repoPath(repo)}/issues?${params.toString()}`,
      z.array(issueSchema)
    );
    return raw
      .filter((r) => !r.pull_request)
      .map(mapIssue);
  }

  async function getIssue(scope: Scope, id: ItemId): Promise<Issue> {
    const repo = requireRepo(scope);
    const raw = await gh.api(
      `/repos/${repoPath(repo)}/issues/${toIssueNumber(id)}`,
      issueSchema
    );
    if (raw.node_id) {
      primeIssueNodeId(id, raw.node_id);
    }
    return mapIssue(raw);
  }

  async function updateIssue(
    scope: Scope,
    id: ItemId,
    opts: UpdateIssueOptions
  ): Promise<{ issue: Issue; warnings: string[] }> {
    const repo = requireRepo(scope);
    const warnings: string[] = [];

    const input: Record<string, unknown> = {};
    if (opts.title !== undefined) input.title = opts.title;
    if (opts.body !== undefined) input.body = opts.body;
    if (opts.labels !== undefined) input.labels = opts.labels;
    if (opts.assignees !== undefined) input.assignees = opts.assignees;
    if (opts.state !== undefined) input.state = opts.state;

    const raw = await gh.api(
      `/repos/${repoPath(repo)}/issues/${toIssueNumber(id)}`,
      issueSchema,
      { method: 'PATCH', input }
    );
    if (raw.node_id) {
      primeIssueNodeId(id, raw.node_id);
    }
    const issue = mapIssue(raw);

    const addOps: Array<{ type: RelationshipType; targets: ItemId[] }> = [
      { type: 'blocks', targets: opts.add_blocks ?? [] },
      { type: 'blocked_by', targets: opts.add_blocked_by ?? [] },
      { type: 'related', targets: opts.add_related ?? [] },
    ];

    for (const { type, targets } of addOps) {
      for (const targetId of targets) {
        try {
          await setRelationship(scope, id, type, targetId);
        } catch (err) {
          warnings.push(
            `add ${type} #${targetId} failed: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    }

    const removeBlocks = opts.remove_blocks ?? [];
    for (const targetId of removeBlocks) {
      try {
        await removeBlockedRelationship(repo, id, targetId, 'blocks');
      } catch (err) {
        warnings.push(
          `remove blocks #${targetId} failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    const removeBlockedBy = opts.remove_blocked_by ?? [];
    for (const targetId of removeBlockedBy) {
      try {
        await removeBlockedRelationship(repo, id, targetId, 'blocked_by');
      } catch (err) {
        warnings.push(
          `remove blocked_by #${targetId} failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    const removeRelated = opts.remove_related ?? [];
    for (const targetId of removeRelated) {
      warnings.push(`remove related #${targetId} is not supported by this provider`);
    }

    if (opts.duplicate_of !== undefined) {
      if (opts.duplicate_of === null) {
        warnings.push('clearing duplicate_of is not supported by this provider');
      } else {
        try {
          await setRelationship(scope, id, 'duplicate', opts.duplicate_of);
        } catch (err) {
          warnings.push(
            `set duplicate_of #${opts.duplicate_of} failed: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    }

    return { issue, warnings };
  }

  async function removeBlockedRelationship(
    repo: NonNullable<Scope['repo']>,
    id: ItemId,
    targetId: ItemId,
    type: 'blocks' | 'blocked_by'
  ): Promise<void> {
    const [sourceNodeId, targetNodeId] = await Promise.all([
      getIssueNodeId(gh, repo, id),
      getIssueNodeId(gh, repo, targetId),
    ]);

    const blockerId = type === 'blocks' ? sourceNodeId : targetNodeId;
    const blockedId = type === 'blocks' ? targetNodeId : sourceNodeId;

    const mutation = `
      mutation($blockerId: ID!, $blockedId: ID!) {
        removeBlockedBy(input: { blockerId: $blockerId, blockedId: $blockedId }) {
          id
        }
      }`;

    const schema = z.object({
      removeBlockedBy: z.object({ id: z.string() }),
    });

    await gh.graphql(mutation, { blockerId, blockedId }, schema);
  }

  async function setIssueStatus(
    scope: Scope,
    id: ItemId,
    status: string
  ): Promise<void> {
    const repo = requireRepo(scope);
    if (!scope.boardId) {
      throw new Error('board context is required to set issue status');
    }

    const [fields, itemId] = await Promise.all([
      getBoardFields(gh, scope.boardId),
      findProjectItemId(gh, repo, scope.boardId, id),
    ]);

    await setItemStatus(gh, scope.boardId, itemId, status, fields);
  }

  async function addIssueComment(scope: Scope, id: ItemId, body: string): Promise<void> {
    const repo = requireRepo(scope);
    await gh.api(
      `/repos/${repoPath(repo)}/issues/${toIssueNumber(id)}/comments`,
      z.any(),
      { method: 'POST', input: { body } }
    );
  }

  async function listIssueComments(scope: Scope, id: ItemId): Promise<Comment[]> {
    const repo = requireRepo(scope);
    const raw = await gh.api(
      `/repos/${repoPath(repo)}/issues/${toIssueNumber(id)}/comments`,
      z.array(commentSchema)
    );
    return raw.map(mapComment);
  }

  async function toggleChecklistItem(
    scope: Scope,
    id: ItemId,
    itemText: string,
    checked?: boolean
  ): Promise<{ matched: string; checked: boolean }> {
    const repo = requireRepo(scope);
    const issue = await getIssue(scope, id);
    const result = toggleChecklistItemInBody(issue.body, itemText, checked);
    await gh.api(
      `/repos/${repoPath(repo)}/issues/${toIssueNumber(id)}`,
      issueSchema,
      { method: 'PATCH', input: { body: result.body } }
    );
    return { matched: result.matched, checked: result.checked };
  }

  async function setRelationship(
    scope: Scope,
    id: ItemId,
    type: RelationshipType,
    targetId: ItemId
  ): Promise<{ mechanism: 'native' | 'keyword-comment' | 'reference-comment' }> {
    if (type === 'blocks' || type === 'blocked_by') {
      const [sourceNodeId, targetNodeId] = await Promise.all([
        getIssueNodeId(gh, requireRepo(scope), id),
        getIssueNodeId(gh, requireRepo(scope), targetId),
      ]);

      const blockerId = type === 'blocks' ? sourceNodeId : targetNodeId;
      const blockedId = type === 'blocks' ? targetNodeId : sourceNodeId;

      const mutation = `
        mutation($blockerId: ID!, $blockedId: ID!) {
          addBlockedBy(input: { blockerId: $blockerId, blockedId: $blockedId }) {
            id
          }
        }`;

      const schema = z.object({
        addBlockedBy: z.object({ id: z.string() }),
      });

      await gh.graphql(mutation, { blockerId, blockedId }, schema);
      return { mechanism: 'native' };
    }

    if (type === 'duplicate') {
      await addIssueComment(scope, id, `Duplicate of #${targetId}`);
      return { mechanism: 'keyword-comment' };
    }

    if (type === 'related') {
      await addIssueComment(scope, id, `Related: #${targetId}`);
      return { mechanism: 'reference-comment' };
    }

    throw new UnsupportedError(`relationship type "${type}"`);
  }

  async function addSubIssue(scope: Scope, parentId: ItemId, childId: ItemId): Promise<void> {
    const repo = requireRepo(scope);
    await gh.api(
      `/repos/${repoPath(repo)}/issues/${toIssueNumber(parentId)}/sub_issues`,
      z.any(),
      {
        method: 'POST',
        input: { sub_issue_id: toIssueNumber(childId) },
      }
    );
  }

  async function listSubIssues(scope: Scope, parentId: ItemId): Promise<Issue[]> {
    const repo = requireRepo(scope);
    const raw = await gh.api(
      `/repos/${repoPath(repo)}/issues/${toIssueNumber(parentId)}/sub_issues`,
      z.array(issueSchema)
    );
    return raw.filter((r) => !r.pull_request).map(mapIssue);
  }

  async function listLabels(scope: Scope): Promise<Label[]> {
    const repo = requireRepo(scope);
    const raw = await gh.api(
      `/repos/${repoPath(repo)}/labels`,
      z.array(repoLabelSchema)
    );
    return raw.map(mapRepoLabel);
  }

  async function listMilestones(
    scope: Scope,
    state?: 'open' | 'closed' | 'all'
  ): Promise<Milestone[]> {
    const repo = requireRepo(scope);
    const raw = await gh.api(
      `/repos/${repoPath(repo)}/milestones?state=${state ?? 'open'}`,
      z.array(repoMilestoneSchema)
    );
    return raw.map(mapRepoMilestone);
  }

  return {
    listIssues,
    createIssue,
    getIssue,
    updateIssue,
    setIssueStatus,
    addIssueComment,
    listIssueComments,
    toggleChecklistItem,
    setRelationship,
    addSubIssue,
    listSubIssues,
    listLabels,
    listMilestones,
  };
}

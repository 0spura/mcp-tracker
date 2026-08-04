import { z } from 'zod';
import type { GhRunner } from '../../transport/gh.js';
import type { Scope } from '../../core/scope.js';
import type { IssueProvider, ListIssuesOptions } from './capabilities.js';
import type {
  Issue,
  IssueType,
  ItemId,
  RelationshipType,
  CreateIssueOptions,
  UpdateIssueOptions,
  Comment,
  Label,
  Milestone,
} from '../../core/types.js';
import { toggleChecklistItem as toggleChecklistItemInBody } from '../../core/checklist.js';
import { CURRENT_MILESTONE, pickCurrentMilestone } from '../../core/milestone.js';
import { resolveUsernames } from '../../core/user.js';
import { UnsupportedError } from '../../core/errors.js';
import {
  createCaches,
  addProjectV2ItemByContentId as addIssueToBoard,
  updateProjectField,
  setProjectFieldByName,
  setItemStatus,
  type BoardFields,
} from '../boards/github-projects.js';

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
  type: z.union([z.string(), z.object({ name: z.string() })]).nullable().optional(),
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
    ...(raw.type
      ? { type: typeof raw.type === 'string' ? raw.type : raw.type.name }
      : {}),
  };
}

const issueFieldDefinitionSchema = z.object({
  id: z.number(),
  name: z.string(),
  data_type: z.string(),
});

const issueTypeSchema = z.object({
  id: z.number(),
  name: z.string(),
  description: z.string().nullable(),
  color: z.string().nullable(),
});

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
  id: z.number(),
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

export function createLabelResolver(gh: GhRunner) {
  const labelCache = new Map<string, Promise<Map<string, string>>>();

  async function loadLabelMap(
    repo: NonNullable<Scope['repo']>
  ): Promise<Map<string, string>> {
    const key = repoPath(repo);
    const cached = labelCache.get(key);
    if (cached) return cached;

    const promise = gh.api(
      `/repos/${key}/labels?per_page=100`,
      z.array(repoLabelSchema)
    ).then((labels) => {
      const map = new Map<string, string>();
      for (const label of labels) {
        map.set(String(label.id), label.name);
      }
      return map;
    });

    labelCache.set(key, promise);
    return promise;
  }

  return async function resolveLabelNames(
    repo: NonNullable<Scope['repo']>,
    labels: string[]
  ): Promise<string[]> {
    if (labels.length === 0) return labels;
    const hasNumericLabel = labels.some((label) => /^\d+$/.test(label));
    if (!hasNumericLabel) return labels;
    const idToName = await loadLabelMap(repo);
    return labels.map((label) => idToName.get(label) ?? label);
  };
}

export function createCurrentUserResolver(gh: GhRunner): () => Promise<string> {
  let currentLoginPromise: Promise<string> | undefined;
  return function getCurrentLogin(): Promise<string> {
    if (!currentLoginPromise) {
      currentLoginPromise = gh
        .api('/user', z.object({ login: z.string() }))
        .then((u) => u.login);
    }
    return currentLoginPromise;
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

export async function resolveMilestoneNumber(
  gh: GhRunner,
  repo: NonNullable<Scope['repo']>,
  title: string
): Promise<number> {
  if (/^\d+$/.test(title)) {
    return Number(title);
  }

  if (title === CURRENT_MILESTONE) {
    const milestones = await gh.api(
      `/repos/${repoPath(repo)}/milestones?state=open`,
      z.array(
        z.object({
          number: z.number(),
          title: z.string(),
          due_on: z.string().nullable().optional(),
        })
      )
    );
    const current = pickCurrentMilestone(milestones, (m) => m.due_on);
    if (!current) {
      throw new Error('no open milestone with an upcoming due date');
    }
    return current.number;
  }
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
  const { getIssueNodeId, primeIssueNodeId, getBoardFields, resolveBoardId } = createCaches();
  const resolveLabelNames = createLabelResolver(gh);
  const getCurrentLogin = createCurrentUserResolver(gh);
  const issueFieldCache = new Map<string, Promise<z.infer<typeof issueFieldDefinitionSchema>[]>>();
  const issueTypeCache = new Map<string, Promise<IssueType[]>>();
  const issueLabelListCache = new Map<string, Promise<Label[]>>();

  async function listIssueTypes(scope: Scope): Promise<IssueType[]> {
    const repo = requireRepo(scope);
    const key = `${repo.owner}/${repo.repo}`;
    let types = issueTypeCache.get(key);
    if (!types) {
      types = gh.api(
        `/repos/${repoPath(repo)}/issue-types`,
        z.array(issueTypeSchema)
      );
      issueTypeCache.set(key, types);
    }
    return types;
  }

  async function setIssueFields(
    repo: NonNullable<Scope['repo']>,
    issueId: ItemId,
    values: Record<string, unknown>
  ): Promise<void> {
    const definitions = issueFieldCache.get(repo.owner) ?? gh.api(
      `/orgs/${encodeURIComponent(repo.owner)}/issue-fields`,
      z.array(issueFieldDefinitionSchema)
    );
    issueFieldCache.set(repo.owner, definitions);
    const fields = await definitions;
    const byName = new Map(fields.map((field) => [field.name.toLowerCase(), field]));
    const issueFieldValues = Object.entries(values).map(([name, value]) => {
      const field = byName.get(name.toLowerCase());
      if (!field) {
        const available = fields.map((candidate) => candidate.name).join(', ');
        throw new UnsupportedError(`issue field "${name}" not found; available: ${available}`);
      }
      return { field_id: field.id, value };
    });

    await gh.api(
      `/repos/${repoPath(repo)}/issues/${toIssueNumber(issueId)}/issue-field-values`,
      z.any(),
      { method: 'POST', input: { issue_field_values: issueFieldValues } }
    );
  }

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
      labels: opts?.labels
        ? await resolveLabelNames(repo, opts.labels)
        : [],
      assignees: opts?.assignees
        ? await resolveUsernames(opts.assignees, getCurrentLogin)
        : [],
    };
    if (opts?.type !== undefined) input.type = opts.type;

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

    if (opts?.issueFields && Object.keys(opts.issueFields).length > 0) {
      try {
        await setIssueFields(repo, issue.id, opts.issueFields);
      } catch (err) {
        warnings.push(
          `set issue fields failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    let boardItemId: string | undefined;
    let resolvedBoardId: string | undefined;
    if (scope.boardId) {
      try {
        resolvedBoardId = await resolveBoardId(gh, scope.boardId, repo);
        const contentId = raw.node_id ?? (await getIssueNodeId(gh, repo, issue.id));
        boardItemId = await addIssueToBoard(gh, resolvedBoardId, contentId);
      } catch (err) {
        warnings.push(
          `add to board failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    if (boardItemId && resolvedBoardId) {
      if (opts?.fields && Object.keys(opts.fields).length > 0) {
        try {
          const fields = await getBoardFields(gh, resolvedBoardId);
          for (const [name, value] of Object.entries(opts.fields)) {
            try {
              await setProjectFieldByName(gh, resolvedBoardId, boardItemId, fields, name, value);
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
          const fields = await getBoardFields(gh, resolvedBoardId);
          await setItemStatus(gh, resolvedBoardId, boardItemId, opts.status, fields);
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
    if (opts.labels !== undefined) {
      input.labels = await resolveLabelNames(repo, opts.labels);
    }
    if (opts.assignees !== undefined) {
      input.assignees = await resolveUsernames(opts.assignees, getCurrentLogin);
    }
    if (opts.milestone !== undefined) {
      input.milestone =
        opts.milestone === null
          ? null
          : await resolveMilestoneNumber(gh, repo, opts.milestone);
    }
    if (opts.state !== undefined) input.state = opts.state;
    if (opts.type !== undefined) input.type = opts.type;

    const raw = await gh.api(
      `/repos/${repoPath(repo)}/issues/${toIssueNumber(id)}`,
      issueSchema,
      { method: 'PATCH', input }
    );
    if (raw.node_id) {
      primeIssueNodeId(id, raw.node_id);
    }
    const issue = mapIssue(raw);

    if (opts.issueFields && Object.keys(opts.issueFields).length > 0) {
      try {
        await setIssueFields(repo, id, opts.issueFields);
      } catch (err) {
        warnings.push(
          `set issue fields failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

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
      mutation($blockingIssueId: ID!, $issueId: ID!) {
        removeBlockedBy(input: { blockingIssueId: $blockingIssueId, issueId: $issueId }) {
          blockingIssue { id }
          issue { id }
        }
      }`;

    const schema = z.object({
      removeBlockedBy: z.object({
        blockingIssue: z.object({ id: z.string() }),
        issue: z.object({ id: z.string() }),
      }),
    });

    await gh.graphql(mutation, { blockingIssueId: blockerId, issueId: blockedId }, schema);
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

    const boardId = await resolveBoardId(gh, scope.boardId, requireRepo(scope));
    const [fields, itemId] = await Promise.all([
      getBoardFields(gh, boardId),
      findProjectItemId(gh, repo, boardId, id),
    ]);

    await setItemStatus(gh, boardId, itemId, status, fields);
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
        mutation($blockingIssueId: ID!, $issueId: ID!) {
          addBlockedBy(input: { blockingIssueId: $blockingIssueId, issueId: $issueId }) {
            blockingIssue { id }
            issue { id }
          }
        }`;

      const schema = z.object({
        addBlockedBy: z.object({
          blockingIssue: z.object({ id: z.string() }),
          issue: z.object({ id: z.string() }),
        }),
      });

      await gh.graphql(mutation, { blockingIssueId: blockerId, issueId: blockedId }, schema);
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
    const key = repoPath(repo);
    let labels = issueLabelListCache.get(key);
    if (!labels) {
      labels = gh.api(
        `/repos/${key}/labels`,
        z.array(repoLabelSchema)
      ).then((raw) => raw.map(mapRepoLabel));
      issueLabelListCache.set(key, labels);
    }
    return labels;
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
    listIssueTypes,
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

import { z } from 'zod';
import type { GlabRunner } from '../../transport/glab.js';
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
import { toggleChecklistItem as toggleInBody } from '../../core/checklist.js';
import { CURRENT_MILESTONE, pickCurrentMilestone } from '../../core/milestone.js';
import { UnsupportedError } from '../../core/errors.js';

export interface GitLabIssueProviderOptions {
  /** Workflow stages used to map status moves to mutually-exclusive labels. */
  stages?: Array<{ key: string; name: string; id?: string }>;
}

function projectRef(repo: NonNullable<Scope['repo']>): string {
  return encodeURIComponent(`${repo.owner}/${repo.repo}`);
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
    throw new UnsupportedError('non-numeric GitLab issue id');
  }
  return n;
}

const issueSchema = z.object({
  iid: z.number(),
  title: z.string(),
  description: z.string().nullable(),
  state: z.enum(['opened', 'closed']),
  web_url: z.string(),
  labels: z.array(z.string()),
  assignees: z.array(z.object({ username: z.string() })).optional(),
  milestone: z.object({ title: z.string() }).nullable().optional(),
});

function mapIssue(raw: z.infer<typeof issueSchema>): Issue {
  return {
    id: String(raw.iid),
    title: raw.title,
    body: raw.description ?? '',
    state: raw.state === 'opened' ? 'open' : 'closed',
    url: raw.web_url,
    labels: raw.labels,
    assignees: raw.assignees?.map((a) => a.username) ?? [],
    milestone: raw.milestone?.title ?? null,
  };
}

const commentSchema = z.object({
  id: z.number(),
  author: z.object({ username: z.string() }),
  body: z.string(),
  created_at: z.string(),
});

function mapComment(raw: z.infer<typeof commentSchema>): Comment {
  return {
    id: String(raw.id),
    author: raw.author.username,
    body: raw.body,
    createdAt: raw.created_at,
  };
}

const labelSchema = z.object({
  name: z.string(),
  color: z.string(),
  description: z.string().nullable().optional(),
});

function mapLabel(raw: z.infer<typeof labelSchema>): Label {
  return {
    name: raw.name,
    color: raw.color,
    description: raw.description ?? '',
  };
}

const milestoneSchema = z.object({
  id: z.number(),
  title: z.string(),
  state: z.enum(['active', 'closed', 'open']),
  due_date: z.string().nullable().optional(),
});

function mapMilestone(raw: z.infer<typeof milestoneSchema>): Milestone {
  return {
    id: String(raw.id),
    title: raw.title,
    state: raw.state === 'closed' ? 'closed' : 'open',
    dueOn: raw.due_date ?? null,
  };
}

async function resolveUserIds(
  glab: GlabRunner,
  usernames: string[]
): Promise<number[]> {
  const ids: number[] = [];
  for (const username of usernames) {
    const users = await glab.api(
      `users?username=${encodeURIComponent(username)}`,
      z.array(z.object({ id: z.number() }))
    );
    if (users[0]) ids.push(users[0].id);
  }
  return ids;
}

async function resolveMilestoneId(
  glab: GlabRunner,
  repo: NonNullable<Scope['repo']>,
  title: string
): Promise<number> {
  const ref = projectRef(repo);
  if (title === CURRENT_MILESTONE) {
    const milestones = await glab.api(
      `projects/${ref}/milestones?state=active`,
      z.array(
        z.object({
          id: z.number(),
          title: z.string(),
          due_date: z.string().nullable().optional(),
        })
      )
    );
    const current = pickCurrentMilestone(milestones, (m) => m.due_date);
    if (!current) {
      throw new Error('no active milestone with an upcoming due date');
    }
    return current.id;
  }
  const params = new URLSearchParams({ include_ancestors: 'true', search: title });
  const milestones = await glab.api(
    `projects/${ref}/milestones?${params.toString()}`,
    z.array(z.object({ id: z.number(), title: z.string() }))
  );
  const match = milestones.find((m) => m.title === title);
  if (!match) {
    throw new Error(`milestone "${title}" not found`);
  }
  return match.id;
}

export function createGitLabIssueProvider(
  glab: GlabRunner,
  opts: GitLabIssueProviderOptions = {}
): IssueProvider {
  const stages = opts.stages ?? [];

  function statusLabel(status: string): string {
    const stage = stages.find(
      (s) => s.key === status || s.name === status || s.id === status
    );
    return stage ? (stage.id ?? stage.name) : status;
  }

  async function listIssues(
    scope: Scope,
    opts?: ListIssuesOptions
  ): Promise<Issue[]> {
    const repo = requireRepo(scope);
    const state = opts?.state ?? 'open';
    const glabState = state === 'open' ? 'opened' : state;
    const perPage = opts?.limit ?? 50;

    const params = new URLSearchParams({
      state: glabState,
      per_page: String(perPage),
    });
    if (opts?.labels && opts.labels.length > 0) {
      params.set('labels', opts.labels.join(','));
    }
    if (opts?.assignee) {
      params.set('assignee_username', opts.assignee);
    }

    const raw = await glab.api(
      `projects/${projectRef(repo)}/issues?${params.toString()}`,
      z.array(issueSchema)
    );
    return raw.map(mapIssue);
  }

  async function createIssue(
    scope: Scope,
    title: string,
    body: string,
    opts?: CreateIssueOptions
  ): Promise<{ issue: Issue; warnings: string[] }> {
    const repo = requireRepo(scope);
    const warnings: string[] = [];

    const fields: Record<string, unknown> = { title, description: body };
    if (opts?.labels && opts.labels.length > 0) {
      fields.labels = opts.labels.join(',');
    }
    if (opts?.assignees && opts.assignees.length > 0) {
      fields.assignee_ids = await resolveUserIds(glab, opts.assignees);
    }
    if (opts?.milestone) {
      fields.milestone_id = await resolveMilestoneId(glab, repo, opts.milestone);
    }

    const raw = await glab.api(
      `projects/${projectRef(repo)}/issues`,
      issueSchema,
      { method: 'POST', fields }
    );
    const issue = mapIssue(raw);

    if (opts?.status) {
      try {
        await setIssueStatus(scope, issue.id, opts.status);
      } catch (err) {
        warnings.push(
          `set status failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    const relationshipArrays: Array<{ type: RelationshipType; targets: ItemId[] }> = [
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

    if (opts?.parent) {
      try {
        await addSubIssue(scope, opts.parent, issue.id);
      } catch (err) {
        warnings.push(
          `add parent failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    return { issue, warnings };
  }

  async function getIssue(scope: Scope, id: ItemId): Promise<Issue> {
    const repo = requireRepo(scope);
    const raw = await glab.api(
      `projects/${projectRef(repo)}/issues/${toIssueNumber(id)}`,
      issueSchema
    );
    return mapIssue(raw);
  }

  async function updateIssue(
    scope: Scope,
    id: ItemId,
    opts: UpdateIssueOptions
  ): Promise<{ issue: Issue; warnings: string[] }> {
    const repo = requireRepo(scope);
    const warnings: string[] = [];

    const fields: Record<string, unknown> = {};
    if (opts.title !== undefined) fields.title = opts.title;
    if (opts.body !== undefined) fields.description = opts.body;
    if (opts.labels !== undefined) fields.labels = opts.labels.join(',');
    if (opts.assignees !== undefined) {
      fields.assignee_ids = await resolveUserIds(glab, opts.assignees);
    }
    if (opts.milestone !== undefined) {
      fields.milestone_id =
        opts.milestone === null
          ? 0
          : await resolveMilestoneId(glab, repo, opts.milestone);
    }
    if (opts.state !== undefined) {
      fields.state_event = opts.state === 'closed' ? 'close' : 'reopen';
    }

    const raw = await glab.api(
      `projects/${projectRef(repo)}/issues/${toIssueNumber(id)}`,
      issueSchema,
      { method: 'PUT', fields }
    );
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

    const removeOps: Array<{ type: RelationshipType; targets: ItemId[] }> = [
      { type: 'blocks', targets: opts.remove_blocks ?? [] },
      { type: 'blocked_by', targets: opts.remove_blocked_by ?? [] },
      { type: 'related', targets: opts.remove_related ?? [] },
    ];

    for (const { type, targets } of removeOps) {
      for (const targetId of targets) {
        warnings.push(`remove ${type} #${targetId} is not supported by this provider`);
      }
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

  async function setIssueStatus(
    scope: Scope,
    id: ItemId,
    status: string
  ): Promise<void> {
    const repo = requireRepo(scope);
    const targetLabel = statusLabel(status);
    const otherLabels = stages
      .map((s) => s.id ?? s.name)
      .filter((label) => label !== targetLabel);

    const fields: Record<string, unknown> = {
      add_labels: targetLabel,
    };
    if (otherLabels.length > 0) {
      fields.remove_labels = otherLabels.join(',');
    }

    await glab.api(
      `projects/${projectRef(repo)}/issues/${toIssueNumber(id)}`,
      z.any(),
      { method: 'PUT', fields }
    );
  }

  async function addIssueComment(
    scope: Scope,
    id: ItemId,
    body: string
  ): Promise<void> {
    const repo = requireRepo(scope);
    await glab.api(
      `projects/${projectRef(repo)}/issues/${toIssueNumber(id)}/notes`,
      z.any(),
      { method: 'POST', fields: { body } }
    );
  }

  async function listIssueComments(scope: Scope, id: ItemId): Promise<Comment[]> {
    const repo = requireRepo(scope);
    const raw = await glab.api(
      `projects/${projectRef(repo)}/issues/${toIssueNumber(id)}/notes`,
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
    const issue = await getIssue(scope, id);
    const result = toggleInBody(issue.body, itemText, checked);
    await updateIssue(scope, id, { body: result.body });
    return { matched: result.matched, checked: result.checked };
  }

  // GitLab CE only supports "relates_to"; blocks/is_blocked_by require Premium.
  // Duplicate also degrades to relates_to because GitLab has no native duplicate link.
  const RELATIONSHIP_MAP: Record<RelationshipType, string> = {
    blocks: 'relates_to',
    blocked_by: 'relates_to',
    related: 'relates_to',
    duplicate: 'relates_to',
  };

  async function setRelationship(
    scope: Scope,
    id: ItemId,
    type: RelationshipType,
    targetId: ItemId
  ): Promise<{ mechanism: 'native' }> {
    const repo = requireRepo(scope);
    const ref = projectRef(repo);
    const project = await glab.api(
      `projects/${ref}`,
      z.object({ id: z.number() })
    );

    await glab.api(
      `projects/${ref}/issues/${toIssueNumber(id)}/links`,
      z.any(),
      {
        method: 'POST',
        fields: {
          target_project_id: project.id,
          target_issue_iid: toIssueNumber(targetId),
          link_type: RELATIONSHIP_MAP[type],
        },
      }
    );

    return { mechanism: 'native' };
  }

  async function resolveWorkItemGid(
    repo: NonNullable<Scope['repo']>,
    iid: number
  ): Promise<string> {
    const query = `
      query($fullPath: ID!, $iid: String!) {
        project(fullPath: $fullPath) {
          workItems(iids: [$iid]) {
            nodes { id }
          }
        }
      }`;
    const schema = z.object({
      project: z.object({
        workItems: z.object({
          nodes: z.array(z.object({ id: z.string() })),
        }),
      }),
    });

    const data = await glab.graphql(
      query,
      { fullPath: `${repo.owner}/${repo.repo}`, iid: String(iid) },
      schema
    );
    const nodes = data.project.workItems.nodes;
    if (nodes.length === 0) {
      throw new Error(`Work item #${iid} not found in ${repo.owner}/${repo.repo}`);
    }
    return nodes[0].id;
  }

  async function addSubIssue(
    scope: Scope,
    parentId: ItemId,
    childId: ItemId
  ): Promise<void> {
    const repo = requireRepo(scope);
    const [parentGid, childGid] = await Promise.all([
      resolveWorkItemGid(repo, toIssueNumber(parentId)),
      resolveWorkItemGid(repo, toIssueNumber(childId)),
    ]);

    const mutation = `
      mutation($id: WorkItemID!, $parentId: WorkItemID!) {
        workItemUpdate(input: { id: $id, hierarchyWidget: { parentId: $parentId } }) {
          workItem { id }
          errors
        }
      }`;
    const schema = z.object({
      workItemUpdate: z.object({
        workItem: z.object({ id: z.string() }),
        errors: z.array(z.string()),
      }),
    });

    const result = await glab.graphql(
      mutation,
      { id: childGid, parentId: parentGid },
      schema
    );
    if (result.workItemUpdate.errors.length > 0) {
      throw new Error(result.workItemUpdate.errors.join(', '));
    }
  }

  async function listSubIssues(scope: Scope, parentId: ItemId): Promise<Issue[]> {
    const repo = requireRepo(scope);
    const query = `
      query($fullPath: ID!, $iid: String!) {
        project(fullPath: $fullPath) {
          workItem(iid: $iid) {
            widgets {
              ... on WorkItemWidgetHierarchy {
                children {
                  nodes { id iid title state }
                }
              }
            }
          }
        }
      }`;
    const schema = z.object({
      project: z.object({
        workItem: z.object({
          widgets: z.array(
            z.object({
              children: z.object({
                nodes: z.array(
                  z.object({
                    id: z.string(),
                    iid: z.string(),
                    title: z.string(),
                    state: z.enum(['OPEN', 'CLOSED']),
                  })
                ),
              }),
            })
          ),
        }),
      }),
    });

    const data = await glab.graphql(
      query,
      { fullPath: `${repo.owner}/${repo.repo}`, iid: String(toIssueNumber(parentId)) },
      schema
    );

    const widgets = data.project.workItem.widgets;
    const hierarchy = widgets.find((w) => 'children' in w);
    const nodes = hierarchy?.children.nodes ?? [];

    return nodes.map((n) => ({
      id: n.iid,
      title: n.title,
      body: '',
      state: n.state === 'OPEN' ? 'open' : 'closed',
      url: '',
      labels: [],
      assignees: [],
      milestone: null,
    }));
  }

  async function listLabels(scope: Scope): Promise<Label[]> {
    const repo = requireRepo(scope);
    const raw = await glab.api(
      `projects/${projectRef(repo)}/labels`,
      z.array(labelSchema)
    );
    return raw.map(mapLabel);
  }

  async function listMilestones(
    scope: Scope,
    state?: 'open' | 'closed' | 'all'
  ): Promise<Milestone[]> {
    const repo = requireRepo(scope);
    const params = new URLSearchParams({ include_ancestors: 'true' });
    if (state && state !== 'all') {
      params.set('state', state);
    }
    const raw = await glab.api(
      `projects/${projectRef(repo)}/milestones?${params.toString()}`,
      z.array(milestoneSchema)
    );
    return raw.map(mapMilestone);
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

import { toggleChecklistItem as toggleInBody } from '../../core/checklist.js';
import { UnsupportedError } from '../../core/errors.js';
import type { Scope } from '../../core/scope.js';
import type {
  Comment,
  CreateIssueOptions,
  Issue,
  ItemId,
  Label,
  RelationshipType,
  UpdateIssueOptions,
} from '../../core/types.js';
import type { IssueProvider, ListIssuesOptions } from './capabilities.js';
import { IssueStore, type IssueMeta, type StoredIssue } from '../local/files.js';

function toIssue(stored: StoredIssue): Issue {
  const { meta, body } = stored;
  return {
    id: meta.id,
    title: meta.title,
    body,
    state: meta.state,
    url: stored.filePath,
    labels: meta.labels,
    assignees: meta.assignees,
    milestone: meta.milestone,
  };
}

function emptyMeta(id: ItemId, title: string): IssueMeta {
  return {
    id,
    title,
    state: 'open',
    labels: [],
    assignees: [],
    milestone: null,
    status: null,
    relationships: { blocks: [], blocked_by: [], related: [], duplicate_of: null },
    parent: null,
    fields: {},
  };
}

function addUnique(list: ItemId[], ids: ItemId[]): ItemId[] {
  return [...new Set([...list, ...ids])];
}

function removeIds(list: ItemId[], ids: ItemId[]): ItemId[] {
  const drop = new Set(ids);
  return list.filter((id) => !drop.has(id));
}

/**
 * Issue provider backed by markdown files on disk. Requires no scope and
 * no external account. Composite options land straight in frontmatter;
 * every mutation runs as one read-modify-write under the store mutex.
 */
export function createLocalIssueProvider(dir: string): IssueProvider {
  const store = new IssueStore(dir);

  async function createIssue(
    _scope: Scope,
    title: string,
    body: string,
    opts?: CreateIssueOptions
  ): Promise<{ issue: Issue; warnings: string[] }> {
    const id = await store.nextId();
    const meta = emptyMeta(id, title);
    if (opts?.labels) meta.labels = opts.labels;
    if (opts?.assignees) meta.assignees = opts.assignees;
    if (opts?.milestone) meta.milestone = opts.milestone;
    if (opts?.status) meta.status = opts.status;
    if (opts?.parent) meta.parent = opts.parent;
    if (opts?.fields) meta.fields = { ...opts.fields };
    if (opts?.blocks) meta.relationships.blocks = opts.blocks;
    if (opts?.blocked_by) meta.relationships.blocked_by = opts.blocked_by;
    if (opts?.related) meta.relationships.related = opts.related;
    if (opts?.duplicate_of) meta.relationships.duplicate_of = opts.duplicate_of;
    const stored = await store.create(meta, body);
    return { issue: toIssue(stored), warnings: [] };
  }

  return {
    createIssue,

    async listIssues(_scope: Scope, opts?: ListIssuesOptions): Promise<Issue[]> {
      let all = await store.list();
      if (opts?.state && opts.state !== 'all') {
        all = all.filter((i) => i.meta.state === opts.state);
      }
      if (opts?.labels?.length) {
        all = all.filter((i) => opts.labels!.every((l) => i.meta.labels.includes(l)));
      }
      if (opts?.assignee) {
        all = all.filter((i) => i.meta.assignees.includes(opts.assignee!));
      }
      if (opts?.limit) all = all.slice(0, opts.limit);
      return all.map(toIssue);
    },

    async getIssue(_scope: Scope, id: ItemId): Promise<Issue> {
      return toIssue(await store.get(id));
    },

    async updateIssue(
      _scope: Scope,
      id: ItemId,
      opts: UpdateIssueOptions
    ): Promise<{ issue: Issue; warnings: string[] }> {
      const saved = await store.update(id, (stored) => {
        const { meta } = stored;
        if (opts.title !== undefined) meta.title = opts.title;
        if (opts.body !== undefined) stored.body = opts.body;
        if (opts.labels !== undefined) meta.labels = opts.labels;
        if (opts.assignees !== undefined) meta.assignees = opts.assignees;
        if (opts.state !== undefined) meta.state = opts.state;
        const rel = meta.relationships;
        if (opts.add_blocks) rel.blocks = addUnique(rel.blocks, opts.add_blocks);
        if (opts.remove_blocks) rel.blocks = removeIds(rel.blocks, opts.remove_blocks);
        if (opts.add_blocked_by) rel.blocked_by = addUnique(rel.blocked_by, opts.add_blocked_by);
        if (opts.remove_blocked_by) rel.blocked_by = removeIds(rel.blocked_by, opts.remove_blocked_by);
        if (opts.add_related) rel.related = addUnique(rel.related, opts.add_related);
        if (opts.remove_related) rel.related = removeIds(rel.related, opts.remove_related);
        if (opts.duplicate_of !== undefined) rel.duplicate_of = opts.duplicate_of;
      });
      return { issue: toIssue(saved), warnings: [] };
    },

    async setIssueStatus(_scope: Scope, id: ItemId, status: string): Promise<void> {
      await store.update(id, (stored) => {
        stored.meta.status = status;
      });
    },

    async addIssueComment(_scope: Scope, id: ItemId, body: string): Promise<void> {
      await store.update(id, (stored) => {
        const createdAt = new Date().toISOString();
        stored.comments.push({ id: createdAt, author: 'local', body, createdAt });
      });
    },

    async listIssueComments(_scope: Scope, id: ItemId): Promise<Comment[]> {
      return (await store.get(id)).comments;
    },

    async toggleChecklistItem(
      _scope: Scope,
      id: ItemId,
      itemText: string,
      checked?: boolean
    ): Promise<{ matched: string; checked: boolean }> {
      let outcome!: { matched: string; checked: boolean };
      await store.update(id, (stored) => {
        const result = toggleInBody(stored.body, itemText, checked);
        stored.body = result.body;
        outcome = { matched: result.matched, checked: result.checked };
      });
      return outcome;
    },

    async setRelationship(
      _scope: Scope,
      id: ItemId,
      type: RelationshipType,
      targetId: ItemId
    ): Promise<{ mechanism: 'native' }> {
      await store.update(id, (stored) => {
        const rel = stored.meta.relationships;
        if (type === 'duplicate') {
          rel.duplicate_of = targetId;
        } else {
          rel[type] = addUnique(rel[type], [targetId]);
        }
      });
      return { mechanism: 'native' };
    },

    async addSubIssue(_scope: Scope, parentId: ItemId, childId: ItemId): Promise<void> {
      await store.update(childId, (child) => {
        child.meta.parent = parentId;
      });
    },

    async listSubIssues(_scope: Scope, parentId: ItemId): Promise<Issue[]> {
      const all = await store.list();
      return all.filter((i) => i.meta.parent === parentId).map(toIssue);
    },

    async listLabels(): Promise<Label[]> {
      const all = await store.list();
      const names = [...new Set(all.flatMap((i) => i.meta.labels))].sort();
      return names.map((name) => ({ name, color: '', description: '' }));
    },

    async listMilestones(): Promise<never> {
      throw new UnsupportedError('milestones');
    },
  };
}

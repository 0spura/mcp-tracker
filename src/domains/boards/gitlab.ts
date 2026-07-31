import { z } from 'zod';
import type { GlabRunner } from '../../transport/glab.js';
import type { Scope } from '../../core/scope.js';
import type { BoardProvider } from './capabilities.js';
import type { ItemId, ProjectItem, ProjectField } from '../../core/types.js';
import { UnsupportedError } from '../../core/errors.js';

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

function projectRef(repo: NonNullable<Scope['repo']>): string {
  return encodeURIComponent(`${repo.owner}/${repo.repo}`);
}

function toIssueNumber(id: ItemId): number {
  const n = Number(id);
  if (Number.isNaN(n)) {
    throw new UnsupportedError('non-numeric GitLab issue id');
  }
  return n;
}

function normalizeIssueState(state: string): 'open' | 'closed' {
  return state === 'opened' ? 'open' : 'closed';
}

const boardListSchema = z.object({
  id: z.number(),
  label: z
    .object({
      id: z.number(),
      name: z.string(),
      color: z.string().optional(),
      description: z.string().nullable().optional(),
    })
    .nullable(),
  position: z.number(),
});

const boardIssueSchema = z.object({
  iid: z.number(),
  title: z.string(),
  state: z.enum(['opened', 'closed']),
  web_url: z.string(),
  labels: z.array(z.string()).optional(),
});

type BoardList = z.infer<typeof boardListSchema>;

async function fetchBoardLists(
  glab: GlabRunner,
  repo: NonNullable<Scope['repo']>,
  boardId: string
): Promise<BoardList[]> {
  const lists = await glab.api(
    `projects/${projectRef(repo)}/boards/${boardId}/lists`,
    z.array(boardListSchema)
  );
  return lists.sort((a, b) => a.position - b.position);
}

function listStatusLabel(list: BoardList): string | null {
  return list.label?.name ?? null;
}

function mapBoardIssue(
  list: BoardList | null,
  raw: z.infer<typeof boardIssueSchema>
): ProjectItem {
  return {
    id: String(raw.iid),
    status: list ? listStatusLabel(list) : null,
    content: {
      type: 'issue',
      id: String(raw.iid),
      title: raw.title,
      state: normalizeIssueState(raw.state),
      url: raw.web_url,
    },
  };
}

export function createGitLabBoardProvider(glab: GlabRunner): BoardProvider {
  async function listBoardItems(scope: Scope): Promise<ProjectItem[]> {
    const boardId = requireBoard(scope);
    const repo = requireRepo(scope);

    const lists = await fetchBoardLists(glab, repo, boardId);
    const items: ProjectItem[] = [];

    for (const list of lists) {
      const issues = await glab.api(
        `projects/${projectRef(repo)}/boards/${boardId}/lists/${list.id}/issues`,
        z.array(boardIssueSchema)
      );
      items.push(...issues.map((issue) => mapBoardIssue(list, issue)));
    }

    // The lists endpoint omits the system backlog and closed lists, but the
    // board shows every issue implicitly: open issues without a list label
    // sit in the backlog, closed issues in the closed list. Synthesize both.
    const listed = new Set(items.map((item) => item.id));
    for (const state of ['opened', 'closed'] as const) {
      const issues = await glab.api(
        `projects/${projectRef(repo)}/issues?state=${state}&per_page=100`,
        z.array(boardIssueSchema)
      );
      for (const issue of issues) {
        const id = String(issue.iid);
        if (!listed.has(id)) {
          items.push(mapBoardIssue(null, issue));
        }
      }
    }

    return items;
  }

  async function listBoardFields(scope: Scope): Promise<ProjectField[]> {
    const boardId = requireBoard(scope);
    const repo = requireRepo(scope);

    const lists = await fetchBoardLists(glab, repo, boardId);
    const options = lists
      .filter((list) => list.label !== null)
      .map((list) => ({
        id: list.label!.name,
        name: list.label!.name,
      }));

    return [
      {
        id: 'status',
        name: 'Status',
        type: 'single_select',
        options,
      },
    ];
  }

  async function setItemFields(
    scope: Scope,
    itemId: ItemId,
    fields: Record<string, string>
  ): Promise<void> {
    const boardId = requireBoard(scope);
    const repo = requireRepo(scope);
    const number = toIssueNumber(itemId);

    const lists = await fetchBoardLists(glab, repo, boardId);
    const statusLists = lists.filter((list) => list.label !== null);

    for (const [name, value] of Object.entries(fields)) {
      if (name.toLowerCase() !== 'status') {
        throw new UnsupportedError(
          `field "${name}" is not supported by this provider`
        );
      }

      const target = statusLists.find(
        (list) => list.label!.name.toLowerCase() === value.toLowerCase()
      );
      if (!target) {
        const available = statusLists.map((list) => list.label!.name).join(', ');
        throw new UnsupportedError(
          `status "${value}" not found; available: ${available || 'none'}`
        );
      }

      const targetLabel = target.label!.name;
      const otherLabels = statusLists
        .filter((list) => list.label!.name !== targetLabel)
        .map((list) => list.label!.name);

      const body: Record<string, unknown> = {
        add_labels: targetLabel,
      };
      if (otherLabels.length > 0) {
        body.remove_labels = otherLabels.join(',');
      }

      await glab.api(
        `projects/${projectRef(repo)}/issues/${number}`,
        z.any(),
        { method: 'PUT', fields: body }
      );
    }
  }

  return {
    listBoardItems,
    listBoardFields,
    setItemFields,
  };
}

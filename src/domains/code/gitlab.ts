import { z } from 'zod';
import type { GlabRunner } from '../../transport/glab.js';
import type {
  TrackerRepo,
  PR,
  PRState,
  CheckRun,
  Comment,
  CreatePROptions,
  UpdatePROptions,
  PRReview,
  ItemId,
} from '../../core/types.js';
import type { CodeProvider, ListPRsOptions } from './capabilities.js';
import { resolveUsernames } from '../../core/user.js';
import { UnsupportedError } from '../../core/errors.js';

const MAX_DIFF_CHARS = 50_000;
const LOG_TAIL_LINES = 200;
const LOG_TAIL_CHARS = 12_000;

function projectRef(repo: TrackerRepo): string {
  return encodeURIComponent(`${repo.owner}/${repo.repo}`);
}

function toIid(id: ItemId): number {
  const n = Number(id);
  if (Number.isNaN(n)) {
    throw new UnsupportedError('non-numeric GitLab issue/MR id');
  }
  return n;
}

const mrSchema = z.object({
  iid: z.number(),
  title: z.string(),
  description: z.string().nullable(),
  state: z.enum(['opened', 'closed', 'merged', 'locked']),
  web_url: z.string(),
  source_branch: z.string(),
  target_branch: z.string(),
});

function normalizePRState(
  rawState: 'opened' | 'closed' | 'merged' | 'locked',
): PRState {
  if (rawState === 'opened' || rawState === 'locked') return 'open';
  return rawState;
}

function mapPR(raw: z.infer<typeof mrSchema>): PR {
  return {
    number: raw.iid,
    title: raw.title,
    body: raw.description ?? '',
    state: normalizePRState(raw.state),
    url: raw.web_url,
    headBranch: raw.source_branch,
    baseBranch: raw.target_branch,
  };
}

const pipelineSchema = z.object({
  id: z.number(),
  status: z.string(),
  web_url: z.string(),
});

const jobSchema = z.object({
  id: z.number(),
  name: z.string(),
  status: z.string(),
  web_url: z.string(),
});

const noteSchema = z.object({
  id: z.number(),
  author: z.object({ username: z.string() }),
  body: z.string(),
  created_at: z.string(),
});

function isFailingJobStatus(status: string): boolean {
  return status === 'failed';
}

function tailLog(raw: string): string {
  const text = raw.trim();
  if (!text) return '';
  const tail = text.split('\n').slice(-LOG_TAIL_LINES).join('\n');
  if (tail.length > LOG_TAIL_CHARS) {
    return `... (truncated)\n${tail.slice(-LOG_TAIL_CHARS)}`;
  }
  return tail;
}

function truncateDiff(text: string): string {
  if (text.length <= MAX_DIFF_CHARS) return text;
  const head = text.slice(0, MAX_DIFF_CHARS);
  return `... (truncated) ...\n${head}\n... (truncated) ...`;
}

function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80)
    .replace(/-$/, '');
  return slug || 'issue';
}

function referencesIssue(body: string, issueNumber: number): boolean {
  const pattern = new RegExp(
    `(?:closes|fixes|resolves)?\\s*#${issueNumber}\\b`,
    'i',
  );
  return pattern.test(body);
}

function injectClosingLines(body: string, issues?: ItemId[]): string {
  if (!issues || issues.length === 0) return body;

  const missing = issues
    .map((id) => Number(id))
    .filter((num) => !Number.isNaN(num) && !referencesIssue(body, num));

  if (missing.length === 0) return body;

  const suffix = missing.map((num) => `Closes #${num}`).join('\n');
  const trimmed = body.trimEnd();
  if (trimmed.length === 0) return `${suffix}\n`;
  return `${trimmed}\n\n${suffix}\n`;
}

export function createGitLabCodeProvider(glab: GlabRunner): CodeProvider {
  let currentUsernamePromise: Promise<string> | undefined;
  function getCurrentUsername(): Promise<string> {
    if (!currentUsernamePromise) {
      currentUsernamePromise = glab
        .api('user', z.object({ username: z.string() }))
        .then((u) => u.username);
    }
    return currentUsernamePromise;
  }

  return {
    createBranch: (repo, issueId, branchName, base) =>
      createBranch(glab, repo, issueId, branchName, base),
    createPR: (repo, title, body, head, base, opts) =>
      createPR(glab, repo, title, body, head, base, opts),
    updatePR: (repo, number, opts) =>
      updatePR(glab, repo, number, opts, getCurrentUsername),
    getPR: (repo, number) => getPR(glab, repo, number),
    listPRs: (repo, opts) => listPRs(glab, repo, opts),
    getPRChecks: (repo, number) => getPRChecks(glab, repo, number),
    mergePR: (repo, number, method, opts) => mergePR(glab, repo, number, method, opts),
    getPRDiff: (repo, number) => getPRDiff(glab, repo, number),
    submitPRReview: (repo, number, review) =>
      submitPRReview(glab, repo, number, review),
    addPRComment: (repo, number, body) =>
      addPRComment(glab, repo, number, body),
    listPRComments: (repo, number) => listPRComments(glab, repo, number),
  };
}

async function getDefaultBranch(
  glab: GlabRunner,
  repo: TrackerRepo,
): Promise<string> {
  const project = await glab.api(
    `projects/${projectRef(repo)}`,
    z.object({ default_branch: z.string() }),
  );
  return project.default_branch;
}

async function resolveBranchSha(
  glab: GlabRunner,
  repo: TrackerRepo,
  branch: string,
): Promise<string> {
  const info = await glab.api(
    `projects/${projectRef(repo)}/repository/branches/${encodeURIComponent(branch)}`,
    z.object({ commit: z.object({ id: z.string() }) }),
  );
  return info.commit.id;
}

async function branchExists(
  glab: GlabRunner,
  repo: TrackerRepo,
  branch: string,
): Promise<boolean> {
  try {
    await glab.api(
      `projects/${projectRef(repo)}/repository/branches/${encodeURIComponent(branch)}`,
      z.unknown(),
    );
    return true;
  } catch {
    return false;
  }
}

async function createBranch(
  glab: GlabRunner,
  repo: TrackerRepo,
  issueId: ItemId | null,
  branchName: string,
  base?: string,
): Promise<{ name: string }> {
  const resolvedName =
    issueId != null
      ? await resolveIssueBranchName(glab, repo, toIid(issueId))
      : branchName;

  const ref = projectRef(repo);
  const baseBranch = base ?? (await getDefaultBranch(glab, repo));
  const sha = await resolveBranchSha(glab, repo, baseBranch);

  if (await branchExists(glab, repo, resolvedName)) {
    return { name: resolvedName };
  }

  await glab.api(`projects/${ref}/repository/branches`, z.unknown(), {
    method: 'POST',
    fields: { branch: resolvedName, ref: sha },
  });

  return { name: resolvedName };
}

async function resolveIssueBranchName(
  glab: GlabRunner,
  repo: TrackerRepo,
  issueNumber: number,
): Promise<string> {
  const ref = projectRef(repo);
  const project = await glab.api(
    `projects/${ref}`,
    z.object({ issue_branch_template: z.string().nullable().optional() }),
  );

  const issue = await glab.api(
    `projects/${ref}/issues/${issueNumber}`,
    z.object({ title: z.string() }),
  );

  const slug = slugify(issue.title);
  const template = project.issue_branch_template;
  if (template) {
    return template
      .replace(/%\{id\}/g, String(issueNumber))
      .replace(/%\{title\}/g, slug);
  }
  return `${issueNumber}-${slug}`;
}

async function createPR(
  glab: GlabRunner,
  repo: TrackerRepo,
  title: string,
  body: string,
  head: string,
  base: string | undefined,
  opts?: CreatePROptions,
): Promise<PR> {
  const ref = projectRef(repo);
  const baseBranch = base ?? (await getDefaultBranch(glab, repo));
  const finalBody = injectClosingLines(body, opts?.issues);

  const raw = await glab.api(`projects/${ref}/merge_requests`, mrSchema, {
    method: 'POST',
    fields: {
      title,
      description: finalBody,
      source_branch: head,
      target_branch: baseBranch,
    },
  });

  return mapPR(raw);
}

async function getPR(
  glab: GlabRunner,
  repo: TrackerRepo,
  number: number,
): Promise<PR> {
  const raw = await glab.api(
    `projects/${projectRef(repo)}/merge_requests/${number}`,
    mrSchema,
  );
  return mapPR(raw);
}

async function listPRs(
  glab: GlabRunner,
  repo: TrackerRepo,
  opts?: ListPRsOptions,
): Promise<PR[]> {
  const state = opts?.state ?? 'open';
  const glabState = state === 'open' ? 'opened' : state;
  const perPage = opts?.limit ?? 50;

  const raw = await glab.api(
    `projects/${projectRef(repo)}/merge_requests?state=${glabState}&per_page=${perPage}`,
    z.array(mrSchema),
  );
  return raw.map(mapPR);
}

async function updatePR(
  glab: GlabRunner,
  repo: TrackerRepo,
  number: number,
  opts: UpdatePROptions,
  getCurrentUsername: () => Promise<string>,
): Promise<{ pr: PR; warnings: string[] }> {
  const warnings: string[] = [];
  const ref = projectRef(repo);

  const primaryFields: Record<string, unknown> = {};
  if (opts.title !== undefined) primaryFields.title = opts.title;
  if (opts.body !== undefined) primaryFields.description = opts.body;
  if (opts.state !== undefined) {
    if (opts.state === 'merged') {
      throw new UnsupportedError('cannot change PR state to merged');
    }
    primaryFields.state_event = opts.state === 'closed' ? 'close' : 'reopen';
  }

  let rawPr: z.infer<typeof mrSchema>;
  if (Object.keys(primaryFields).length > 0) {
    rawPr = await glab.api(
      `projects/${ref}/merge_requests/${number}`,
      mrSchema,
      { method: 'PUT', fields: primaryFields },
    );
  } else {
    rawPr = await glab.api(
      `projects/${ref}/merge_requests/${number}`,
      mrSchema,
    );
  }

  if (opts.draft !== undefined) {
    warnings.push(`draft update is not supported by the GitLab provider`);
  }

  if (opts.labels !== undefined) {
    try {
      await glab.api(`projects/${ref}/merge_requests/${number}`, z.any(), {
        method: 'PUT',
        fields: { labels: opts.labels.join(',') },
      });
    } catch (err) {
      warnings.push(
        `labels update failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (opts.milestone !== undefined) {
    try {
      await setMilestone(glab, repo, number, opts.milestone);
    } catch (err) {
      warnings.push(
        `milestone update failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (opts.add_reviewers && opts.add_reviewers.length > 0) {
    try {
      const reviewers = await resolveUsernames(opts.add_reviewers, getCurrentUsername);
      const ids = await resolveUserIds(glab, reviewers);
      await glab.api(`projects/${ref}/merge_requests/${number}`, z.any(), {
        method: 'PUT',
        fields: { reviewer_ids: ids },
      });
    } catch (err) {
      warnings.push(
        `add reviewers failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (opts.remove_reviewers && opts.remove_reviewers.length > 0) {
    try {
      const current = await glab.api(
        `projects/${ref}/merge_requests/${number}`,
        z.object({
          reviewers: z.array(z.object({ id: z.number() })).optional(),
        }),
      );
      const reviewers = await resolveUsernames(opts.remove_reviewers, getCurrentUsername);
      const removeIds = await resolveUserIds(glab, reviewers);
      const remaining = (current.reviewers ?? [])
        .map((r) => r.id)
        .filter((id) => !removeIds.includes(id));
      await glab.api(`projects/${ref}/merge_requests/${number}`, z.any(), {
        method: 'PUT',
        fields: { reviewer_ids: remaining },
      });
    } catch (err) {
      warnings.push(
        `remove reviewers failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (opts.add_assignees && opts.add_assignees.length > 0) {
    try {
      const assignees = await resolveUsernames(opts.add_assignees, getCurrentUsername);
      const ids = await resolveUserIds(glab, assignees);
      await glab.api(`projects/${ref}/merge_requests/${number}`, z.any(), {
        method: 'PUT',
        fields: { assignee_ids: ids },
      });
    } catch (err) {
      warnings.push(
        `add assignees failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (opts.remove_assignees && opts.remove_assignees.length > 0) {
    try {
      const current = await glab.api(
        `projects/${ref}/merge_requests/${number}`,
        z.object({
          assignees: z.array(z.object({ id: z.number() })).optional(),
        }),
      );
      const assignees = await resolveUsernames(opts.remove_assignees, getCurrentUsername);
      const removeIds = await resolveUserIds(glab, assignees);
      const remaining = (current.assignees ?? [])
        .map((a) => a.id)
        .filter((id) => !removeIds.includes(id));
      await glab.api(`projects/${ref}/merge_requests/${number}`, z.any(), {
        method: 'PUT',
        fields: { assignee_ids: remaining },
      });
    } catch (err) {
      warnings.push(
        `remove assignees failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return { pr: mapPR(rawPr), warnings };
}

async function resolveUserIds(
  glab: GlabRunner,
  usernames: string[],
): Promise<number[]> {
  const ids: number[] = [];
  for (const username of usernames) {
    const users = await glab.api(
      `users?username=${encodeURIComponent(username)}`,
      z.array(z.object({ id: z.number() })),
    );
    if (users[0]) ids.push(users[0].id);
  }
  return ids;
}

async function setMilestone(
  glab: GlabRunner,
  repo: TrackerRepo,
  number: number,
  title: string,
): Promise<void> {
  const ref = projectRef(repo);

  let milestoneId: number;
  if (/^\d+$/.test(title)) {
    try {
      const milestone = await glab.api(
        `projects/${ref}/milestones/${Number(title)}`,
        z.object({ id: z.number() }),
      );
      milestoneId = milestone.id;
    } catch {
      milestoneId = await findMilestoneIdByTitle(glab, ref, title);
    }
  } else {
    milestoneId = await findMilestoneIdByTitle(glab, ref, title);
  }

  await glab.api(`projects/${ref}/merge_requests/${number}`, z.any(), {
    method: 'PUT',
    fields: { milestone_id: milestoneId },
  });
}

async function findMilestoneIdByTitle(
  glab: GlabRunner,
  ref: string,
  title: string,
): Promise<number> {
  const params = new URLSearchParams({
    include_ancestors: 'true',
    search: title,
  });
  const milestones = await glab.api(
    `projects/${ref}/milestones?${params.toString()}`,
    z.array(z.object({ id: z.number(), title: z.string() })),
  );
  const match = milestones.find((m) => m.title === title);
  if (!match) {
    throw new Error(`milestone '${title}' not found`);
  }
  return match.id;
}

async function getPRChecks(
  glab: GlabRunner,
  repo: TrackerRepo,
  number: number,
): Promise<CheckRun[]> {
  const ref = projectRef(repo);
  const pipelines = await glab.api(
    `projects/${ref}/merge_requests/${number}/pipelines`,
    z.array(pipelineSchema),
  );
  if (pipelines.length === 0) return [];

  const latest = pipelines[0];
  const jobs = await glab.api(
    `projects/${ref}/pipelines/${latest.id}/jobs`,
    z.array(jobSchema),
  );

  return Promise.all(
    jobs.map(async (job) => {
      let logs: string | null = null;
      if (isFailingJobStatus(job.status)) {
        try {
          const raw = await glab.raw([
            'api',
            `projects/${ref}/jobs/${job.id}/trace`,
          ]);
          logs = tailLog(raw);
        } catch {
          // Logs are best-effort; leave them null on failure.
        }
      }
      return {
        name: job.name,
        status: mapJobStatus(job.status),
        conclusion: mapJobConclusion(job.status),
        url: job.web_url,
        logs,
      };
    }),
  );
}

function mapJobStatus(status: string): string {
  if (status === 'running') return 'in_progress';
  if (status === 'pending' || status === 'waiting_for_resource')
    return 'queued';
  return 'completed';
}

function mapJobConclusion(status: string): string | null {
  if (status === 'success') return 'success';
  if (status === 'failed') return 'failure';
  if (status === 'canceled') return 'cancelled';
  if (status === 'skipped') return 'skipped';
  return null;
}

async function mergePR(
  glab: GlabRunner,
  repo: TrackerRepo,
  number: number,
  method?: 'merge' | 'squash' | 'rebase',
  opts?: { deleteBranch?: boolean },
): Promise<{ warnings: string[] }> {
  const ref = projectRef(repo);

  if (method === 'rebase') {
    await glab.api(`projects/${ref}/merge_requests/${number}/rebase`, z.any(), {
      method: 'PUT',
    });
    const warnings = opts?.deleteBranch
      ? ['deleteBranch is not supported by the rebase-only merge path']
      : [];
    return { warnings };
  }

  const fields: Record<string, unknown> = {};
  if (method === 'squash') {
    fields.squash = true;
  }
  if (opts?.deleteBranch) {
    fields.should_remove_source_branch = true;
  }

  await glab.api(`projects/${ref}/merge_requests/${number}/merge`, z.any(), {
    method: 'PUT',
    fields,
  });
  return { warnings: [] };
}

async function getPRDiff(
  glab: GlabRunner,
  repo: TrackerRepo,
  number: number,
): Promise<string> {
  const diff = await glab.raw([
    'mr',
    'diff',
    String(number),
    '-R',
    `${repo.owner}/${repo.repo}`,
  ]);
  return truncateDiff(diff);
}

async function submitPRReview(
  glab: GlabRunner,
  repo: TrackerRepo,
  number: number,
  review: PRReview,
): Promise<void> {
  const ref = projectRef(repo);

  if (review.comments && review.comments.length > 0) {
    throw new UnsupportedError('inline PR review comments on GitLab');
  }

  if (review.event === 'approve') {
    await glab.api(
      `projects/${ref}/merge_requests/${number}/approve`,
      z.any(),
      { method: 'POST' },
    );
    return;
  }

  // comment and request_changes both post a note; request_changes also revokes approval.
  await glab.api(`projects/${ref}/merge_requests/${number}/notes`, z.any(), {
    method: 'POST',
    fields: { body: review.body ?? '' },
  });

  if (review.event === 'request_changes') {
    try {
      await glab.api(
        `projects/${ref}/merge_requests/${number}/unapprove`,
        z.any(),
        { method: 'POST' },
      );
    } catch {
      // Best-effort; may not have been approved.
    }
  }
}

async function addPRComment(
  glab: GlabRunner,
  repo: TrackerRepo,
  number: number,
  body: string,
): Promise<void> {
  await glab.api(
    `projects/${projectRef(repo)}/merge_requests/${number}/notes`,
    z.any(),
    { method: 'POST', fields: { body } },
  );
}

async function listPRComments(
  glab: GlabRunner,
  repo: TrackerRepo,
  number: number,
): Promise<Comment[]> {
  const raw = await glab.api(
    `projects/${projectRef(repo)}/merge_requests/${number}/notes`,
    z.array(noteSchema),
  );
  return raw.map((n) => ({
    id: String(n.id),
    author: n.author.username,
    body: n.body,
    createdAt: n.created_at,
  }));
}

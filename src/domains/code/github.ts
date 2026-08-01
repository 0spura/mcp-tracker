import { z } from 'zod';
import type { GhRunner } from '../../transport/gh.js';
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
import { UnsupportedError } from '../../core/errors.js';
import {
  createLabelResolver,
  resolveMilestoneNumber,
} from '../issues/github-projects.js';

const MAX_DIFF_CHARS = 50_000;
const LOG_TAIL_LINES = 200;
const LOG_TAIL_CHARS = 12_000;

function repoPath(repo: TrackerRepo): string {
  return `${repo.owner}/${repo.repo}`;
}

const prSchema = z.object({
  number: z.number(),
  title: z.string(),
  body: z.string().nullable(),
  state: z.enum(['open', 'closed']),
  html_url: z.string(),
  head: z.object({ ref: z.string(), sha: z.string().optional() }),
  base: z.object({ ref: z.string() }),
  merged: z.boolean().optional(),
  node_id: z.string().optional(),
});

function normalizePRState(
  rawState: 'open' | 'closed',
  merged?: boolean
): PRState {
  if (merged) return 'merged';
  return rawState;
}

function mapPR(raw: z.infer<typeof prSchema>): PR {
  return {
    number: raw.number,
    title: raw.title,
    body: raw.body ?? '',
    state: normalizePRState(raw.state, raw.merged),
    url: raw.html_url,
    headBranch: raw.head.ref,
    baseBranch: raw.base.ref,
  };
}

const pullHeadSchema = z.object({
  head: z.object({ sha: z.string() }),
});

const checkRunSchema = z.object({
  id: z.number(),
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  html_url: z.string().nullable().optional(),
});

const checkRunsSchema = z.object({
  check_runs: z.array(checkRunSchema),
});

const commentSchema = z.object({
  id: z.number(),
  user: z.object({ login: z.string() }).nullable(),
  body: z.string(),
  created_at: z.string(),
});

function isFailingConclusion(conclusion: string | null): boolean {
  return conclusion === 'failure' || conclusion === 'timed_out';
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

function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50)
    .replace(/-$/, '');
  return slug || 'issue';
}

function truncateDiff(text: string): string {
  if (text.length <= MAX_DIFF_CHARS) return text;
  const head = text.slice(0, MAX_DIFF_CHARS);
  return `... (truncated) ...\n${head}\n... (truncated) ...`;
}

function referencesIssue(body: string, issueNumber: number): boolean {
  const pattern = new RegExp(
    `(?:closes|fixes|resolves)?\\s*#${issueNumber}\\b`,
    'i'
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

export function createGitHubCodeProvider(gh: GhRunner): CodeProvider {
  const resolveLabelNames = createLabelResolver(gh);
  return {
    createBranch: (repo, issueId, branchName, base) =>
      createBranch(gh, repo, issueId, branchName, base),
    createPR: (repo, title, body, head, base, opts) =>
      createPR(gh, repo, title, body, head, base, opts),
    updatePR: (repo, number, opts) =>
      updatePR(gh, repo, number, opts, resolveLabelNames),
    getPR: (repo, number) => getPR(gh, repo, number),
    listPRs: (repo, opts) => listPRs(gh, repo, opts),
    getPRChecks: (repo, number) => getPRChecks(gh, repo, number),
    mergePR: (repo, number, method) => mergePR(gh, repo, number, method),
    getPRDiff: (repo, number) => getPRDiff(gh, repo, number),
    submitPRReview: (repo, number, review) =>
      submitPRReview(gh, repo, number, review),
    addPRComment: (repo, number, body) => addPRComment(gh, repo, number, body),
    listPRComments: (repo, number) => listPRComments(gh, repo, number),
  };
}

async function createBranch(
  gh: GhRunner,
  repo: TrackerRepo,
  issueId: ItemId | null,
  branchName: string,
  base?: string
): Promise<{ name: string }> {
  if (issueId != null) {
    return createLinkedBranch(gh, repo, issueId, branchName, base);
  }
  return createPlainBranch(gh, repo, branchName, base);
}

async function createLinkedBranch(
  gh: GhRunner,
  repo: TrackerRepo,
  issueId: ItemId,
  branchName: string,
  base?: string
): Promise<{ name: string }> {
  const issueNumber = Number(issueId);
  if (Number.isNaN(issueNumber)) {
    throw new UnsupportedError('non-numeric GitHub issue id for linked branch');
  }

  const query = `
    query($owner: String!, $repo: String!, $issueNumber: Int!, $base: String!) {
      repository(owner: $owner, name: $repo) {
        id
        issue(number: $issueNumber) {
          id
          title
          linkedBranches(first: 10) {
            nodes { ref { name target { oid } } }
          }
        }
        defaultBranchRef { target { oid } }
        baseRef: ref(qualifiedName: $base) { target { oid } }
      }
    }`;

  const schema = z.object({
    repository: z.object({
      id: z.string(),
      issue: z.object({
        id: z.string(),
        title: z.string(),
        linkedBranches: z.object({
          nodes: z.array(
            z.object({
              ref: z.object({
                name: z.string(),
                target: z.object({ oid: z.string() }),
              }),
            })
          ),
        }),
      }),
      defaultBranchRef: z.object({ target: z.object({ oid: z.string() }) }),
      baseRef: z
        .object({ target: z.object({ oid: z.string() }) })
        .nullable(),
    }),
  });

  const data = await gh.graphql(
    query,
    {
      owner: repo.owner,
      repo: repo.repo,
      issueNumber,
      base: `refs/heads/${base ?? '__none__'}`,
    },
    schema
  );

  const existing = data.repository.issue.linkedBranches.nodes[0];
  if (existing) {
    return { name: existing.ref.name };
  }

  const nameToUse = branchName.trim() || `${issueId}-${slugify(data.repository.issue.title)}`;
  const oid =
    data.repository.baseRef?.target.oid ??
    data.repository.defaultBranchRef.target.oid;

  const mutation = `
    mutation($issueId: ID!, $repositoryId: ID!, $name: String!, $oid: GitObjectID!) {
      createLinkedBranch(input: { issueId: $issueId, repositoryId: $repositoryId, name: $name, oid: $oid }) {
        linkedBranch { ref { name } }
      }
    }`;

  const mutationSchema = z.object({
    createLinkedBranch: z.object({
      linkedBranch: z.object({ ref: z.object({ name: z.string() }) }),
    }),
  });

  const result = await gh.graphql(
    mutation,
    {
      issueId: data.repository.issue.id,
      repositoryId: data.repository.id,
      name: nameToUse,
      oid,
    },
    mutationSchema
  );

  return {
    name: result.createLinkedBranch.linkedBranch.ref.name,
  };
}

async function createPlainBranch(
  gh: GhRunner,
  repo: TrackerRepo,
  branchName: string,
  base?: string
): Promise<{ name: string }> {
  const query = `
    query($owner: String!, $repo: String!, $branch: String!, $base: String!) {
      repository(owner: $owner, name: $repo) {
        id
        defaultBranchRef { target { oid } }
        baseRef: ref(qualifiedName: $base) { target { oid } }
        ref(qualifiedName: $branch) { target { oid } }
      }
    }`;

  const schema = z.object({
    repository: z.object({
      id: z.string(),
      defaultBranchRef: z.object({ target: z.object({ oid: z.string() }) }),
      baseRef: z
        .object({ target: z.object({ oid: z.string() }) })
        .nullable(),
      ref: z.object({ target: z.object({ oid: z.string() }) }).nullable(),
    }),
  });

  const data = await gh.graphql(
    query,
    {
      owner: repo.owner,
      repo: repo.repo,
      branch: `refs/heads/${branchName}`,
      base: `refs/heads/${base ?? '__none__'}`,
    },
    schema
  );

  if (data.repository.ref) {
    return { name: branchName };
  }

  const oid =
    data.repository.baseRef?.target.oid ??
    data.repository.defaultBranchRef.target.oid;

  const mutation = `
    mutation($repositoryId: ID!, $name: String!, $oid: GitObjectID!) {
      createRef(input: { repositoryId: $repositoryId, name: $name, oid: $oid }) {
        ref { name }
      }
    }`;

  const mutationSchema = z.object({
    createRef: z.object({ ref: z.object({ name: z.string() }) }),
  });

  await gh.graphql(
    mutation,
    {
      repositoryId: data.repository.id,
      name: `refs/heads/${branchName}`,
      oid,
    },
    mutationSchema
  );

  return { name: branchName };
}

async function createPR(
  gh: GhRunner,
  repo: TrackerRepo,
  title: string,
  body: string,
  head: string,
  base: string | undefined,
  opts?: CreatePROptions
): Promise<PR> {
  let baseBranch = base;
  if (!baseBranch) {
    const repoData = await gh.api(
      `/repos/${repoPath(repo)}`,
      z.object({ default_branch: z.string() })
    );
    baseBranch = repoData.default_branch;
  }

  const finalBody = injectClosingLines(body, opts?.issues);
  const raw = await gh.api(
    `/repos/${repoPath(repo)}/pulls`,
    prSchema,
    {
      method: 'POST',
      input: { title, body: finalBody, head, base: baseBranch },
    }
  );

  return mapPR(raw);
}

async function getPR(gh: GhRunner, repo: TrackerRepo, number: number): Promise<PR> {
  const raw = await gh.api(
    `/repos/${repoPath(repo)}/pulls/${number}`,
    prSchema
  );
  return mapPR(raw);
}

async function listPRs(
  gh: GhRunner,
  repo: TrackerRepo,
  opts?: ListPRsOptions
): Promise<PR[]> {
  const state = opts?.state ?? 'open';
  const perPage = opts?.limit ?? 50;
  const raw = await gh.api(
    `/repos/${repoPath(repo)}/pulls?state=${state}&per_page=${perPage}`,
    z.array(prSchema)
  );
  return raw.map(mapPR);
}

async function updatePR(
  gh: GhRunner,
  repo: TrackerRepo,
  number: number,
  opts: UpdatePROptions,
  resolveLabelNames: (
    repo: TrackerRepo,
    labels: string[]
  ) => Promise<string[]>
): Promise<{ pr: PR; warnings: string[] }> {
  const warnings: string[] = [];

  const primaryInput: Record<string, unknown> = {};
  if (opts.title !== undefined) primaryInput.title = opts.title;
  if (opts.body !== undefined) primaryInput.body = opts.body;
  if (opts.state !== undefined) {
    if (opts.state === 'merged') {
      throw new UnsupportedError('cannot change PR state to merged');
    }
    primaryInput.state = opts.state;
  }

  let rawPr: z.infer<typeof prSchema>;
  if (Object.keys(primaryInput).length > 0) {
    rawPr = await gh.api(
      `/repos/${repoPath(repo)}/pulls/${number}`,
      prSchema,
      { method: 'PATCH', input: primaryInput }
    );
  } else {
    rawPr = await gh.api(
      `/repos/${repoPath(repo)}/pulls/${number}`,
      prSchema
    );
  }

  if (opts.draft !== undefined && rawPr.node_id) {
    try {
      await setDraft(gh, rawPr.node_id, opts.draft);
    } catch (err) {
      warnings.push(
        `draft update failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  if (opts.labels !== undefined) {
    try {
      const resolvedLabels = await resolveLabelNames(repo, opts.labels);
      await gh.api(
        `/repos/${repoPath(repo)}/issues/${number}/labels`,
        z.any(),
        { method: 'PUT', input: { labels: resolvedLabels } }
      );
    } catch (err) {
      warnings.push(
        `labels update failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  if (opts.milestone !== undefined) {
    try {
      await setMilestone(gh, repo, number, opts.milestone);
    } catch (err) {
      warnings.push(
        `milestone update failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  if (opts.add_reviewers && opts.add_reviewers.length > 0) {
    try {
      await gh.api(
        `/repos/${repoPath(repo)}/pulls/${number}/requested_reviewers`,
        z.any(),
        { method: 'POST', input: { reviewers: opts.add_reviewers } }
      );
    } catch (err) {
      warnings.push(
        `add reviewers failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  if (opts.remove_reviewers && opts.remove_reviewers.length > 0) {
    try {
      await gh.api(
        `/repos/${repoPath(repo)}/pulls/${number}/requested_reviewers`,
        z.any(),
        { method: 'DELETE', input: { reviewers: opts.remove_reviewers } }
      );
    } catch (err) {
      warnings.push(
        `remove reviewers failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  if (opts.add_assignees && opts.add_assignees.length > 0) {
    try {
      await gh.api(
        `/repos/${repoPath(repo)}/issues/${number}/assignees`,
        z.any(),
        { method: 'POST', input: { assignees: opts.add_assignees } }
      );
    } catch (err) {
      warnings.push(
        `add assignees failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  if (opts.remove_assignees && opts.remove_assignees.length > 0) {
    try {
      await gh.api(
        `/repos/${repoPath(repo)}/issues/${number}/assignees`,
        z.any(),
        { method: 'DELETE', input: { assignees: opts.remove_assignees } }
      );
    } catch (err) {
      warnings.push(
        `remove assignees failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  return { pr: mapPR(rawPr), warnings };
}

async function setDraft(
  gh: GhRunner,
  pullRequestId: string,
  draft: boolean
): Promise<void> {
  if (draft) {
    const mutation = `
      mutation($pullRequestId: ID!) {
        convertPullRequestToDraft(input: { pullRequestId: $pullRequestId }) {
          pullRequest { id }
        }
      }`;
    const schema = z.object({
      convertPullRequestToDraft: z.object({
        pullRequest: z.object({ id: z.string() }),
      }),
    });
    await gh.graphql(mutation, { pullRequestId }, schema);
  } else {
    const mutation = `
      mutation($pullRequestId: ID!) {
        markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) {
          pullRequest { id }
        }
      }`;
    const schema = z.object({
      markPullRequestReadyForReview: z.object({
        pullRequest: z.object({ id: z.string() }),
      }),
    });
    await gh.graphql(mutation, { pullRequestId }, schema);
  }
}

async function setMilestone(
  gh: GhRunner,
  repo: TrackerRepo,
  number: number,
  title: string
): Promise<void> {
  const milestoneNumber = await resolveMilestoneNumber(gh, repo, title);
  await gh.api(
    `/repos/${repoPath(repo)}/issues/${number}`,
    z.any(),
    { method: 'PATCH', input: { milestone: milestoneNumber } }
  );
}

async function getPRChecks(
  gh: GhRunner,
  repo: TrackerRepo,
  number: number
): Promise<CheckRun[]> {
  const pull = await gh.api(
    `/repos/${repoPath(repo)}/pulls/${number}`,
    pullHeadSchema
  );

  const { check_runs } = await gh.api(
    `/repos/${repoPath(repo)}/commits/${pull.head.sha}/check-runs`,
    checkRunsSchema
  );

  return Promise.all(
    check_runs.map(async (run) => {
      let logs: string | null = null;
      if (isFailingConclusion(run.conclusion)) {
        try {
          const raw = await gh.raw([
            'api',
            `/repos/${repoPath(repo)}/actions/jobs/${run.id}/logs`,
          ]);
          logs = tailLog(raw);
        } catch {
          // Logs are best-effort; leave them null on failure.
        }
      }
      return {
        name: run.name,
        status: run.status,
        conclusion: run.conclusion,
        url: run.html_url ?? '',
        logs,
      };
    })
  );
}

async function mergePR(
  gh: GhRunner,
  repo: TrackerRepo,
  number: number,
  method?: 'merge' | 'squash' | 'rebase'
): Promise<void> {
  await gh.api(
    `/repos/${repoPath(repo)}/pulls/${number}/merge`,
    z.any(),
    { method: 'PUT', input: { merge_method: method ?? 'squash' } }
  );
}

async function getPRDiff(
  gh: GhRunner,
  repo: TrackerRepo,
  number: number
): Promise<string> {
  const diff = await gh.raw([
    'pr',
    'diff',
    String(number),
    '--repo',
    repoPath(repo),
  ]);
  return truncateDiff(diff);
}

async function submitPRReview(
  gh: GhRunner,
  repo: TrackerRepo,
  number: number,
  review: PRReview
): Promise<void> {
  const eventMap: Record<PRReview['event'], string> = {
    approve: 'APPROVE',
    request_changes: 'REQUEST_CHANGES',
    comment: 'COMMENT',
  };

  const comments = (review.comments ?? []).map((c) => ({
    path: c.path,
    line: c.line,
    side: 'RIGHT' as const,
    body: c.body,
  }));

  await gh.api(
    `/repos/${repoPath(repo)}/pulls/${number}/reviews`,
    z.any(),
    {
      method: 'POST',
      input: {
        event: eventMap[review.event],
        body: review.body,
        comments,
      },
    }
  );
}

async function addPRComment(
  gh: GhRunner,
  repo: TrackerRepo,
  number: number,
  body: string
): Promise<void> {
  await gh.api(
    `/repos/${repoPath(repo)}/issues/${number}/comments`,
    z.any(),
    { method: 'POST', input: { body } }
  );
}

async function listPRComments(
  gh: GhRunner,
  repo: TrackerRepo,
  number: number
): Promise<Comment[]> {
  const raw = await gh.api(
    `/repos/${repoPath(repo)}/issues/${number}/comments`,
    z.array(commentSchema)
  );
  return raw.map((c) => ({
    id: String(c.id),
    author: c.user?.login ?? '',
    body: c.body,
    createdAt: c.created_at,
  }));
}

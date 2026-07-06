import type { TrackerRepo, PR, CheckRun } from "../../interfaces/types.js";
import { glab, glabApi, projectRef, repoFlag, type RawGitLabMR, type RawGitLabNote } from "./helpers.js";

function mapMR(mr: RawGitLabMR): PR {
  return {
    number: mr.iid,
    title: mr.title,
    body: mr.description ?? "",
    state: mr.state,
    url: mr.web_url,
    headBranch: mr.source_branch,
    baseBranch: mr.target_branch,
  };
}

export async function createPR(repo: TrackerRepo, title: string, body: string, head: string, base?: string): Promise<PR> {
  const ref = projectRef(repo);
  // glab mr create has no --output json; use REST API directly
  const defaultBranch = base ?? glabApi<{ default_branch: string }>(`projects/${ref}`).default_branch;
  const fields = [
    "--raw-field", `title=${title}`,
    "--raw-field", `description=${body}`,
    "--raw-field", `source_branch=${head}`,
    "--raw-field", `target_branch=${defaultBranch}`,
  ];
  return mapMR(glabApi<RawGitLabMR>(`projects/${ref}/merge_requests`, "POST", fields));
}

export async function listPRs(repo: TrackerRepo, opts?: { state?: "open" | "closed" | "all"; limit?: number }): Promise<PR[]> {
  const args = ["mr", "list", "-R", repoFlag(repo), "--output", "json"];
  if (opts?.state === "closed") args.push("--closed");
  else if (opts?.state === "all") args.push("--all");
  if (opts?.limit) args.push("--per-page", String(opts.limit));
  return glab<RawGitLabMR[]>(args).map(mapMR);
}

export async function getPR(repo: TrackerRepo, number: number): Promise<PR> {
  return mapMR(glab<RawGitLabMR>(["mr", "view", String(number), "-R", repoFlag(repo), "--output", "json"]));
}

export async function updatePR(repo: TrackerRepo, number: number, opts: { title?: string; body?: string }): Promise<PR> {
  const ref = projectRef(repo);
  const fields: string[] = [];
  if (opts.title) fields.push("--raw-field", `title=${opts.title}`);
  if (opts.body !== undefined) fields.push("--raw-field", `description=${opts.body}`);
  return mapMR(glabApi<RawGitLabMR>(`projects/${ref}/merge_requests/${number}`, "PUT", fields));
}

export async function mergePR(repo: TrackerRepo, number: number, method?: string): Promise<void> {
  const args = ["mr", "merge", String(number), "-R", repoFlag(repo)];
  if (method === "squash") args.push("--squash");
  else if (method === "rebase") args.push("--rebase");
  glab<unknown>(args);
}

export async function getPRChecks(repo: TrackerRepo, number: number): Promise<CheckRun[]> {
  const ref = projectRef(repo);
  const pipelines = glabApi<Array<{ id: number; status: string; web_url: string }>>(`projects/${ref}/merge_requests/${number}/pipelines`);
  if (!pipelines.length) return [];
  // Get jobs from the latest pipeline
  const latest = pipelines[0];
  const jobs = glabApi<Array<{ name: string; status: string; web_url: string }>>(`projects/${ref}/pipelines/${latest.id}/jobs`);
  return jobs.map((j) => ({
    name: j.name,
    status: j.status === "running" ? "in_progress" : j.status === "pending" ? "queued" : "completed",
    conclusion: j.status === "success" ? "success" : j.status === "failed" ? "failure" : null,
    url: j.web_url,
  }));
}

export async function requestReviewers(repo: TrackerRepo, prNumber: number, reviewers: string[]): Promise<void> {
  const ref = projectRef(repo);
  // Look up user IDs from usernames
  const ids: number[] = [];
  for (const username of reviewers) {
    const users = glabApi<Array<{ id: number }>>(`users?username=${encodeURIComponent(username)}`);
    if (users[0]) ids.push(users[0].id);
  }
  const fields = ids.flatMap((id) => ["--raw-field", `reviewer_ids[]=${id}`]);
  glabApi<unknown>(`projects/${ref}/merge_requests/${prNumber}`, "PUT", fields);
}

export async function addPRComment(repo: TrackerRepo, number: number, body: string): Promise<void> {
  glab<unknown>(["mr", "note", "create", String(number), "-R", repoFlag(repo), "-m", body]);
}

export async function listPRComments(repo: TrackerRepo, number: number): Promise<Array<{ id: number; author: string; body: string; createdAt: string }>> {
  const ref = projectRef(repo);
  const notes = glabApi<RawGitLabNote[]>(`projects/${ref}/merge_requests/${number}/notes`);
  return notes.map((n) => ({ id: n.id, author: n.author.username, body: n.body, createdAt: n.created_at }));
}

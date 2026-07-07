import type { TrackerRepo, PR, CheckRun } from "../../interfaces/types.js";
import { gh, ghRaw, repoFlag, mapPR, type RawPR, type RawCheckRun } from "./helpers.js";

export async function createPR(
  repo: TrackerRepo,
  title: string,
  body: string,
  head: string,
  base?: string
): Promise<PR> {
  let baseBranch = base;
  if (!baseBranch) {
    const repoData = gh<{ default_branch: string }>(["api", `repos/${repoFlag(repo)}`]);
    baseBranch = repoData.default_branch;
  }
  const data = gh<RawPR>(
    ["api", "--method", "POST", `repos/${repoFlag(repo)}/pulls`, "--input", "-"],
    { title, body, head, base: baseBranch }
  );
  return mapPR(data);
}

export async function updatePR(
  repo: TrackerRepo,
  number: number,
  opts: { title?: string; body?: string }
): Promise<PR> {
  const data = gh<RawPR>(
    ["api", "--method", "PATCH", `repos/${repoFlag(repo)}/pulls/${number}`, "--input", "-"],
    opts
  );
  return mapPR(data);
}

export async function getPRChecks(repo: TrackerRepo, number: number): Promise<CheckRun[]> {
  const pr = gh<{ headRefOid: string }>([
    "pr", "view", String(number), "--repo", repoFlag(repo), "--json", "headRefOid",
  ]);
  const checks = gh<{ check_runs: RawCheckRun[] }>([
    "api", `repos/${repoFlag(repo)}/commits/${pr.headRefOid}/check-runs`,
  ]);
  return checks.check_runs.map((r) => {
    const run: CheckRun = {
      name: r.name,
      status: r.status,
      conclusion: r.conclusion ?? null,
      url: r.html_url ?? "",
    };
    if (r.conclusion === "failure" || r.conclusion === "timed_out") {
      const logs = fetchFailedJobLog(repo, r);
      if (logs) run.logs = logs;
    }
    return run;
  });
}

// Fetches the failing steps' log for a check run. Only GitHub Actions checks
// expose a job id (via /job/<id> in their URL); external checks return null.
function fetchFailedJobLog(repo: TrackerRepo, r: RawCheckRun): string | null {
  const jobId = `${r.details_url ?? ""} ${r.html_url ?? ""}`.match(/\/job\/(\d+)/)?.[1];
  if (!jobId) return null;
  const base = ["run", "view", "--repo", repoFlag(repo), "--job", jobId];
  const log = tailLog(ghRaw([...base, "--log-failed"])) || tailLog(ghRaw([...base, "--log"]));
  return log || null;
}

// Keeps the last lines of a log within a bounded size so it stays useful in
// context without dumping a multi-megabyte CI log.
function tailLog(raw: string): string {
  const text = raw.trim();
  if (!text) return "";
  const tail = text.split("\n").slice(-200).join("\n");
  const MAX = 12000;
  return tail.length > MAX ? `... (truncated)\n${tail.slice(-MAX)}` : tail;
}

export async function listPRs(
  repo: TrackerRepo,
  opts?: { state?: "open" | "closed" | "all"; limit?: number }
): Promise<PR[]> {
  return gh<Array<{ number: number; title: string; body: string; state: string; headRefName: string; baseRefName: string; url: string }>>([
    "pr", "list",
    "--repo", repoFlag(repo),
    "--state", opts?.state ?? "open",
    "--limit", String(opts?.limit ?? 50),
    "--json", "number,title,body,state,headRefName,baseRefName,url",
  ]).map((d) => ({ number: d.number, title: d.title, body: d.body ?? "", state: d.state, url: d.url, headBranch: d.headRefName, baseBranch: d.baseRefName }));
}

export async function getPR(repo: TrackerRepo, number: number): Promise<PR> {
  const d = gh<{ number: number; title: string; body: string; state: string; headRefName: string; baseRefName: string; url: string }>([
    "pr", "view", String(number),
    "--repo", repoFlag(repo),
    "--json", "number,title,body,state,headRefName,baseRefName,url",
  ]);
  return { number: d.number, title: d.title, body: d.body ?? "", state: d.state, url: d.url, headBranch: d.headRefName, baseBranch: d.baseRefName };
}

export async function mergePR(
  repo: TrackerRepo,
  number: number,
  method: "merge" | "squash" | "rebase" = "squash"
): Promise<void> {
  gh<unknown>(
    ["api", "--method", "PUT", `repos/${repoFlag(repo)}/pulls/${number}/merge`, "--input", "-"],
    { merge_method: method }
  );
}

export async function requestReviewers(
  repo: TrackerRepo,
  prNumber: number,
  reviewers: string[]
): Promise<void> {
  gh<unknown>(
    ["api", "--method", "POST", `repos/${repoFlag(repo)}/pulls/${prNumber}/requested_reviewers`, "--input", "-"],
    { reviewers }
  );
}

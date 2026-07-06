import type { TrackerRepo, Issue, RelationshipType, CreateIssueOptions, UpdateIssueOptions } from "../../interfaces/types.js";
import type { ListIssuesOptions } from "../../interfaces/issue.js";
import { glab, glabApi, projectRef, repoFlag } from "../gitlab/helpers.js";

interface RawGitLabIssue {
  iid: number;
  title: string;
  description: string | null;
  state: string;
  web_url: string;
  labels: string[];
}

function mapIssue(i: RawGitLabIssue): Issue {
  return { number: i.iid, title: i.title, body: i.description ?? "", state: i.state, url: i.web_url, labels: i.labels };
}

export async function listIssues(repo: TrackerRepo, opts?: ListIssuesOptions): Promise<Issue[]> {
  const args = ["issue", "list", "-R", repoFlag(repo), "--output", "json"];
  if (opts?.state === "closed") args.push("--closed");
  else if (opts?.state === "all") args.push("--all");
  if (opts?.labels?.length) args.push("--label", opts.labels.join(","));
  if (opts?.assignee) args.push("--assignee", opts.assignee);
  if (opts?.limit) args.push("--per-page", String(opts.limit));
  return glab<RawGitLabIssue[]>(args).map(mapIssue);
}

export async function createIssue(repo: TrackerRepo, title: string, body: string, opts?: CreateIssueOptions): Promise<Issue> {
  const ref = projectRef(repo);
  // glab issue create has no --output json; use REST API directly
  const fields = [
    "--raw-field", `title=${title}`,
    "--raw-field", `description=${body}`,
  ];
  if (opts?.labels?.length) fields.push("--raw-field", `labels=${opts.labels.join(",")}`);
  return mapIssue(glabApi<RawGitLabIssue>(`projects/${ref}/issues`, "POST", fields));
}

export async function getIssue(repo: TrackerRepo, number: number): Promise<Issue> {
  return mapIssue(glab<RawGitLabIssue>(["issue", "view", String(number), "-R", repoFlag(repo), "--output", "json"]));
}

export async function updateIssue(repo: TrackerRepo, number: number, opts: UpdateIssueOptions): Promise<Issue> {
  const ref = projectRef(repo);
  const fields: string[] = [];
  if (opts.title !== undefined) fields.push("--raw-field", `title=${opts.title}`);
  if (opts.body !== undefined) fields.push("--raw-field", `description=${opts.body}`);
  if (opts.labels !== undefined) fields.push("--raw-field", `labels=${opts.labels.join(",")}`);
  if (opts.state !== undefined) fields.push("--raw-field", `state_event=${opts.state === "closed" ? "close" : "reopen"}`);
  return mapIssue(glabApi<RawGitLabIssue>(`projects/${ref}/issues/${number}`, "PUT", fields));
}

export async function setIssueStatus(repo: TrackerRepo, issueNumber: number, status: string): Promise<void> {
  const ref = projectRef(repo);
  glabApi<unknown>(`projects/${ref}/issues/${issueNumber}`, "PUT", ["--raw-field", `add_labels=${status}`]);
}

export async function addIssueComment(repo: TrackerRepo, number: number, body: string): Promise<void> {
  // glab issue note has no "create" subcommand; uses -m not -b
  glab<unknown>(["issue", "note", String(number), "-R", repoFlag(repo), "-m", body]);
}

export async function listIssueComments(repo: TrackerRepo, number: number): Promise<Array<{ id: number; author: string; body: string; createdAt: string }>> {
  const ref = projectRef(repo);
  const notes = glabApi<Array<{ id: number; author: { username: string }; body: string; created_at: string }>>(`projects/${ref}/issues/${number}/notes`);
  return notes.map((n) => ({ id: n.id, author: n.author.username, body: n.body, createdAt: n.created_at }));
}

export async function toggleChecklistItem(repo: TrackerRepo, issueNumber: number, itemText: string, checked?: boolean): Promise<{ matched: string; checked: boolean }> {
  const issue = await getIssue(repo, issueNumber);
  const lines = issue.body.split("\n");
  const needle = itemText.toLowerCase();
  let matchedLine: string | null = null;
  let newChecked = false;
  const updated = lines.map((line) => {
    const isUnchecked = /^- \[ \] /i.test(line);
    const isChecked = /^- \[x\] /i.test(line);
    if (!isUnchecked && !isChecked) return line;
    const text = line.replace(/^- \[[x ]\] /i, "").toLowerCase();
    if (!text.includes(needle)) return line;
    matchedLine = line.replace(/^- \[[x ]\] /i, "").trim();
    newChecked = checked !== undefined ? checked : isUnchecked;
    return newChecked ? line.replace(/^- \[ \] /i, "- [x] ") : line.replace(/^- \[x\] /i, "- [ ] ");
  });
  if (!matchedLine) throw new Error(`No checklist item matching "${itemText}" found in issue #${issueNumber}`);
  await updateIssue(repo, issueNumber, { body: updated.join("\n") });
  return { matched: matchedLine, checked: newChecked };
}

const RELATIONSHIP_MAP: Record<string, string> = {
  blocks: "blocks",
  blocked_by: "is_blocked_by",
  related: "relates_to",
  duplicate: "relates_to",
};

export async function setRelationship(repo: TrackerRepo, issueNumber: number, type: RelationshipType, targetNumber: number): Promise<void> {
  const ref = projectRef(repo);
  const project = glabApi<{ id: number }>(`projects/${ref}`);
  glabApi<unknown>(`projects/${ref}/issues/${issueNumber}/links`, "POST", [
    "--raw-field", `target_project_id=${project.id}`,
    "--raw-field", `target_issue_iid=${targetNumber}`,
    "--raw-field", `link_type=${RELATIONSHIP_MAP[type] ?? "relates_to"}`,
  ]);
}

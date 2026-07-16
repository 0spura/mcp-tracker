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
  if (opts?.assignees?.length) fields.push("--raw-field", `assignee_ids=${opts.assignees.join(",")}`);
  if (opts?.milestone) {
    const milestoneId = resolveMilestoneId(ref, opts.milestone);
    if (milestoneId) fields.push("--raw-field", `milestone_id=${milestoneId}`);
  }
  return mapIssue(glabApi<RawGitLabIssue>(`projects/${ref}/issues`, "POST", fields));
}

function resolveMilestoneId(projectRef: string, milestoneTitle: string): number | null {
  const params = new URLSearchParams({ include_ancestors: "true", search: milestoneTitle });
  const milestones = glabApi<Array<{ id: number; title: string }>>(`projects/${projectRef}/milestones?${params}`);
  const exact = milestones.find((m) => m.title === milestoneTitle);
  return exact?.id ?? milestones[0]?.id ?? null;
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

// Status labels are mutually exclusive — setting one removes the others.
const STATUS_LABELS = ["⌛ todo", "🏃 doing", "✌ done", "🥺 waiting"];

export async function setIssueStatus(repo: TrackerRepo, issueNumber: number, status: string): Promise<void> {
  const ref = projectRef(repo);
  const toRemove = STATUS_LABELS.filter((l) => l !== status);
  const fields = ["--raw-field", `add_labels=${status}`];
  if (toRemove.length) fields.push("--raw-field", `remove_labels=${toRemove.join(",")}`);
  glabApi<unknown>(`projects/${ref}/issues/${issueNumber}`, "PUT", fields);
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

// GitLab CE only supports "relates_to"; blocks/is_blocked_by require Premium.
const RELATIONSHIP_MAP: Record<string, string> = {
  blocks: "relates_to",
  blocked_by: "relates_to",
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

export async function addSubIssue(repo: TrackerRepo, parentNumber: number, childNumber: number): Promise<void> {
  const fullPath = repoFlag(repo);
  // Resolve work item GIDs via GraphQL
  const query = `query { project(fullPath: "${fullPath}") { workItems(iids: ["${parentNumber}", "${childNumber}"]) { nodes { id iid: title } } } }`;
  const result = glab<{ data: { project: { workItems: { nodes: Array<{ id: string; iid: string }> } } } }>(["api", "graphql", "--raw-field", `query=${query}`]);
  
  // Use the issues API to get work item IDs by iid
  const parentGid = resolveWorkItemGid(fullPath, parentNumber);
  const childGid = resolveWorkItemGid(fullPath, childNumber);

  // Set parent via mutation
  const mutation = `mutation { workItemUpdate(input: { id: "${childGid}", hierarchyWidget: { parentId: "${parentGid}" } }) { workItem { id } errors } }`;
  const mutResult = glab<{ data: { workItemUpdate: { errors: string[] } } }>(["api", "graphql", "--raw-field", `query=${mutation}`]);
  const errors = mutResult?.data?.workItemUpdate?.errors;
  if (errors?.length) throw new Error(`Failed to set parent: ${errors.join(", ")}`);
}

function resolveWorkItemGid(fullPath: string, iid: number): string {
  const query = `query { project(fullPath: "${fullPath}") { workItems(iids: ["${iid}"]) { nodes { id } } } }`;
  const result = glab<{ data: { project: { workItems: { nodes: Array<{ id: string }> } } } }>(["api", "graphql", "--raw-field", `query=${query}`]);
  const nodes = result?.data?.project?.workItems?.nodes;
  if (!nodes?.length) throw new Error(`Work item #${iid} not found in ${fullPath}`);
  return nodes[0].id;
}

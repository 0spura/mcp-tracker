import type { TrackerRepo, Issue, RelationshipType, CreateIssueOptions, UpdateIssueOptions } from "../../interfaces/types.js";
import type { ListIssuesOptions } from "../../interfaces/issue.js";
import {
  ensureDir, findFilePath, listFilePaths, nextId,
  issueFilePath, readFile, writeFile, toIssue,
  type LocalMeta,
} from "./helpers.js";

export async function listIssues(_repo: TrackerRepo, opts?: ListIssuesOptions): Promise<Issue[]> {
  const dir = ensureDir();
  const issues: Issue[] = [];
  for (const fp of listFilePaths(dir)) {
    const { meta, body } = readFile(fp);
    const state = meta.status === "closed" ? "closed" : "open";
    if (opts?.state && opts.state !== "all" && state !== opts.state) continue;
    if (opts?.labels?.length && !opts.labels.every(l => meta.labels.includes(l))) continue;
    if (opts?.assignee && !meta.assignees.includes(opts.assignee)) continue;
    issues.push(toIssue(meta, body, fp));
  }
  return opts?.limit ? issues.slice(0, opts.limit) : issues;
}

export async function createIssue(
  _repo: TrackerRepo,
  title: string,
  body: string,
  opts?: CreateIssueOptions
): Promise<Issue> {
  const dir = ensureDir();
  const id = nextId(dir);
  const now = new Date().toISOString();
  const meta = {
    id,
    title,
    status: "open",
    labels: opts?.labels ?? [],
    assignees: opts?.assignees ?? [],
    milestone: opts?.milestone ?? null,
    blocks: [] as number[],
    blocked_by: [] as number[],
    related: [] as number[],
    duplicate_of: null as number | null,
    created_at: now,
    updated_at: now,
  };
  const fp = issueFilePath(dir, id, title);
  writeFile(fp, meta, body, []);
  return toIssue(meta, body, fp);
}

export async function getIssue(_repo: TrackerRepo, number: number): Promise<Issue> {
  const dir = ensureDir();
  const fp = findFilePath(dir, number);
  if (!fp) throw new Error(`Issue #${number} not found in ${dir}`);
  const { meta, body } = readFile(fp);
  return toIssue(meta, body, fp);
}

export async function updateIssue(
  _repo: TrackerRepo,
  number: number,
  opts: UpdateIssueOptions
): Promise<Issue> {
  const dir = ensureDir();
  const fp = findFilePath(dir, number);
  if (!fp) throw new Error(`Issue #${number} not found`);
  const { meta, body: currentBody, comments } = readFile(fp);

  if (opts.title !== undefined) meta.title = opts.title;
  if (opts.labels !== undefined) meta.labels = opts.labels;
  if (opts.assignees !== undefined) meta.assignees = opts.assignees;
  if (opts.state !== undefined) meta.status = opts.state;
  meta.updated_at = new Date().toISOString();

  const newBody = opts.body !== undefined ? opts.body : currentBody;
  writeFile(fp, meta, newBody, comments);
  return toIssue(meta, newBody, fp);
}

export async function setIssueStatus(_repo: TrackerRepo, issueNumber: number, status: string): Promise<void> {
  const dir = ensureDir();
  const fp = findFilePath(dir, issueNumber);
  if (!fp) throw new Error(`Issue #${issueNumber} not found`);
  const { meta, body, comments } = readFile(fp);
  meta.status = status.toLowerCase() === "done" || status.toLowerCase() === "closed" ? "closed" : status;
  meta.updated_at = new Date().toISOString();
  writeFile(fp, meta, body, comments);
}

export async function addIssueComment(
  _repo: TrackerRepo,
  number: number,
  body: string
): Promise<void> {
  const dir = ensureDir();
  const fp = findFilePath(dir, number);
  if (!fp) throw new Error(`Issue #${number} not found`);
  const { meta, body: issueBody, comments } = readFile(fp);
  const nextCommentId = comments.length ? Math.max(...comments.map(c => c.id)) + 1 : 1;
  comments.push({ id: nextCommentId, author: "local", body, createdAt: new Date().toISOString() });
  writeFile(fp, meta, issueBody, comments);
}

export async function listIssueComments(
  _repo: TrackerRepo,
  number: number
): Promise<Array<{ id: number; author: string; body: string; createdAt: string }>> {
  const dir = ensureDir();
  const fp = findFilePath(dir, number);
  if (!fp) throw new Error(`Issue #${number} not found`);
  const { comments } = readFile(fp);
  return comments;
}

export async function toggleChecklistItem(
  repo: TrackerRepo,
  issueNumber: number,
  itemText: string,
  checked?: boolean
): Promise<{ matched: string; checked: boolean }> {
  const issue = await getIssue(repo, issueNumber);
  const lines = issue.body.split("\n");
  const needle = itemText.toLowerCase();
  let matchedLine: string | null = null;
  let newChecked = false;

  const updated = lines.map(line => {
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

const RELATIONSHIP_FIELD: Record<RelationshipType, "blocks" | "blocked_by" | "related" | "duplicate_of"> = {
  blocks: "blocks",
  blocked_by: "blocked_by",
  related: "related",
  duplicate: "duplicate_of",
};

export async function setRelationship(
  _repo: TrackerRepo,
  issueNumber: number,
  type: RelationshipType,
  targetNumber: number
): Promise<void> {
  const dir = ensureDir();

  const updateSide = (id: number, field: keyof LocalMeta, value: number) => {
    const fp = findFilePath(dir, id);
    if (!fp) return;
    const { meta, body, comments } = readFile(fp);
    if (field === "duplicate_of") {
      meta.duplicate_of = value;
    } else {
      const arr = meta[field] as number[];
      if (!arr.includes(value)) arr.push(value);
    }
    meta.updated_at = new Date().toISOString();
    writeFile(fp, meta, body, comments);
  };

  const field = RELATIONSHIP_FIELD[type];
  updateSide(issueNumber, field, targetNumber);

  // mirror the relationship on the target
  if (type === "blocks") updateSide(targetNumber, "blocked_by", issueNumber);
  else if (type === "blocked_by") updateSide(targetNumber, "blocks", issueNumber);
  else if (type === "related") updateSide(targetNumber, "related", issueNumber);
}

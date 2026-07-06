import type { TrackerRepo } from "../../interfaces/types.js";
import { gh, repoFlag } from "../github/helpers.js";
import { getIssue, updateIssue } from "./issues.js";

export async function addIssueComment(repo: TrackerRepo, number: number, body: string): Promise<void> {
  gh<unknown>(["issue", "comment", String(number), "--repo", repoFlag(repo), "--body", body]);
}

export async function listIssueComments(
  repo: TrackerRepo,
  number: number
): Promise<Array<{ id: number; author: string; body: string; createdAt: string }>> {
  const raw = gh<Array<{ id: number; user: { login: string }; body: string; created_at: string }>>(
    ["api", `repos/${repoFlag(repo)}/issues/${number}/comments`]
  );
  return raw.map((c) => ({ id: c.id, author: c.user.login, body: c.body, createdAt: c.created_at }));
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

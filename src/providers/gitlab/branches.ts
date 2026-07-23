import type { TrackerRepo } from "../../interfaces/types.js";
import { glabApi, projectRef } from "./helpers.js";

interface RawGitLabProject {
  default_branch: string;
  issue_branch_template: string | null;
}

export async function createBranch(repo: TrackerRepo, issueNumber: number | null, branchName: string, base?: string): Promise<{ name: string }> {
  const ref = projectRef(repo);
  const project = glabApi<RawGitLabProject>(`projects/${ref}`);
  const baseBranch = base ?? project.default_branch;
  const baseBranchInfo = glabApi<{ commit: { id: string } }>(`projects/${ref}/repository/branches/${encodeURIComponent(baseBranch)}`);
  const sha = baseBranchInfo.commit.id;

  // GitLab only shows a branch as "related" on an issue's sidebar (Issues::RelatedBranchesService)
  // when its name matches the project's issue_branch_template, or "<iid>-<slug>" if unset. A branch
  // named e.g. "feat/42-x" would create fine but never surface as linked, so the requested name is
  // overridden here to match what GitLab itself expects.
  const resolvedName = issueNumber != null
    ? resolveIssueBranchName(ref, issueNumber, project.issue_branch_template)
    : branchName;

  // idempotent — return early if branch already exists
  try {
    glabApi<unknown>(`projects/${ref}/repository/branches/${encodeURIComponent(resolvedName)}`);
    return { name: resolvedName };
  } catch {
    // does not exist, continue
  }

  glabApi<unknown>(`projects/${ref}/repository/branches`, "POST", [
    "--raw-field", `branch=${resolvedName}`,
    "--raw-field", `ref=${sha}`,
  ]);

  return { name: resolvedName };
}

function resolveIssueBranchName(ref: string, issueNumber: number, template: string | null): string {
  const issue = glabApi<{ title: string }>(`projects/${ref}/issues/${issueNumber}`);
  const slug = slugify(issue.title);
  if (template) {
    return template.replace(/%\{id\}/g, String(issueNumber)).replace(/%\{title\}/g, slug);
  }
  return `${issueNumber}-${slug}`;
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

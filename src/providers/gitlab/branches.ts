import type { TrackerRepo } from "../../interfaces/types.js";
import { glabApi, projectRef } from "./helpers.js";

export async function createBranch(repo: TrackerRepo, issueNumber: number | null, branchName: string): Promise<{ name: string }> {
  const ref = projectRef(repo);
  const project = glabApi<{ default_branch: string }>(`projects/${ref}`);
  const defaultBranchInfo = glabApi<{ commit: { id: string } }>(`projects/${ref}/repository/branches/${encodeURIComponent(project.default_branch)}`);
  const sha = defaultBranchInfo.commit.id;

  // idempotent — return early if branch already exists
  try {
    glabApi<unknown>(`projects/${ref}/repository/branches/${encodeURIComponent(branchName)}`);
    return { name: branchName };
  } catch {
    // does not exist, continue
  }

  glabApi<unknown>(`projects/${ref}/repository/branches`, "POST", [
    "--raw-field", `branch=${branchName}`,
    "--raw-field", `ref=${sha}`,
  ]);

  if (issueNumber != null) {
    glabApi<unknown>(`projects/${ref}/issues/${issueNumber}/notes`, "POST", [
      "--raw-field", `body=Branch \`${branchName}\` created for this issue.`,
    ]);
  }

  return { name: branchName };
}

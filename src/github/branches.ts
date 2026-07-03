import type { TrackerRepo } from "../types.js";
import { graphql } from "./helpers.js";

// Creates a branch and links it to the issue.
// If the branch already exists, links it; if not, creates it off the default branch.
export async function createBranch(
  repo: TrackerRepo,
  issueNumber: number,
  branchName: string
): Promise<{ name: string }> {
  const data = graphql<{
    repository: {
      id: string;
      issue: { id: string };
      defaultBranchRef: { target: { oid: string } };
      ref: { target: { oid: string } } | null;
    };
  }>(
    `query($owner: String!, $repo: String!, $branch: String!) {
      repository(owner: $owner, name: $repo) {
        id
        issue(number: ${issueNumber}) { id }
        defaultBranchRef { target { oid } }
        ref(qualifiedName: $branch) { target { oid } }
      }
    }`,
    { owner: repo.owner, repo: repo.repo, branch: `refs/heads/${branchName}` }
  );

  const oid = data.repository.ref?.target.oid ?? data.repository.defaultBranchRef.target.oid;

  graphql(
    `mutation($issueId: ID!, $repoId: ID!, $name: String!, $oid: GitObjectID!) {
      createLinkedBranch(input: { issueId: $issueId repositoryId: $repoId name: $name oid: $oid }) {
        linkedBranch { ref { name } }
      }
    }`,
    { issueId: data.repository.issue.id, repoId: data.repository.id, name: branchName, oid }
  );

  return { name: branchName };
}

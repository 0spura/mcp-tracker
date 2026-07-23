import type { TrackerRepo } from "../../interfaces/types.js";
import { graphql } from "./helpers.js";

export async function createBranch(
  repo: TrackerRepo,
  issueNumber: number | null,
  branchName: string,
  base?: string
): Promise<{ name: string }> {
  if (issueNumber != null) {
    return createLinkedBranch(repo, issueNumber, branchName, base);
  }
  return createPlainBranch(repo, branchName, base);
}

async function createLinkedBranch(
  repo: TrackerRepo,
  issueNumber: number,
  branchName: string,
  base?: string
): Promise<{ name: string }> {
  const data = graphql<{
    repository: {
      id: string;
      issue: { id: string };
      defaultBranchRef: { target: { oid: string } };
      baseRef: { target: { oid: string } } | null;
      ref: { target: { oid: string } } | null;
    };
  }>(
    `query($owner: String!, $repo: String!, $branch: String!, $base: String!) {
      repository(owner: $owner, name: $repo) {
        id
        issue(number: ${issueNumber}) { id }
        defaultBranchRef { target { oid } }
        baseRef: ref(qualifiedName: $base) { target { oid } }
        ref(qualifiedName: $branch) { target { oid } }
      }
    }`,
    { owner: repo.owner, repo: repo.repo, branch: `refs/heads/${branchName}`, base: `refs/heads/${base ?? ""}` }
  );

  const oid = data.repository.ref?.target.oid ?? data.repository.baseRef?.target.oid ?? data.repository.defaultBranchRef.target.oid;

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

async function createPlainBranch(
  repo: TrackerRepo,
  branchName: string,
  base?: string
): Promise<{ name: string }> {
  const data = graphql<{
    repository: {
      id: string;
      defaultBranchRef: { target: { oid: string } };
      baseRef: { target: { oid: string } } | null;
      ref: { target: { oid: string } } | null;
    };
  }>(
    `query($owner: String!, $repo: String!, $branch: String!, $base: String!) {
      repository(owner: $owner, name: $repo) {
        id
        defaultBranchRef { target { oid } }
        baseRef: ref(qualifiedName: $base) { target { oid } }
        ref(qualifiedName: $branch) { target { oid } }
      }
    }`,
    { owner: repo.owner, repo: repo.repo, branch: `refs/heads/${branchName}`, base: `refs/heads/${base ?? ""}` }
  );

  if (data.repository.ref) {
    return { name: branchName };
  }

  const oid = data.repository.baseRef?.target.oid ?? data.repository.defaultBranchRef.target.oid;

  graphql(
    `mutation($repoId: ID!, $name: String!, $oid: GitObjectID!) {
      createRef(input: { repositoryId: $repoId name: $name oid: $oid }) {
        ref { name }
      }
    }`,
    { repoId: data.repository.id, name: `refs/heads/${branchName}`, oid }
  );

  return { name: branchName };
}

import type { TrackerRepo, Label, Milestone, RelationshipType } from "../types.js";
import { gh, graphql, repoFlag } from "./helpers.js";

const RELATIONSHIP_TYPE_MAP: Record<RelationshipType, string> = {
  blocks: "BLOCKS",
  blocked_by: "BLOCKED_BY",
  related: "RELATED_TO",
  duplicate: "DUPLICATES",
};

export async function listLabels(repo: TrackerRepo): Promise<Label[]> {
  return gh<Array<{ name: string; color: string; description: string }>>(
    ["label", "list", "--repo", repoFlag(repo), "--json", "name,color,description"]
  ).map((l) => ({ name: l.name, color: l.color, description: l.description ?? "" }));
}

export async function listMilestones(
  repo: TrackerRepo,
  state?: "open" | "closed" | "all"
): Promise<Milestone[]> {
  return gh<Array<{ number: number; title: string; state: string; due_on: string | null }>>(
    ["api", `repos/${repoFlag(repo)}/milestones`, "--method", "GET", "-f", `state=${state ?? "open"}`]
  ).map((m) => ({ number: m.number, title: m.title, state: m.state, dueOn: m.due_on }));
}

export async function setRelationship(
  repo: TrackerRepo,
  issueNumber: number,
  type: RelationshipType,
  targetNumber: number
): Promise<void> {
  const data = graphql<{ repository: { source: { id: string }; target: { id: string } } }>(
    `query($owner: String!, $repo: String!) {
      repository(owner: $owner, name: $repo) {
        source: issue(number: ${issueNumber}) { id }
        target: issue(number: ${targetNumber}) { id }
      }
    }`,
    { owner: repo.owner, repo: repo.repo }
  );

  graphql(
    `mutation($sourceId: ID!, $targetId: ID!, $type: IssueRelationshipType!) {
      addIssueRelationship(input: { itemId: $sourceId relatedItemId: $targetId relationshipType: $type }) {
        relationship { relationshipType }
      }
    }`,
    { sourceId: data.repository.source.id, targetId: data.repository.target.id, type: RELATIONSHIP_TYPE_MAP[type] }
  );
}

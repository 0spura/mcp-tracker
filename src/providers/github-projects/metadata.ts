import type { TrackerRepo, Label, Milestone, RelationshipType } from "../../interfaces/types.js";
import { gh, repoFlag } from "../github/helpers.js";
import { addIssueComment } from "./comments.js";

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

// GitHub has no generic "relationship" API — `addIssueRelationship` /
// `IssueRelationshipType` (the old approach here) don't exist in either the
// REST or GraphQL schema and always 400'd. What actually exists (REST,
// GA as of 2025-08) is the issue-dependencies API, which only models
// "blocked_by" / its inverse "blocking" view — no "related" or "duplicate"
// relationship type. `POST .../dependencies/blocked_by` takes the numeric
// database `issue_id` of the blocking issue, not its issue number, and must
// be sent as a JSON integer (a string body 422s).
async function issueDbId(repo: TrackerRepo, number: number): Promise<number> {
  return gh<{ id: number }>(["api", `repos/${repoFlag(repo)}/issues/${number}`]).id;
}

async function addBlockedBy(repo: TrackerRepo, blockedNumber: number, blockerId: number): Promise<void> {
  gh<unknown>([
    "api", "--method", "POST",
    `repos/${repoFlag(repo)}/issues/${blockedNumber}/dependencies/blocked_by`,
    "-F", `issue_id=${blockerId}`,
  ]);
}

export async function setRelationship(
  repo: TrackerRepo,
  issueNumber: number,
  type: RelationshipType,
  targetNumber: number
): Promise<void> {
  switch (type) {
    case "blocked_by": {
      const targetId = await issueDbId(repo, targetNumber);
      await addBlockedBy(repo, issueNumber, targetId);
      return;
    }
    case "blocks": {
      // issueNumber blocks targetNumber === targetNumber is blocked_by issueNumber.
      const sourceId = await issueDbId(repo, issueNumber);
      await addBlockedBy(repo, targetNumber, sourceId);
      return;
    }
    case "related":
    case "duplicate": {
      // No native relationship for these — GitHub's own UI links them via a
      // plain cross-referencing comment (`#N` auto-links), so do the same
      // instead of failing the whole operation.
      const label = type === "duplicate" ? "Duplicate of" : "Related";
      await addIssueComment(repo, issueNumber, `${label}: #${targetNumber}`);
      return;
    }
  }
}

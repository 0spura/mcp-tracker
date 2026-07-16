import type { TrackerRepo, Label, Milestone } from "../../interfaces/types.js";
import { glab, glabApi, projectRef, repoFlag } from "../gitlab/helpers.js";

export async function listLabels(repo: TrackerRepo): Promise<Label[]> {
  const raw = glab<Array<{ name: string; color: string; description: string | null }>>(
    ["label", "list", "-R", repoFlag(repo), "--output", "json"]
  );
  return raw.map((l) => ({ name: l.name, color: l.color, description: l.description ?? "" }));
}

export async function listMilestones(repo: TrackerRepo, state?: "open" | "closed" | "all"): Promise<Milestone[]> {
  const ref = projectRef(repo);
  const params = new URLSearchParams({ include_ancestors: "true" });
  if (state) params.set("state", state);
  const raw = glabApi<Array<{ id: number; title: string; state: string; due_date: string | null }>>(
    `projects/${ref}/milestones?${params}`
  );
  return raw.map((m) => ({ number: m.id, title: m.title, state: m.state, dueOn: m.due_date }));
}

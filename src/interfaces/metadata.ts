import type { TrackerRepo, Label, Milestone } from "./types.js";

export interface MetadataProvider {
  listLabels(repo: TrackerRepo): Promise<Label[]>;
  listMilestones(repo: TrackerRepo, state?: "open" | "closed" | "all"): Promise<Milestone[]>;
}

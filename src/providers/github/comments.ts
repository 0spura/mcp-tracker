import type { TrackerRepo } from "../../interfaces/types.js";
import { gh, repoFlag } from "./helpers.js";

export async function addPRComment(repo: TrackerRepo, number: number, body: string): Promise<void> {
  gh<unknown>(["pr", "comment", String(number), "--repo", repoFlag(repo), "--body", body]);
}

export async function listPRComments(
  repo: TrackerRepo,
  number: number
): Promise<Array<{ id: number; author: string; body: string; createdAt: string }>> {
  // GitHub uses the same issues endpoint for PR timeline comments
  const raw = gh<Array<{ id: number; user: { login: string }; body: string; created_at: string }>>(
    ["api", `repos/${repoFlag(repo)}/issues/${number}/comments`]
  );
  return raw.map((c) => ({ id: c.id, author: c.user.login, body: c.body, createdAt: c.created_at }));
}

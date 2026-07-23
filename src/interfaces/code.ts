import type { TrackerRepo, PR, CheckRun } from "./types.js";

export interface CodeProvider {
  createBranch(repo: TrackerRepo, issueNumber: number | null, branchName: string, base?: string): Promise<{ name: string }>;
  createPR(repo: TrackerRepo, title: string, body: string, head: string, base?: string): Promise<PR>;
  updatePR(repo: TrackerRepo, number: number, opts: { title?: string; body?: string }): Promise<PR>;
  getPRChecks(repo: TrackerRepo, number: number): Promise<CheckRun[]>;
  listPRs(repo: TrackerRepo, opts?: { state?: "open" | "closed" | "all"; limit?: number }): Promise<PR[]>;
  getPR(repo: TrackerRepo, number: number): Promise<PR>;
  mergePR(repo: TrackerRepo, number: number, method?: string): Promise<void>;
  requestReviewers(repo: TrackerRepo, prNumber: number, reviewers: string[]): Promise<void>;
  addPRComment(repo: TrackerRepo, number: number, body: string): Promise<void>;
  listPRComments(repo: TrackerRepo, number: number): Promise<Array<{ id: number; author: string; body: string; createdAt: string }>>;
}

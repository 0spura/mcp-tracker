import type { CodeProvider } from "../../interfaces/code.js";
import type { TrackerRepo, PR, CheckRun } from "../../interfaces/types.js";
import { createBranch } from "./branches.js";
import { createPR, updatePR, getPRChecks, listPRs, getPR, mergePR, requestReviewers } from "./prs.js";
import { addPRComment, listPRComments } from "./comments.js";

export class GitHubCodeProvider implements CodeProvider {
  createBranch(repo: TrackerRepo, issueNumber: number | null, branchName: string) { return createBranch(repo, issueNumber, branchName); }
  createPR(repo: TrackerRepo, title: string, body: string, head: string, base?: string) { return createPR(repo, title, body, head, base); }
  updatePR(repo: TrackerRepo, number: number, opts: { title?: string; body?: string }) { return updatePR(repo, number, opts); }
  getPRChecks(repo: TrackerRepo, number: number) { return getPRChecks(repo, number); }
  listPRs(repo: TrackerRepo, opts?: { state?: "open" | "closed" | "all"; limit?: number }) { return listPRs(repo, opts); }
  getPR(repo: TrackerRepo, number: number) { return getPR(repo, number); }
  mergePR(repo: TrackerRepo, number: number, method?: string) { return mergePR(repo, number, method as "merge" | "squash" | "rebase"); }
  requestReviewers(repo: TrackerRepo, prNumber: number, reviewers: string[]) { return requestReviewers(repo, prNumber, reviewers); }
  addPRComment(repo: TrackerRepo, number: number, body: string) { return addPRComment(repo, number, body); }
  listPRComments(repo: TrackerRepo, number: number) { return listPRComments(repo, number); }
}

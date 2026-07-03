import type { TrackerProvider, ListIssuesOptions } from "../provider.js";
import type { TrackerRepo, Issue, PR, CheckRun, RelationshipType, Label, Milestone, ProjectItem, ProjectField, CreateIssueOptions, UpdateIssueOptions } from "../types.js";
import { listIssues, createIssue, getIssue, updateIssue, setIssueStatus, addSubIssue, listSubIssues } from "./issues.js";
import { createBranch } from "./branches.js";
import { createPR, updatePR, getPRChecks, listPRs, getPR, mergePR, requestReviewers } from "./prs.js";
import { addIssueComment, addPRComment, listComments, toggleChecklistItem } from "./comments.js";
import { listBoardItems, listBoardFields, addIssueToBoard, setItemFields } from "./board.js";
import { listLabels, listMilestones, setRelationship } from "./metadata.js";

export class GitHubProvider implements TrackerProvider {
  listIssues(repo: TrackerRepo, opts?: ListIssuesOptions): Promise<Issue[]> { return listIssues(repo, opts); }
  createIssue(repo: TrackerRepo, title: string, body: string, opts?: CreateIssueOptions): Promise<Issue> { return createIssue(repo, title, body, opts); }
  getIssue(repo: TrackerRepo, number: number): Promise<Issue> { return getIssue(repo, number); }
  updateIssue(repo: TrackerRepo, number: number, opts: UpdateIssueOptions): Promise<Issue> { return updateIssue(repo, number, opts); }
  setIssueStatus(repo: TrackerRepo, issueNumber: number, status: string): Promise<void> { return setIssueStatus(repo, issueNumber, status); }

  createBranch(repo: TrackerRepo, issueNumber: number, branchName: string): Promise<{ name: string }> { return createBranch(repo, issueNumber, branchName); }

  createPR(repo: TrackerRepo, title: string, body: string, head: string, base?: string): Promise<PR> { return createPR(repo, title, body, head, base); }
  updatePR(repo: TrackerRepo, number: number, opts: { title?: string; body?: string }): Promise<PR> { return updatePR(repo, number, opts); }
  getPRChecks(repo: TrackerRepo, number: number): Promise<CheckRun[]> { return getPRChecks(repo, number); }
  listPRs(repo: TrackerRepo, opts?: { state?: "open" | "closed" | "all"; limit?: number }): Promise<PR[]> { return listPRs(repo, opts); }
  getPR(repo: TrackerRepo, number: number): Promise<PR> { return getPR(repo, number); }
  mergePR(repo: TrackerRepo, number: number, method?: "merge" | "squash" | "rebase"): Promise<void> { return mergePR(repo, number, method); }
  requestReviewers(repo: TrackerRepo, prNumber: number, reviewers: string[]): Promise<void> { return requestReviewers(repo, prNumber, reviewers); }

  addIssueComment(repo: TrackerRepo, number: number, body: string): Promise<void> { return addIssueComment(repo, number, body); }
  addPRComment(repo: TrackerRepo, number: number, body: string): Promise<void> { return addPRComment(repo, number, body); }
  listComments(repo: TrackerRepo, type: "issue" | "pr", number: number): Promise<Array<{ id: number; author: string; body: string; createdAt: string }>> { return listComments(repo, type, number); }
  toggleChecklistItem(repo: TrackerRepo, issueNumber: number, itemText: string, checked?: boolean): Promise<{ matched: string; checked: boolean }> { return toggleChecklistItem(repo, issueNumber, itemText, checked); }

  addSubIssue(repo: TrackerRepo, parentNumber: number, childNumber: number): Promise<void> { return addSubIssue(repo, parentNumber, childNumber); }
  listSubIssues(repo: TrackerRepo, parentNumber: number): Promise<Issue[]> { return listSubIssues(repo, parentNumber); }
  setRelationship(repo: TrackerRepo, issueNumber: number, type: RelationshipType, targetNumber: number): Promise<void> { return setRelationship(repo, issueNumber, type, targetNumber); }

  listLabels(repo: TrackerRepo): Promise<Label[]> { return listLabels(repo); }
  listMilestones(repo: TrackerRepo, state?: "open" | "closed" | "all"): Promise<Milestone[]> { return listMilestones(repo, state); }

  listBoardItems(repo: TrackerRepo, boardId: string): Promise<ProjectItem[]> { return listBoardItems(repo, boardId); }
  listBoardFields(repo: TrackerRepo, boardId: string): Promise<ProjectField[]> { return listBoardFields(repo, boardId); }
  addIssueToBoard(repo: TrackerRepo, issueNumber: number, boardId: string): Promise<string> { return addIssueToBoard(repo, issueNumber, boardId); }
  setItemFields(repo: TrackerRepo, boardId: string, itemId: string, fields: Record<string, string>): Promise<void> { return setItemFields(repo, boardId, itemId, fields); }
}

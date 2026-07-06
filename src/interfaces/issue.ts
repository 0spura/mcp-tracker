import type { TrackerRepo, Issue, RelationshipType, CreateIssueOptions, UpdateIssueOptions } from "./types.js";

export interface ListIssuesOptions {
  state?: "open" | "closed" | "all";
  labels?: string[];
  assignee?: string;
  limit?: number;
}

export interface IssueProvider {
  listIssues(repo: TrackerRepo, opts?: ListIssuesOptions): Promise<Issue[]>;
  createIssue(repo: TrackerRepo, title: string, body: string, opts?: CreateIssueOptions): Promise<Issue>;
  getIssue(repo: TrackerRepo, number: number): Promise<Issue>;
  updateIssue(repo: TrackerRepo, number: number, opts: UpdateIssueOptions): Promise<Issue>;
  setIssueStatus(repo: TrackerRepo, issueNumber: number, status: string): Promise<void>;
  addIssueComment(repo: TrackerRepo, number: number, body: string): Promise<void>;
  listIssueComments(repo: TrackerRepo, number: number): Promise<Array<{ id: number; author: string; body: string; createdAt: string }>>;
  // Optional sub-capabilities — not all providers support these
  addSubIssue?(repo: TrackerRepo, parentNumber: number, childNumber: number): Promise<void>;
  listSubIssues?(repo: TrackerRepo, parentNumber: number): Promise<Issue[]>;
  toggleChecklistItem?(repo: TrackerRepo, issueNumber: number, itemText: string, checked?: boolean): Promise<{ matched: string; checked: boolean }>;
  setRelationship?(repo: TrackerRepo, issueNumber: number, type: RelationshipType, targetNumber: number): Promise<void>;
}

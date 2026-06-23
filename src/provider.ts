import type {
  TrackerRepo,
  Issue,
  PR,
  CheckRun,
  RelationshipType,
  Label,
  Milestone,
  ProjectItem,
  ProjectField,
  CreateIssueOptions,
  UpdateIssueOptions,
} from "./types.js";

export interface ListIssuesOptions {
  state?: "open" | "closed" | "all";
  labels?: string[];
  assignee?: string;
  limit?: number;
}

export interface TrackerProvider {
  listIssues(repo: TrackerRepo, opts?: ListIssuesOptions): Promise<Issue[]>;
  createIssue(repo: TrackerRepo, title: string, body: string, opts?: CreateIssueOptions): Promise<Issue>;
  getIssue(repo: TrackerRepo, number: number): Promise<Issue>;
  updateIssue(repo: TrackerRepo, number: number, opts: UpdateIssueOptions): Promise<Issue>;
  setIssueStatus(repo: TrackerRepo, issueNumber: number, status: string): Promise<void>;

  createLinkedBranch(repo: TrackerRepo, issueNumber: number, branchName: string): Promise<{ name: string }>;
  linkBranch(repo: TrackerRepo, issueNumber: number, branchName: string): Promise<void>;

  createPR(repo: TrackerRepo, title: string, body: string, head: string, base?: string): Promise<PR>;
  updatePR(repo: TrackerRepo, number: number, opts: { title?: string; body?: string }): Promise<PR>;
  getPRChecks(repo: TrackerRepo, number: number): Promise<CheckRun[]>;

  addSubIssue(repo: TrackerRepo, parentNumber: number, childNumber: number): Promise<void>;
  listSubIssues(repo: TrackerRepo, parentNumber: number): Promise<Issue[]>;
  setRelationship(repo: TrackerRepo, issueNumber: number, type: RelationshipType, targetNumber: number): Promise<void>;

  listPRs(repo: TrackerRepo, opts?: { state?: "open" | "closed" | "all"; limit?: number }): Promise<PR[]>;
  getPR(repo: TrackerRepo, number: number): Promise<PR>;
  addIssueComment(repo: TrackerRepo, number: number, body: string): Promise<void>;

  mergePR(repo: TrackerRepo, number: number, method?: "merge" | "squash" | "rebase"): Promise<void>;
  addPRComment(repo: TrackerRepo, number: number, body: string): Promise<void>;
  listComments(repo: TrackerRepo, type: "issue" | "pr", number: number): Promise<Array<{ id: number; author: string; body: string; createdAt: string }>>;

  listLabels(repo: TrackerRepo): Promise<Label[]>;
  listMilestones(repo: TrackerRepo, state?: "open" | "closed" | "all"): Promise<Milestone[]>;
  listProjectItems(repo: TrackerRepo, projectNumber: number): Promise<ProjectItem[]>;
  listProjectFields(repo: TrackerRepo, projectNumber: number): Promise<ProjectField[]>;
  addIssueToProject(repo: TrackerRepo, issueNumber: number, projectNumber: number): Promise<string>;
  setProjectItemFields(repo: TrackerRepo, projectNumber: number, itemId: string, fields: Record<string, string>): Promise<void>;
}

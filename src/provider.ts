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

  // Create a branch and link it to an issue. If the branch already exists, links it;
  // if not, creates it off the default branch.
  createBranch(repo: TrackerRepo, issueNumber: number, branchName: string): Promise<{ name: string }>;

  createPR(repo: TrackerRepo, title: string, body: string, head: string, base?: string): Promise<PR>;
  updatePR(repo: TrackerRepo, number: number, opts: { title?: string; body?: string }): Promise<PR>;
  getPRChecks(repo: TrackerRepo, number: number): Promise<CheckRun[]>;
  listPRs(repo: TrackerRepo, opts?: { state?: "open" | "closed" | "all"; limit?: number }): Promise<PR[]>;
  getPR(repo: TrackerRepo, number: number): Promise<PR>;
  mergePR(repo: TrackerRepo, number: number, method?: "merge" | "squash" | "rebase"): Promise<void>;
  requestReviewers(repo: TrackerRepo, prNumber: number, reviewers: string[]): Promise<void>;

  addIssueComment(repo: TrackerRepo, number: number, body: string): Promise<void>;
  addPRComment(repo: TrackerRepo, number: number, body: string): Promise<void>;
  listComments(repo: TrackerRepo, type: "issue" | "pr", number: number): Promise<Array<{ id: number; author: string; body: string; createdAt: string }>>;
  toggleChecklistItem(repo: TrackerRepo, issueNumber: number, itemText: string, checked?: boolean): Promise<{ matched: string; checked: boolean }>;

  addSubIssue(repo: TrackerRepo, parentNumber: number, childNumber: number): Promise<void>;
  listSubIssues(repo: TrackerRepo, parentNumber: number): Promise<Issue[]>;
  setRelationship(repo: TrackerRepo, issueNumber: number, type: RelationshipType, targetNumber: number): Promise<void>;

  listLabels(repo: TrackerRepo): Promise<Label[]>;
  listMilestones(repo: TrackerRepo, state?: "open" | "closed" | "all"): Promise<Milestone[]>;

  // Board operations — provider-specific concept (GitHub Projects V2, GitLab boards, Linear cycles, etc.)
  // boardId is an opaque string; each provider interprets it as needed.
  listBoardItems(repo: TrackerRepo, boardId: string): Promise<ProjectItem[]>;
  listBoardFields(repo: TrackerRepo, boardId: string): Promise<ProjectField[]>;
  addIssueToBoard(repo: TrackerRepo, issueNumber: number, boardId: string): Promise<string>;
  setItemFields(repo: TrackerRepo, boardId: string, itemId: string, fields: Record<string, string>): Promise<void>;
}

import type {
  TrackerRepo,
  Issue,
  PR,
  CheckRun,
  Label,
  Milestone,
  ProjectItem,
  ProjectField,
  RelationshipType,
  CreateIssueOptions,
  UpdateIssueOptions,
  CreatePROptions,
  UpdatePROptions,
} from './types.js';

export interface ListIssuesOptions {
  state?: 'open' | 'closed' | 'all';
  labels?: string[];
  assignee?: string;
  limit?: number;
}

export interface ListPRsOptions {
  state?: 'open' | 'closed' | 'all';
  limit?: number;
}

export interface Comment {
  id: number;
  author: string;
  body: string;
  createdAt: string;
}

export interface CodeProvider {
  createBranch(
    repo: TrackerRepo,
    issueNumber: number | null,
    branchName: string,
    base?: string
  ): Promise<{ name: string }>;
  createPR(
    repo: TrackerRepo,
    title: string,
    body: string,
    head: string,
    base: string | undefined,
    opts?: CreatePROptions
  ): Promise<PR>;
  updatePR(repo: TrackerRepo, number: number, opts: UpdatePROptions): Promise<PR>;
  getPRChecks(repo: TrackerRepo, number: number): Promise<CheckRun[]>;
  listPRs(repo: TrackerRepo, opts?: ListPRsOptions): Promise<PR[]>;
  getPR(repo: TrackerRepo, number: number): Promise<PR>;
  mergePR(repo: TrackerRepo, number: number, method?: string): Promise<void>;
  requestReviewers(repo: TrackerRepo, prNumber: number, reviewers: string[]): Promise<void>;
  addPRComment(repo: TrackerRepo, number: number, body: string): Promise<void>;
  listPRComments(repo: TrackerRepo, number: number): Promise<Comment[]>;
}

export interface IssueProvider {
  listIssues(repo: TrackerRepo, opts?: ListIssuesOptions): Promise<Issue[]>;
  createIssue(
    repo: TrackerRepo,
    title: string,
    body: string,
    opts?: CreateIssueOptions
  ): Promise<Issue>;
  getIssue(repo: TrackerRepo, number: number): Promise<Issue>;
  updateIssue(repo: TrackerRepo, number: number, opts: UpdateIssueOptions): Promise<Issue>;
  setIssueStatus(
    repo: TrackerRepo,
    issueNumber: number,
    status: string,
    allStatusLabels?: string[]
  ): Promise<void>;
  addIssueComment(repo: TrackerRepo, number: number, body: string): Promise<void>;
  listIssueComments(repo: TrackerRepo, number: number): Promise<Comment[]>;

  // Optional sub-capabilities.
  toggleChecklistItem?(
    repo: TrackerRepo,
    issueNumber: number,
    itemText: string,
    checked?: boolean
  ): Promise<{ matched: string; checked: boolean }>;
  setRelationship?(
    repo: TrackerRepo,
    issueNumber: number,
    type: RelationshipType,
    targetNumber: number
  ): Promise<void>;
  addSubIssue?(repo: TrackerRepo, parentNumber: number, childNumber: number): Promise<void>;
  listSubIssues?(repo: TrackerRepo, parentNumber: number): Promise<Issue[]>;
}

export interface BoardProvider {
  listBoardItems(repo: TrackerRepo, boardId: string): Promise<ProjectItem[]>;
  listBoardFields(repo: TrackerRepo, boardId: string): Promise<ProjectField[]>;
  addIssueToBoard(repo: TrackerRepo, issueNumber: number, boardId: string): Promise<string>;
  setItemFields(
    repo: TrackerRepo,
    boardId: string,
    itemId: string,
    fields: Record<string, string>
  ): Promise<void>;
}

export interface MetadataProvider {
  listLabels(repo: TrackerRepo): Promise<Label[]>;
  listMilestones(repo: TrackerRepo, state?: 'open' | 'closed' | 'all'): Promise<Milestone[]>;
}

export interface ProviderBundle {
  code?: CodeProvider;
  issue?: IssueProvider;
  board?: BoardProvider;
  metadata?: MetadataProvider;
}

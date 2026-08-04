import type { Scope } from '../../core/scope.js';
import type {
  Issue,
  IssueType,
  ItemId,
  RelationshipType,
  CreateIssueOptions,
  UpdateIssueOptions,
  Comment,
  Label,
  Milestone,
  PR,
  ProjectField,
} from '../../core/types.js';

export interface IssueCatalog {
  issueTypes: IssueType[];
  labels: string[];
  milestones: string[];
  boardFields: ProjectField[];
}

export interface ListIssuesOptions {
  state?: 'open' | 'closed' | 'all';
  labels?: string[];
  assignee?: string;
  limit?: number;
}

export interface IssueProvider {
  listIssues(scope: Scope, opts?: ListIssuesOptions): Promise<Issue[]>;
  listIssueTypes?(scope: Scope): Promise<IssueType[]>;

  createIssue(
    scope: Scope,
    title: string,
    body: string,
    opts?: CreateIssueOptions
  ): Promise<{ issue: Issue; warnings: string[] }>;

  getIssue(scope: Scope, id: ItemId): Promise<Issue>;
  updateIssue(
    scope: Scope,
    id: ItemId,
    opts: UpdateIssueOptions
  ): Promise<{ issue: Issue; warnings: string[] }>;
  setIssueStatus(scope: Scope, id: ItemId, status: string): Promise<void>;
  addIssueComment(scope: Scope, id: ItemId, body: string): Promise<void>;
  listIssueComments(scope: Scope, id: ItemId): Promise<Comment[]>;

  // Optional sub-capabilities.
  toggleChecklistItem?(
    scope: Scope,
    id: ItemId,
    itemText: string,
    checked?: boolean
  ): Promise<{ matched: string; checked: boolean }>;

  setRelationship?(
    scope: Scope,
    id: ItemId,
    type: RelationshipType,
    targetId: ItemId
  ): Promise<{ mechanism: 'native' | 'keyword-comment' | 'reference-comment' }>;

  addSubIssue?(scope: Scope, parentId: ItemId, childId: ItemId): Promise<void>;
  listSubIssues?(scope: Scope, parentId: ItemId): Promise<Issue[]>;

  listLabels?(scope: Scope): Promise<Label[]>;
  listMilestones?(
    scope: Scope,
    state?: 'open' | 'closed' | 'all'
  ): Promise<Milestone[]>;

  logTime?(
    scope: Scope,
    id: ItemId,
    opts: { spend?: string; estimate?: string }
  ): Promise<{ warnings: string[] }>;

  /** Uploads are project-scoped, not issue-scoped: no issue id involved. */
  attachFile?(scope: Scope, filePath: string): Promise<{ url: string; markdown: string }>;

  listRelatedIssues?(scope: Scope, id: ItemId): Promise<Issue[]>;
  listLinkedPRs?(scope: Scope, id: ItemId): Promise<PR[]>;
}

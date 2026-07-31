import type { Scope } from '../../domain/scope.js';
import type {
  Issue,
  ItemId,
  RelationshipType,
  CreateIssueOptions,
  UpdateIssueOptions,
  Comment,
  Label,
  Milestone,
} from '../../domain/types.js';

export interface ListIssuesOptions {
  state?: 'open' | 'closed' | 'all';
  labels?: string[];
  assignee?: string;
  limit?: number;
}

export interface IssueProvider {
  listIssues(scope: Scope, opts?: ListIssuesOptions): Promise<Issue[]>;

  createIssue(
    scope: Scope,
    title: string,
    body: string,
    opts?: CreateIssueOptions
  ): Promise<{ issue: Issue; warnings: string[] }>;

  getIssue(scope: Scope, id: ItemId): Promise<Issue>;
  updateIssue(scope: Scope, id: ItemId, opts: UpdateIssueOptions): Promise<Issue>;
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
}

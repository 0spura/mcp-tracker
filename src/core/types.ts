export interface TrackerRepo {
  owner: string;
  repo: string;
}

export type ItemId = string;

export type IssueState = 'open' | 'closed';

export type PRState = 'open' | 'closed' | 'merged';

export type RelationshipType = 'blocks' | 'blocked_by' | 'related' | 'duplicate';

export interface Comment {
  id: ItemId;
  author: string;
  body: string;
  createdAt: string;
}

export interface Issue {
  id: ItemId;
  title: string;
  body: string;
  state: IssueState;
  url: string;
  labels: string[];
  assignees: string[];
  milestone?: string | null;
}

export interface PR {
  number: number;
  title: string;
  body: string;
  state: PRState;
  url: string;
  headBranch: string;
  baseBranch: string;
}

export interface CheckRun {
  name: string;
  status: string;
  conclusion: string | null;
  url: string;
  logs?: string | null;
}

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface Milestone {
  id: ItemId;
  title: string;
  state: 'open' | 'closed';
  dueOn: string | null;
}

export interface ProjectItem {
  id: ItemId;
  status: string | null;
  content: {
    type: 'issue' | 'pr';
    id: ItemId;
    title: string;
    state: IssueState | PRState;
    url: string;
  } | null;
}

export interface ProjectField {
  id: string;
  name: string;
  type: string;
  options?: Array<{ id: string; name: string }>;
}

export interface CreateIssueOptions {
  labels?: string[];
  assignees?: string[];
  milestone?: string;
  blocks?: ItemId[];
  blocked_by?: ItemId[];
  related?: ItemId[];
  duplicate_of?: ItemId;
  parent?: ItemId;
  status?: string;
  fields?: Record<string, string>;
}

export interface UpdateIssueOptions {
  title?: string;
  body?: string;
  labels?: string[];
  assignees?: string[];
  state?: IssueState;
  add_blocks?: ItemId[];
  remove_blocks?: ItemId[];
  add_blocked_by?: ItemId[];
  remove_blocked_by?: ItemId[];
  add_related?: ItemId[];
  remove_related?: ItemId[];
  duplicate_of?: ItemId | null;
}

export interface CreatePROptions {
  issues?: ItemId[];
}

export interface UpdatePROptions {
  title?: string;
  body?: string;
  state?: PRState;
  labels?: string[];
  milestone?: string;
  draft?: boolean;
  add_reviewers?: string[];
  remove_reviewers?: string[];
  add_assignees?: string[];
  remove_assignees?: string[];
}

export interface PRReview {
  event: 'approve' | 'request_changes' | 'comment';
  body?: string;
  comments?: Array<{ path: string; line: number; body: string }>;
}

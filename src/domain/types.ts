export interface TrackerRepo {
  owner: string;
  repo: string;
}

export type IssueState = 'open' | 'closed';

export type PRState = 'open' | 'closed' | 'merged';

export type RelationshipType = 'blocks' | 'blocked_by' | 'related' | 'duplicate';

export interface Issue {
  number: number;
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
  number: number;
  title: string;
  state: 'open' | 'closed';
  dueOn: string | null;
}

export interface ProjectItem {
  id: string;
  status: string | null;
  content: {
    type: 'issue' | 'pr';
    number: number;
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
  blocks?: number[];
  blocked_by?: number[];
  related?: number[];
  duplicate_of?: number;
  parent?: number;
  status?: string;
  fields?: Record<string, string>;
}

export interface UpdateIssueOptions {
  title?: string;
  body?: string;
  labels?: string[];
  assignees?: string[];
  state?: IssueState;
  add_blocks?: number[];
  remove_blocks?: number[];
  add_blocked_by?: number[];
  remove_blocked_by?: number[];
  add_related?: number[];
  remove_related?: number[];
  duplicate_of?: number | null;
}

export interface CreatePROptions {
  issues?: number[];
}

export interface UpdatePROptions {
  title?: string;
  body?: string;
  state?: PRState;
  add_reviewers?: string[];
  remove_reviewers?: string[];
  add_assignees?: string[];
  remove_assignees?: string[];
}

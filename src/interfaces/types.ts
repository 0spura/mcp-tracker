export interface TrackerRepo {
  owner: string;
  repo: string;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: string;
  url: string;
  labels: string[];
}

export interface PR {
  number: number;
  title: string;
  body: string;
  state: string;
  url: string;
  headBranch: string;
  baseBranch: string;
}

export interface CheckRun {
  name: string;
  status: string;
  conclusion: string | null;
  url: string;
  // Populated only for failed checks: the tail of the failing job's log.
  logs?: string | null;
}

export type RelationshipType = "blocks" | "blocked_by" | "related" | "duplicate";

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface Milestone {
  number: number;
  title: string;
  state: string;
  dueOn: string | null;
}

export interface ProjectItem {
  id: string;
  status: string | null;
  content: {
    type: "issue" | "pr";
    number: number;
    title: string;
    state: string;
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
}

export interface UpdateIssueOptions {
  title?: string;
  body?: string;
  labels?: string[];
  assignees?: string[];
  state?: "open" | "closed";
}

import type {
  TrackerRepo,
  PR,
  CheckRun,
  Comment,
  CreatePROptions,
  UpdatePROptions,
  PRReview,
  ItemId,
} from '../../domain/types.js';

export interface ListPRsOptions {
  state?: 'open' | 'closed' | 'all';
  limit?: number;
}

export interface CodeProvider {
  createBranch(
    repo: TrackerRepo,
    issueId: ItemId | null,
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

  updatePR(
    repo: TrackerRepo,
    number: number,
    opts: UpdatePROptions
  ): Promise<{ pr: PR; warnings: string[] }>;
  getPRChecks(repo: TrackerRepo, number: number): Promise<CheckRun[]>;
  listPRs(repo: TrackerRepo, opts?: ListPRsOptions): Promise<PR[]>;
  getPR(repo: TrackerRepo, number: number): Promise<PR>;
  mergePR(
    repo: TrackerRepo,
    number: number,
    method?: 'merge' | 'squash' | 'rebase'
  ): Promise<void>;
  getPRDiff(repo: TrackerRepo, number: number): Promise<string>;
  submitPRReview(repo: TrackerRepo, number: number, review: PRReview): Promise<void>;
  addPRComment(repo: TrackerRepo, number: number, body: string): Promise<void>;
  listPRComments(repo: TrackerRepo, number: number): Promise<Comment[]>;
}

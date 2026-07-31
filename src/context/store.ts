import { run } from '../core/process.js';
import type { TrackerRepo, ItemId } from '../core/types.js';
import type { Scope, ScopeKey } from '../core/scope.js';
import { deriveActiveIssue, deriveRepo, type ProcessRunner } from './git.js';
import { loadConfig, type TrackerConfig, type MergeMethod } from './config.js';

export type ContextSource = 'explicit' | 'session' | 'config' | 'derived' | 'unset';

export interface ResolvedContextValue<T> {
  value: T | 'unset';
  source: ContextSource;
}

export interface ContextSnapshot {
  repo: ResolvedContextValue<TrackerRepo>;
  board_id: ResolvedContextValue<string>;
  active_issue: ResolvedContextValue<ItemId>;
  default_base: ResolvedContextValue<string>;
  default_reviewers: ResolvedContextValue<string[]>;
  default_merge_method: ResolvedContextValue<MergeMethod>;
  default_assignee: ResolvedContextValue<string>;
  default_milestone: ResolvedContextValue<string>;
  default_labels?: ResolvedContextValue<string[]>;
  workflow?: ResolvedContextValue<TrackerConfig['workflow']>;
}

export interface SetContextOptions {
  repo?: string;
  board_id?: string;
  active_issue?: ItemId | null;
  default_base?: string;
  default_reviewers?: string[];
  default_merge_method?: MergeMethod;
  default_assignee?: string;
  default_milestone?: string;
}

interface SessionContext {
  repo: TrackerRepo | null;
  boardId: string | null;
  activeIssue: ItemId | null;
  defaultBase: string | null;
  defaultReviewers: string[] | null;
  defaultMergeMethod: MergeMethod | null;
  defaultAssignee: string | null;
  defaultMilestone: string | null;
}

/**
 * Holds session context and resolves each value by precedence:
 * explicit argument > session value > config file > git derivation.
 *
 * Every resolved value carries its source for the snapshot used by
 * tracker_get_context.
 */
export class ContextStore {
  private readonly session: SessionContext = {
    repo: null,
    boardId: null,
    activeIssue: null,
    defaultBase: null,
    defaultReviewers: null,
    defaultMergeMethod: null,
    defaultAssignee: null,
    defaultMilestone: null,
  };

  private readonly configPromise: Promise<TrackerConfig>;
  private repoCache: Promise<TrackerRepo | 'unset'> | undefined;

  constructor(
    private readonly runFn: ProcessRunner,
    loadConfigFn: () => Promise<TrackerConfig>
  ) {
    this.configPromise = loadConfigFn();
  }

  static create(): ContextStore {
    return new ContextStore(run, () => loadConfig());
  }

  /** Raw resolved config (workflow stages, automation triggers, labels). */
  async getConfig(): Promise<TrackerConfig> {
    return this.configPromise;
  }

  /**
   * Merge session overrides. An explicit `active_issue: null` clears it.
   */
  setContext(partial: SetContextOptions): void {
    if (partial.repo !== undefined) {
      this.session.repo = partial.repo ? parseRepo(partial.repo) : null;
    }
    if (partial.board_id !== undefined) {
      this.session.boardId = partial.board_id;
    }
    if (partial.active_issue !== undefined) {
      this.session.activeIssue = partial.active_issue;
    }
    if (partial.default_base !== undefined) {
      this.session.defaultBase = partial.default_base;
    }
    if (partial.default_reviewers !== undefined) {
      this.session.defaultReviewers = partial.default_reviewers;
    }
    if (partial.default_merge_method !== undefined) {
      this.session.defaultMergeMethod = partial.default_merge_method;
    }
    if (partial.default_assignee !== undefined) {
      this.session.defaultAssignee = partial.default_assignee;
    }
    if (partial.default_milestone !== undefined) {
      this.session.defaultMilestone = partial.default_milestone;
    }
  }

  async resolveRepo(explicit?: string): Promise<ResolvedContextValue<TrackerRepo>> {
    const config = await this.configPromise;
    return this.resolve(
      explicit !== undefined ? parseRepo(explicit) : undefined,
      this.session.repo,
      config.repo !== undefined ? parseRepo(config.repo) : undefined,
      () => this.cachedRepo()
    );
  }

  async resolveBoardId(explicit?: string): Promise<ResolvedContextValue<string>> {
    const config = await this.configPromise;
    return this.resolve(
      explicit,
      this.session.boardId,
      config.boardId,
      async () => 'unset'
    );
  }

  async resolveActiveIssue(explicit?: ItemId): Promise<ResolvedContextValue<ItemId>> {
    const config = await this.configPromise;
    return this.resolve(
      explicit,
      this.session.activeIssue,
      config.activeIssue,
      () => deriveActiveIssue(this.runFn)
    );
  }

  async resolveDefaultBase(explicit?: string): Promise<ResolvedContextValue<string>> {
    const config = await this.configPromise;
    return this.resolve(
      explicit,
      this.session.defaultBase,
      config.defaults?.baseBranch,
      async () => 'unset'
    );
  }

  async resolveDefaultReviewers(
    explicit?: string[]
  ): Promise<ResolvedContextValue<string[]>> {
    const config = await this.configPromise;
    return this.resolve(
      explicit,
      this.session.defaultReviewers,
      config.defaults?.reviewers,
      async () => 'unset'
    );
  }

  async resolveDefaultMergeMethod(
    explicit?: MergeMethod
  ): Promise<ResolvedContextValue<MergeMethod>> {
    const config = await this.configPromise;
    return this.resolve(
      explicit,
      this.session.defaultMergeMethod,
      config.defaults?.mergeMethod,
      async () => 'unset'
    );
  }

  async resolveDefaultAssignee(
    explicit?: string
  ): Promise<ResolvedContextValue<string>> {
    const config = await this.configPromise;
    return this.resolve(
      explicit,
      this.session.defaultAssignee,
      config.defaults?.assignee,
      async () => 'unset'
    );
  }

  async resolveDefaultMilestone(
    explicit?: string
  ): Promise<ResolvedContextValue<string>> {
    const config = await this.configPromise;
    return this.resolve(
      explicit,
      this.session.defaultMilestone,
      config.defaults?.milestone,
      async () => 'unset'
    );
  }

  async snapshot(): Promise<ContextSnapshot> {
    const config = await this.configPromise;

    const [
      repo,
      boardId,
      activeIssue,
      defaultBase,
      defaultReviewers,
      defaultMergeMethod,
      defaultAssignee,
      defaultMilestone,
    ] = await Promise.all([
      this.resolveRepo(),
      this.resolveBoardId(),
      this.resolveActiveIssue(),
      this.resolveDefaultBase(),
      this.resolveDefaultReviewers(),
      this.resolveDefaultMergeMethod(),
      this.resolveDefaultAssignee(),
      this.resolveDefaultMilestone(),
    ]);

    const snapshot: ContextSnapshot = {
      repo,
      board_id: boardId,
      active_issue: activeIssue,
      default_base: defaultBase,
      default_reviewers: defaultReviewers,
      default_merge_method: defaultMergeMethod,
      default_assignee: defaultAssignee,
      default_milestone: defaultMilestone,
    };

    if (config.defaults?.labels !== undefined) {
      snapshot.default_labels = {
        value: config.defaults.labels,
        source: 'config',
      };
    }
    if (config.workflow !== undefined) {
      snapshot.workflow = { value: config.workflow, source: 'config' };
    }

    return snapshot;
  }

  async resolveScope(): Promise<Scope> {
    const [repo, boardId] = await Promise.all([
      this.resolveRepo(),
      this.resolveBoardId(),
    ]);

    const scope: Scope = {};
    if (repo.value !== 'unset') {
      scope.repo = repo.value;
    }
    if (boardId.value !== 'unset') {
      scope.boardId = boardId.value;
    }
    return scope;
  }

  async requireScope(keys: ScopeKey[]): Promise<Scope> {
    const scope = await this.resolveScope();
    for (const key of keys) {
      if (key === 'repo' && scope.repo === undefined) {
        throw new Error(`Missing required scope: ${key}`);
      }
      if (key === 'board' && scope.boardId === undefined) {
        throw new Error(`Missing required scope: ${key}`);
      }
    }
    return scope;
  }

  private async resolve<T>(
    explicit: T | undefined,
    session: T | null,
    config: T | undefined,
    derive: () => Promise<T | 'unset'>
  ): Promise<ResolvedContextValue<T>> {
    if (explicit !== undefined) {
      return { value: explicit, source: 'explicit' };
    }
    if (session !== null) {
      return { value: session, source: 'session' };
    }
    if (config !== undefined) {
      return { value: config, source: 'config' };
    }

    const derived = await derive();
    if (derived === 'unset') {
      return { value: 'unset', source: 'unset' };
    }
    return { value: derived, source: 'derived' };
  }

  private cachedRepo(): Promise<TrackerRepo | 'unset'> {
    if (this.repoCache === undefined) {
      this.repoCache = deriveRepo(this.runFn);
    }
    return this.repoCache;
  }
}

function parseRepo(value: string): TrackerRepo {
  const parts = value.split('/');
  if (parts.length < 2 || parts.some((part) => !part)) {
    throw new Error(`Invalid repo "${value}": expected "owner/repo"`);
  }
  const repo = parts[parts.length - 1];
  const owner = parts.slice(0, -1).join('/');
  return { owner, repo };
}

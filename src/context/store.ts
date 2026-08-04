import { run } from '../core/process.js';
import type { TrackerRepo } from '../core/types.js';
import type { Scope, ScopeKey } from '../core/scope.js';
import { deriveRepo, type ProcessRunner } from './git.js';
import { loadConfig, type TrackerConfig, type MergeMethod } from './config.js';

export type ContextSource = 'explicit' | 'config' | 'derived' | 'unset';

export interface ResolvedContextValue<T> {
  value: T | 'unset';
  source: ContextSource;
}

/**
 * Resolves explicit arguments, project configuration, and git-derived scope.
 */
export class ContextStore {
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

  async resolveRepo(explicit?: string): Promise<ResolvedContextValue<TrackerRepo>> {
    const config = await this.configPromise;
    return this.resolve(
      explicit !== undefined ? parseRepo(explicit) : undefined,
      config.repo !== undefined ? parseRepo(config.repo) : undefined,
      () => this.cachedRepo()
    );
  }

  async resolveBoardId(explicit?: string): Promise<ResolvedContextValue<string>> {
    const config = await this.configPromise;
    return this.resolve(
      explicit,
      config.boardId,
      async () => 'unset'
    );
  }

  async resolveDefaultBase(explicit?: string): Promise<ResolvedContextValue<string>> {
    const config = await this.configPromise;
    return this.resolve(
      explicit,
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
      config.defaults?.mergeMethod,
      async () => 'unset'
    );
  }

  async resolveDefaultMergeDeleteBranch(
    explicit?: boolean
  ): Promise<ResolvedContextValue<boolean>> {
    const config = await this.configPromise;
    return this.resolve(
      explicit,
      config.defaults?.deleteBranchOnMerge,
      async () => 'unset'
    );
  }

  async resolveDefaultAssignee(
    explicit?: string
  ): Promise<ResolvedContextValue<string>> {
    const config = await this.configPromise;
    return this.resolve(
      explicit,
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
      config.defaults?.milestone,
      async () => 'unset'
    );
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
    config: T | undefined,
    derive: () => Promise<T | 'unset'>
  ): Promise<ResolvedContextValue<T>> {
    if (explicit !== undefined) {
      return { value: explicit, source: 'explicit' };
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

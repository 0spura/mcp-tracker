import type { run } from '../core/process.js';
import type { TrackerRepo, ItemId } from '../domain/types.js';

export type GitDerivationResult<T> = T | 'unset';

export type ProcessRunner = typeof run;

/**
 * Derive the repository from `git remote get-url origin`.
 *
 * Supports SSH (`git@host:owner/repo.git`) and HTTPS
 * (`https://host/owner/repo(.git)`), including nested owner paths such as
 * `group/subgroup/repo`. Any failure resolves to "unset" and never throws.
 */
export async function deriveRepo(
  gitRun: ProcessRunner
): Promise<GitDerivationResult<TrackerRepo>> {
  let remote: string;
  try {
    remote = (await gitRun('git', ['remote', 'get-url', 'origin'])).trim();
  } catch {
    return 'unset';
  }

  return parseRemoteUrl(remote);
}

function parseRemoteUrl(url: string): GitDerivationResult<TrackerRepo> {
  // Convert the SSH separator (`git@host:path`) into a slash so both forms can
  // be parsed the same way.
  const normalized = url.replace(/^git@([^:]+):/, 'git@$1/');
  const withoutProtocol = normalized.replace(/^(?:https?:\/\/|git@)/, '');

  const separatorIndex = withoutProtocol.indexOf('/');
  if (separatorIndex === -1) {
    return 'unset';
  }

  const path = withoutProtocol
    .slice(separatorIndex + 1)
    .replace(/\.git$/, '');

  const parts = path.split('/').filter(Boolean);
  if (parts.length < 2) {
    return 'unset';
  }

  const repo = parts[parts.length - 1];
  const owner = parts.slice(0, -1).join('/');
  return { owner, repo };
}

/**
 * Derive the active item id from `git branch --show-current`.
 *
 * Matches numeric ids (`feat/42-slug`, `42-slug`) and tracker-style key ids
 * (`feat/PROJ-123-slug`). Failures resolve to "unset" and never throw.
 */
export async function deriveActiveIssue(
  gitRun: ProcessRunner
): Promise<GitDerivationResult<ItemId>> {
  let branch: string;
  try {
    branch = (await gitRun('git', ['branch', '--show-current'])).trim();
  } catch {
    return 'unset';
  }

  if (!branch) {
    return 'unset';
  }

  const match = branch.match(/(?:^|\/)([A-Z]+-\d+|\d+)(?:-|$)/);
  if (!match) {
    return 'unset';
  }

  return match[1];
}

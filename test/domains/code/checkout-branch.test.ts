import { describe, it, expect } from 'vitest';
import {
  checkoutBranch,
  parseGitHubSlug,
} from '../../../src/domains/code/tools.js';

type RunGit = (cmd: string, args: string[]) => Promise<string>;

function fakeGit(handlers: Record<string, string | Error>): {
  run: RunGit;
  calls: string[];
} {
  const calls: string[] = [];
  const run: RunGit = async (cmd, args) => {
    const key = `${cmd} ${args.join(' ')}`;
    calls.push(key);
    const handler = handlers[key];
    if (handler === undefined) throw new Error(`unexpected command: ${key}`);
    if (handler instanceof Error) throw handler;
    return handler;
  };
  return { run, calls };
}

const checkoutErr = new Error(
  "error: pathspec 'feat/1-oidc-assertions' did not match any file(s) known to git",
);

describe('parseGitHubSlug', () => {
  it.each([
    ['https://github.com/CollariTech/oath-grant.git', 'collaritech/oath-grant'],
    ['https://github.com/CollariTech/oath-grant', 'collaritech/oath-grant'],
    ['git@github.com:CollariTech/oath-grant.git', 'collaritech/oath-grant'],
    ['git@github.com:oath/oath', 'oath/oath'],
  ])('parses %s', (url, expected) => {
    expect(parseGitHubSlug(url)).toBe(expected);
  });

  it.each([['https://gitlab.com/a/b.git'], ['not-a-url'], ['']])(
    'returns null for %s',
    (url) => {
      expect(parseGitHubSlug(url)).toBeNull();
    },
  );
});

describe('checkoutBranch', () => {
  const repo = { owner: 'CollariTech', repo: 'oath-grant' };

  it('checks out directly when the branch is already known', async () => {
    const { run, calls } = fakeGit({
      'git checkout feat/1-oidc-assertions': '',
    });
    const result = await checkoutBranch(run, 'feat/1-oidc-assertions', repo);
    expect(result).toEqual({ checkedOut: true });
    expect(calls).toEqual(['git checkout feat/1-oidc-assertions']);
  });

  it('skips the checkout without fetching when cwd is a different repo', async () => {
    const { run, calls } = fakeGit({
      'git checkout feat/1-oidc-assertions': checkoutErr,
      'git remote get-url origin':
        'https://github.com/CollariTech/oath.git\n',
    });
    const result = await checkoutBranch(run, 'feat/1-oidc-assertions', repo);
    expect(result.checkedOut).toBe(false);
    expect(result.warning).toContain('feat/1-oidc-assertions');
    expect(result.warning).toContain('collaritech/oath-grant');
    expect(result.warning).toContain('collaritech/oath');
    expect(calls.some((c) => c.startsWith('git fetch'))).toBe(false);
  });

  it('fetches the single branch and tracks it when cwd matches', async () => {
    const { run, calls } = fakeGit({
      'git checkout feat/1-oidc-assertions': checkoutErr,
      'git remote get-url origin':
        'https://github.com/CollariTech/oath-grant.git\n',
      'git fetch origin feat/1-oidc-assertions': '',
      'git checkout -B feat/1-oidc-assertions origin/feat/1-oidc-assertions':
        '',
    });
    const result = await checkoutBranch(run, 'feat/1-oidc-assertions', repo);
    expect(result).toEqual({ checkedOut: true });
    expect(calls).not.toContain('git fetch --all --prune');
    expect(calls).toContain('git fetch origin feat/1-oidc-assertions');
  });

  it('attempts recovery when the remote cannot be determined', async () => {
    const { run } = fakeGit({
      'git checkout feat/1-oidc-assertions': checkoutErr,
      'git remote get-url origin': new Error('no origin'),
      'git fetch origin feat/1-oidc-assertions': '',
      'git checkout -B feat/1-oidc-assertions origin/feat/1-oidc-assertions':
        '',
    });
    const result = await checkoutBranch(run, 'feat/1-oidc-assertions', repo);
    expect(result).toEqual({ checkedOut: true });
  });

  it('throws an informative error when recovery fails', async () => {
    const { run } = fakeGit({
      'git checkout feat/1-oidc-assertions': checkoutErr,
      'git remote get-url origin':
        'https://github.com/CollariTech/oath-grant.git\n',
      'git fetch origin feat/1-oidc-assertions': new Error('fetch failed'),
    });
    await expect(
      checkoutBranch(run, 'feat/1-oidc-assertions', repo),
    ).rejects.toThrow(/feat\/1-oidc-assertions.*collaritech\/oath-grant/);
  });
});

import { describe, it, expect } from 'vitest';
import {
  deriveRepo,
  deriveActiveIssue,
  type ProcessRunner,
} from '../../src/context/git.js';
import type { run } from '../../src/core/process.js';

function fakeRunner(commands: Record<string, string | Error>): typeof run {
  return (async (cmd: string, args: string[]) => {
    const key = `${cmd} ${args.join(' ')}`;
    const response = commands[key];
    if (response === undefined) {
      throw new Error(`unexpected command: ${key}`);
    }
    if (response instanceof Error) {
      throw response;
    }
    return response;
  }) as typeof run;
}

describe('deriveRepo', () => {
  it('parses an SSH remote with .git', async () => {
    const runner = fakeRunner({
      'git remote get-url origin': 'git@github.com:acme/widgets.git',
    });
    const repo = await deriveRepo(runner);
    expect(repo).toEqual({ owner: 'acme', repo: 'widgets' });
  });

  it('parses an SSH remote without .git', async () => {
    const runner = fakeRunner({
      'git remote get-url origin': 'git@github.com:acme/widgets',
    });
    const repo = await deriveRepo(runner);
    expect(repo).toEqual({ owner: 'acme', repo: 'widgets' });
  });

  it('parses an HTTPS remote with .git', async () => {
    const runner = fakeRunner({
      'git remote get-url origin': 'https://github.com/acme/widgets.git',
    });
    const repo = await deriveRepo(runner);
    expect(repo).toEqual({ owner: 'acme', repo: 'widgets' });
  });

  it('parses an HTTPS remote without .git', async () => {
    const runner = fakeRunner({
      'git remote get-url origin': 'https://github.com/acme/widgets',
    });
    const repo = await deriveRepo(runner);
    expect(repo).toEqual({ owner: 'acme', repo: 'widgets' });
  });

  it('parses a nested owner path', async () => {
    const runner = fakeRunner({
      'git remote get-url origin': 'git@github.com:acme/team/widgets.git',
    });
    const repo = await deriveRepo(runner);
    expect(repo).toEqual({ owner: 'acme/team', repo: 'widgets' });
  });

  it('resolves to unset when there is no remote', async () => {
    const runner = fakeRunner({
      'git remote get-url origin': new Error('No such remote'),
    });
    const repo = await deriveRepo(runner);
    expect(repo).toBe('unset');
  });

  it('resolves to unset when git itself fails', async () => {
    const runner = fakeRunner({
      'git remote get-url origin': new Error('not a git repository'),
    });
    const repo = await deriveRepo(runner);
    expect(repo).toBe('unset');
  });
});

describe('deriveActiveIssue', () => {
  it('extracts a numeric id from feat/42-slug', async () => {
    const runner = fakeRunner({
      'git branch --show-current': 'feat/42-slug',
    });
    const issue = await deriveActiveIssue(runner);
    expect(issue).toBe('42');
  });

  it('extracts a numeric id from 123-feature-name', async () => {
    const runner = fakeRunner({
      'git branch --show-current': '123-feature-name',
    });
    const issue = await deriveActiveIssue(runner);
    expect(issue).toBe('123');
  });

  it('extracts a tracker-style key id from feat/PROJ-123-slug', async () => {
    const runner = fakeRunner({
      'git branch --show-current': 'feat/PROJ-123-slug',
    });
    const issue = await deriveActiveIssue(runner);
    expect(issue).toBe('PROJ-123');
  });

  it('extracts a tracker-style key id from fix/PROJ-456', async () => {
    const runner = fakeRunner({
      'git branch --show-current': 'fix/PROJ-456',
    });
    const issue = await deriveActiveIssue(runner);
    expect(issue).toBe('PROJ-456');
  });

  it('resolves to unset for a version-like branch', async () => {
    const runner = fakeRunner({
      'git branch --show-current': 'v2',
    });
    const issue = await deriveActiveIssue(runner);
    expect(issue).toBe('unset');
  });

  it('resolves to unset when the id is not a segment start', async () => {
    const runner = fakeRunner({
      'git branch --show-current': 'foo-42',
    });
    const issue = await deriveActiveIssue(runner);
    expect(issue).toBe('unset');
  });

  it('resolves to unset when git fails', async () => {
    const runner = fakeRunner({
      'git branch --show-current': new Error('not a git repository'),
    });
    const issue = await deriveActiveIssue(runner);
    expect(issue).toBe('unset');
  });
});

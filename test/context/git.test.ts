import { describe, it, expect } from 'vitest';
import { deriveRepo, type ProcessRunner } from '../../src/context/git.js';
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

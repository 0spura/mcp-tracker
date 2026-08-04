import { describe, it, expect } from 'vitest';
import { ContextStore } from '../../src/context/store.js';
import type { TrackerConfig } from '../../src/context/config.js';
import type { run } from '../../src/core/process.js';

function fakeRunner(commands: Record<string, string | Error>): typeof run {
  return (async (cmd: string, args: string[]) => {
    const response = commands[`${cmd} ${args.join(' ')}`];
    if (response === undefined) throw new Error('unexpected command');
    if (response instanceof Error) throw response;
    return response;
  }) as typeof run;
}

function createStore(config: TrackerConfig, runner: typeof run): ContextStore {
  return new ContextStore(runner, () => Promise.resolve(config));
}

describe('ContextStore', () => {
  it('prefers an explicit repo', async () => {
    const store = createStore({ repo: 'config/repo' }, fakeRunner({}));
    expect(await store.resolveRepo('explicit/repo')).toEqual({
      value: { owner: 'explicit', repo: 'repo' },
      source: 'explicit',
    });
  });

  it('uses the configured repo', async () => {
    const store = createStore({ repo: 'config/repo' }, fakeRunner({}));
    expect(await store.resolveRepo()).toEqual({
      value: { owner: 'config', repo: 'repo' },
      source: 'config',
    });
  });

  it('derives the repo from git', async () => {
    const store = createStore({}, fakeRunner({
      'git remote get-url origin': 'git@github.com:acme/widgets.git',
    }));
    expect(await store.resolveRepo()).toEqual({
      value: { owner: 'acme', repo: 'widgets' },
      source: 'derived',
    });
  });

  it('returns unset without a repo source', async () => {
    const store = createStore({}, fakeRunner({
      'git remote get-url origin': new Error('no remote'),
    }));
    expect(await store.resolveRepo()).toEqual({ value: 'unset', source: 'unset' });
  });

  it('resolves configured defaults', async () => {
    const store = createStore({
      defaults: { baseBranch: 'main', reviewers: ['alice'] },
    }, fakeRunner({}));
    expect(await store.resolveDefaultBase()).toEqual({ value: 'main', source: 'config' });
    expect(await store.resolveDefaultReviewers()).toEqual({
      value: ['alice'],
      source: 'config',
    });
  });

  it('resolves repo and board scope', async () => {
    const store = createStore(
      { repo: 'acme/widgets', boardId: 'PVT_1' },
      fakeRunner({})
    );
    expect(await store.resolveScope()).toEqual({
      repo: { owner: 'acme', repo: 'widgets' },
      boardId: 'PVT_1',
    });
  });

  it('requires declared scope', async () => {
    const store = createStore({ boardId: 'PVT_1' }, fakeRunner({}));
    await expect(store.requireScope(['repo'])).rejects.toThrow('repo');
  });

  it('caches git repo derivation', async () => {
    let calls = 0;
    const runner = (async () => {
      calls++;
      return 'git@github.com:acme/widgets.git';
    }) as typeof run;
    const store = createStore({}, runner);
    await store.resolveRepo();
    await store.resolveRepo();
    expect(calls).toBe(1);
  });
});

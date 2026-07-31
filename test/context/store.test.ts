import { describe, it, expect } from 'vitest';
import { ContextStore } from '../../src/context/store.js';
import type { TrackerConfig } from '../../src/context/config.js';
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

function createStore(config: TrackerConfig, runner: typeof run): ContextStore {
  return new ContextStore(runner, () => Promise.resolve(config));
}

describe('ContextStore', () => {
  describe('precedence', () => {
    it('explicit repo wins over session, config, and git', async () => {
      const runner = fakeRunner({
        'git remote get-url origin': 'git@github.com:derived/from-git.git',
      });
      const store = createStore({ repo: 'config/repo' }, runner);
      store.setContext({ repo: 'session/repo' });

      const resolved = await store.resolveRepo('explicit/repo');
      expect(resolved).toEqual({
        value: { owner: 'explicit', repo: 'repo' },
        source: 'explicit',
      });
    });

    it('session repo wins over config and git', async () => {
      const runner = fakeRunner({
        'git remote get-url origin': 'git@github.com:derived/from-git.git',
      });
      const store = createStore({ repo: 'config/repo' }, runner);
      store.setContext({ repo: 'session/repo' });

      const resolved = await store.resolveRepo();
      expect(resolved).toEqual({
        value: { owner: 'session', repo: 'repo' },
        source: 'session',
      });
    });

    it('config repo wins over git derivation', async () => {
      const runner = fakeRunner({
        'git remote get-url origin': 'git@github.com:derived/from-git.git',
      });
      const store = createStore({ repo: 'config/repo' }, runner);

      const resolved = await store.resolveRepo();
      expect(resolved).toEqual({
        value: { owner: 'config', repo: 'repo' },
        source: 'config',
      });
    });

    it('falls back to git-derived repo', async () => {
      const runner = fakeRunner({
        'git remote get-url origin': 'git@github.com:acme/widgets.git',
      });
      const store = createStore({}, runner);

      const resolved = await store.resolveRepo();
      expect(resolved).toEqual({
        value: { owner: 'acme', repo: 'widgets' },
        source: 'derived',
      });
    });

    it('resolves to unset when no source provides the repo', async () => {
      const runner = fakeRunner({
        'git remote get-url origin': new Error('no remote'),
      });
      const store = createStore({}, runner);

      const resolved = await store.resolveRepo();
      expect(resolved).toEqual({ value: 'unset', source: 'unset' });
    });

    it('config default_base wins over derived unset', async () => {
      const store = createStore(
        { defaults: { baseBranch: 'main' } },
        fakeRunner({})
      );
      const resolved = await store.resolveDefaultBase();
      expect(resolved).toEqual({ value: 'main', source: 'config' });
    });

    it('session default_reviewers win over config', async () => {
      const store = createStore(
        { defaults: { reviewers: ['alice'] } },
        fakeRunner({})
      );
      store.setContext({ default_reviewers: ['bob'] });
      const resolved = await store.resolveDefaultReviewers();
      expect(resolved).toEqual({ value: ['bob'], source: 'session' });
    });
  });

  describe('active issue', () => {
    it('derives the active issue from the current branch', async () => {
      const runner = fakeRunner({
        'git branch --show-current': 'feat/42-slug',
      });
      const store = createStore({}, runner);

      const resolved = await store.resolveActiveIssue();
      expect(resolved).toEqual({ value: '42', source: 'derived' });
    });

    it('derives a tracker-style id from the current branch', async () => {
      const runner = fakeRunner({
        'git branch --show-current': 'feat/PROJ-123-slug',
      });
      const store = createStore({}, runner);

      const resolved = await store.resolveActiveIssue();
      expect(resolved).toEqual({ value: 'PROJ-123', source: 'derived' });
    });

    it('uses the session value over the derived value', async () => {
      const runner = fakeRunner({
        'git branch --show-current': 'feat/42-slug',
      });
      const store = createStore({}, runner);
      store.setContext({ active_issue: '7' });

      const resolved = await store.resolveActiveIssue();
      expect(resolved).toEqual({ value: '7', source: 'session' });
    });

    it('uses an explicit value over the session value', async () => {
      const runner = fakeRunner({
        'git branch --show-current': 'feat/42-slug',
      });
      const store = createStore({}, runner);
      store.setContext({ active_issue: '7' });

      const resolved = await store.resolveActiveIssue('99');
      expect(resolved).toEqual({ value: '99', source: 'explicit' });
    });

    it('clears the session active issue when set to null', async () => {
      const runner = fakeRunner({
        'git branch --show-current': 'feat/42-slug',
      });
      const store = createStore({}, runner);
      store.setContext({ active_issue: '7' });
      store.setContext({ active_issue: null });

      const resolved = await store.resolveActiveIssue();
      expect(resolved).toEqual({ value: '42', source: 'derived' });
    });

    it('config activeIssue wins over derived', async () => {
      const runner = fakeRunner({
        'git branch --show-current': 'feat/42-slug',
      });
      const store = createStore({ activeIssue: '5' }, runner);

      const resolved = await store.resolveActiveIssue();
      expect(resolved).toEqual({ value: '5', source: 'config' });
    });
  });

  describe('snapshot', () => {
    it('records the correct source for every resolved value', async () => {
      const runner = fakeRunner({
        'git branch --show-current': 'feat/42-slug',
      });
      const store = createStore(
        {
          defaults: {
            baseBranch: 'main',
            reviewers: ['alice'],
          },
          workflow: {
            stages: [{ key: 'design', name: 'In design' }],
          },
        },
        runner
      );
      store.setContext({ board_id: 'PVT_session', default_assignee: 'bob' });

      const snapshot = await store.snapshot();

      expect(snapshot.repo).toEqual({ value: 'unset', source: 'unset' });
      expect(snapshot.board_id).toEqual({
        value: 'PVT_session',
        source: 'session',
      });
      expect(snapshot.active_issue).toEqual({ value: '42', source: 'derived' });
      expect(snapshot.default_base).toEqual({ value: 'main', source: 'config' });
      expect(snapshot.default_reviewers).toEqual({
        value: ['alice'],
        source: 'config',
      });
      expect(snapshot.default_assignee).toEqual({ value: 'bob', source: 'session' });
      expect(snapshot.default_merge_method).toEqual({
        value: 'unset',
        source: 'unset',
      });
      expect(snapshot.default_milestone).toEqual({
        value: 'unset',
        source: 'unset',
      });
      expect(snapshot.workflow).toEqual({
        value: { stages: [{ key: 'design', name: 'In design' }] },
        source: 'config',
      });
    });
  });

  describe('scope resolution', () => {
    it('resolves a scope containing repo and boardId', async () => {
      const store = createStore(
        { repo: 'acme/widgets', boardId: 'PVT_1' },
        fakeRunner({})
      );

      const scope = await store.resolveScope();
      expect(scope).toEqual({
        repo: { owner: 'acme', repo: 'widgets' },
        boardId: 'PVT_1',
      });
    });

    it('omits missing keys from the resolved scope', async () => {
      const store = createStore({ boardId: 'PVT_1' }, fakeRunner({}));

      const scope = await store.resolveScope();
      expect(scope).toEqual({ boardId: 'PVT_1' });
    });

    it('throws when a required scope key is missing', async () => {
      const store = createStore({ boardId: 'PVT_1' }, fakeRunner({}));

      await expect(store.requireScope(['repo'])).rejects.toThrow('repo');
    });

    it('throws when board scope is required but missing', async () => {
      const store = createStore({ repo: 'acme/widgets' }, fakeRunner({}));

      await expect(store.requireScope(['board'])).rejects.toThrow('board');
    });

    it('returns the scope when all required keys are present', async () => {
      const store = createStore(
        { repo: 'acme/widgets', boardId: 'PVT_1' },
        fakeRunner({})
      );

      const scope = await store.requireScope(['repo', 'board']);
      expect(scope).toEqual({
        repo: { owner: 'acme', repo: 'widgets' },
        boardId: 'PVT_1',
      });
    });
  });

  describe('caching', () => {
    it('caches repo derivation per instance', async () => {
      let remoteCalls = 0;
      const runner = (async (cmd: string, args: string[]) => {
        if (cmd === 'git' && args[0] === 'remote' && args[1] === 'get-url') {
          remoteCalls++;
          return 'git@github.com:acme/widgets.git';
        }
        if (cmd === 'git' && args[0] === 'branch' && args[1] === '--show-current') {
          return 'feat/42-slug';
        }
        throw new Error('unexpected command');
      }) as typeof run;

      const store = createStore({}, runner);
      await store.resolveRepo();
      await store.resolveRepo();
      const snapshot = await store.snapshot();

      expect(remoteCalls).toBe(1);
      expect(snapshot.repo).toEqual({
        value: { owner: 'acme', repo: 'widgets' },
        source: 'derived',
      });
    });
  });
});

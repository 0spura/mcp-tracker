import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../../src/context/config.js';
import { ConfigError } from '../../src/core/errors.js';

describe('loadConfig', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'mcp-tracker-config-'));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('returns an empty config when both files are missing', async () => {
    const config = await loadConfig(cwd);
    expect(config).toEqual({});
  });

  it('loads the nested versioned config file', async () => {
    writeFileSync(
      join(cwd, '.mcp-tracker.json'),
      JSON.stringify({
        repo: 'acme/widgets',
        boardId: 'PVT_1',
        defaults: {
          baseBranch: 'main',
          mergeMethod: 'squash',
          reviewers: ['alice'],
          assignee: 'bob',
          milestone: 'v1',
          labels: ['todo'],
        },
        workflow: {
          stages: [
            { key: 'design', name: 'In design' },
            { key: 'doing', name: 'Doing', id: 'opt_123' },
          ],
          on: {
            createIssue: 'design',
            createBranch: 'doing',
            createPr: 'review',
          },
        },
      })
    );

    const config = await loadConfig(cwd);
    expect(config).toEqual({
      repo: 'acme/widgets',
      boardId: 'PVT_1',
      defaults: {
        baseBranch: 'main',
        mergeMethod: 'squash',
        reviewers: ['alice'],
        assignee: 'bob',
        milestone: 'v1',
        labels: ['todo'],
      },
      workflow: {
        stages: [
          { key: 'design', name: 'In design' },
          { key: 'doing', name: 'Doing', id: 'opt_123' },
        ],
        on: {
          createIssue: 'design',
          createBranch: 'doing',
          createPr: 'review',
        },
      },
    });
  });

  it('rejects activeIssue in the versioned config file', async () => {
    writeFileSync(
      join(cwd, '.mcp-tracker.json'),
      JSON.stringify({ activeIssue: '42' })
    );

    await expect(loadConfig(cwd)).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(ConfigError);
      const configErr = err as ConfigError;
      expect(configErr.filePath).toContain('.mcp-tracker.json');
      expect(configErr.issue.toLowerCase()).toContain('activeissue');
      return true;
    });
  });

  it('merges typeLabels key by key with the local file winning', async () => {
    writeFileSync(
      join(cwd, '.mcp-tracker.json'),
      JSON.stringify({ typeLabels: { feat: 'feature', fix: 'bug' } })
    );
    writeFileSync(
      join(cwd, '.mcp-tracker.local.json'),
      JSON.stringify({ typeLabels: { fix: 'defect' } })
    );

    const config = await loadConfig(cwd);
    expect(config.typeLabels).toEqual({ feat: 'feature', fix: 'defect' });
  });

  it('allows activeIssue in the local config file', async () => {
    writeFileSync(
      join(cwd, '.mcp-tracker.local.json'),
      JSON.stringify({ activeIssue: 'PROJ-42' })
    );

    const config = await loadConfig(cwd);
    expect(config.activeIssue).toBe('PROJ-42');
  });

  it('throws ConfigError for invalid JSON', async () => {
    writeFileSync(join(cwd, '.mcp-tracker.json'), '{ not json');

    await expect(loadConfig(cwd)).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(ConfigError);
      const configErr = err as ConfigError;
      expect(configErr.filePath).toContain('.mcp-tracker.json');
      expect(configErr.issue).toContain('JSON');
      return true;
    });
  });

  it('throws ConfigError for a schema mismatch', async () => {
    writeFileSync(
      join(cwd, '.mcp-tracker.json'),
      JSON.stringify({ defaults: { mergeMethod: 'fast-forward' } })
    );

    await expect(loadConfig(cwd)).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(ConfigError);
      const configErr = err as ConfigError;
      expect(configErr.filePath).toContain('.mcp-tracker.json');
      expect(configErr.issue).toContain('mergeMethod');
      return true;
    });
  });

  it('names the local file when the local file is invalid', async () => {
    writeFileSync(
      join(cwd, '.mcp-tracker.json'),
      JSON.stringify({ repo: 'acme/widgets' })
    );
    writeFileSync(join(cwd, '.mcp-tracker.local.json'), '{ bad');

    await expect(loadConfig(cwd)).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(ConfigError);
      const configErr = err as ConfigError;
      expect(configErr.filePath).toContain('.mcp-tracker.local.json');
      return true;
    });
  });

  it('deep-merges the local file over the versioned file', async () => {
    writeFileSync(
      join(cwd, '.mcp-tracker.json'),
      JSON.stringify({
        repo: 'acme/widgets',
        boardId: 'PVT_base',
        defaults: {
          baseBranch: 'main',
          reviewers: ['alice'],
          assignee: 'bob',
          labels: ['todo'],
        },
        workflow: {
          stages: [
            { key: 'design', name: 'In design' },
            { key: 'doing', name: 'Doing' },
          ],
          on: {
            createIssue: 'design',
          },
        },
      })
    );
    writeFileSync(
      join(cwd, '.mcp-tracker.local.json'),
      JSON.stringify({
        boardId: 'PVT_local',
        defaults: {
          mergeMethod: 'rebase',
          labels: ['agent'],
        },
        workflow: {
          stages: [
            { key: 'doing', name: 'In Progress' },
            { key: 'review', name: 'In Review' },
          ],
          on: {
            createPr: 'review',
          },
        },
      })
    );

    const config = await loadConfig(cwd);
    expect(config).toEqual({
      repo: 'acme/widgets',
      boardId: 'PVT_local',
      defaults: {
        baseBranch: 'main',
        reviewers: ['alice'],
        assignee: 'bob',
        mergeMethod: 'rebase',
        labels: ['todo', 'agent'],
      },
      workflow: {
        stages: [
          { key: 'design', name: 'In design' },
          { key: 'doing', name: 'In Progress' },
          { key: 'review', name: 'In Review' },
        ],
        on: {
          createIssue: 'design',
          createPr: 'review',
        },
      },
    });
  });
});

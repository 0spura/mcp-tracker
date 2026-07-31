import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IssueProvider } from '../../src/domains/issues/capabilities.js';
import { createLocalIssueProvider } from '../../src/domains/issues/local.js';

/**
 * Shared IssueProvider contract suite. Every implementation runs the same
 * scenarios; add a provider by instantiating runIssueProviderContract with
 * its factory and setup/teardown. github-projects is covered by its
 * dedicated fake-transport unit tests until a fixture-backed instance of
 * this suite is wired (tracked as future work).
 */
export function runIssueProviderContract(
  name: string,
  setup: () => Promise<{ provider: IssueProvider; cleanup: () => Promise<void> }>
): void {
  describe(`IssueProvider contract: ${name}`, () => {
    let provider: IssueProvider;
    let cleanup: () => Promise<void>;
    const scope = {};

    beforeEach(async () => {
      ({ provider, cleanup } = await setup());
    });
    afterEach(async () => {
      await cleanup();
    });

    it('creates an issue with a string id and normalized state', async () => {
      const { issue, warnings } = await provider.createIssue(scope, 'Title', 'Body');
      expect(typeof issue.id).toBe('string');
      expect(['open', 'closed']).toContain(issue.state);
      expect(Array.isArray(warnings)).toBe(true);
    });

    it('gets back what it created', async () => {
      const { issue } = await provider.createIssue(scope, 'Round trip', 'Some body');
      const read = await provider.getIssue(scope, issue.id);
      expect(read.title).toBe('Round trip');
      expect(read.body).toBe('Some body');
    });

    it('lists issues filtered by state', async () => {
      const { issue } = await provider.createIssue(scope, 'To close', 'b');
      await provider.updateIssue(scope, issue.id, { state: 'closed' });
      const open = await provider.listIssues(scope, { state: 'open' });
      const closed = await provider.listIssues(scope, { state: 'closed' });
      expect(open.map((i) => i.id)).not.toContain(issue.id);
      expect(closed.map((i) => i.id)).toContain(issue.id);
    });

    it('updates title and labels', async () => {
      const { issue } = await provider.createIssue(scope, 'Old', 'b', { labels: ['a'] });
      const { issue: updated } = await provider.updateIssue(scope, issue.id, {
        title: 'New',
        labels: ['b', 'c'],
      });
      expect(updated.title).toBe('New');
      expect(updated.labels).toEqual(['b', 'c']);
    });

    it('stores and lists comments', async () => {
      const { issue } = await provider.createIssue(scope, 't', 'b');
      await provider.addIssueComment(scope, issue.id, 'hello');
      const comments = await provider.listIssueComments(scope, issue.id);
      expect(comments.map((c) => c.body)).toContain('hello');
    });

    it('errors clearly on a missing issue', async () => {
      await expect(provider.getIssue(scope, '999999')).rejects.toThrow();
    });
  });
}

runIssueProviderContract('local', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-tracker-contract-'));
  return {
    provider: createLocalIssueProvider(dir),
    cleanup: () => fs.rm(dir, { recursive: true, force: true }),
  };
});

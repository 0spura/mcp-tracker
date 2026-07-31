import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLocalIssueProvider } from '../../../src/domains/issues/local.js';
import type { IssueProvider } from '../../../src/domains/issues/capabilities.js';

let dir: string;
let provider: IssueProvider;
const scope = {};

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-tracker-'));
  provider = createLocalIssueProvider(dir);
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('local issue provider', () => {
  it('creates and reads an issue with sequential ids', async () => {
    const a = await provider.createIssue(scope, 'First', 'body one');
    const b = await provider.createIssue(scope, 'Second', 'body two');
    expect(a.issue.id).toBe('1');
    expect(b.issue.id).toBe('2');
    const read = await provider.getIssue(scope, '1');
    expect(read.title).toBe('First');
    expect(read.body).toBe('body one');
  });

  it('round-trips hostile titles through the file on disk', async () => {
    const title = 'Fix "quoted" \\ backslash — ünïcode 100%';
    const { issue } = await provider.createIssue(scope, title, 'body');
    const read = await provider.getIssue(scope, issue.id);
    expect(read.title).toBe(title);
  });

  it('renames the file when the title changes', async () => {
    const { issue } = await provider.createIssue(scope, 'old name', 'b');
    await provider.updateIssue(scope, issue.id, { title: 'new name' });
    const files = await fs.readdir(dir);
    expect(files.some((f) => f.startsWith(`${issue.id}-new-name`))).toBe(true);
    expect(files.some((f) => f.includes('old-name'))).toBe(false);
  });

  it('applies composite create options to frontmatter', async () => {
    const { issue } = await provider.createIssue(scope, 't', 'b', {
      labels: ['bug'],
      status: 'design',
      blocks: ['9'],
      parent: '5',
      fields: { Size: 'M' },
    });
    const stored = await fs.readFile(
      path.join(dir, (await fs.readdir(dir))[0]),
      'utf8'
    );
    expect(stored).toContain('"design"');
    expect(issue.labels).toEqual(['bug']);
  });

  it('supports batch relationship ops on update', async () => {
    const { issue } = await provider.createIssue(scope, 't', 'b', { blocks: ['1'] });
    await provider.updateIssue(scope, issue.id, {
      add_blocks: ['2'],
      remove_blocks: ['1'],
      add_related: ['3'],
    });
    const stored = await fs.readFile(
      path.join(dir, (await fs.readdir(dir))[0]),
      'utf8'
    );
    const meta = JSON.parse(stored.split('---\n')[1]);
    expect(meta.relationships.blocks).toEqual(['2']);
    expect(meta.relationships.related).toEqual(['3']);
  });

  it('survives concurrent comment writes without corruption', async () => {
    const { issue } = await provider.createIssue(scope, 't', 'b');
    await Promise.all([
      provider.addIssueComment(scope, issue.id, 'comment A'),
      provider.addIssueComment(scope, issue.id, 'comment B'),
      provider.addIssueComment(scope, issue.id, 'comment C'),
    ]);
    const comments = await provider.listIssueComments(scope, issue.id);
    const bodies = comments.map((c) => c.body);
    expect(bodies).toContain('comment A');
    expect(bodies).toContain('comment B');
    expect(bodies).toContain('comment C');
    const leftovers = (await fs.readdir(dir)).filter((f) => f.includes('.tmp-'));
    expect(leftovers).toEqual([]);
  });

  it('toggles checklist items via shared logic', async () => {
    const { issue } = await provider.createIssue(scope, 't', '- [ ] write tests\n- [ ] docs');
    const result = await provider.toggleChecklistItem!(scope, issue.id, 'tests');
    expect(result.checked).toBe(true);
    const read = await provider.getIssue(scope, issue.id);
    expect(read.body).toContain('- [x] write tests');
  });

  it('tracks status and sub-issues', async () => {
    const parent = await provider.createIssue(scope, 'parent', 'b');
    const child = await provider.createIssue(scope, 'child', 'b');
    await provider.setIssueStatus(scope, parent.issue.id, 'doing');
    await provider.addSubIssue!(scope, parent.issue.id, child.issue.id);
    const subs = await provider.listSubIssues!(scope, parent.issue.id);
    expect(subs.map((s) => s.id)).toEqual([child.issue.id]);
  });

  it('lists labels from actual usage and refuses milestones', async () => {
    await provider.createIssue(scope, 't', 'b', { labels: ['bug', 'agent'] });
    const labels = await provider.listLabels!(scope);
    expect(labels.map((l) => l.name)).toEqual(['agent', 'bug']);
    await expect(provider.listMilestones!(scope)).rejects.toThrow(/milestones/);
  });
});

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Comment, ItemId } from '../../core/types.js';

/**
 * Local markdown storage: one `<id>-<slug>.md` file per issue.
 * The frontmatter block is JSON between `---` markers (YAML is a JSON
 * superset), so parse and serialize are exact inverses with no ad-hoc
 * escaping. Writes are atomic (temp file + rename) and serialized through
 * a per-path async mutex so concurrent tool calls cannot corrupt a file.
 */

export interface IssueMeta {
  id: ItemId;
  title: string;
  state: 'open' | 'closed';
  labels: string[];
  assignees: string[];
  milestone: string | null;
  status: string | null;
  relationships: {
    blocks: ItemId[];
    blocked_by: ItemId[];
    related: ItemId[];
    duplicate_of: ItemId | null;
  };
  parent: ItemId | null;
  fields: Record<string, string>;
}

export interface StoredIssue {
  meta: IssueMeta;
  body: string;
  comments: Comment[];
  filePath: string;
}

const COMMENTS_HEADING = '## Comments';
const mutexes = new Map<string, Promise<void>>();

export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/g, '');
  return slug || 'issue';
}

export function fileNameFor(id: ItemId, title: string): string {
  return `${id}-${slugify(title)}.md`;
}

export function serialize(meta: IssueMeta, body: string, comments: Comment[]): string {
  const { filePath: _ignored, ...cleanMeta } = meta as IssueMeta & { filePath?: string };
  const fm = JSON.stringify(cleanMeta, null, 2);
  const commentBlocks = comments
    .map((c) => `### ${c.createdAt} — ${c.author}\n\n${c.body.trim()}\n`)
    .join('\n');
  return `---\n${fm}\n---\n\n${body.trim()}\n\n${COMMENTS_HEADING}\n\n${commentBlocks}`;
}

export function parse(content: string, filePath: string): StoredIssue {
  const fmMatch = /^---\n([\s\S]*?)\n---\n?/.exec(content);
  if (!fmMatch) throw new Error(`invalid issue file ${filePath}: missing frontmatter`);
  let meta: IssueMeta;
  try {
    meta = JSON.parse(fmMatch[1]) as IssueMeta;
  } catch (err) {
    throw new Error(`invalid issue file ${filePath}: bad frontmatter JSON`);
  }
  const rest = content.slice(fmMatch[0].length);
  const commentsIdx = rest.indexOf(COMMENTS_HEADING);
  const body = (commentsIdx === -1 ? rest : rest.slice(0, commentsIdx)).trim();
  const comments: Comment[] = [];
  if (commentsIdx !== -1) {
    const section = rest.slice(commentsIdx + COMMENTS_HEADING.length);
    const blocks = section.split(/^### /m).slice(1);
    for (const block of blocks) {
      const nl = block.indexOf('\n');
      const header = nl === -1 ? block : block.slice(0, nl);
      const text = nl === -1 ? '' : block.slice(nl + 1).trim();
      const sep = header.indexOf(' — ');
      comments.push({
        id: header.trim(),
        createdAt: sep === -1 ? header.trim() : header.slice(0, sep).trim(),
        author: sep === -1 ? 'local' : header.slice(sep + 3).trim(),
        body: text,
      });
    }
  }
  return { meta, body, comments, filePath };
}

async function withMutex<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = mutexes.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  mutexes.set(key, prev.then(() => gate));
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (mutexes.get(key) !== undefined) {
      // Clean up when nothing is queued behind us.
      const current = mutexes.get(key);
      void current?.then(() => {
        if (mutexes.get(key) === current) mutexes.delete(key);
      });
    }
  }
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, content, 'utf8');
  await fs.rename(tmp, filePath);
}

function resolveInside(dir: string, ...segments: string[]): string {
  const resolved = path.resolve(dir, ...segments);
  const root = path.resolve(dir);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`path escapes task directory: ${resolved}`);
  }
  return resolved;
}

export class IssueStore {
  constructor(readonly dir: string) {}

  async ensureDir(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
  }

  async list(): Promise<StoredIssue[]> {
    await this.ensureDir();
    const names = (await fs.readdir(this.dir)).filter(
      (n) => n.endsWith('.md') && !n.includes('.tmp-')
    );
    const issues: StoredIssue[] = [];
    for (const name of names.sort()) {
      const content = await fs.readFile(resolveInside(this.dir, name), 'utf8');
      issues.push(parse(content, resolveInside(this.dir, name)));
    }
    return issues;
  }

  async get(id: ItemId): Promise<StoredIssue> {
    const all = await this.list();
    const found = all.find((i) => i.meta.id === id);
    if (!found) throw new Error(`issue ${id} not found in ${this.dir}`);
    return found;
  }

  async nextId(): Promise<ItemId> {
    const all = await this.list();
    const max = all.reduce((acc, i) => {
      const n = Number(i.meta.id);
      return Number.isFinite(n) && n > acc ? n : acc;
    }, 0);
    return String(max + 1);
  }

  /** Serialized, atomic write; renames the file when the title changed. */
  async save(issue: StoredIssue): Promise<StoredIssue> {
    return withMutex(resolveInside(this.dir), async () => {
      await this.ensureDir();
      const target = resolveInside(this.dir, fileNameFor(issue.meta.id, issue.meta.title));
      const content = serialize(issue.meta, issue.body, issue.comments);
      await atomicWrite(target, content);
      const old = path.resolve(issue.filePath);
      if (old !== target) {
        await fs.rm(old, { force: true });
      }
      return { ...issue, filePath: target };
    });
  }

  /** Read-modify-write under one mutex: no lost updates under concurrency. */
  async update(
    id: ItemId,
    mutate: (issue: StoredIssue) => void | Promise<void>
  ): Promise<StoredIssue> {
    return withMutex(resolveInside(this.dir), async () => {
      const stored = await this.get(id);
      await mutate(stored);
      return this.saveUnlocked(stored);
    });
  }

  private async saveUnlocked(issue: StoredIssue): Promise<StoredIssue> {
    await this.ensureDir();
    const target = resolveInside(this.dir, fileNameFor(issue.meta.id, issue.meta.title));
    const content = serialize(issue.meta, issue.body, issue.comments);
    await atomicWrite(target, content);
    const old = path.resolve(issue.filePath);
    if (old !== target) {
      await fs.rm(old, { force: true });
    }
    return { ...issue, filePath: target };
  }

  async create(meta: IssueMeta, body: string): Promise<StoredIssue> {
    return withMutex(resolveInside(this.dir), async () => {
      await this.ensureDir();
      const filePath = resolveInside(this.dir, fileNameFor(meta.id, meta.title));
      await atomicWrite(filePath, serialize(meta, body, []));
      return { meta, body, comments: [], filePath };
    });
  }
}

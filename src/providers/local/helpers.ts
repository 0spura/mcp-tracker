import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from "fs";
import { execSync } from "child_process";
import * as path from "path";
import type { Issue, Label, Milestone } from "../../interfaces/types.js";

export interface CommentData {
  id: number;
  author: string;
  body: string;
  createdAt: string;
}

export interface LocalMeta {
  id: number;
  title: string;
  status: string;
  labels: string[];
  assignees: string[];
  milestone: string | null;
  blocks: number[];
  blocked_by: number[];
  related: number[];
  duplicate_of: number | null;
  created_at: string;
  updated_at: string;
}

const COMMENTS_TAG = "<!-- @comments";

export function getTaskDir(): string {
  const env = process.env.LOCAL_TASK_DIR;
  if (env) return path.resolve(env);
  try {
    const root = execSync("git rev-parse --show-toplevel", {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return path.join(root, ".tasks");
  } catch {
    return path.join(process.cwd(), ".tasks");
  }
}

export function ensureDir(): string {
  const dir = getTaskDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50);
}

export function issueFilePath(dir: string, id: number, title: string): string {
  return path.join(dir, `${String(id).padStart(4, "0")}-${slugify(title)}.md`);
}

export function findFilePath(dir: string, id: number): string | null {
  if (!existsSync(dir)) return null;
  const prefix = String(id).padStart(4, "0") + "-";
  const file = readdirSync(dir).find(f => f.startsWith(prefix) && f.endsWith(".md"));
  return file ? path.join(dir, file) : null;
}

export function listFilePaths(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => /^\d{4}-/.test(f) && f.endsWith(".md"))
    .sort()
    .map(f => path.join(dir, f));
}

export function nextId(dir: string): number {
  const files = listFilePaths(dir);
  if (!files.length) return 1;
  return parseInt(path.basename(files[files.length - 1]).slice(0, 4), 10) + 1;
}

// --- Frontmatter ---

function parseLine(raw: string): unknown {
  const v = raw.trim();
  if (!v || v === "null") return null;
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  if (v.startsWith("[")) {
    const inner = v.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map(s => parseLine(s.trim()));
  }
  return v.replace(/^["']|["']$/g, "");
}

function parseFrontmatter(content: string): { meta: Record<string, unknown>; rest: string } {
  const m = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { meta: {}, rest: content };
  const meta: Record<string, unknown> = {};
  for (const line of m[1].split("\n")) {
    // match key: value where value may contain colons (e.g. quoted title)
    const match = line.match(/^(\S+):\s*(.*)/);
    if (!match) continue;
    meta[match[1]] = parseLine(match[2]);
  }
  return { meta, rest: m[2] };
}

function serializeMeta(meta: LocalMeta): string {
  const arr = (v: number[]) => v.length ? `[${v.join(", ")}]` : "[]";
  const sarr = (v: string[]) => v.length ? `[${v.join(", ")}]` : "[]";
  return [
    `id: ${meta.id}`,
    `title: "${meta.title.replace(/"/g, '\\"')}"`,
    `status: ${meta.status}`,
    `labels: ${sarr(meta.labels)}`,
    `assignees: ${sarr(meta.assignees)}`,
    `milestone: ${meta.milestone ?? "null"}`,
    `blocks: ${arr(meta.blocks)}`,
    `blocked_by: ${arr(meta.blocked_by)}`,
    `related: ${arr(meta.related)}`,
    `duplicate_of: ${meta.duplicate_of ?? "null"}`,
    `created_at: ${meta.created_at}`,
    `updated_at: ${meta.updated_at}`,
  ].join("\n");
}

// --- Comments block (stored at end of body, outside frontmatter) ---

function extractComments(text: string): { body: string; comments: CommentData[] } {
  const idx = text.lastIndexOf(COMMENTS_TAG);
  if (idx === -1) return { body: text, comments: [] };
  const end = text.indexOf("-->", idx);
  const json = text.slice(idx + COMMENTS_TAG.length, end).trim();
  return {
    body: text.slice(0, idx).trimEnd(),
    comments: json ? (JSON.parse(json) as CommentData[]) : [],
  };
}

function injectComments(body: string, comments: CommentData[]): string {
  if (!comments.length) return body;
  return `${body}\n\n${COMMENTS_TAG}\n${JSON.stringify(comments)}\n-->`;
}

// --- Read / write ---

export function readFile(filePath: string): { meta: LocalMeta; body: string; comments: CommentData[] } {
  const content = readFileSync(filePath, "utf8");
  const { meta, rest } = parseFrontmatter(content);
  const { body, comments } = extractComments(rest);
  return {
    meta: {
      id: meta.id as number,
      title: meta.title as string,
      status: (meta.status as string) ?? "open",
      labels: (meta.labels as string[]) ?? [],
      assignees: (meta.assignees as string[]) ?? [],
      milestone: (meta.milestone as string | null) ?? null,
      blocks: (meta.blocks as number[]) ?? [],
      blocked_by: (meta.blocked_by as number[]) ?? [],
      related: (meta.related as number[]) ?? [],
      duplicate_of: (meta.duplicate_of as number | null) ?? null,
      created_at: meta.created_at as string,
      updated_at: meta.updated_at as string,
    },
    body,
    comments,
  };
}

export function writeFile(filePath: string, meta: LocalMeta, body: string, comments: CommentData[]): void {
  writeFileSync(filePath, `---\n${serializeMeta(meta)}\n---\n${injectComments(body, comments)}\n`, "utf8");
}

export function toIssue(meta: LocalMeta, body: string, filePath: string): Issue {
  return {
    number: meta.id,
    title: meta.title,
    body,
    state: meta.status === "closed" ? "closed" : "open",
    url: path.relative(process.cwd(), filePath),
    labels: meta.labels,
  };
}

export function collectLabels(dir: string): Label[] {
  const seen = new Map<string, Label>();
  for (const fp of listFilePaths(dir)) {
    const { meta } = readFile(fp);
    for (const name of meta.labels) {
      if (!seen.has(name)) seen.set(name, { name, color: "", description: "" });
    }
  }
  return [...seen.values()];
}

export function collectMilestones(dir: string): Milestone[] {
  const seen = new Map<string, Milestone>();
  let n = 1;
  for (const fp of listFilePaths(dir)) {
    const { meta } = readFile(fp);
    if (meta.milestone && !seen.has(meta.milestone)) {
      seen.set(meta.milestone, { number: n++, title: meta.milestone, state: "open", dueOn: null });
    }
  }
  return [...seen.values()];
}

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { ConfigError } from '../core/errors.js';

export type MergeMethod = 'merge' | 'squash' | 'rebase';

const mergeMethodSchema = z.enum(['merge', 'squash', 'rebase']);

const stageSchema = z.object({
  key: z.string(),
  name: z.string(),
  id: z.string().optional(),
});

const workflowSchema = z.object({
  stages: z.array(stageSchema).optional(),
  on: z
    .object({
      createIssue: z.string().optional(),
      createBranch: z.string().optional(),
      createPr: z.string().optional(),
      mergePr: z.string().optional(),
      reviewApproved: z.string().optional(),
    })
    .optional(),
});

const defaultsSchema = z.object({
  baseBranch: z.string().optional(),
  mergeMethod: mergeMethodSchema.optional(),
  reviewers: z.array(z.string()).optional(),
  assignee: z.string().optional(),
  milestone: z.string().optional(),
  labels: z.array(z.string()).optional(),
});

const versionedShape = {
  codeProvider: z.string().optional(),
  taskProvider: z.string().optional(),
  localTaskDir: z.string().optional(),
  repo: z.string().optional(),
  boardId: z.string().optional(),
  defaults: defaultsSchema.optional(),
  workflow: workflowSchema.optional(),
  typeLabels: z.record(z.string()).optional(),
};

const localShape = {
  ...versionedShape,
  activeIssue: z.string().optional(),
};

const versionedRawSchema = z.object(versionedShape).strict();
const localRawSchema = z.object(localShape).strict();

export interface TrackerDefaults {
  baseBranch?: string;
  mergeMethod?: MergeMethod;
  reviewers?: string[];
  assignee?: string;
  milestone?: string;
  labels?: string[];
}

export interface TrackerWorkflowStage {
  key: string;
  name: string;
  id?: string;
}

export interface TrackerWorkflow {
  stages?: TrackerWorkflowStage[];
  on?: Partial<
    Record<
      'createIssue' | 'createBranch' | 'createPr' | 'mergePr' | 'reviewApproved',
      string
    >
  >;
}

export interface TrackerConfig {
  codeProvider?: string;
  taskProvider?: string;
  localTaskDir?: string;
  repo?: string;
  boardId?: string;
  activeIssue?: string;
  defaults?: TrackerDefaults;
  workflow?: TrackerWorkflow;
  typeLabels?: Record<string, string>;
}

const CONFIG_FILE = '.mcp-tracker.json';
const LOCAL_CONFIG_FILE = '.mcp-tracker.local.json';
const LOCAL_GITIGNORE_ENTRY = '.mcp-tracker.local.json';

/**
 * Load and validate the versioned config and the gitignored local override.
 *
 * Missing files are treated as empty configs. Invalid JSON or schema mismatches
 * throw ConfigError with the file path and a descriptive issue. The local file
 * is deep-merged over the versioned file field by field; workflow stages merge
 * by key.
 */
export async function loadConfig(cwd: string = process.cwd()): Promise<TrackerConfig> {
  const base = await loadConfigFile(join(cwd, CONFIG_FILE), versionedRawSchema);
  const local = await loadConfigFile(join(cwd, LOCAL_CONFIG_FILE), localRawSchema);

  await ensureLocalGitignoreEntry(cwd);

  return mergeConfigs(base, local);
}

async function loadConfigFile<T extends z.ZodTypeAny>(
  filePath: string,
  schema: T
): Promise<z.infer<T>> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return {} as z.infer<T>;
    }
    throw new ConfigError(filePath, `unable to read file: ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(filePath, `invalid JSON: ${(err as Error).message}`);
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new ConfigError(filePath, result.error.message);
  }

  return result.data as z.infer<T>;
}

function mergeConfigs(base: TrackerConfig, override: TrackerConfig): TrackerConfig {
  const merged: TrackerConfig = {};

  for (const key of ['codeProvider', 'taskProvider', 'localTaskDir'] as const) {
    if (base[key] !== undefined || override[key] !== undefined) {
      merged[key] = override[key] ?? base[key];
    }
  }
  if (base.repo !== undefined || override.repo !== undefined) {
    merged.repo = override.repo ?? base.repo;
  }
  if (base.boardId !== undefined || override.boardId !== undefined) {
    merged.boardId = override.boardId ?? base.boardId;
  }
  if (override.activeIssue !== undefined) {
    merged.activeIssue = override.activeIssue;
  }

  const mergedDefaults = mergeDefaults(base.defaults, override.defaults);
  if (mergedDefaults !== undefined) {
    merged.defaults = mergedDefaults;
  }

  const mergedWorkflow = mergeWorkflow(base.workflow, override.workflow);
  if (mergedWorkflow !== undefined) {
    merged.workflow = mergedWorkflow;
  }

  if (base.typeLabels !== undefined || override.typeLabels !== undefined) {
    merged.typeLabels = { ...base.typeLabels, ...override.typeLabels };
  }

  return merged;
}

function mergeDefaults(
  base: TrackerDefaults | undefined,
  override: TrackerDefaults | undefined
): TrackerDefaults | undefined {
  if (!base && !override) {
    return undefined;
  }

  const merged: TrackerDefaults = { ...base };
  if (!override) {
    return merged;
  }

  const keys: Array<keyof TrackerDefaults> = [
    'baseBranch',
    'mergeMethod',
    'reviewers',
    'assignee',
    'milestone',
  ];
  for (const key of keys) {
    if (override[key] !== undefined) {
      (merged as unknown as Record<string, TrackerDefaults[keyof TrackerDefaults]>)[key] =
        override[key];
    }
  }

  // Labels are additive by nature: project labels live in the versioned file,
  // personal labels in the local one; the merged config carries both.
  if (base?.labels !== undefined || override.labels !== undefined) {
    merged.labels = [...new Set([...(base?.labels ?? []), ...(override.labels ?? [])])];
  }

  return merged;
}

function mergeWorkflow(
  base: TrackerWorkflow | undefined,
  override: TrackerWorkflow | undefined
): TrackerWorkflow | undefined {
  if (!base && !override) {
    return undefined;
  }

  const stageMap = new Map<string, TrackerWorkflowStage>();
  for (const stage of base?.stages ?? []) {
    stageMap.set(stage.key, { ...stage });
  }
  for (const stage of override?.stages ?? []) {
    stageMap.set(stage.key, { ...stage });
  }

  const merged: TrackerWorkflow = {
    stages: Array.from(stageMap.values()),
  };

  const on = { ...(base?.on ?? {}), ...(override?.on ?? {}) };
  if (Object.keys(on).length > 0) {
    merged.on = on;
  }

  return merged;
}

async function ensureLocalGitignoreEntry(cwd: string): Promise<void> {
  const gitignorePath = join(cwd, '.gitignore');
  let content: string;
  try {
    content = await readFile(gitignorePath, 'utf8');
  } catch {
    return;
  }

  const lines = content.split('\n').map((line) => line.trim());
  if (lines.includes(LOCAL_GITIGNORE_ENTRY)) {
    return;
  }

  const separator = content.endsWith('\n') ? '' : '\n';
  await writeFile(gitignorePath, `${content}${separator}${LOCAL_GITIGNORE_ENTRY}\n`);
}

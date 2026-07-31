import { z } from 'zod';
import type { ContextStore } from '../context/store.js';
import type { Scope } from '../core/scope.js';
import type { ItemId } from '../core/types.js';

export const REPO_PARAM = z
  .string()
  .optional()
  .describe('owner/repo. Omit to auto-resolve from git/context.');

export const ISSUE_NUMBER_PARAM = z
  .number()
  .int()
  .positive()
  .optional()
  .describe('Defaults to active issue.');

export const BOARD_ID_PARAM = z
  .string()
  .optional()
  .describe('Board ID. Uses context if set.');

type Result = { content: Array<{ type: 'text'; text: string }> };

export function json(value: unknown): Result {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

export function text(message: string): Result {
  return { content: [{ type: 'text', text: message }] };
}

/** Resolve the issue id for tools that default to the active issue. */
export async function resolveIssueId(
  ctx: ContextStore,
  explicit?: number
): Promise<ItemId> {
  const resolved = await ctx.resolveActiveIssue(
    explicit !== undefined ? String(explicit) : undefined
  );
  if (resolved.value === 'unset') {
    throw new Error('no active issue; pass an issue number or set active_issue in context');
  }
  return resolved.value;
}

/** Resolve scope from context, requiring the provider's declared keys. */
export async function resolveScope(
  ctx: ContextStore,
  requires: Array<'repo' | 'board'>,
  explicitRepo?: string,
  explicitBoard?: string
): Promise<Scope> {
  const scope = await ctx.resolveScope();
  if (explicitRepo !== undefined) {
    const [owner, repo] = explicitRepo.split('/');
    scope.repo = { owner, repo };
  }
  if (explicitBoard !== undefined) scope.boardId = explicitBoard;
  for (const key of requires) {
    if (key === 'repo' && !scope.repo) {
      throw new Error('this provider requires a repo; pass repo or set it in context');
    }
    if (key === 'board' && !scope.boardId) {
      throw new Error('this tool requires a board; pass board_id or set it in context');
    }
  }
  return scope;
}

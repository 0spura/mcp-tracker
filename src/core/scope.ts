import type { TrackerRepo } from './types.js';

export interface Scope {
  repo?: TrackerRepo;
  boardId?: string;
}

export type ScopeKey = 'repo' | 'board';

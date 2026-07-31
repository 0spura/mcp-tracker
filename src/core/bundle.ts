import type { ScopeKey } from './scope.js';
import type { CodeProvider } from '../domains/code/capabilities.js';
import type { IssueProvider } from '../domains/issues/capabilities.js';
import type { BoardProvider } from '../domains/boards/capabilities.js';

export interface ProviderBundle {
  requires: ScopeKey[];
  code?: CodeProvider;
  issue?: IssueProvider;
  board?: BoardProvider;
}

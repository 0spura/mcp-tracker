import type { Scope } from '../../core/scope.js';
import type { ProjectItem, ProjectField, ItemId } from '../../core/types.js';

export interface BoardProvider {
  listBoardItems(scope: Scope): Promise<ProjectItem[]>;
  listBoardFields(scope: Scope): Promise<ProjectField[]>;
  /** Explicit board membership; absent for implicit boards such as GitLab. */
  addIssueToBoard?(scope: Scope, issueId: ItemId): Promise<string>;
  setItemFields(
    scope: Scope,
    itemId: ItemId,
    fields: Record<string, string>
  ): Promise<void>;
}

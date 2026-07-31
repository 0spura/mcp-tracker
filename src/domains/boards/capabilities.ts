import type { Scope } from '../../core/scope.js';
import type { ProjectItem, ProjectField, ItemId } from '../../core/types.js';

export interface BoardProvider {
  listBoardItems(scope: Scope): Promise<ProjectItem[]>;
  listBoardFields(scope: Scope): Promise<ProjectField[]>;
  /**
   * Optional: only boards whose membership is explicit (GitHub Projects)
   * implement this. Boards where open issues appear implicitly (GitLab)
   * omit it, and the add_issue_to_board tool is not registered.
   */
  addIssueToBoard?(scope: Scope, issueId: ItemId): Promise<string>;
  setItemFields(
    scope: Scope,
    itemId: ItemId,
    fields: Record<string, string>
  ): Promise<void>;
}

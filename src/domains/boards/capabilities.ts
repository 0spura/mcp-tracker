import type { Scope } from '../../core/scope.js';
import type { ProjectItem, ProjectField, ItemId } from '../../core/types.js';

export interface BoardProvider {
  listBoardItems(scope: Scope, boardId: string): Promise<ProjectItem[]>;
  listBoardFields(scope: Scope, boardId: string): Promise<ProjectField[]>;
  addIssueToBoard(scope: Scope, issueId: ItemId, boardId: string): Promise<string>;
  setItemFields(
    scope: Scope,
    boardId: string,
    itemId: ItemId,
    fields: Record<string, string>
  ): Promise<void>;
}

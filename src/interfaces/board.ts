import type { TrackerRepo, ProjectItem, ProjectField } from "./types.js";

export interface BoardProvider {
  listBoardItems(repo: TrackerRepo, boardId: string): Promise<ProjectItem[]>;
  listBoardFields(repo: TrackerRepo, boardId: string): Promise<ProjectField[]>;
  addIssueToBoard(repo: TrackerRepo, issueNumber: number, boardId: string): Promise<string>;
  setItemFields(repo: TrackerRepo, boardId: string, itemId: string, fields: Record<string, string>): Promise<void>;
}

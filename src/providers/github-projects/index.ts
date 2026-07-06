import type { IssueProvider, ListIssuesOptions } from "../../interfaces/issue.js";
import type { BoardProvider } from "../../interfaces/board.js";
import type { MetadataProvider } from "../../interfaces/metadata.js";
import type { TrackerRepo, Issue, Label, Milestone, ProjectItem, ProjectField, RelationshipType, CreateIssueOptions, UpdateIssueOptions } from "../../interfaces/types.js";
import { listIssues, createIssue, getIssue, updateIssue, setIssueStatus, addSubIssue, listSubIssues } from "./issues.js";
import { listBoardItems, listBoardFields, addIssueToBoard, setItemFields } from "./boards.js";
import { listLabels, listMilestones, setRelationship } from "./metadata.js";
import { addIssueComment, listIssueComments, toggleChecklistItem } from "./comments.js";

export class GitHubTaskProvider implements IssueProvider, BoardProvider, MetadataProvider {
  // IssueProvider
  listIssues(repo: TrackerRepo, opts?: ListIssuesOptions) { return listIssues(repo, opts); }
  createIssue(repo: TrackerRepo, title: string, body: string, opts?: CreateIssueOptions) { return createIssue(repo, title, body, opts); }
  getIssue(repo: TrackerRepo, number: number) { return getIssue(repo, number); }
  updateIssue(repo: TrackerRepo, number: number, opts: UpdateIssueOptions) { return updateIssue(repo, number, opts); }
  setIssueStatus(repo: TrackerRepo, issueNumber: number, status: string) { return setIssueStatus(repo, issueNumber, status); }
  addIssueComment(repo: TrackerRepo, number: number, body: string) { return addIssueComment(repo, number, body); }
  listIssueComments(repo: TrackerRepo, number: number) { return listIssueComments(repo, number); }
  // IssueProvider — optional sub-capabilities
  addSubIssue(repo: TrackerRepo, parentNumber: number, childNumber: number) { return addSubIssue(repo, parentNumber, childNumber); }
  listSubIssues(repo: TrackerRepo, parentNumber: number) { return listSubIssues(repo, parentNumber); }
  toggleChecklistItem(repo: TrackerRepo, issueNumber: number, itemText: string, checked?: boolean) { return toggleChecklistItem(repo, issueNumber, itemText, checked); }
  setRelationship(repo: TrackerRepo, issueNumber: number, type: RelationshipType, targetNumber: number) { return setRelationship(repo, issueNumber, type, targetNumber); }
  // BoardProvider
  listBoardItems(repo: TrackerRepo, boardId: string) { return listBoardItems(repo, boardId); }
  listBoardFields(repo: TrackerRepo, boardId: string) { return listBoardFields(repo, boardId); }
  addIssueToBoard(repo: TrackerRepo, issueNumber: number, boardId: string) { return addIssueToBoard(repo, issueNumber, boardId); }
  setItemFields(repo: TrackerRepo, boardId: string, itemId: string, fields: Record<string, string>) { return setItemFields(repo, boardId, itemId, fields); }
  // MetadataProvider
  listLabels(repo: TrackerRepo) { return listLabels(repo); }
  listMilestones(repo: TrackerRepo, state?: "open" | "closed" | "all") { return listMilestones(repo, state); }
}

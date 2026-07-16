import type { IssueProvider, ListIssuesOptions } from "../../interfaces/issue.js";
import type { MetadataProvider } from "../../interfaces/metadata.js";
import type { TrackerRepo, Issue, Label, Milestone, RelationshipType, CreateIssueOptions, UpdateIssueOptions } from "../../interfaces/types.js";
import { listIssues, createIssue, getIssue, updateIssue, setIssueStatus, addIssueComment, listIssueComments, toggleChecklistItem, setRelationship, addSubIssue } from "./issues.js";
import { listLabels, listMilestones } from "./metadata.js";

export class GitLabTaskProvider implements IssueProvider, MetadataProvider {
  // IssueProvider
  listIssues(repo: TrackerRepo, opts?: ListIssuesOptions) { return listIssues(repo, opts); }
  createIssue(repo: TrackerRepo, title: string, body: string, opts?: CreateIssueOptions) { return createIssue(repo, title, body, opts); }
  getIssue(repo: TrackerRepo, number: number) { return getIssue(repo, number); }
  updateIssue(repo: TrackerRepo, number: number, opts: UpdateIssueOptions) { return updateIssue(repo, number, opts); }
  setIssueStatus(repo: TrackerRepo, issueNumber: number, status: string, allStatusLabels?: string[]) { return setIssueStatus(repo, issueNumber, status, allStatusLabels); }
  addIssueComment(repo: TrackerRepo, number: number, body: string) { return addIssueComment(repo, number, body); }
  listIssueComments(repo: TrackerRepo, number: number) { return listIssueComments(repo, number); }
  // IssueProvider — optional sub-capabilities
  addSubIssue(repo: TrackerRepo, parentNumber: number, childNumber: number) { return addSubIssue(repo, parentNumber, childNumber); }
  toggleChecklistItem(repo: TrackerRepo, issueNumber: number, itemText: string, checked?: boolean) { return toggleChecklistItem(repo, issueNumber, itemText, checked); }
  setRelationship(repo: TrackerRepo, issueNumber: number, type: RelationshipType, targetNumber: number) { return setRelationship(repo, issueNumber, type, targetNumber); }
  // MetadataProvider
  listLabels(repo: TrackerRepo) { return listLabels(repo); }
  listMilestones(repo: TrackerRepo, state?: "open" | "closed" | "all") { return listMilestones(repo, state); }
}

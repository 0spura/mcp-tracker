import type { IssueProvider, ListIssuesOptions } from "../../interfaces/issue.js";
import type { MetadataProvider } from "../../interfaces/metadata.js";
import type { TrackerRepo, Issue, Label, Milestone, RelationshipType, CreateIssueOptions, UpdateIssueOptions } from "../../interfaces/types.js";
import { listIssues, createIssue, getIssue, updateIssue, setIssueStatus, addIssueComment, listIssueComments, toggleChecklistItem, setRelationship } from "./issues.js";
import { ensureDir, collectLabels, collectMilestones } from "./helpers.js";

export class LocalTaskProvider implements IssueProvider, MetadataProvider {
  // IssueProvider
  listIssues(repo: TrackerRepo, opts?: ListIssuesOptions) { return listIssues(repo, opts); }
  createIssue(repo: TrackerRepo, title: string, body: string, opts?: CreateIssueOptions) { return createIssue(repo, title, body, opts); }
  getIssue(repo: TrackerRepo, number: number) { return getIssue(repo, number); }
  updateIssue(repo: TrackerRepo, number: number, opts: UpdateIssueOptions) { return updateIssue(repo, number, opts); }
  setIssueStatus(repo: TrackerRepo, issueNumber: number, status: string) { return setIssueStatus(repo, issueNumber, status); }
  addIssueComment(repo: TrackerRepo, number: number, body: string) { return addIssueComment(repo, number, body); }
  listIssueComments(repo: TrackerRepo, number: number) { return listIssueComments(repo, number); }
  // IssueProvider — optional sub-capabilities
  toggleChecklistItem(repo: TrackerRepo, issueNumber: number, itemText: string, checked?: boolean) { return toggleChecklistItem(repo, issueNumber, itemText, checked); }
  setRelationship(repo: TrackerRepo, issueNumber: number, type: RelationshipType, targetNumber: number) { return setRelationship(repo, issueNumber, type, targetNumber); }
  // MetadataProvider
  async listLabels(_repo: TrackerRepo): Promise<Label[]> { return collectLabels(ensureDir()); }
  async listMilestones(_repo: TrackerRepo, state?: "open" | "closed" | "all"): Promise<Milestone[]> {
    return collectMilestones(ensureDir()).filter(m => !state || state === "all" || m.state === state);
  }
}

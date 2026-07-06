import { execSync } from "child_process";
import type { TrackerRepo } from "./interfaces/types.js";

interface Context {
  repo: TrackerRepo | null;
  boardId: string | null;
  activeIssue: number | null;
  defaultAssignee: string | null;
  defaultBase: string | null;
  defaultMergeMethod: "merge" | "squash" | "rebase" | null;
  defaultReviewers: string[];
  defaultMilestone: string | null;
}

export class ContextStore {
  private ctx: Context = {
    repo: null,
    boardId: null,
    activeIssue: null,
    defaultAssignee: null,
    defaultBase: null,
    defaultMergeMethod: null,
    defaultReviewers: [],
    defaultMilestone: null,
  };

  resolveRepo(explicit?: string): TrackerRepo {
    if (explicit) return parseRepo(explicit);
    if (this.ctx.repo) return this.ctx.repo;

    const detected = this.detectFromGit();
    if (detected) {
      this.ctx.repo = detected;
      return detected;
    }

    throw new Error(
      "No repository context. Set one with tracker_set_context or pass repo explicitly as owner/repo."
    );
  }

  set(opts: {
    repo?: string;
    boardId?: string;
    activeIssue?: number | null;
    defaultAssignee?: string;
    defaultBase?: string;
    defaultMergeMethod?: "merge" | "squash" | "rebase";
    defaultReviewers?: string[];
    defaultMilestone?: string;
  }): void {
    if (opts.repo) this.ctx.repo = parseRepo(opts.repo);
    if (opts.boardId !== undefined) this.ctx.boardId = opts.boardId;
    if (opts.activeIssue !== undefined) this.ctx.activeIssue = opts.activeIssue;
    if (opts.defaultAssignee !== undefined) this.ctx.defaultAssignee = opts.defaultAssignee;
    if (opts.defaultBase !== undefined) this.ctx.defaultBase = opts.defaultBase;
    if (opts.defaultMergeMethod !== undefined) this.ctx.defaultMergeMethod = opts.defaultMergeMethod;
    if (opts.defaultReviewers !== undefined) this.ctx.defaultReviewers = opts.defaultReviewers;
    if (opts.defaultMilestone !== undefined) this.ctx.defaultMilestone = opts.defaultMilestone;
  }

  resolveIssue(explicit?: number): number {
    const n = explicit ?? this.ctx.activeIssue;
    if (!n) throw new Error("No active issue. Set one with tracker_set_context (active_issue) or pass issue_number explicitly.");
    return n;
  }

  get boardId(): string | null { return this.ctx.boardId; }
  get activeIssue(): number | null { return this.ctx.activeIssue; }
  get defaultAssignee(): string | null { return this.ctx.defaultAssignee; }
  get defaultBase(): string | null { return this.ctx.defaultBase; }
  get defaultMergeMethod(): "merge" | "squash" | "rebase" | null { return this.ctx.defaultMergeMethod; }
  get defaultReviewers(): string[] { return this.ctx.defaultReviewers; }
  get defaultMilestone(): string | null { return this.ctx.defaultMilestone; }

  snapshot(): Context & { detectedRepo: TrackerRepo | null } {
    return {
      ...this.ctx,
      detectedRepo: this.ctx.repo ?? this.detectFromGit(),
    };
  }

  private detectFromGit(): TrackerRepo | null {
    try {
      const remote = execSync("git remote get-url origin", {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      // Handles git@host:owner/repo.git and https://host/owner/repo[.git]
      const match = remote.match(/[/:]([^/:]+)\/([^/.]+?)(?:\.git)?$/);
      if (match) return { owner: match[1], repo: match[2] };
      return null;
    } catch {
      return null;
    }
  }
}

function parseRepo(value: string): TrackerRepo {
  const [owner, repo] = value.split("/");
  if (!owner || !repo) throw new Error(`Invalid repo "${value}": expected "owner/repo"`);
  return { owner, repo };
}

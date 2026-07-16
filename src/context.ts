import { execSync } from "child_process";
import { readFileSync, existsSync } from "fs";
import * as path from "path";
import type { TrackerRepo } from "./interfaces/types.js";

// Session overrides — set explicitly via tracker_set_context. Win over config and derivation.
interface SessionContext {
  repo: TrackerRepo | null;
  boardId: string | null;
  activeIssue: number | null;
  defaultAssignee: string | null;
  defaultBase: string | null;
  defaultMergeMethod: "merge" | "squash" | "rebase" | null;
  defaultReviewers: string[] | null;
  defaultMilestone: string | null;
}

// Static project config from .mcp-tracker.json at the repo root. Versioned, shared by the team.
interface TrackerConfig {
  repo?: string;
  board?: string;
  defaultBase?: string;
  defaultReviewers?: string[];
  defaultMergeMethod?: "merge" | "squash" | "rebase";
  defaultAssignee?: string;
  defaultMilestone?: string;
  defaultLabels?: string[];
  typeLabels?: Record<string, string>;
}

const CONFIG_FILE = ".mcp-tracker.json";
const CONFIG_LOCAL_FILE = ".mcp-tracker.local.json";

/**
 * Resolves context by precedence: explicit argument > session override > project config > environment.
 * Nothing needs to be set up front — repo comes from the git remote, the active issue from the current
 * branch, and defaults from the config file. tracker_set_context is only an override for edge cases.
 */
export class ContextStore {
  private session: SessionContext = {
    repo: null,
    boardId: null,
    activeIssue: null,
    defaultAssignee: null,
    defaultBase: null,
    defaultMergeMethod: null,
    defaultReviewers: null,
    defaultMilestone: null,
  };

  private configCache: TrackerConfig | null = null;
  private detectedRepoCache: TrackerRepo | null | undefined;

  resolveRepo(explicit?: string): TrackerRepo {
    if (explicit) return parseRepo(explicit);
    if (this.session.repo) return this.session.repo;

    const configured = this.config().repo;
    if (configured) return parseRepo(configured);

    const detected = this.detectRepoFromGit();
    if (detected) return detected;

    throw new Error(
      `No repository. Add "repo" to ${CONFIG_FILE}, set a git remote, or pass repo explicitly as owner/repo.`
    );
  }

  resolveIssue(explicit?: number): number {
    const n = explicit ?? this.session.activeIssue ?? this.detectIssueFromBranch();
    if (!n) {
      throw new Error(
        "No active issue. Work on a branch named <type>/<issue>-<slug>, pass issue_number, or set active_issue via tracker_set_context."
      );
    }
    return n;
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
    if (opts.repo) this.session.repo = parseRepo(opts.repo);
    if (opts.boardId !== undefined) this.session.boardId = opts.boardId;
    if (opts.activeIssue !== undefined) this.session.activeIssue = opts.activeIssue;
    if (opts.defaultAssignee !== undefined) this.session.defaultAssignee = opts.defaultAssignee;
    if (opts.defaultBase !== undefined) this.session.defaultBase = opts.defaultBase;
    if (opts.defaultMergeMethod !== undefined) this.session.defaultMergeMethod = opts.defaultMergeMethod;
    if (opts.defaultReviewers !== undefined) this.session.defaultReviewers = opts.defaultReviewers;
    if (opts.defaultMilestone !== undefined) this.session.defaultMilestone = opts.defaultMilestone;
  }

  get boardId(): string | null { return this.session.boardId ?? this.config().board ?? null; }
  get activeIssue(): number | null { return this.session.activeIssue ?? this.detectIssueFromBranch(); }
  get defaultAssignee(): string | null { return this.session.defaultAssignee ?? this.config().defaultAssignee ?? null; }
  get defaultBase(): string | null { return this.session.defaultBase ?? this.config().defaultBase ?? null; }
  get defaultMergeMethod(): "merge" | "squash" | "rebase" | null { return this.session.defaultMergeMethod ?? this.config().defaultMergeMethod ?? null; }
  get defaultReviewers(): string[] { return this.session.defaultReviewers ?? this.config().defaultReviewers ?? []; }
  get defaultMilestone(): string | null { return this.session.defaultMilestone ?? this.config().defaultMilestone ?? null; }
  get defaultLabels(): string[] { return this.config().defaultLabels ?? []; }
  get typeLabels(): Record<string, string> { return this.config().typeLabels ?? {}; }

  snapshot() {
    let repo: TrackerRepo | null = null;
    let repoSource = "none";
    if (this.session.repo) { repo = this.session.repo; repoSource = "session"; }
    else if (this.config().repo) { repo = parseRepo(this.config().repo!); repoSource = "config"; }
    else { const d = this.detectRepoFromGit(); if (d) { repo = d; repoSource = "git-remote"; } }

    const branchIssue = this.detectIssueFromBranch();
    const activeIssue = this.session.activeIssue ?? branchIssue;
    const activeIssueSource = this.session.activeIssue ? "session" : branchIssue ? "branch" : "none";

    return {
      repo,
      repoSource,
      activeIssue,
      activeIssueSource,
      boardId: this.boardId,
      defaultBase: this.defaultBase,
      defaultReviewers: this.defaultReviewers,
      defaultMergeMethod: this.defaultMergeMethod,
      defaultAssignee: this.defaultAssignee,
      defaultMilestone: this.defaultMilestone,
      defaultLabels: this.defaultLabels,
      typeLabels: this.typeLabels,
      configFile: this.configPath(),
    };
  }

  private config(): TrackerConfig {
    if (this.configCache) return this.configCache;
    const root = this.git(["rev-parse", "--show-toplevel"]) ?? process.cwd();
    let base: TrackerConfig = {};
    let local: TrackerConfig = {};

    const basePath = path.join(root, CONFIG_FILE);
    if (existsSync(basePath)) {
      try { base = JSON.parse(readFileSync(basePath, "utf8")) as TrackerConfig; } catch { /* ignore */ }
    }

    const localPath = path.join(root, CONFIG_LOCAL_FILE);
    if (existsSync(localPath)) {
      try { local = JSON.parse(readFileSync(localPath, "utf8")) as TrackerConfig; } catch { /* ignore */ }
    }

    // Local overrides base — shallow merge, local wins per key.
    this.configCache = { ...base, ...local };
    return this.configCache;
  }

  private configPath(): string {
    const root = this.git(["rev-parse", "--show-toplevel"]) ?? process.cwd();
    return path.join(root, CONFIG_FILE);
  }

  private detectRepoFromGit(): TrackerRepo | null {
    if (this.detectedRepoCache !== undefined) return this.detectedRepoCache;
    const remote = this.git(["remote", "get-url", "origin"]);
    // Handles git@host:group/sub/repo.git and https://host/group/sub/repo[.git]
    // Captures everything after the host as the full path, then splits into owner + repo.
    const match = remote?.match(/[/:](.+?)(?:\.git)?$/);
    if (!match) { this.detectedRepoCache = null; return null; }
    const parts = match[1].split("/").filter(Boolean);
    if (parts.length < 2) { this.detectedRepoCache = null; return null; }
    const repo = parts[parts.length - 1];
    const owner = parts.slice(0, -1).join("/");
    this.detectedRepoCache = { owner, repo };
    return this.detectedRepoCache;
  }

  private detectIssueFromBranch(): number | null {
    const branch = this.git(["branch", "--show-current"]);
    // <issue> as a path-segment start: `42-slug`, `feat/42-slug`, `feat/42`. Ignores `v2`, `foo-42`.
    const match = branch?.match(/(?:^|\/)(\d+)(?:-|$)/);
    return match ? parseInt(match[1], 10) : null;
  }

  private git(args: string[]): string | null {
    try {
      return execSync(`git ${args.join(" ")}`, {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
    } catch {
      return null;
    }
  }
}

function parseRepo(value: string): TrackerRepo {
  const parts = value.split("/");
  if (parts.length < 2 || parts.some((p) => !p)) throw new Error(`Invalid repo "${value}": expected "owner/repo" or "group/subgroup/repo"`);
  const repo = parts[parts.length - 1];
  const owner = parts.slice(0, -1).join("/");
  return { owner, repo };
}

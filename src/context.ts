import { execSync } from "child_process";
import type { TrackerRepo } from "./types.js";

interface Context {
  repo: TrackerRepo | null;
  projectNumber: number | null;
  defaultAssignee: string | null;
}

export class ContextStore {
  private ctx: Context = {
    repo: null,
    projectNumber: null,
    defaultAssignee: null,
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

  set(opts: { repo?: string; projectNumber?: number; defaultAssignee?: string }): void {
    if (opts.repo) this.ctx.repo = parseRepo(opts.repo);
    if (opts.projectNumber !== undefined) this.ctx.projectNumber = opts.projectNumber;
    if (opts.defaultAssignee !== undefined) this.ctx.defaultAssignee = opts.defaultAssignee;
  }

  get projectNumber(): number | null {
    return this.ctx.projectNumber;
  }

  get defaultAssignee(): string | null {
    return this.ctx.defaultAssignee;
  }

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
      const match = remote.match(/github\.com[/:]([^/]+?)\/([^/.]+)/);
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

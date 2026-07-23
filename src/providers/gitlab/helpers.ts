import { execFileSync } from "child_process";
import type { TrackerRepo } from "../../interfaces/types.js";

export function glab<T>(args: string[]): T {
  try {
    const output = execFileSync("glab", args, { encoding: "utf8", stdio: ["inherit", "pipe", "pipe"] }).trim();
    return output ? (JSON.parse(output) as T) : ({} as T);
  } catch (err: unknown) {
    const e = err as { stderr?: Buffer | string; message?: string };
    const stderr = (e.stderr?.toString() ?? "").trim();
    throw new Error(stderr || e.message || `glab ${args[0]} failed`);
  }
}

export function glabApi<T>(path: string, method = "GET", extraArgs: string[] = []): T {
  return glab<T>(["api", path, "--method", method, ...extraArgs]);
}

// Runs a glab subcommand whose stdout is human-readable text, not JSON (e.g. `issue note`,
// `mr note create`, `mr merge`). Only throws on actual command failure — never on stdout that
// isn't valid JSON, which glab<T> would misreport as a failure despite the command succeeding.
export function glabVoid(args: string[]): void {
  try {
    execFileSync("glab", args, { encoding: "utf8", stdio: ["inherit", "pipe", "pipe"] });
  } catch (err: unknown) {
    const e = err as { stderr?: Buffer | string; message?: string };
    const stderr = (e.stderr?.toString() ?? "").trim();
    throw new Error(stderr || e.message || `glab ${args[0]} failed`);
  }
}

// Runs glab for plain-text output (e.g. a job trace). Best-effort: returns
// whatever reached stdout, empty string on failure.
export function glabRaw(args: string[]): string {
  try {
    return execFileSync("glab", args, { encoding: "utf8", stdio: ["inherit", "pipe", "pipe"] });
  } catch (err: unknown) {
    const e = err as { stdout?: Buffer | string };
    return e.stdout?.toString() ?? "";
  }
}

export function projectRef(repo: TrackerRepo): string {
  return encodeURIComponent(`${repo.owner}/${repo.repo}`);
}

export function repoFlag(repo: TrackerRepo): string {
  return `${repo.owner}/${repo.repo}`;
}

export interface RawGitLabMR {
  iid: number;
  title: string;
  description: string | null;
  state: string;
  web_url: string;
  source_branch: string;
  target_branch: string;
}

export interface RawGitLabNote {
  id: number;
  author: { username: string };
  body: string;
  created_at: string;
}

import { execFileSync } from "child_process";
import type { TrackerRepo, Issue, PR } from "../../interfaces/types.js";

export function gh<T>(args: string[], inputData?: unknown): T {
  const hasInput = inputData !== undefined;
  try {
    const output = execFileSync("gh", args, {
      encoding: "utf8",
      input: hasInput ? JSON.stringify(inputData) : undefined,
      stdio: [hasInput ? "pipe" : "inherit", "pipe", "pipe"],
    }).trim();
    return output ? (JSON.parse(output) as T) : ({} as T);
  } catch (err: unknown) {
    const e = err as { stderr?: Buffer | string; message?: string };
    const stderr = (e.stderr?.toString() ?? "").trim();
    throw new Error(stderr || e.message || `gh ${args[0]} failed`);
  }
}

// Runs gh for plain-text output (e.g. logs). Best-effort: some log commands
// exit non-zero while still writing the log to stdout, so we return that.
export function ghRaw(args: string[]): string {
  try {
    return execFileSync("gh", args, { encoding: "utf8", stdio: ["inherit", "pipe", "pipe"] });
  } catch (err: unknown) {
    const e = err as { stdout?: Buffer | string };
    return e.stdout?.toString() ?? "";
  }
}

export function graphql<T>(query: string, variables: Record<string, unknown> = {}): T {
  type GQLResponse = { data: T; errors?: Array<{ message: string }> };
  const res = gh<GQLResponse>(["api", "graphql", "--input", "-"], { query, variables });
  if (res.errors?.length) throw new Error(res.errors[0].message);
  return res.data;
}

export function repoFlag(repo: TrackerRepo): string {
  return `${repo.owner}/${repo.repo}`;
}

export interface RawIssue {
  number: number;
  title: string;
  body: string;
  state: string;
  url: string;
  html_url?: string;
  labels: Array<{ name: string } | string>;
}

export interface RawPR {
  number: number;
  title: string;
  body: string;
  state: string;
  html_url: string;
  head: { ref: string };
  base: { ref: string };
}

export interface RawCheckRun {
  name: string;
  status: string;
  conclusion: string | null;
  html_url?: string;
  details_url?: string;
}

export function mapIssue(d: RawIssue): Issue {
  return {
    number: d.number,
    title: d.title,
    body: d.body ?? "",
    state: d.state,
    url: d.url ?? d.html_url ?? "",
    labels: (d.labels ?? []).map((l) => (typeof l === "string" ? l : l.name)),
  };
}

export function mapPR(d: RawPR): PR {
  return {
    number: d.number,
    title: d.title,
    body: d.body ?? "",
    state: d.state,
    url: d.html_url,
    headBranch: d.head.ref,
    baseBranch: d.base.ref,
  };
}

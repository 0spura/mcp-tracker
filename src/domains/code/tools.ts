import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ContextStore } from "../../context/store.js";
import type { Scope } from "../../core/scope.js";
import type { ItemId, PR } from "../../core/types.js";
import type { IssueCatalog, IssueProvider } from "../issues/capabilities.js";
import type { CodeProvider } from "./capabilities.js";
import { UnsupportedError } from "../../core/errors.js";
import { run as runProcess } from "../../core/process.js";
import {
  json,
  text,
  REPO_PARAM,
  ATTACHMENTS_PARAM,
  appendAttachments,
  resolveScope,
} from "../../tools/helpers.js";

export function summarizePR(pr: PR): Omit<PR, "body"> {
  const { body: _body, ...summary } = pr;
  return summary;
}

/** Best-effort status automation driven by config workflow.on triggers. */
async function applyStageTrigger(
  ctx: ContextStore,
  issue: IssueProvider | undefined,
  scope: Scope,
  issueIds: ItemId[],
  event: "createBranch" | "createPr" | "mergePr" | "reviewApproved",
  warnings: string[],
): Promise<void> {
  if (!issue || issueIds.length === 0) return;
  const config = await ctx.getConfig();
  const stageKey = config.workflow?.on?.[event];
  if (!stageKey) return;
  const stage = config.workflow?.stages?.find((s) => s.key === stageKey);
  if (!stage) {
    warnings.push(`workflow.on.${event} points to unknown stage "${stageKey}"`);
    return;
  }
  for (const issueId of issueIds) {
    try {
      await issue.setIssueStatus(scope, issueId, stage.id ?? stage.name);
    } catch (err) {
      warnings.push(
        `could not move issue #${issueId} to "${stage.name}": ${(err as Error).message}`,
      );
    }
  }
}

export function registerCodeTools(
  server: McpServer,
  code: CodeProvider,
  ctx: ContextStore,
  issue?: IssueProvider,
  catalog?: IssueCatalog,
  runGit: (cmd: string, args: string[]) => Promise<string> = runProcess,
): void {
  const repoOf = async (explicit?: string) => {
    const scope = await resolveScope(ctx, ["repo"], explicit);
    return scope.repo!;
  };
  const labels = catalog?.labels ?? [];
  const labelSchema =
    labels.length > 0 ? z.enum(labels as [string, ...string[]]) : z.string();
  const milestones = catalog?.milestones ?? [];
  const milestoneSchema =
    milestones.length > 0
      ? z.enum(milestones as [string, ...string[]])
      : z.string();

  server.tool(
    "create_branch",
    "Create or reuse an issue-linked branch.",
    {
      issue_number: z.number().int().positive().describe("Issue number."),
      base: z
        .string()
        .optional()
        .describe("Base branch; defaults to the repo default branch."),
      repo: REPO_PARAM,
    },
    async (args) => {
      const repo = await repoOf(args.repo);
      const issueId = String(args.issue_number);
      const result = await code.createBranch(repo, issueId, "", args.base);
      await runGit("git", ["checkout", result.name]);
      const warnings: string[] = [];
      const scope = await resolveScope(ctx, []);
      await applyStageTrigger(
        ctx,
        issue,
        scope,
        [issueId],
        "createBranch",
        warnings,
      );
      return json({ ...result, warnings });
    },
  );

  server.tool(
    "create_pr",
    "Create a pull request linked to issues.",
    {
      title: z.string(),
      body: z.string(),
      head: z.string().describe("Head branch."),
      base: z
        .string()
        .optional()
        .describe("Base branch; defaults to project configuration."),
      draft: z.boolean().optional(),
      issues: z
        .array(z.number().int().positive())
        .min(1)
        .describe("Issues closed by the PR."),
      attachments: ATTACHMENTS_PARAM,
      repo: REPO_PARAM,
    },
    async (args) => {
      const repo = await repoOf(args.repo);
      const base = args.base ?? (await ctx.resolveDefaultBase()).value;
      const closing = new Set<string>(args.issues.map(String));

      const warnings: string[] = [];
      let body = args.body;
      if (args.attachments && args.attachments.length > 0) {
        if (!issue)
          throw new UnsupportedError(
            "attachments (requires a task/issue provider)",
          );
        const result = await appendAttachments(
          issue,
          { repo },
          args.body,
          args.attachments,
        );
        body = result.body;
        warnings.push(...result.warnings);
      }

      const pr = await code.createPR(
        repo,
        args.title,
        body,
        args.head,
        base === "unset" ? undefined : base,
        { issues: [...closing] },
      );
      const reviewers = (await ctx.resolveDefaultReviewers()).value;
      if (reviewers !== "unset" && reviewers.length > 0) {
        const updated = await code.updatePR(repo, pr.number, {
          add_reviewers: reviewers,
        });
        warnings.push(...updated.warnings);
      }
      const scope = await resolveScope(ctx, []);
      await applyStageTrigger(
        ctx,
        issue,
        scope,
        [...closing],
        "createPr",
        warnings,
      );
      return json({ ...pr, warnings });
    },
  );

  server.tool(
    "update_pr",
    "Update a pull request.",
    {
      number: z.number().int().positive(),
      title: z.string().optional(),
      body: z.string().optional(),
      state: z.enum(["open", "closed"]).optional(),
      draft: z
        .boolean()
        .optional()
        .describe("true = convert to draft; false = mark ready for review."),
      labels: z.array(labelSchema).optional(),
      milestone: milestoneSchema.optional(),
      add_reviewers: z.array(z.string()).optional(),
      remove_reviewers: z.array(z.string()).optional(),
      add_assignees: z.array(z.string()).optional(),
      remove_assignees: z.array(z.string()).optional(),
      repo: REPO_PARAM,
    },
    async ({ repo: repoArg, number, ...opts }) => {
      const repo = await repoOf(repoArg);
      return json(await code.updatePR(repo, number, opts));
    },
  );

  server.tool(
    "get_pr",
    "Get a full pull request.",
    { number: z.number().int().positive(), repo: REPO_PARAM },
    async (args) =>
      json(await code.getPR(await repoOf(args.repo), args.number)),
  );

  server.tool(
    "list_prs",
    "Find pull request summaries.",
    {
      state: z.enum(["open", "closed", "all"]).optional(),
      limit: z.number().int().positive().max(100).default(10),
      repo: REPO_PARAM,
    },
    async (args) => {
      const prs = await code.listPRs(await repoOf(args.repo), {
        state: args.state,
        limit: args.limit,
      });
      return json(prs.map(summarizePR));
    },
  );

  server.tool(
    "get_pr_checks",
    "Get pull request checks.",
    { number: z.number().int().positive(), repo: REPO_PARAM },
    async (args) =>
      json(await code.getPRChecks(await repoOf(args.repo), args.number)),
  );

  server.tool(
    "merge_pr",
    "Merge a pull request.",
    {
      number: z.number().int().positive(),
      issues: z.array(z.number().int().positive()).optional(),
      method: z.enum(["merge", "squash", "rebase"]).optional(),
      delete_branch: z
        .boolean()
        .optional()
        .describe("Omit this field if it is not explicitly specified"),
      repo: REPO_PARAM,
    },
    async (args) => {
      const repo = await repoOf(args.repo);
      const method =
        args.method ?? (await ctx.resolveDefaultMergeMethod()).value;
      const deleteBranch =
        args.delete_branch ??
        (await ctx.resolveDefaultMergeDeleteBranch()).value;
      const { warnings } = await code.mergePR(
        repo,
        args.number,
        method === "unset" ? undefined : method,
        { deleteBranch: deleteBranch === "unset" ? false : deleteBranch },
      );
      const scope = await resolveScope(ctx, []);
      if (args.issues)
        await applyStageTrigger(
          ctx,
          issue,
          scope,
          args.issues.map(String),
          "mergePr",
          warnings,
        );
      return json({ number: args.number, merged: true, warnings });
    },
  );

  server.tool(
    "get_pr_diff",
    "Get a pull request diff.",
    { number: z.number().int().positive(), repo: REPO_PARAM },
    async (args) =>
      text(await code.getPRDiff(await repoOf(args.repo), args.number)),
  );

  server.tool(
    "submit_pr_review",
    "Submit a pull request review.",
    {
      number: z.number().int().positive(),
      issues: z.array(z.number().int().positive()).min(1),
      event: z.enum(["approve", "request_changes", "comment"]),
      body: z.string().optional(),
      comments: z
        .array(
          z.object({
            path: z.string(),
            line: z.number().int().positive(),
            body: z.string(),
          }),
        )
        .optional(),
      repo: REPO_PARAM,
    },
    async (args) => {
      const repo = await repoOf(args.repo);
      await code.submitPRReview(repo, args.number, {
        event: args.event,
        body: args.body,
        comments: args.comments,
      });
      const warnings: string[] = [];
      if (args.event === "approve") {
        const scope = await resolveScope(ctx, []);
        await applyStageTrigger(
          ctx,
          issue,
          scope,
          args.issues.map(String),
          "reviewApproved",
          warnings,
        );
      }
      return json({ number: args.number, reviewed: args.event, warnings });
    },
  );
}

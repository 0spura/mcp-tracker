import { execFileSync } from "child_process";
import type { TrackerProvider, ListIssuesOptions } from "../provider.js";
import type {
  TrackerRepo,
  Issue,
  PR,
  CheckRun,
  RelationshipType,
  Label,
  Milestone,
  ProjectItem,
  ProjectField,
  CreateIssueOptions,
  UpdateIssueOptions,
} from "../types.js";

const RELATIONSHIP_TYPE_MAP: Record<RelationshipType, string> = {
  blocks: "BLOCKS",
  blocked_by: "BLOCKED_BY",
  related: "RELATED_TO",
  duplicate: "DUPLICATES",
};

function gh<T>(args: string[], inputData?: unknown): T {
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

function graphql<T>(query: string, variables: Record<string, unknown> = {}): T {
  type GQLResponse = { data: T; errors?: Array<{ message: string }> };
  const res = gh<GQLResponse>(["api", "graphql", "--input", "-"], { query, variables });
  if (res.errors?.length) throw new Error(res.errors[0].message);
  return res.data;
}

function repoFlag(repo: TrackerRepo): string {
  return `${repo.owner}/${repo.repo}`;
}

export class GitHubProvider implements TrackerProvider {
  // Auth is handled by `gh auth login` — no token needed.

  async listIssues(repo: TrackerRepo, opts?: ListIssuesOptions): Promise<Issue[]> {
    const args = [
      "issue", "list",
      "--repo", repoFlag(repo),
      "--state", opts?.state ?? "open",
      "--limit", String(opts?.limit ?? 50),
      "--json", "number,title,body,state,url,labels",
    ];
    if (opts?.labels?.length) args.push("--label", opts.labels.join(","));
    if (opts?.assignee) args.push("--assignee", opts.assignee);

    return gh<RawIssue[]>(args).map(mapIssue);
  }

  async createIssue(repo: TrackerRepo, title: string, body: string, opts?: CreateIssueOptions): Promise<Issue> {
    let milestoneNumber: number | undefined;
    if (opts?.milestone) {
      const milestones = gh<Array<{ number: number; title: string }>>([
        "api", `repos/${repoFlag(repo)}/milestones`,
      ]);
      const found = milestones.find((m) => m.title === opts.milestone);
      if (!found) throw new Error(`Milestone "${opts.milestone}" not found`);
      milestoneNumber = found.number;
    }

    const data = gh<RawIssue>(
      ["api", "--method", "POST", `repos/${repoFlag(repo)}/issues`, "--input", "-"],
      {
        title,
        body,
        labels: opts?.labels ?? [],
        assignees: opts?.assignees ?? [],
        ...(milestoneNumber !== undefined && { milestone: milestoneNumber }),
      }
    );

    return mapIssue(data);
  }

  async getIssue(repo: TrackerRepo, number: number): Promise<Issue> {
    const data = gh<RawIssue>([
      "issue", "view", String(number),
      "--repo", repoFlag(repo),
      "--json", "number,title,body,state,url,labels",
    ]);
    return mapIssue(data);
  }

  async updateIssue(repo: TrackerRepo, number: number, opts: UpdateIssueOptions): Promise<Issue> {
    const body: Record<string, unknown> = {};
    if (opts.title !== undefined) body.title = opts.title;
    if (opts.body !== undefined) body.body = opts.body;
    if (opts.labels !== undefined) body.labels = opts.labels;
    if (opts.assignees !== undefined) body.assignees = opts.assignees;
    if (opts.state !== undefined) body.state = opts.state;

    const data = gh<RawIssue>(
      ["api", "--method", "PATCH", `repos/${repoFlag(repo)}/issues/${number}`, "--input", "-"],
      body
    );
    return mapIssue(data);
  }

  async setIssueStatus(repo: TrackerRepo, issueNumber: number, status: string): Promise<void> {
    const issueData = graphql<{
      repository: { issue: { projectItems: { nodes: Array<{ id: string; project: { id: string; title: string } }> } } };
    }>(
      `query($owner: String!, $repo: String!, $number: Int!) {
        repository(owner: $owner, name: $repo) {
          issue(number: $number) {
            projectItems(first: 20) { nodes { id project { id title } } }
          }
        }
      }`,
      { owner: repo.owner, repo: repo.repo, number: issueNumber }
    );

    const items = issueData.repository.issue.projectItems.nodes;
    if (items.length === 0) throw new Error(`Issue #${issueNumber} is not in any project`);
    const { id: itemId, project } = items[0];

    const fieldsData = graphql<{
      node: { fields: { nodes: Array<{ __typename: string; id: string; name: string; options?: Array<{ id: string; name: string }> }> } };
    }>(
      `query($projectId: ID!) {
        node(id: $projectId) {
          ... on ProjectV2 {
            fields(first: 50) {
              nodes {
                __typename
                ... on ProjectV2SingleSelectField { id name options { id name } }
                ... on ProjectV2Field { id name }
              }
            }
          }
        }
      }`,
      { projectId: project.id }
    );

    const statusField = fieldsData.node.fields.nodes.find(
      (f) => f.name === "Status" && f.__typename === "ProjectV2SingleSelectField"
    );
    if (!statusField?.options) throw new Error(`Project "${project.title}" has no Status field`);

    const option = statusField.options.find((o) => o.name.toLowerCase() === status.toLowerCase());
    if (!option) {
      const available = statusField.options.map((o) => o.name).join(", ");
      throw new Error(`Status "${status}" not found in "${project.title}". Available: ${available}`);
    }

    graphql(
      `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
        updateProjectV2ItemFieldValue(input: {
          projectId: $projectId itemId: $itemId fieldId: $fieldId
          value: { singleSelectOptionId: $optionId }
        }) { projectV2Item { id } }
      }`,
      { projectId: project.id, itemId, fieldId: statusField.id, optionId: option.id }
    );
  }

  async createLinkedBranch(repo: TrackerRepo, issueNumber: number, branchName: string): Promise<{ name: string }> {
    const data = graphql<{
      repository: { id: string; issue: { id: string }; defaultBranchRef: { target: { oid: string } } };
    }>(
      `query($owner: String!, $repo: String!) {
        repository(owner: $owner, name: $repo) {
          id
          issue(number: ${issueNumber}) { id }
          defaultBranchRef { target { oid } }
        }
      }`,
      { owner: repo.owner, repo: repo.repo }
    );

    graphql(
      `mutation($issueId: ID!, $repoId: ID!, $name: String!, $oid: GitObjectID!) {
        createLinkedBranch(input: { issueId: $issueId repositoryId: $repoId name: $name oid: $oid }) {
          linkedBranch { ref { name } }
        }
      }`,
      { issueId: data.repository.issue.id, repoId: data.repository.id, name: branchName, oid: data.repository.defaultBranchRef.target.oid }
    );

    return { name: branchName };
  }

  async linkBranch(repo: TrackerRepo, issueNumber: number, branchName: string): Promise<void> {
    const data = graphql<{
      repository: { id: string; issue: { id: string }; ref: { target: { oid: string } } | null };
    }>(
      `query($owner: String!, $repo: String!, $branch: String!) {
        repository(owner: $owner, name: $repo) {
          id
          issue(number: ${issueNumber}) { id }
          ref(qualifiedName: $branch) { target { oid } }
        }
      }`,
      { owner: repo.owner, repo: repo.repo, branch: `refs/heads/${branchName}` }
    );

    if (!data.repository.ref) throw new Error(`Branch "${branchName}" not found in ${repoFlag(repo)}`);

    graphql(
      `mutation($issueId: ID!, $repoId: ID!, $name: String!, $oid: GitObjectID!) {
        createLinkedBranch(input: { issueId: $issueId repositoryId: $repoId name: $name oid: $oid }) {
          linkedBranch { ref { name } }
        }
      }`,
      { issueId: data.repository.issue.id, repoId: data.repository.id, name: branchName, oid: data.repository.ref.target.oid }
    );
  }

  async createPR(repo: TrackerRepo, title: string, body: string, head: string, base?: string): Promise<PR> {
    let baseBranch = base;
    if (!baseBranch) {
      const repoData = gh<{ default_branch: string }>(["api", `repos/${repoFlag(repo)}`]);
      baseBranch = repoData.default_branch;
    }

    const data = gh<RawPR>(
      ["api", "--method", "POST", `repos/${repoFlag(repo)}/pulls`, "--input", "-"],
      { title, body, head, base: baseBranch }
    );
    return mapPR(data);
  }

  async updatePR(repo: TrackerRepo, number: number, opts: { title?: string; body?: string }): Promise<PR> {
    const data = gh<RawPR>(
      ["api", "--method", "PATCH", `repos/${repoFlag(repo)}/pulls/${number}`, "--input", "-"],
      opts
    );
    return mapPR(data);
  }

  async getPRChecks(repo: TrackerRepo, number: number): Promise<CheckRun[]> {
    const pr = gh<{ headRefOid: string }>([
      "pr", "view", String(number), "--repo", repoFlag(repo), "--json", "headRefOid",
    ]);

    const checks = gh<{ check_runs: RawCheckRun[] }>([
      "api", `repos/${repoFlag(repo)}/commits/${pr.headRefOid}/check-runs`,
    ]);

    return checks.check_runs.map((r) => ({
      name: r.name,
      status: r.status,
      conclusion: r.conclusion ?? null,
      url: r.html_url ?? "",
    }));
  }

  async listSubIssues(repo: TrackerRepo, parentNumber: number): Promise<Issue[]> {
    const data = graphql<{
      repository: { issue: { subIssues: { nodes: Array<{ number: number; title: string; body: string; state: string; url: string; labels: { nodes: Array<{ name: string }> } }> } } };
    }>(
      `query($owner: String!, $repo: String!, $number: Int!) {
        repository(owner: $owner, name: $repo) {
          issue(number: $number) {
            subIssues(first: 50) {
              nodes { number title body state url labels(first: 10) { nodes { name } } }
            }
          }
        }
      }`,
      { owner: repo.owner, repo: repo.repo, number: parentNumber }
    );
    return data.repository.issue.subIssues.nodes.map((n) => ({
      number: n.number,
      title: n.title,
      body: n.body ?? "",
      state: n.state,
      url: n.url,
      labels: n.labels.nodes.map((l) => l.name),
    }));
  }

  async addSubIssue(repo: TrackerRepo, parentNumber: number, childNumber: number): Promise<void> {
    const data = graphql<{ repository: { parent: { id: string }; child: { id: string } } }>(
      `query($owner: String!, $repo: String!) {
        repository(owner: $owner, name: $repo) {
          parent: issue(number: ${parentNumber}) { id }
          child: issue(number: ${childNumber}) { id }
        }
      }`,
      { owner: repo.owner, repo: repo.repo }
    );

    graphql(
      `mutation($parentId: ID!, $childId: ID!) {
        addSubIssue(input: { issueId: $parentId subIssueId: $childId }) { issue { number } }
      }`,
      { parentId: data.repository.parent.id, childId: data.repository.child.id }
    );
  }

  async toggleChecklistItem(
    repo: TrackerRepo,
    issueNumber: number,
    itemText: string,
    checked?: boolean
  ): Promise<{ matched: string; checked: boolean }> {
    const issue = await this.getIssue(repo, issueNumber);
    const lines = issue.body.split("\n");
    const needle = itemText.toLowerCase();

    let matchedLine: string | null = null;
    let newChecked = false;

    const updated = lines.map((line) => {
      const isUnchecked = /^- \[ \] /i.test(line);
      const isChecked = /^- \[x\] /i.test(line);
      if (!isUnchecked && !isChecked) return line;

      const text = line.replace(/^- \[[x ]\] /i, "").toLowerCase();
      if (!text.includes(needle)) return line;

      matchedLine = line.replace(/^- \[[x ]\] /i, "").trim();
      newChecked = checked !== undefined ? checked : isUnchecked;
      return newChecked ? line.replace(/^- \[ \] /i, "- [x] ") : line.replace(/^- \[x\] /i, "- [ ] ");
    });

    if (!matchedLine) throw new Error(`No checklist item matching "${itemText}" found in issue #${issueNumber}`);

    await this.updateIssue(repo, issueNumber, { body: updated.join("\n") });
    return { matched: matchedLine, checked: newChecked };
  }

  async requestReviewers(repo: TrackerRepo, prNumber: number, reviewers: string[]): Promise<void> {
    gh<unknown>(
      ["api", "--method", "POST", `repos/${repoFlag(repo)}/pulls/${prNumber}/requested_reviewers`, "--input", "-"],
      { reviewers }
    );
  }

  async mergePR(repo: TrackerRepo, number: number, method: "merge" | "squash" | "rebase" = "squash"): Promise<void> {
    gh<unknown>(
      ["api", "--method", "PUT", `repos/${repoFlag(repo)}/pulls/${number}/merge`, "--input", "-"],
      { merge_method: method }
    );
  }

  async addPRComment(repo: TrackerRepo, number: number, body: string): Promise<void> {
    gh<unknown>(["pr", "comment", String(number), "--repo", repoFlag(repo), "--body", body]);
  }

  async listComments(repo: TrackerRepo, type: "issue" | "pr", number: number): Promise<Array<{ id: number; author: string; body: string; createdAt: string }>> {
    const raw = gh<Array<{ id: number; user: { login: string }; body: string; created_at: string }>>(
      ["api", `repos/${repoFlag(repo)}/issues/${number}/comments`]
    );
    return raw.map((c) => ({ id: c.id, author: c.user.login, body: c.body, createdAt: c.created_at }));
  }

  async listPRs(repo: TrackerRepo, opts?: { state?: "open" | "closed" | "all"; limit?: number }): Promise<PR[]> {
    const args = [
      "pr", "list",
      "--repo", repoFlag(repo),
      "--state", opts?.state ?? "open",
      "--limit", String(opts?.limit ?? 50),
      "--json", "number,title,body,state,headRefName,baseRefName,url",
    ];
    return gh<Array<{ number: number; title: string; body: string; state: string; headRefName: string; baseRefName: string; url: string }>>(args)
      .map((d) => ({ number: d.number, title: d.title, body: d.body ?? "", state: d.state, url: d.url, headBranch: d.headRefName, baseBranch: d.baseRefName }));
  }

  async getPR(repo: TrackerRepo, number: number): Promise<PR> {
    const d = gh<{ number: number; title: string; body: string; state: string; headRefName: string; baseRefName: string; url: string }>([
      "pr", "view", String(number),
      "--repo", repoFlag(repo),
      "--json", "number,title,body,state,headRefName,baseRefName,url",
    ]);
    return { number: d.number, title: d.title, body: d.body ?? "", state: d.state, url: d.url, headBranch: d.headRefName, baseBranch: d.baseRefName };
  }

  async addIssueComment(repo: TrackerRepo, number: number, body: string): Promise<void> {
    gh<unknown>(["issue", "comment", String(number), "--repo", repoFlag(repo), "--body", body]);
  }

  async listLabels(repo: TrackerRepo): Promise<Label[]> {
    return gh<Array<{ name: string; color: string; description: string }>>(["label", "list", "--repo", repoFlag(repo), "--json", "name,color,description"])
      .map((l) => ({ name: l.name, color: l.color, description: l.description ?? "" }));
  }

  async listMilestones(repo: TrackerRepo, state?: "open" | "closed" | "all"): Promise<Milestone[]> {
    const milestones = gh<Array<{ number: number; title: string; state: string; due_on: string | null }>>(
      ["api", `repos/${repoFlag(repo)}/milestones`, "--method", "GET", "-f", `state=${state ?? "open"}`]
    );
    return milestones.map((m) => ({ number: m.number, title: m.title, state: m.state, dueOn: m.due_on }));
  }

  async listProjectItems(repo: TrackerRepo, projectNumber: number): Promise<ProjectItem[]> {
    const ownerData = graphql<{ repository: { owner: { login: string } } }>(
      `query($owner: String!, $repo: String!) { repository(owner: $owner, name: $repo) { owner { login } } }`,
      { owner: repo.owner, repo: repo.repo }
    );
    const owner = ownerData.repository.owner.login;

    const data = graphql<{
      repositoryOwner: { projectV2: { items: { nodes: Array<{ id: string; fieldValues: { nodes: Array<{ __typename: string; name?: string }> }; content: { __typename: string; number?: number; title?: string; state?: string; url?: string } | null }> } } };
    }>(
      `query($owner: String!, $number: Int!) {
        repositoryOwner(login: $owner) {
          projectV2(number: $number) {
            items(first: 100) {
              nodes {
                id
                fieldValues(first: 20) {
                  nodes {
                    __typename
                    ... on ProjectV2ItemFieldSingleSelectValue { name }
                  }
                }
                content {
                  __typename
                  ... on Issue { number title state url }
                  ... on PullRequest { number title state url }
                }
              }
            }
          }
        }
      }`,
      { owner, number: projectNumber }
    );

    return data.repositoryOwner.projectV2.items.nodes.map((item) => {
      const statusField = item.fieldValues.nodes.find((f) => f.__typename === "ProjectV2ItemFieldSingleSelectValue");
      const c = item.content;
      return {
        id: item.id,
        status: statusField?.name ?? null,
        content: c ? {
          type: c.__typename === "Issue" ? "issue" : "pr",
          number: c.number!,
          title: c.title!,
          state: c.state!,
          url: c.url!,
        } : null,
      };
    });
  }

  async listProjectFields(repo: TrackerRepo, projectNumber: number): Promise<ProjectField[]> {
    const ownerData = graphql<{ repository: { owner: { login: string } } }>(
      `query($owner: String!, $repo: String!) { repository(owner: $owner, name: $repo) { owner { login } } }`,
      { owner: repo.owner, repo: repo.repo }
    );
    const owner = ownerData.repository.owner.login;

    const data = graphql<{
      repositoryOwner: { projectV2: { fields: { nodes: Array<{ __typename: string; id: string; name: string; options?: Array<{ id: string; name: string }> }> } } };
    }>(
      `query($owner: String!, $number: Int!) {
        repositoryOwner(login: $owner) {
          projectV2(number: $number) {
            fields(first: 50) {
              nodes {
                __typename
                ... on ProjectV2Field { id name }
                ... on ProjectV2SingleSelectField { id name options { id name } }
                ... on ProjectV2IterationField { id name }
                ... on ProjectV2NumberField { id name }
              }
            }
          }
        }
      }`,
      { owner, number: projectNumber }
    );

    return data.repositoryOwner.projectV2.fields.nodes
      .filter((f) => f.id && f.name)
      .map((f) => ({
        id: f.id,
        name: f.name,
        type: f.__typename.replace("ProjectV2", "").replace("Field", "").toLowerCase() || "text",
        options: f.options,
      }));
  }

  async addIssueToProject(repo: TrackerRepo, issueNumber: number, projectNumber: number): Promise<string> {
    const data = graphql<{ repository: { issue: { id: string }; owner: { login: string } } }>(
      `query($owner: String!, $repo: String!) {
        repository(owner: $owner, name: $repo) {
          issue(number: ${issueNumber}) { id }
          owner { login }
        }
      }`,
      { owner: repo.owner, repo: repo.repo }
    );
    const owner = data.repository.owner.login;

    const projectData = graphql<{ repositoryOwner: { projectV2: { id: string } } }>(
      `query($owner: String!, $number: Int!) { repositoryOwner(login: $owner) { projectV2(number: $number) { id } } }`,
      { owner, number: projectNumber }
    );

    const result = graphql<{ addProjectV2ItemById: { item: { id: string } } }>(
      `mutation($projectId: ID!, $contentId: ID!) {
        addProjectV2ItemById(input: { projectId: $projectId contentId: $contentId }) { item { id } }
      }`,
      { projectId: projectData.repositoryOwner.projectV2.id, contentId: data.repository.issue.id }
    );
    return result.addProjectV2ItemById.item.id;
  }

  async setProjectItemFields(
    repo: TrackerRepo,
    projectNumber: number,
    itemId: string,
    fields: Record<string, string>
  ): Promise<void> {
    const projectFields = await this.listProjectFields(repo, projectNumber);

    const ownerData = graphql<{ repository: { owner: { login: string } } }>(
      `query($owner: String!, $repo: String!) { repository(owner: $owner, name: $repo) { owner { login } } }`,
      { owner: repo.owner, repo: repo.repo }
    );
    const owner = ownerData.repository.owner.login;

    const projectData = graphql<{ repositoryOwner: { projectV2: { id: string } } }>(
      `query($owner: String!, $number: Int!) { repositoryOwner(login: $owner) { projectV2(number: $number) { id } } }`,
      { owner, number: projectNumber }
    );
    const projectId = projectData.repositoryOwner.projectV2.id;

    for (const [fieldName, value] of Object.entries(fields)) {
      const field = projectFields.find((f) => f.name.toLowerCase() === fieldName.toLowerCase());
      if (!field) throw new Error(`Field "${fieldName}" not found in project. Available: ${projectFields.map((f) => f.name).join(", ")}`);

      let fieldValue: unknown;
      if (field.options) {
        const opt = field.options.find((o) => o.name.toLowerCase() === value.toLowerCase());
        if (!opt) throw new Error(`Option "${value}" not found for field "${fieldName}". Available: ${field.options.map((o) => o.name).join(", ")}`);
        fieldValue = { singleSelectOptionId: opt.id };
      } else {
        fieldValue = { text: value };
      }

      graphql(
        `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: ProjectV2FieldValue!) {
          updateProjectV2ItemFieldValue(input: { projectId: $projectId itemId: $itemId fieldId: $fieldId value: $value }) {
            projectV2Item { id }
          }
        }`,
        { projectId, itemId, fieldId: field.id, value: fieldValue }
      );
    }
  }

  async setRelationship(repo: TrackerRepo, issueNumber: number, type: RelationshipType, targetNumber: number): Promise<void> {
    const data = graphql<{ repository: { source: { id: string }; target: { id: string } } }>(
      `query($owner: String!, $repo: String!) {
        repository(owner: $owner, name: $repo) {
          source: issue(number: ${issueNumber}) { id }
          target: issue(number: ${targetNumber}) { id }
        }
      }`,
      { owner: repo.owner, repo: repo.repo }
    );

    graphql(
      `mutation($sourceId: ID!, $targetId: ID!, $type: IssueRelationshipType!) {
        addIssueRelationship(input: { itemId: $sourceId relatedItemId: $targetId relationshipType: $type }) {
          relationship { relationshipType }
        }
      }`,
      { sourceId: data.repository.source.id, targetId: data.repository.target.id, type: RELATIONSHIP_TYPE_MAP[type] }
    );
  }
}

interface RawIssue {
  number: number;
  title: string;
  body: string;
  state: string;
  url: string;
  html_url?: string;
  labels: Array<{ name: string } | string>;
}

interface RawPR {
  number: number;
  title: string;
  body: string;
  state: string;
  html_url: string;
  head: { ref: string };
  base: { ref: string };
}

interface RawCheckRun {
  name: string;
  status: string;
  conclusion: string | null;
  html_url?: string;
}

function mapIssue(d: RawIssue): Issue {
  return {
    number: d.number,
    title: d.title,
    body: d.body ?? "",
    state: d.state,
    url: d.url ?? d.html_url ?? "",
    labels: (d.labels ?? []).map((l) => (typeof l === "string" ? l : l.name)),
  };
}

function mapPR(d: RawPR): PR {
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

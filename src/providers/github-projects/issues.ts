import type { TrackerRepo, Issue, CreateIssueOptions, UpdateIssueOptions } from "../../interfaces/types.js";
import type { ListIssuesOptions } from "../../interfaces/issue.js";
import { gh, graphql, repoFlag, mapIssue, type RawIssue } from "../github/helpers.js";

export async function listIssues(repo: TrackerRepo, opts?: ListIssuesOptions): Promise<Issue[]> {
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

export async function createIssue(
  repo: TrackerRepo,
  title: string,
  body: string,
  opts?: CreateIssueOptions
): Promise<Issue> {
  let milestoneNumber: number | undefined;
  if (opts?.milestone) {
    const milestones = gh<Array<{ number: number; title: string }>>(["api", `repos/${repoFlag(repo)}/milestones`]);
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

export async function getIssue(repo: TrackerRepo, number: number): Promise<Issue> {
  const data = gh<RawIssue>([
    "issue", "view", String(number),
    "--repo", repoFlag(repo),
    "--json", "number,title,body,state,url,labels",
  ]);
  return mapIssue(data);
}

export async function updateIssue(
  repo: TrackerRepo,
  number: number,
  opts: UpdateIssueOptions
): Promise<Issue> {
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

export async function setIssueStatus(
  repo: TrackerRepo,
  issueNumber: number,
  status: string
): Promise<void> {
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

export async function addSubIssue(
  repo: TrackerRepo,
  parentNumber: number,
  childNumber: number
): Promise<void> {
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

export async function listSubIssues(repo: TrackerRepo, parentNumber: number): Promise<Issue[]> {
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

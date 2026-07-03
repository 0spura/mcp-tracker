import type { TrackerRepo, ProjectItem, ProjectField } from "../types.js";
import { graphql, repoFlag, gh } from "./helpers.js";

// GitHub interprets boardId as a numeric project number (Projects V2).
function projectNumber(boardId: string): number {
  const n = parseInt(boardId, 10);
  if (isNaN(n)) throw new Error(`Invalid board ID "${boardId}": GitHub expects a numeric project number`);
  return n;
}

async function resolveOwner(repo: TrackerRepo): Promise<string> {
  const data = graphql<{ repository: { owner: { login: string } } }>(
    `query($owner: String!, $repo: String!) { repository(owner: $owner, name: $repo) { owner { login } } }`,
    { owner: repo.owner, repo: repo.repo }
  );
  return data.repository.owner.login;
}

async function resolveProjectId(owner: string, pn: number): Promise<string> {
  const data = graphql<{ repositoryOwner: { projectV2: { id: string } } }>(
    `query($owner: String!, $number: Int!) { repositoryOwner(login: $owner) { projectV2(number: $number) { id } } }`,
    { owner, number: pn }
  );
  return data.repositoryOwner.projectV2.id;
}

export async function listBoardItems(repo: TrackerRepo, boardId: string): Promise<ProjectItem[]> {
  const pn = projectNumber(boardId);
  const owner = await resolveOwner(repo);

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
                nodes { __typename ... on ProjectV2ItemFieldSingleSelectValue { name } }
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
    { owner, number: pn }
  );

  return data.repositoryOwner.projectV2.items.nodes.map((item) => {
    const statusField = item.fieldValues.nodes.find((f) => f.__typename === "ProjectV2ItemFieldSingleSelectValue");
    const c = item.content;
    return {
      id: item.id,
      status: statusField?.name ?? null,
      content: c ? {
        type: (c.__typename === "Issue" ? "issue" : "pr") as "issue" | "pr",
        number: c.number!,
        title: c.title!,
        state: c.state!,
        url: c.url!,
      } : null,
    };
  });
}

export async function listBoardFields(repo: TrackerRepo, boardId: string): Promise<ProjectField[]> {
  const pn = projectNumber(boardId);
  const owner = await resolveOwner(repo);

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
    { owner, number: pn }
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

export async function addIssueToBoard(
  repo: TrackerRepo,
  issueNumber: number,
  boardId: string
): Promise<string> {
  const pn = projectNumber(boardId);
  const data = graphql<{ repository: { issue: { id: string }; owner: { login: string } } }>(
    `query($owner: String!, $repo: String!) {
      repository(owner: $owner, name: $repo) {
        issue(number: ${issueNumber}) { id }
        owner { login }
      }
    }`,
    { owner: repo.owner, repo: repo.repo }
  );
  const projectId = await resolveProjectId(data.repository.owner.login, pn);

  const result = graphql<{ addProjectV2ItemById: { item: { id: string } } }>(
    `mutation($projectId: ID!, $contentId: ID!) {
      addProjectV2ItemById(input: { projectId: $projectId contentId: $contentId }) { item { id } }
    }`,
    { projectId, contentId: data.repository.issue.id }
  );
  return result.addProjectV2ItemById.item.id;
}

export async function setItemFields(
  repo: TrackerRepo,
  boardId: string,
  itemId: string,
  fields: Record<string, string>
): Promise<void> {
  const pn = projectNumber(boardId);
  const projectFields = await listBoardFields(repo, boardId);
  const owner = await resolveOwner(repo);
  const projectId = await resolveProjectId(owner, pn);

  for (const [fieldName, value] of Object.entries(fields)) {
    const field = projectFields.find((f) => f.name.toLowerCase() === fieldName.toLowerCase());
    if (!field) throw new Error(`Field "${fieldName}" not found. Available: ${projectFields.map((f) => f.name).join(", ")}`);

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

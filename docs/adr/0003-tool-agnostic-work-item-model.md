# 0003: Tool-agnostic work-item model

- Status: Accepted
- Date: 2026-07-30

## Context

The domain model grew around GitHub: integer issue numbers, `repo` as the universal scope anchor, board membership as an optional afterthought, and status as a Projects field. Trackers we explicitly want to plug in later (ADR-0002 names Jira and Linear; Trello is the stress case) break each assumption: Jira identifies items as `PROJ-123`, Trello has no repo and its cards live only on a board, and "status" is a list, a transition, a field, or a label depending on the tool. Baking GitHub's shape into the domain types would make every future provider a leaky adapter.

## Decision

The domain model is built around a tool-agnostic **work item**, from the first commit, even though only GitHub and local providers ship now:

1. **Opaque identifiers.** Item, comment, and milestone ids are strings (`ItemId`). GitHub formats its numbers as strings; Jira would use `PROJ-123`; Trello its card id. External tool parameters keep accepting GitHub-style numbers where the contract requires, but the boundary converts immediately.
2. **Declared scope.** Providers no longer receive `repo` as a universal argument. A `Scope { repo?, boardId? }` travels through calls, and each provider bundle declares `requires: ('repo' | 'board')[]`. The tool layer resolves the scope from context and fails only when a *required* key is missing. Trello would require `board`; GitHub requires `repo`; local requires neither.
3. **Abstract column.** "Status" means "the item's position in the workflow" — a Projects field, a Trello list, a Jira transition, a label set, or frontmatter. The mechanism is provider-internal (already RF-ISS.2). `workflow.stages` in config is an ordered list of named stages that providers map to their native mechanism.
4. **Comments hang off the item**, never the board. Card comments (Trello), ticket comments (Jira), and issue comments (GitHub) are the same capability.
5. **Board is an optional capability** meaning "a native board surface with custom fields", never a prerequisite for having items.

## Alternatives Considered

- **Keep GitHub's shape, adapt later:** cheapest now, but every interface signature (`number`, `TrackerRepo`, repo-first) would need a breaking rework when the second tracker family arrives — precisely the costly reversal ADRs exist to avoid.
- **Fully generic plugin model (entities, relations as data):** solves portability we do not need; the five decisions above cover the observed variance across GitHub, GitLab, Jira, Linear, and Trello without a meta-model.
- **Rename tools to neutral terms (`create_item`):** the external contract is frozen by RNF-CMP.1; "issue" is documented as the generic term instead.

## Consequences

- `Issue.id` is a string; GitHub-specific numeric conveniences live in the GitHub implementation, not the domain.
- Branch-name issue derivation captures both `42` and `PROJ-123` shapes.
- Config `workflow.stages` is ordered; automation triggers (`on.createIssue/createBranch/createPr`) reference stage keys, so "create the issue in the In design column" is configuration, not code.
- Tool docs must state that "issue" means "work item" generically.
- Adding Trello/Jira later = new files inside `src/domains/issues/` and `src/domains/boards/` plus one registry line; no tool or interface changes.

## Traceability

- Requirements: [RF-PRV.2](../srs.md#rf-prv2-capability-based-tool-registration), [RF-ISS.2](../srs.md#rf-iss2-issue-status), [RF-CTX.2](../srs.md#rf-ctx2-resolution-precedence)
- Tracker: none

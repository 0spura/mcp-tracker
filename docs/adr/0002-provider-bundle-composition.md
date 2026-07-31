# 0002: Provider bundle composition over duck-typed classes

- Status: Accepted
- Date: 2026-07-30

## Context

The pre-rewrite providers were stateless classes that only delegated to module-level functions, existing solely so `server.ts` could detect capabilities with `"method" in obj` duck-typing. The rewrite needs a provider model where capabilities are declarative, tool registration is statically typed, and providers are testable without a network. It also needs a seam where removed providers (GitLab) and future ones (Jira, Linear) plug in without touching the tool layer.

## Decision

Each provider module exports a factory returning a `ProviderBundle` — a plain object with optional members `code`, `issue`, `board`, `metadata`. A present member is a declared capability; `tools/register.ts` gates each tool domain on bundle member presence. External dependencies (`GhRunner`, directory paths) are injected into the factories, which is what makes the contract test suite runnable with fakes. Optional sub-capabilities (checklist, sub-issues, relationships) stay optional methods on `IssueProvider`.

## Alternatives Considered

- **Keep classes + duck-typing:** proven to work, but produced the delegator-class boilerplate and runtime-only capability checks the rewrite is eliminating. Rejected.
- **Single union interface with `UnsupportedError` defaults:** every provider implements everything, most methods throwing. Simple registration, but pushes capability absence to call time instead of registration time, and the SRS requires unregistered tools to be absent from the tool list. Rejected.
- **Plugin/registry system with dynamic loading:** solves a distribution problem this project does not have; providers ship in-tree. Rejected as overbuilt.

## Consequences

- Adding a provider means writing one factory and one line in `server.ts`'s provider map; the tool layer is untouched.
- Capability mistakes are compile-time errors, not runtime surprises.
- Sub-capabilities still use method-presence checks inside the issue tool domain — a contained, typed exception to the no-duck-typing rule.
- The bundle shape is the documented seam for reintroducing GitLab providers later.

## Traceability

- Requirements: [RF-PRV.1](../srs.md#rf-prv1-provider-selection-via-environment), [RF-PRV.2](../srs.md#rf-prv2-capability-based-tool-registration), [RNF-TST.1](../srs.md#rnf-tst1-contract-test-suite)
- Tracker: none

# Workctl vision

## Problem

Developers and coding agents need a small local CLI for managing work items in the current repository. The existing MCP server is being replaced with a native Rust command-line tool, beginning with the GitHub issue workflow used most often.

## Vision

`workctl` provides predictable, scriptable issue operations while leaving GitHub authentication to the official `gh` CLI. It infers the current repository from Git when possible, accepts explicit overrides, and reports machine-readable errors without exposing provider diagnostics.

## Initial users and outcomes

- Developers can create, list, inspect, and edit GitHub issues from a terminal.
- Coding agents can invoke those same operations without an MCP host or direct access to credentials.
- Scripts can consume compact JSON output and distinguish failures using stable error codes and exit status.

## v0 boundary

The initial release supports GitHub issue create/list/show/edit, including list filters, attachment upload, and body edits that never require rewriting the whole body. It excludes issue deletion, GitLab, pull requests, projects and boards, comments, relationships, checklists, attachment management beyond upload, token handling, direct HTTP, and MCP transport. See the [SRS](../srs.md) for observable requirements and [architecture](../architecture.md) for implementation boundaries.

## Design principles

- Keep the CLI and provider boundary explicit; avoid an omnibus command or provider module.
- Prefer Git context, with explicit provider and repository flags for automation and non-repository use.
- Fail closed on ambiguous provider selection, invalid configuration, or malformed provider data.
- Keep user-facing output stable and safe: JSON by default, optional text, no raw subprocess stderr.
- Exercise behavior against isolated command fixtures; tests do not mutate live GitHub issues.

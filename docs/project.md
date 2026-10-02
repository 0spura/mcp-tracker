# Project: workctl

## Stack

- **Runtime:** native Rust binary, built with the stable toolchain.
- **CLI:** `clap` derive API; 4.6.7 was the latest release checked on 2026-10-01.
- **Serialization:** `serde` and `serde_json` for strict config and provider payloads.
- **External CLIs:** `gh` for GitHub requests/authentication; `git` for worktree and remote discovery.
- **Subprocesses:** `std::process::Command` behind one process runner; `wait-timeout` enforces the child deadline.
- **Tests:** Rust unit and integration tests under Cargo. No network access or live issue mutation in tests.

## Global constraints

- No direct HTTP clients, token management, or automatic dependency downloads.
- No shell invocation; untrusted values remain argument/stdin data.
- User errors never include raw provider stderr, credentials, stack traces, or internal paths.
- v0 supports GitHub issue create/list/show/edit only. GitLab and other old MCP capabilities are deferred.
- Modules are split by ownership and reason to change; no omnibus `main.rs`, command, provider, or output module.

## Repository layout

```text
src/              Rust binary modules
tests/            CLI/provider integration tests
docs/             vision, SRS, architecture, ADRs
Cargo.toml        application manifest
Cargo.lock        resolved application dependency versions
rust-toolchain.toml stable Rust channel
target/           local build output; not committed
```

## Environments and verification

- Runtime: developer machine with `git`, `gh`, and GitHub authentication configured.
- `cargo test`: unit and isolated CLI tests.
- `cargo build --release`: optimized local-target binary at `target/release/workctl`.

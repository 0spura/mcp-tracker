#![cfg(unix)]

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::process::{Command, Output};
use std::sync::atomic::{AtomicUsize, Ordering};

use serde_json::{Value, json};

static NEXT_DIR: AtomicUsize = AtomicUsize::new(0);

struct Fixture {
    root: PathBuf,
    bin: PathBuf,
    log: PathBuf,
    input: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "workctl-cli-{}-{}",
            std::process::id(),
            NEXT_DIR.fetch_add(1, Ordering::Relaxed)
        ));
        let bin = root.join("bin");
        fs::create_dir_all(&bin).expect("create isolated fixture directory");
        let log = root.join("gh-args.log");
        let input = root.join("gh-input.json");
        let script = r#"#!/bin/sh
printf '%s\n' "$*" >> "$WORKCTL_GH_LOG"
if [ "$1" = "auth" ]; then
    if [ "$WORKCTL_GH_MODE" = "auth-failure" ]; then
        printf '%s\n' 'provider diagnostic withheld' >&2
        exit 1
    fi
    exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "list" ]; then
    printf '%s\n' '[{"number":8,"title":"First","state":"OPEN","url":"https://github.com/owner/repo/issues/8","updatedAt":"2026-01-01T00:00:00Z"},{"number":9,"title":"Second","state":"CLOSED","url":"https://github.com/owner/repo/issues/9","updatedAt":"2026-01-02T00:00:00Z"}]'
    exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "create" ]; then
    cat > "$WORKCTL_GH_INPUT"
    printf '%s\n' 'https://github.com/owner/repo/issues/7'
    exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "edit" ]; then
    cat > "$WORKCTL_GH_INPUT"
    exit 0
fi
if [ "$1" = "api" ]; then
    if [ "$WORKCTL_GH_MODE" = "early-exit" ]; then
        printf '%s\n' '{"number":7,"title":"Provider title","body":"Provider body\n\n## Notes\n\noriginal notes","state":"OPEN","html_url":"https://github.com/owner/repo/issues/7","created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-02T00:00:00Z"}'
        exit 0
    fi
    cat > "$WORKCTL_GH_INPUT"
    if [ "$WORKCTL_GH_MODE" = "pull-request" ]; then
        printf '%s\n' '{"number":7,"title":"Not an issue","body":null,"state":"OPEN","html_url":"https://github.com/owner/repo/pull/7","created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-02T00:00:00Z","pull_request":{}}'
    else
        printf '%s\n' '{"number":7,"title":"Provider title","body":"Provider body\n\n## Notes\n\noriginal notes","state":"OPEN","html_url":"https://github.com/owner/repo/issues/7","created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-02T00:00:00Z"}'
    fi
    exit 0
fi
printf '%s\n' 'unexpected fixture invocation' >&2
exit 64
"#;
        let script_path = bin.join("gh");
        fs::write(&script_path, script).expect("write gh fixture");
        let mut permissions = fs::metadata(&script_path)
            .expect("read fixture permissions")
            .permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&script_path, permissions).expect("make fixture executable");
        Self {
            root,
            bin,
            log,
            input,
        }
    }

    fn run(&self, args: &[&str], mode: &str) -> Output {
        let mut paths = vec![self.bin.clone()];
        paths.extend(std::env::split_paths(
            &std::env::var_os("PATH").unwrap_or_default(),
        ));
        let path = std::env::join_paths(paths).expect("compose isolated PATH");
        Command::new(env!("CARGO_BIN_EXE_workctl"))
            .args(args)
            .current_dir(&self.root)
            .env("PATH", path)
            .env("WORKCTL_GH_LOG", &self.log)
            .env("WORKCTL_GH_INPUT", &self.input)
            .env("WORKCTL_GH_MODE", mode)
            .output()
            .expect("run workctl binary")
    }

    fn run_issue(&self, args: &[&str], mode: &str) -> Output {
        let mut full_args = vec!["--provider", "github", "--repo", "owner/repo"];
        full_args.extend_from_slice(args);
        self.run(&full_args, mode)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn success_json(output: &Output) -> Value {
    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stderr.is_empty());
    serde_json::from_slice(&output.stdout).expect("valid JSON success output")
}

fn error_json(output: &Output) -> Value {
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    serde_json::from_slice(&output.stderr).expect("valid JSON error output")
}

#[test]
fn create_list_show_and_edit_preserve_the_cli_contract() {
    let fixture = Fixture::new();
    let title = "quoted \" title; $(touch should-not-run)";
    let body = "first line\nsecond line; $(touch should-not-run)";

    let created = fixture.run_issue(
        &["issue", "create", "--title", title, "--body", body],
        "",
    );
    let created = success_json(&created);
    assert_eq!(created["number"], 7);
    assert_eq!(created["state"], "open");
    assert_eq!(created["body"], "Provider body\n\n## Notes\n\noriginal notes");
    let request: Value = serde_json::from_slice(&fs::read(&fixture.input).expect("read create body"))
        .expect("create request JSON");
    assert_eq!(request, json!({"title": title, "body": body}));


    let created_without_body =
        fixture.run_issue(&["issue", "create", "--title", "No body"], "");
    success_json(&created_without_body);
    let request: Value = serde_json::from_slice(&fs::read(&fixture.input).expect("read empty-body create"))
        .expect("empty-body create JSON");
    assert_eq!(request, json!({"title": "No body", "body": ""}));
    let listed = fixture.run_issue(
        &["issue", "list", "--state", "closed", "--limit", "1"],
        "",
    );
    let listed = success_json(&listed);
    assert_eq!(listed.as_array().expect("issue list").len(), 1);
    assert_eq!(listed[0]["number"], 8);
    assert_eq!(listed[0]["state"], "open");
    assert!(listed[0].get("body").is_none());
    let maximum = fixture.run_issue(&["issue", "list", "--limit", "1000"], "");
    assert_eq!(success_json(&maximum).as_array().expect("issue list").len(), 2);

    let shown = fixture.run_issue(&["issue", "show", "7"], "");
    let shown = success_json(&shown);
    assert_eq!(shown["url"], "https://github.com/owner/repo/issues/7");
    assert_eq!(shown["created_at"], "2026-01-01T00:00:00Z");

    let edited = fixture.run_issue(&["issue", "edit", "7", "--body", ""], "");
    let edited = success_json(&edited);
    assert_eq!(edited["number"], 7);
    let request: Value = serde_json::from_slice(&fs::read(&fixture.input).expect("read edit body"))
        .expect("edit request JSON");
    assert_eq!(request, json!({"body": ""}));

    let log = fs::read_to_string(&fixture.log).expect("read gh argument log");
    assert!(log.contains("api --method POST --input - repos/owner/repo/issues"));
    assert!(log.contains(
        "issue list --repo owner/repo --state closed --limit 1 --json number,title,state,url,updatedAt"
    ));
    assert!(log.contains(
        "issue list --repo owner/repo --state open --limit 1000 --json number,title,state,url,updatedAt"
    ));
    assert!(log.contains("api repos/owner/repo/issues/7"));
    assert!(log.contains("api --method PATCH --input - repos/owner/repo/issues/7"));
    assert!(!fixture.root.join("should-not-run").exists());
}

#[test]
fn text_output_and_provider_failures_are_safe() {
    let fixture = Fixture::new();
    let text = fixture.run_issue(
        &["issue", "list", "--format", "text", "--limit", "2"],
        "",
    );
    assert!(text.status.success());
    assert!(String::from_utf8_lossy(&text.stdout).contains("#8 First [open]"));

    let auth = fixture.run_issue(&["issue", "show", "7"], "auth-failure");
    let error = error_json(&auth);
    assert_eq!(error["code"], "authentication");
    assert!(!String::from_utf8_lossy(&auth.stderr).contains("provider diagnostic"));

    let pull_request = fixture.run_issue(&["issue", "show", "7"], "pull-request");
    assert_eq!(error_json(&pull_request)["code"], "not_issue");
    let large_body = "x".repeat(100_000);
    let early_exit = fixture.run_issue(
        &["issue", "create", "--title", "Closed stdin", "--body", &large_body],
        "early-exit",
    );
    assert_eq!(success_json(&early_exit)["number"], 7);
    let pull_request_edit = fixture.run_issue(
        &["issue", "edit", "7", "--title", "Must not change"],
        "pull-request",
    );
    assert_eq!(error_json(&pull_request_edit)["code"], "not_issue");
    let log = fs::read_to_string(&fixture.log).expect("read gh argument log");
    assert!(!log.contains("api --method PATCH"));
}

#[test]
fn help_documents_every_flag_and_the_patch_contract() {
    let fixture = Fixture::new();
    for args in [
        &["issue", "create", "--help"][..],
        &["issue", "list", "--help"][..],
        &["issue", "edit", "--help"][..],
    ] {
        let output = fixture.run(args, "");
        assert!(output.status.success());
        let help = String::from_utf8_lossy(&output.stdout);
        // Only the indented options block; after-help prose also starts lines with `--`.
        for line in help
            .lines()
            .filter(|line| line.starts_with("  ") && line.trim_start().starts_with("--"))
        {
            let line = line.trim();
            let described = line
                .split_once("  ")
                .is_some_and(|(_, description)| !description.trim().is_empty());
            assert!(described, "flag without a help description: {line}");
        }
    }
    // The patch failure mode is the one thing a caller cannot guess from the flag names.
    let edit = fixture.run(&["issue", "edit", "--help"], "");
    let help = String::from_utf8_lossy(&edit.stdout);
    assert!(help.contains("patch_conflict"));
    assert!(help.contains("exact context match"));
    assert!(!fixture.log.exists());
}

#[test]
fn invalid_inputs_and_unsupported_provider_fail_before_gh() {
    let fixture = Fixture::new();
    let blank_title = fixture.run_issue(&["issue", "create", "--title", "   "], "");
    assert_eq!(error_json(&blank_title)["code"], "invalid_input");
    let invalid = [
        &["issue", "list", "--limit", "0"][..],
        &["issue", "list", "--limit", "1001"][..],
        &["issue", "show", "0"][..],
        &["issue", "show", "not-a-number"][..],
        &["issue", "edit", "7"][..],
        &["issue", "edit", "7", "--title", "  "][..],
        &["issue", "delete", "7"][..],
    ];
    for args in invalid {
        let output = fixture.run_issue(args, "");
        assert_eq!(error_json(&output)["code"], "invalid_input");
    }
    assert!(!fixture.log.exists());

    let unsupported = fixture.run(
        &["--provider", "gitlab", "--repo", "owner/repo", "issue", "list"],
        "",
    );
    assert_eq!(error_json(&unsupported)["code"], "provider_unsupported");
    assert!(!fixture.log.exists());

    let help = fixture.run(&["issue", "--help"], "");
    assert!(help.status.success());
    let help_text = String::from_utf8_lossy(&help.stdout);
    let commands: Vec<_> = help_text
        .lines()
        .skip_while(|line| line.trim() != "Commands:")
        .skip(1)
        .take_while(|line| !line.trim().is_empty())
        .filter_map(|line| line.split_whitespace().next())
        .collect();
    assert_eq!(commands, ["create", "list", "show", "edit"]);
    assert!(!fixture.log.exists());
    assert!(
        Command::new("git")
            .args(["init", "--quiet"])
            .current_dir(&fixture.root)
            .status()
            .expect("initialize test Git root")
            .success()
    );
    fs::write(
        fixture.root.join(".workctl.json"),
        r#"{"repo":"owner/repo"}"#,
    )
    .expect("write invalid project config");
    let invalid_config = fixture.run_issue(
        &["issue", "create", "--title", "Must not mutate"],
        "",
    );
    assert_eq!(error_json(&invalid_config)["code"], "config");
    assert!(!fixture.log.exists());
}

#[test]
fn body_changes_reach_github_without_rewriting_the_whole_body() {
    let fixture = Fixture::new();
    let patch_path = fixture.root.join("body.patch");
    fs::write(
        &patch_path,
        "@@ -5,1 +5,1 @@\n-original notes\n+revised notes\n",
    )
    .expect("write patch file");

    let appended = fixture.run_issue(&["issue", "edit", "7", "--append-body", "extra"], "");
    success_json(&appended);
    let request: Value =
        serde_json::from_slice(&fs::read(&fixture.input).expect("read append body"))
            .expect("append request JSON");
    assert_eq!(
        request,
        json!({"body": "Provider body\n\n## Notes\n\noriginal notes\nextra"})
    );

    let sectioned = fixture.run_issue(
        &[
            "issue",
            "edit",
            "7",
            "--replace-section",
            "## Notes",
            "--section-body",
            "replaced",
        ],
        "",
    );
    success_json(&sectioned);
    let request: Value =
        serde_json::from_slice(&fs::read(&fixture.input).expect("read section body"))
            .expect("section request JSON");
    assert_eq!(request["body"], "Provider body\n\n## Notes\nreplaced");

    let patched = fixture.run_issue(
        &["issue", "edit", "7", "--patch-file", "body.patch"],
        "",
    );
    success_json(&patched);
    let request: Value =
        serde_json::from_slice(&fs::read(&fixture.input).expect("read patched body"))
            .expect("patch request JSON");
    assert_eq!(request["body"], "Provider body\n\n## Notes\n\nrevised notes");

    let log = fs::read_to_string(&fixture.log).expect("read gh argument log");
    // One fetch per edit: the body is read once and patched locally.
    assert_eq!(log.matches("api repos/owner/repo/issues/7").count(), 3);
    assert_eq!(log.matches("api --method PATCH").count(), 3);
}

#[test]
fn attachment_flags_use_the_gh_issue_commands() {
    let fixture = Fixture::new();
    fs::write(fixture.root.join("shot.png"), b"png").expect("write attachment");

    let created = fixture.run_issue(
        &[
            "issue",
            "create",
            "--title",
            "With image",
            "--body",
            "see image",
            "--attach",
            "shot.png#Screenshot",
        ],
        "",
    );
    assert_eq!(success_json(&created)["number"], 7);

    let edited = fixture.run_issue(
        &["issue", "edit", "7", "--attach", "shot.png"],
        "",
    );
    success_json(&edited);

    let log = fs::read_to_string(&fixture.log).expect("read gh argument log");
    assert!(log.contains(
        "issue create --repo owner/repo --title With image --body-file - --attach shot.png#Screenshot"
    ));
    assert!(log.contains("issue edit 7 --repo owner/repo --attach shot.png"));
    // The attachment commands carry the body on stdin, not in the argument list.
    assert!(!log.contains("--body see image"));
}

#[test]
fn list_filters_and_edit_guards_are_enforced() {
    let fixture = Fixture::new();
    let listed = fixture.run_issue(
        &[
            "issue",
            "list",
            "--label",
            "bug",
            "--label",
            "p1",
            "--assignee",
            "me",
            "--search",
            "in:title fix",
            "--milestone",
            "v1",
        ],
        "",
    );
    success_json(&listed);
    let log = fs::read_to_string(&fixture.log).expect("read gh argument log");
    assert!(log.contains(
        "issue list --repo owner/repo --state open --limit 30 --json number,title,state,url,updatedAt --label bug --label p1 --assignee me --milestone v1 --search in:title fix"
    ));

    let guarded = fixture.run_issue(
        &[
            "issue",
            "edit",
            "7",
            "--title",
            "Stale",
            "--expect-updated-at",
            "2020-01-01T00:00:00Z",
        ],
        "",
    );
    assert_eq!(error_json(&guarded)["code"], "conflict");
    let log = fs::read_to_string(&fixture.log).expect("read gh argument log");
    assert!(!log.contains("api --method PATCH"));

    let accepted = fixture.run_issue(
        &[
            "issue",
            "edit",
            "7",
            "--title",
            "Fresh",
            "--expect-updated-at",
            "2026-01-02T00:00:00Z",
        ],
        "",
    );
    success_json(&accepted);

    let bad_patch = fixture.root.join("bad.patch");
    fs::write(&bad_patch, "@@ -1,1 +1,1 @@\n-not the body\n+replacement\n")
        .expect("write non-applying patch");
    let rejected = [
        &["issue", "edit", "7", "--body", "a", "--append-body", "b"][..],
        &["issue", "edit", "7", "--replace-section", "## Notes"][..],
        &["issue", "edit", "7", "--section-body", "orphan"][..],
        &["issue", "edit", "7", "--patch-file", "bad.patch"][..],
        &["issue", "edit", "7", "--attach", "missing.png"][..],
    ];
    for args in rejected {
        let output = fixture.run_issue(args, "");
        let code = error_json(&output)["code"].clone();
        assert!(
            code == "invalid_input" || code == "patch_conflict",
            "unexpected code {code} for {args:?}"
        );
    }
    let log = fs::read_to_string(&fixture.log).expect("read gh argument log");
    assert_eq!(log.matches("api --method PATCH").count(), 1);
}

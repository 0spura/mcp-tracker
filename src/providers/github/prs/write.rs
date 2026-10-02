use crate::domain::{AppError, PullRequest, body};
use crate::providers::github::prs::{GitHubPulls, read};
use crate::providers::{
    MergeMethod, NewPr, PrPatch, ReviewEvent, resolve_body_change,
};

pub(super) fn create(provider: &GitHubPulls, pr: &NewPr) -> Result<PullRequest, AppError> {
    let body = if pr.closes.is_empty() {
        pr.body.clone()
    } else {
        let block = pr
            .closes
            .iter()
            .map(|number| format!("Closes #{number}"))
            .collect::<Vec<_>>()
            .join("\n");
        body::append(&pr.body, &block)
    };

    let mut args = vec![
        "pr".to_owned(),
        "create".to_owned(),
        "--repo".to_owned(),
        provider.repo.clone(),
        "--title".to_owned(),
        pr.title.clone(),
        "--body-file".to_owned(),
        "-".to_owned(),
    ];
    if let Some(base) = &pr.base {
        args.push("--base".to_owned());
        args.push(base.clone());
    }
    if let Some(head) = &pr.head {
        args.push("--head".to_owned());
        args.push(head.clone());
    }
    if pr.draft {
        args.push("--draft".to_owned());
    }
    let output = provider.run_gh(&args, Some(body.into_bytes()))?;
    read::show(provider, parse_pr_number(&output)?)
}

pub(super) fn edit(
    provider: &GitHubPulls,
    number: u64,
    patch: &PrPatch,
) -> Result<PullRequest, AppError> {
    let current = read::show(provider, number)?;
    if let Some(expected) = patch.expect_updated_at.as_deref() {
        if current.updated_at != expected {
            return Err(AppError::conflict());
        }
    }

    let body = match &patch.body {
        Some(change) => Some(resolve_body_change(&current.body, change)?),
        None => None,
    };
    if !has_field(patch, body.is_some()) {
        return Ok(current);
    }

    let mut args = vec![
        "pr".to_owned(),
        "edit".to_owned(),
        number.to_string(),
        "--repo".to_owned(),
        provider.repo.clone(),
    ];
    if let Some(title) = &patch.title {
        args.push("--title".to_owned());
        args.push(title.clone());
    }
    if body.is_some() {
        args.push("--body-file".to_owned());
        args.push("-".to_owned());
    }
    if let Some(base) = &patch.base {
        args.push("--base".to_owned());
        args.push(base.clone());
    }
    push_repeated(&mut args, "--add-label", &patch.labels_add);
    push_repeated(&mut args, "--remove-label", &patch.labels_remove);
    push_repeated(&mut args, "--add-reviewer", &patch.reviewers_add);
    push_repeated(&mut args, "--remove-reviewer", &patch.reviewers_remove);
    push_repeated(&mut args, "--add-assignee", &patch.assignees_add);
    push_repeated(&mut args, "--remove-assignee", &patch.assignees_remove);
    if let Some(milestone) = &patch.milestone {
        args.push("--milestone".to_owned());
        args.push(milestone.clone());
    }
    provider.run_gh(&args, body.map(String::into_bytes))?;
    read::show(provider, number)
}

pub(super) fn review(
    provider: &GitHubPulls,
    number: u64,
    event: ReviewEvent,
    body: Option<&str>,
) -> Result<(), AppError> {
    let event = match event {
        ReviewEvent::Approve => "--approve",
        ReviewEvent::RequestChanges => "--request-changes",
        ReviewEvent::Comment => "--comment",
    };
    let mut args = vec![
        "pr".to_owned(),
        "review".to_owned(),
        number.to_string(),
        "--repo".to_owned(),
        provider.repo.clone(),
        event.to_owned(),
    ];
    if body.is_some() {
        args.push("--body-file".to_owned());
        args.push("-".to_owned());
    }
    provider.run_gh(&args, body.map(|body| body.as_bytes().to_vec()))?;
    Ok(())
}

pub(super) fn merge(
    provider: &GitHubPulls,
    number: u64,
    method: Option<MergeMethod>,
    delete_branch: bool,
    auto: bool,
) -> Result<(), AppError> {
    let mut args = vec![
        "pr".to_owned(),
        "merge".to_owned(),
        number.to_string(),
        "--repo".to_owned(),
        provider.repo.clone(),
    ];
    if let Some(method) = method {
        args.push(format!("--{}", method.as_str()));
    }
    if delete_branch {
        args.push("--delete-branch".to_owned());
    }
    if auto {
        args.push("--auto".to_owned());
    }
    provider.run_gh(&args, None)?;
    Ok(())
}

pub(super) fn set_ready(
    provider: &GitHubPulls,
    number: u64,
    draft: bool,
) -> Result<(), AppError> {
    let mut args = vec![
        "pr".to_owned(),
        "ready".to_owned(),
        number.to_string(),
        "--repo".to_owned(),
        provider.repo.clone(),
    ];
    if draft {
        args.push("--undo".to_owned());
    }
    provider.run_gh(&args, None)?;
    Ok(())
}

pub(super) fn close(
    provider: &GitHubPulls,
    number: u64,
    comment: Option<&str>,
    delete_branch: bool,
) -> Result<(), AppError> {
    let mut args = vec![
        "pr".to_owned(),
        "close".to_owned(),
        number.to_string(),
        "--repo".to_owned(),
        provider.repo.clone(),
    ];
    if let Some(comment) = comment {
        args.push("-c".to_owned());
        args.push(comment.to_owned());
    }
    if delete_branch {
        args.push("--delete-branch".to_owned());
    }
    provider.run_gh(&args, None)?;
    Ok(())
}

pub(super) fn reopen(
    provider: &GitHubPulls,
    number: u64,
    comment: Option<&str>,
) -> Result<(), AppError> {
    let mut args = vec![
        "pr".to_owned(),
        "reopen".to_owned(),
        number.to_string(),
        "--repo".to_owned(),
        provider.repo.clone(),
    ];
    if let Some(comment) = comment {
        args.push("-c".to_owned());
        args.push(comment.to_owned());
    }
    provider.run_gh(&args, None)?;
    Ok(())
}

fn push_repeated(args: &mut Vec<String>, flag: &str, values: &[String]) {
    for value in values {
        args.push(flag.to_owned());
        args.push(value.clone());
    }
}

/// Whether the patch requests any mutation; `expect_updated_at` only guards concurrency.
fn has_field(patch: &PrPatch, has_body: bool) -> bool {
    has_body
        || patch.title.is_some()
        || patch.base.is_some()
        || patch.milestone.is_some()
        || !patch.labels_add.is_empty()
        || !patch.labels_remove.is_empty()
        || !patch.reviewers_add.is_empty()
        || !patch.reviewers_remove.is_empty()
        || !patch.assignees_add.is_empty()
        || !patch.assignees_remove.is_empty()
}

/// Extracts the pull request number from the URL printed by `gh pr create`.
fn parse_pr_number(output: &[u8]) -> Result<u64, AppError> {
    let text = std::str::from_utf8(output).map_err(|_| AppError::provider_response())?;
    text.split_whitespace()
        .filter_map(|token| token.rsplit_once("/pull/"))
        .filter_map(|(_, number)| number.trim_end_matches('/').parse::<u64>().ok())
        .next()
        .ok_or(AppError::provider_response())
}

#[cfg(test)]
mod tests {
    use super::parse_pr_number;

    #[test]
    fn reads_the_pull_request_number_from_created_output() {
        let output = b"https://github.com/owner/repo/pull/21\n";
        assert_eq!(parse_pr_number(output).expect("number"), 21);
        let noisy = b"warning: something\nhttps://github.com/owner/repo/pull/7\n";
        assert_eq!(parse_pr_number(noisy).expect("number"), 7);
    }

    #[test]
    fn rejects_output_without_a_pull_request_url() {
        assert_eq!(
            parse_pr_number(b"nothing here").unwrap_err().code,
            "provider_response"
        );
    }
}

use crate::domain::{AppError, Issue};
use crate::providers::github::issues::{GitHubIssues, mapping, read};
use crate::providers::{Attachment, NewIssue};

pub(super) fn create(provider: &GitHubIssues, issue: &NewIssue) -> Result<Issue, AppError> {
    if issue.attachments.is_empty() {
        let payload = serde_json::to_vec(&serde_json::json!({
            "title": issue.title,
            "body": issue.body,
        }))
        .map_err(|_| AppError::provider_response())?;
        let endpoint = format!("repos/{}/issues", provider.repo);
        let args = [
            "api".to_owned(),
            "--method".to_owned(),
            "POST".to_owned(),
            "--input".to_owned(),
            "-".to_owned(),
            endpoint,
        ];
        return mapping::issue(&provider.run_gh(&args, Some(payload))?);
    }

    // Attachment upload exists only in the `gh issue` command; the body still travels on stdin.
    let mut args = vec![
        "issue".to_owned(),
        "create".to_owned(),
        "--repo".to_owned(),
        provider.repo.clone(),
        "--title".to_owned(),
        issue.title.clone(),
        "--body-file".to_owned(),
        "-".to_owned(),
    ];
    push_attachments(&mut args, &issue.attachments);
    let output = provider.run_gh(&args, Some(issue.body.clone().into_bytes()))?;
    read::show(provider, parse_issue_number(&output)?)
}

pub(super) fn edit(
    provider: &GitHubIssues,
    number: u64,
    title: Option<&str>,
    body: Option<&str>,
    attachments: &[Attachment],
) -> Result<Issue, AppError> {
    if attachments.is_empty() {
        let mut payload = serde_json::Map::new();
        if let Some(title) = title {
            payload.insert("title".to_owned(), serde_json::Value::String(title.to_owned()));
        }
        if let Some(body) = body {
            payload.insert("body".to_owned(), serde_json::Value::String(body.to_owned()));
        }
        let payload = serde_json::to_vec(&serde_json::Value::Object(payload))
            .map_err(|_| AppError::provider_response())?;
        let endpoint = format!("repos/{}/issues/{number}", provider.repo);
        let args = [
            "api".to_owned(),
            "--method".to_owned(),
            "PATCH".to_owned(),
            "--input".to_owned(),
            "-".to_owned(),
            endpoint,
        ];
        return mapping::issue(&provider.run_gh(&args, Some(payload))?);
    }

    let mut args = vec![
        "issue".to_owned(),
        "edit".to_owned(),
        number.to_string(),
        "--repo".to_owned(),
        provider.repo.clone(),
    ];
    if let Some(title) = title {
        args.push("--title".to_owned());
        args.push(title.to_owned());
    }
    if body.is_some() {
        args.push("--body-file".to_owned());
        args.push("-".to_owned());
    }
    push_attachments(&mut args, attachments);
    provider.run_gh(&args, body.map(|body| body.as_bytes().to_vec()))?;
    read::show(provider, number)
}

fn push_attachments(args: &mut Vec<String>, attachments: &[Attachment]) {
    for attachment in attachments {
        args.push("--attach".to_owned());
        args.push(attachment.gh_argument());
    }
}

/// Extracts the issue number from the URL printed by `gh issue create`.
fn parse_issue_number(output: &[u8]) -> Result<u64, AppError> {
    let text = std::str::from_utf8(output).map_err(|_| AppError::provider_response())?;
    text.split_whitespace()
        .filter_map(|token| token.rsplit_once("/issues/"))
        .filter_map(|(_, number)| number.trim_end_matches('/').parse::<u64>().ok())
        .next()
        .ok_or(AppError::provider_response())
}

#[cfg(test)]
mod tests {
    use super::parse_issue_number;

    #[test]
    fn reads_the_issue_number_from_created_output() {
        let output = b"https://github.com/owner/repo/issues/21\n";
        assert_eq!(parse_issue_number(output).expect("number"), 21);
        let noisy = b"warning: something\nhttps://github.com/owner/repo/issues/7\n";
        assert_eq!(parse_issue_number(noisy).expect("number"), 7);
    }

    #[test]
    fn rejects_output_without_an_issue_url() {
        assert_eq!(
            parse_issue_number(b"nothing here").unwrap_err().code,
            "provider_response"
        );
    }
}

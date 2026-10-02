use crate::domain::{AppError, Issue, IssueSummary};
use crate::providers::IssueQuery;
use crate::providers::github::issues::{GitHubIssues, mapping};

pub(super) fn list(
    provider: &GitHubIssues,
    query: &IssueQuery,
) -> Result<Vec<IssueSummary>, AppError> {
    let mut args = vec![
        "issue".to_owned(),
        "list".to_owned(),
        "--repo".to_owned(),
        provider.repo.clone(),
        "--state".to_owned(),
        query.state.clone(),
        "--limit".to_owned(),
        query.limit.to_string(),
        "--json".to_owned(),
        "number,title,state,url,updatedAt".to_owned(),
    ];
    for label in &query.labels {
        args.push("--label".to_owned());
        args.push(label.clone());
    }
    for (flag, value) in [
        ("--assignee", &query.assignee),
        ("--author", &query.author),
        ("--mention", &query.mention),
        ("--milestone", &query.milestone),
        ("--search", &query.search),
        ("--type", &query.issue_type),
    ] {
        if let Some(value) = value {
            args.push(flag.to_owned());
            args.push(value.clone());
        }
    }
    let output = provider.run_gh(&args, None)?;
    let mut issues = mapping::issue_summaries(&output)?;
    issues.truncate(query.limit);
    Ok(issues)
}

pub(super) fn show(provider: &GitHubIssues, number: u64) -> Result<Issue, AppError> {
    let endpoint = format!("repos/{}/issues/{number}", provider.repo);
    let args = ["api".to_owned(), endpoint];
    mapping::issue(&provider.run_gh(&args, None)?)
}

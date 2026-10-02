use std::fs;

use crate::cli::{IssueAction, IssueArgs, ListArgs, OutputFormat};
use crate::config::Provider;
use crate::domain::AppError;
use crate::output::{self, SuccessOutput};
use crate::providers::github::issues::GitHubIssues;
use crate::providers::{Attachment, IssuePatch, IssueQuery, NewIssue, WorkItemProvider};

use super::support;

pub(super) fn execute(
    explicit_provider: Option<Provider>,
    explicit_repo: Option<&str>,
    format: OutputFormat,
    args: IssueArgs,
) -> Result<(), AppError> {
    let output = match args.action {
        IssueAction::Create(args) => {
            validate_title(&args.title)?;
            let body = support::optional_text(
                args.body.as_deref(),
                args.body_file.as_deref(),
                "use either --body or --body-file",
            )?
            .unwrap_or_default();
            let attachments = parse_attachments(&args.attach)?;
            let provider = provider(explicit_provider, explicit_repo)?;
            SuccessOutput::Issue(provider.create(&NewIssue {
                title: args.title,
                body,
                attachments,
            })?)
        }
        IssueAction::List(args) => {
            let query = query(&args)?;
            let provider = provider(explicit_provider, explicit_repo)?;
            SuccessOutput::Issues(provider.list(&query)?)
        }
        IssueAction::Show { number } => {
            let provider = provider(explicit_provider, explicit_repo)?;
            SuccessOutput::Issue(provider.show(number.0)?)
        }
        IssueAction::Edit(args) => {
            if let Some(title) = args.title.as_deref() {
                validate_title(title)?;
            }
            let change = support::body_change(&args.change)?;
            let attachments = parse_attachments(&args.attach)?;
            if args.title.is_none() && change.is_none() && attachments.is_empty() {
                return Err(AppError::invalid_input(
                    "edit requires --title, a body change, or --attach",
                ));
            }
            let provider = provider(explicit_provider, explicit_repo)?;
            SuccessOutput::Issue(provider.edit(
                args.number.0,
                &IssuePatch {
                    title: args.title,
                    body: change,
                    attachments,
                    expect_updated_at: args.expect_updated_at,
                },
            )?)
        }
    };
    output::write(format, &output)
}

fn query(args: &ListArgs) -> Result<IssueQuery, AppError> {
    support::validate_filters(&[
        &args.assignee,
        &args.author,
        &args.mention,
        &args.milestone,
        &args.search,
        &args.issue_type,
    ])?;
    support::validate_names(&args.labels, "label values must not be blank")?;
    Ok(IssueQuery {
        state: args.state.as_str().to_owned(),
        limit: args.limit,
        labels: args.labels.clone(),
        assignee: args.assignee.clone(),
        author: args.author.clone(),
        mention: args.mention.clone(),
        milestone: args.milestone.clone(),
        search: args.search.clone(),
        issue_type: args.issue_type.clone(),
    })
}

/// Parses `FILE[#ALT]` values and rejects files that do not exist.
fn parse_attachments(values: &[String]) -> Result<Vec<Attachment>, AppError> {
    values
        .iter()
        .map(|value| {
            let (path, alt) = match value.split_once('#') {
                Some((path, alt)) => (path, Some(alt)),
                None => (value.as_str(), None),
            };
            if path.is_empty() {
                return Err(AppError::invalid_input("attachment path must not be empty"));
            }
            let metadata = fs::metadata(path).map_err(|_| {
                AppError::invalid_input("attachment must be an existing regular file")
            })?;
            if !metadata.is_file() {
                return Err(AppError::invalid_input(
                    "attachment must be an existing regular file",
                ));
            }
            Ok(Attachment {
                path: path.to_owned(),
                alt: alt
                    .filter(|alt| !alt.is_empty())
                    .map(|alt| alt.to_owned()),
            })
        })
        .collect()
}

fn provider(
    explicit_provider: Option<Provider>,
    explicit_repo: Option<&str>,
) -> Result<GitHubIssues, AppError> {
    let provider = GitHubIssues::new(support::resolve_repo(explicit_provider, explicit_repo)?);
    provider.authenticate()?;
    Ok(provider)
}

fn validate_title(title: &str) -> Result<(), AppError> {
    support::validate_title(title)
}

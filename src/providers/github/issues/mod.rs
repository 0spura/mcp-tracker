mod mapping;
mod read;
mod write;

use crate::domain::{AppError, Issue, IssueSummary, body, patch};
use crate::process::runner::{self, ProcessError};
use crate::providers::{BodyChange, IssuePatch, IssueQuery, NewIssue, WorkItemProvider};

pub struct GitHubIssues {
    repo: String,
}

impl GitHubIssues {
    pub fn new(repo: String) -> Self {
        Self { repo }
    }

    pub(super) fn run_gh(&self, args: &[String], input: Option<Vec<u8>>) -> Result<Vec<u8>, AppError> {
        let output = runner::run("gh", args, input, None).map_err(map_process_error)?;
        if !output.success {
            return Err(AppError::github_cli());
        }
        Ok(output.stdout)
    }
}

impl WorkItemProvider for GitHubIssues {
    fn authenticate(&self) -> Result<(), AppError> {
        let args = ["auth", "status", "--hostname", "github.com"].map(str::to_owned);
        let output = runner::run("gh", &args, None, None).map_err(map_process_error)?;
        if output.success {
            Ok(())
        } else {
            Err(AppError::authentication())
        }
    }

    fn create(&self, issue: &NewIssue) -> Result<Issue, AppError> {
        write::create(self, issue)
    }

    fn list(&self, query: &IssueQuery) -> Result<Vec<IssueSummary>, AppError> {
        read::list(self, query)
    }

    fn show(&self, number: u64) -> Result<Issue, AppError> {
        read::show(self, number)
    }

    /// Fetches the issue once, then applies the requested change.
    ///
    /// The fetch rejects a pull request before any mutation and provides the current body for a
    /// body change and the timestamp for the concurrency guard.
    fn edit(&self, number: u64, patch: &IssuePatch) -> Result<Issue, AppError> {
        let current = read::show(self, number)?;
        if let Some(expected) = patch.expect_updated_at.as_deref() {
            if current.updated_at != expected {
                return Err(AppError::conflict());
            }
        }
        let resolved = match &patch.body {
            None => None,
            Some(BodyChange::Replace(text)) => Some(text.clone()),
            Some(BodyChange::Append(text)) => Some(body::append(&current.body, text)),
            Some(BodyChange::ReplaceSection { heading, body: text }) => {
                Some(body::replace_section(&current.body, heading, text)?)
            }
            Some(BodyChange::Patch(patch)) => Some(patch::apply(&current.body, patch)?),
        };
        write::edit(
            self,
            number,
            patch.title.as_deref(),
            resolved.as_deref(),
            &patch.attachments,
        )
    }
}

fn map_process_error(error: ProcessError) -> AppError {
    match error {
        ProcessError::NotFound => AppError::dependency(),
        ProcessError::Timeout => AppError::timeout(),
        ProcessError::OutputLimit => AppError::output_limit(),
        ProcessError::Io => AppError::github_cli(),
    }
}

pub mod github;

use crate::domain::{AppError, Issue, IssueSummary};

/// Bounded query for issue summaries. Every set field maps to one provider filter.
#[derive(Debug)]
pub struct IssueQuery {
    pub state: String,
    pub limit: usize,
    pub labels: Vec<String>,
    pub assignee: Option<String>,
    pub author: Option<String>,
    pub mention: Option<String>,
    pub milestone: Option<String>,
    pub search: Option<String>,
    pub issue_type: Option<String>,
}

#[derive(Debug)]
pub struct NewIssue {
    pub title: String,
    pub body: String,
    pub attachments: Vec<Attachment>,
}

/// A change requested without the caller having to reproduce the current body.
#[derive(Debug)]
pub enum BodyChange {
    Replace(String),
    Append(String),
    ReplaceSection { heading: String, body: String },
    /// Unified diff applied to the current body.
    Patch(String),
}

#[derive(Debug)]
pub struct IssuePatch {
    pub title: Option<String>,
    pub body: Option<BodyChange>,
    pub attachments: Vec<Attachment>,
    pub expect_updated_at: Option<String>,
}

/// Local file to upload, optionally with image alt text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Attachment {
    pub path: String,
    pub alt: Option<String>,
}

impl Attachment {
    /// Value accepted by `gh --attach`, in `path[#alt]` form.
    pub fn gh_argument(&self) -> String {
        match &self.alt {
            Some(alt) => format!("{}#{alt}", self.path),
            None => self.path.clone(),
        }
    }
}

pub trait WorkItemProvider {
    fn authenticate(&self) -> Result<(), AppError>;
    fn create(&self, issue: &NewIssue) -> Result<Issue, AppError>;
    fn list(&self, query: &IssueQuery) -> Result<Vec<IssueSummary>, AppError>;
    fn show(&self, number: u64) -> Result<Issue, AppError>;
    fn edit(&self, number: u64, patch: &IssuePatch) -> Result<Issue, AppError>;
}

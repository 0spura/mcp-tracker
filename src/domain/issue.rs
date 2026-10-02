use serde::Serialize;

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum IssueState {
    Open,
    Closed,
}

#[derive(Debug, Serialize)]
pub struct Issue {
    pub number: u64,
    pub title: String,
    pub body: String,
    pub state: IssueState,
    pub url: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize)]
pub struct IssueSummary {
    pub number: u64,
    pub title: String,
    pub state: IssueState,
    pub url: String,
    pub updated_at: String,
}

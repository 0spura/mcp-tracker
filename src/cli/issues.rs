use std::str::FromStr;

use clap::{Args, Subcommand, ValueEnum};

#[derive(Debug, Args)]
#[command(
    disable_help_subcommand = true,
    after_help = "A body edit never requires rewriting the whole issue:\n  \
workctl issue edit 12 --append-body \"Reproduced on 1.4.2.\"\n  \
workctl issue edit 12 --replace-section \"## Acceptance\" --section-body \"New criteria\"\n  \
workctl issue edit 12 --patch-file changes.patch --expect-updated-at 2026-01-02T00:00:00Z\n\n\
See `workctl issue edit --help` for the patch workflow and `workctl issue list --help` for filters."
)]
pub struct IssueArgs {
    #[command(subcommand)]
    pub action: IssueAction,
}

#[derive(Debug, Subcommand)]
pub enum IssueAction {
    /// Create an issue, optionally uploading attachments
    Create(CreateArgs),
    /// List issue summaries (never bodies, never pull requests)
    List(ListArgs),
    /// Show one issue with its body
    Show {
        /// Issue number
        number: IssueNumber,
    },
    /// Edit an issue title, body, or attachments
    Edit(EditArgs),
}

#[derive(Debug, Args)]
pub struct CreateArgs {
    /// Issue title; must not be blank
    #[arg(long)]
    pub title: String,
    /// Issue body text
    #[arg(long)]
    pub body: Option<String>,
    /// Read the body from a file; `-` reads standard input
    #[arg(long = "body-file", value_name = "FILE")]
    pub body_file: Option<String>,
    /// Upload a file, with optional alt text after `#`; may be repeated
    #[arg(long = "attach", value_name = "FILE[#ALT]")]
    pub attach: Vec<String>,
}

#[derive(Debug, Args)]
#[command(after_help = "Filters pass straight to `gh issue list`. All of them are optional and combine:\n  \
workctl issue list --label bug --label p1 --assignee me --search \"in:title fix\"")]
pub struct ListArgs {
    /// Issue state to list
    #[arg(long, value_enum, default_value = "open")]
    pub state: ListState,
    /// Maximum number of issues to return
    #[arg(long, default_value_t = 30, value_parser = parse_limit)]
    pub limit: usize,
    /// Filter by label; may be repeated
    #[arg(long = "label", value_name = "NAME")]
    pub labels: Vec<String>,
    /// Filter by assignee login
    #[arg(long)]
    pub assignee: Option<String>,
    /// Filter by author login
    #[arg(long)]
    pub author: Option<String>,
    /// Filter by mentioned user login
    #[arg(long)]
    pub mention: Option<String>,
    /// Filter by milestone name
    #[arg(long)]
    pub milestone: Option<String>,
    /// GitHub search query
    #[arg(long)]
    pub search: Option<String>,
    /// Filter by issue type name
    #[arg(long = "type", value_name = "NAME")]
    pub issue_type: Option<String>,
}

#[derive(Debug, Args)]
#[command(after_help = "Body changes: pick at most one of --body, --append-body, --replace-section, or\n\
--patch-file. The issue is fetched once, the change is applied to that text, and one write is sent.\n\n\
--patch-file takes standard `git diff` output and locates each hunk by exact context match, not by\n\
line number. Unmatched context is a patch_conflict error and nothing is written; there is no fuzzy\n\
matching. Generate the diff against the body from `workctl issue show <NUMBER>` and pass that\n\
response's updated_at as --expect-updated-at to refuse the write if the issue changed meanwhile.")]
pub struct EditArgs {
    /// Issue number
    pub number: IssueNumber,
    /// New title; must not be blank
    #[arg(long)]
    pub title: Option<String>,
    /// Replace the whole body with this text
    #[arg(long)]
    pub body: Option<String>,
    /// Replace the whole body with a file's contents; `-` reads standard input
    #[arg(long = "body-file", value_name = "FILE")]
    pub body_file: Option<String>,
    /// Append this text as a new block
    #[arg(long = "append-body")]
    pub append_body: Option<String>,
    /// Append a file's contents as a new block; `-` reads standard input
    #[arg(long = "append-body-file", value_name = "FILE")]
    pub append_body_file: Option<String>,
    /// Replace the content of one ATX section, e.g. `## Acceptance`
    #[arg(long = "replace-section", value_name = "HEADING")]
    pub replace_section: Option<String>,
    /// New section content; requires --replace-section
    #[arg(long = "section-body")]
    pub section_body: Option<String>,
    /// New section content from a file; requires --replace-section
    #[arg(long = "section-body-file", value_name = "FILE")]
    pub section_body_file: Option<String>,
    /// Apply a unified diff to the current body; `-` reads standard input
    #[arg(long = "patch-file", value_name = "FILE")]
    pub patch_file: Option<String>,
    /// Upload a file, with optional alt text after `#`; may be repeated
    #[arg(long = "attach", value_name = "FILE[#ALT]")]
    pub attach: Vec<String>,
    /// Refuse the write unless the issue's updated_at matches this value
    #[arg(long = "expect-updated-at", value_name = "TIMESTAMP")]
    pub expect_updated_at: Option<String>,
}

#[derive(Debug, Clone, Copy, ValueEnum)]
pub enum ListState {
    Open,
    Closed,
    All,
}

impl ListState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Closed => "closed",
            Self::All => "all",
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct IssueNumber(pub u64);

impl FromStr for IssueNumber {
    type Err = &'static str;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        let number = value.parse::<u64>().map_err(|_| "expected a positive issue number")?;
        if number == 0 {
            return Err("expected a positive issue number");
        }
        Ok(Self(number))
    }
}

fn parse_limit(value: &str) -> Result<usize, &'static str> {
    let limit = value
        .parse::<usize>()
        .map_err(|_| "limit must be an integer")?;
    if (1..=1000).contains(&limit) {
        Ok(limit)
    } else {
        Err("limit must be between 1 and 1000")
    }
}

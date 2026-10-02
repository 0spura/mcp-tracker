use clap::Args;

/// Body-change flags shared by `issue edit` and `pr update`.
///
/// The item is fetched once, the change is applied to that text, and one write is sent, so a
/// caller never has to reproduce the current body.
#[derive(Debug, Args)]
pub struct BodyChangeArgs {
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
}

pub fn parse_limit(value: &str) -> Result<usize, &'static str> {
    let limit = value
        .parse::<usize>()
        .map_err(|_| "limit must be an integer")?;
    if (1..=1000).contains(&limit) {
        Ok(limit)
    } else {
        Err("limit must be between 1 and 1000")
    }
}

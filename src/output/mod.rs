pub mod json;
pub mod text;

use serde::Serialize;

use crate::cli::OutputFormat;
use crate::domain::{AppError, Issue, IssueSummary};

#[derive(Serialize)]
#[serde(untagged)]
pub enum SuccessOutput {
    Issue(Issue),
    Issues(Vec<IssueSummary>),
}

pub fn write(format: OutputFormat, output: &SuccessOutput) -> Result<(), AppError> {
    match format {
        OutputFormat::Json => json::write_success(output),
        OutputFormat::Text => text::write(output),
    }
}

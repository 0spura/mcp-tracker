pub mod issues;
pub mod prs;

use crate::domain::AppError;
use crate::process::runner::{self, ProcessError};

/// Runs `gh`, mapping a process failure onto the shared error contract.
pub(super) fn run_gh(args: &[String], input: Option<Vec<u8>>) -> Result<Vec<u8>, AppError> {
    let output = run_gh_raw(args, input)?;
    if !output.success {
        return Err(AppError::github_cli());
    }
    Ok(output.stdout)
}

/// Runs `gh` and returns the raw result, including a non-zero exit status.
///
/// `gh` reports some outcomes through the exit status while still printing a usable payload, so a
/// caller that can interpret the status itself uses this instead of `run_gh`.
pub(super) fn run_gh_raw(
    args: &[String],
    input: Option<Vec<u8>>,
) -> Result<runner::ProcessOutput, AppError> {
    runner::run("gh", args, input, None).map_err(map_process_error)
}

pub(super) fn authenticate() -> Result<(), AppError> {
    let args = ["auth", "status", "--hostname", "github.com"].map(str::to_owned);
    let output = runner::run("gh", &args, None, None).map_err(map_process_error)?;
    if output.success {
        Ok(())
    } else {
        Err(AppError::authentication())
    }
}

pub(super) fn map_process_error(error: ProcessError) -> AppError {
    match error {
        ProcessError::NotFound => AppError::dependency(),
        ProcessError::Timeout => AppError::timeout(),
        ProcessError::OutputLimit => AppError::output_limit(),
        ProcessError::Io => AppError::github_cli(),
    }
}

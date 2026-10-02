use std::path::{Path, PathBuf};

use crate::domain::AppError;
use crate::process::runner::{self, ProcessError};

pub fn git_root(cwd: &Path) -> Result<Option<PathBuf>, AppError> {
    let output = runner::run(
        "git",
        &["rev-parse", "--show-toplevel"].map(str::to_owned),
        None,
        Some(cwd),
    )
    .map_err(map_process_error)?;
    if !output.success {
        return Ok(None);
    }
    let root = std::str::from_utf8(&output.stdout)
        .map_err(|_| AppError::context("Git returned an invalid repository path"))?
        .trim();
    if root.is_empty() {
        return Err(AppError::context("Git returned an invalid repository path"));
    }
    Ok(Some(PathBuf::from(root)))
}

pub fn origin_remote(root: &Path) -> Result<Option<String>, AppError> {
    let output = runner::run(
        "git",
        &["remote", "get-url", "origin"].map(str::to_owned),
        None,
        Some(root),
    )
    .map_err(map_process_error)?;
    if !output.success {
        return Ok(None);
    }
    let remote = std::str::from_utf8(&output.stdout)
        .map_err(|_| AppError::context("Git returned an invalid remote"))?
        .trim();
    if remote.is_empty() {
        return Ok(None);
    }
    Ok(Some(remote.to_owned()))
}

fn map_process_error(error: ProcessError) -> AppError {
    match error {
        ProcessError::NotFound => AppError::dependency(),
        ProcessError::Timeout => AppError::timeout(),
        ProcessError::OutputLimit => AppError::output_limit(),
        ProcessError::Io => AppError::context("could not inspect the Git repository"),
    }
}

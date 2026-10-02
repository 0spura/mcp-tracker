mod issues;

use clap::{Parser, Subcommand};

use crate::config::Provider;

#[derive(Debug, Parser)]
#[command(name = "workctl", version, about = "Manage GitHub issues from the terminal")]
pub struct Cli {
    /// Work-item provider; only `github` is implemented
    #[arg(long, global = true, value_enum)]
    pub provider: Option<Provider>,
    /// Repository as OWNER/REPO; defaults to the Git origin remote
    #[arg(long, global = true, value_name = "OWNER/REPO")]
    pub repo: Option<String>,
    /// Success output format
    #[arg(long, global = true, value_enum, default_value = "json")]
    pub format: OutputFormat,
    #[command(subcommand)]
    pub command: Command,
}

#[derive(Debug, Clone, Copy, clap::ValueEnum)]
pub enum OutputFormat {
    Json,
    Text,
}

#[derive(Debug, Subcommand)]
pub enum Command {
    Issue(issues::IssueArgs),
}

pub use issues::{EditArgs, IssueAction, IssueArgs, ListArgs};

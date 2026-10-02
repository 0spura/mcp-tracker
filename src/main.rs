mod cli;
mod commands;
mod config;
mod domain;
mod output;
mod process;
mod providers;

use std::process::ExitCode;

use clap::Parser;
use domain::AppError;

fn main() -> ExitCode {
    let cli = match cli::Cli::try_parse() {
        Ok(cli) => cli,
        Err(error) => match error.kind() {
            clap::error::ErrorKind::DisplayHelp | clap::error::ErrorKind::DisplayVersion => {
                let _ = error.print();
                return ExitCode::SUCCESS;
            }
            _ => {
                output::json::write_error(&AppError::invalid_input(
                    "invalid command-line arguments",
                ));
                return ExitCode::from(2);
            }
        },
    };

    match commands::execute(cli) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            output::json::write_error(&error);
            ExitCode::FAILURE
        }
    }
}

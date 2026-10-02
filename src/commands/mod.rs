mod issues;

use crate::cli::{Cli, Command};
use crate::domain::AppError;

pub fn execute(cli: Cli) -> Result<(), AppError> {
    match cli.command {
        Command::Issue(args) => issues::execute(cli.provider, cli.repo.as_deref(), cli.format, args),
    }
}

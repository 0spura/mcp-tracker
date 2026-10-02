use std::io::{self, Write};

use crate::domain::{AppError, Issue};
use crate::output::SuccessOutput;

pub fn write(output: &SuccessOutput) -> Result<(), AppError> {
    let stdout = io::stdout();
    let mut stdout = stdout.lock();
    write_to(&mut stdout, output)
}

fn write_to(stdout: &mut impl Write, output: &SuccessOutput) -> Result<(), AppError> {
    match output {
        SuccessOutput::Issue(issue) => write_issue(stdout, issue)?,
        SuccessOutput::Issues(issues) => {
            for issue in issues {
                write!(stdout, "#{} ", issue.number).map_err(|_| AppError::output())?;
                write_safe(stdout, &issue.title, false)?;
                write!(stdout, " [{}] ", state(issue.state)).map_err(|_| AppError::output())?;
                write_safe(stdout, &issue.url, false)?;
                writeln!(stdout).map_err(|_| AppError::output())?;
            }
        }
    }
    Ok(())
}

fn write_issue(stdout: &mut impl Write, issue: &Issue) -> Result<(), AppError> {
    write!(stdout, "#{} ", issue.number).map_err(|_| AppError::output())?;
    write_safe(stdout, &issue.title, false)?;
    writeln!(stdout, " [{}]", state(issue.state)).map_err(|_| AppError::output())?;
    write_safe(stdout, &issue.url, false)?;
    writeln!(stdout).map_err(|_| AppError::output())?;
    write!(stdout, "Created: ").map_err(|_| AppError::output())?;
    write_safe(stdout, &issue.created_at, false)?;
    writeln!(stdout).map_err(|_| AppError::output())?;
    write!(stdout, "Updated: ").map_err(|_| AppError::output())?;
    write_safe(stdout, &issue.updated_at, false)?;
    write!(stdout, "\n").map_err(|_| AppError::output())?;
    write_safe(stdout, &issue.body, true)?;
    writeln!(stdout).map_err(|_| AppError::output())
}

fn write_safe(
    stdout: &mut impl Write,
    value: &str,
    preserve_layout: bool,
) -> Result<(), AppError> {
    for character in value.chars() {
        if preserve_layout && matches!(character, '\n' | '\t') {
            stdout
                .write_all(character.encode_utf8(&mut [0; 4]).as_bytes())
                .map_err(|_| AppError::output())?;
        } else if character.is_control() {
            write!(stdout, "\\u{{{:x}}}", character as u32)
                .map_err(|_| AppError::output())?;
        } else {
            stdout
                .write_all(character.encode_utf8(&mut [0; 4]).as_bytes())
                .map_err(|_| AppError::output())?;
        }
    }
    Ok(())
}

fn state(state: crate::domain::IssueState) -> &'static str {
    match state {
        crate::domain::IssueState::Open => "open",
        crate::domain::IssueState::Closed => "closed",
    }
}

#[cfg(test)]
mod tests {
    use super::{SuccessOutput, write_to};
    use crate::domain::{Issue, IssueState, IssueSummary};

    #[test]
    fn escapes_terminal_controls_and_preserves_body_layout() {
        let issue = Issue {
            number: 5,
            title: "Title\n\u{1b}]52;c=clipboard".to_owned(),
            body: "line 1\nline 2\t\u{7}".to_owned(),
            state: IssueState::Open,
            url: "https://github.com/owner/repo/issues/5".to_owned(),
            created_at: "2026-01-01T00:00:00Z".to_owned(),
            updated_at: "2026-01-02T00:00:00Z".to_owned(),
        };
        let mut bytes = Vec::new();
        write_to(&mut bytes, &SuccessOutput::Issue(issue)).expect("render safe text");
        let rendered = String::from_utf8(bytes).expect("UTF-8 output");
        assert!(!rendered.contains('\u{1b}'));
        assert!(!rendered.contains('\u{7}'));
        assert!(rendered.contains(r"Title\u{a}\u{1b}]52;c=clipboard"));
        assert!(rendered.contains("line 1\nline 2\t\\u{7}"));

        let summary = IssueSummary {
            number: 6,
            title: "List\u{1b}[2J".to_owned(),
            state: IssueState::Closed,
            url: "https://github.com/owner/repo/issues/6".to_owned(),
            updated_at: "2026-01-02T00:00:00Z".to_owned(),
        };
        let mut bytes = Vec::new();
        write_to(&mut bytes, &SuccessOutput::Issues(vec![summary]))
            .expect("render safe summary");
        let rendered = String::from_utf8(bytes).expect("UTF-8 output");
        assert!(!rendered.contains('\u{1b}'));
        assert!(rendered.contains(r"List\u{1b}[2J"));
    }
}

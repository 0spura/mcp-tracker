#[derive(Debug, Clone, Copy)]
pub struct AppError {
    pub code: &'static str,
    pub message: &'static str,
}

impl AppError {
    pub const fn new(code: &'static str, message: &'static str) -> Self {
        Self { code, message }
    }

    pub const fn invalid_input(message: &'static str) -> Self {
        Self::new("invalid_input", message)
    }

    pub const fn context(message: &'static str) -> Self {
        Self::new("context", message)
    }

    pub const fn config(message: &'static str) -> Self {
        Self::new("config", message)
    }

    pub const fn provider_unsupported() -> Self {
        Self::new("provider_unsupported", "the selected provider is not supported")
    }

    pub const fn dependency() -> Self {
        Self::new("dependency", "a required command is unavailable")
    }

    pub const fn authentication() -> Self {
        Self::new("authentication", "GitHub CLI authentication is required")
    }

    pub const fn github_cli() -> Self {
        Self::new("github_cli", "the GitHub CLI operation failed")
    }

    pub const fn provider_response() -> Self {
        Self::new("provider_response", "the GitHub CLI returned an invalid response")
    }

    pub const fn not_issue() -> Self {
        Self::new("not_issue", "the selected number is not a GitHub issue")
    }

    pub const fn not_pull_request() -> Self {
        Self::new(
            "not_pull_request",
            "the selected number is not a GitHub pull request",
        )
    }

    pub const fn section_not_found() -> Self {
        Self::new(
            "section_not_found",
            "the section heading was not found in the body",
        )
    }

    pub const fn conflict() -> Self {
        Self::new("conflict", "the item changed since it was read")
    }

    pub const fn patch_conflict() -> Self {
        Self::new(
            "patch_conflict",
            "the patch does not apply to the current body",
        )
    }

    pub const fn timeout() -> Self {
        Self::new("timeout", "a required command exceeded its time limit")
    }

    pub const fn output_limit() -> Self {
        Self::new("output_limit", "a required command exceeded the output limit")
    }

    pub const fn output() -> Self {
        Self::new("output", "workctl could not write its output")
    }
}

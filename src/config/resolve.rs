use std::path::Path;

use clap::ValueEnum;
use serde::Deserialize;

use crate::config::{discover, files};
use crate::domain::AppError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    #[value(name = "github")]
    Github,
    #[value(name = "gitlab")]
    Gitlab,
}

#[derive(Debug)]
pub struct ResolvedContext {
    pub repo: String,
}

#[derive(Debug)]
struct Remote {
    provider: Provider,
    repo: String,
}

pub fn resolve_context(
    explicit_provider: Option<Provider>,
    explicit_repo: Option<&str>,
    cwd: &Path,
) -> Result<ResolvedContext, AppError> {
    let explicit_repo = explicit_repo.map(validate_repo).transpose()?;
    let root = discover::git_root(cwd)?;
    let config = root
        .as_deref()
        .map(files::load)
        .transpose()?
        .unwrap_or_default();
    let configured_provider = config.work_item_provider.or(config.provider);
    let needs_remote = explicit_repo.is_none()
        || (explicit_provider.is_none() && configured_provider.is_none());
    let remote = if needs_remote {
        root.as_deref()
            .map(discover::origin_remote)
            .transpose()?
            .flatten()
            .map(|url| parse_remote(&url))
            .transpose()?
    } else {
        None
    };

    let provider = explicit_provider
        .or(configured_provider)
        .or_else(|| remote.as_ref().map(|remote| remote.provider))
        .ok_or(AppError::context(
            "could not determine a work-item provider; specify --provider",
        ))?;
    if provider != Provider::Github {
        return Err(AppError::provider_unsupported());
    }

    let repo = explicit_repo
        .or_else(|| remote.map(|remote| remote.repo))
        .ok_or(AppError::context(
            "could not determine a repository; specify --repo OWNER/REPO",
        ))?;
    Ok(ResolvedContext { repo })
}

pub fn validate_repo(repo: &str) -> Result<String, AppError> {
    let Some((owner, name)) = repo.split_once('/') else {
        return Err(AppError::invalid_input("repository must be OWNER/REPO"));
    };
    if name.contains('/') || !valid_component(owner) || !valid_component(name) {
        return Err(AppError::invalid_input("repository must be OWNER/REPO"));
    }
    Ok(format!("{owner}/{name}"))
}

fn valid_component(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

fn parse_remote(url: &str) -> Result<Remote, AppError> {
    let (host, path) = if let Some(rest) = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
    {
        let (authority, path) = rest
            .split_once('/')
            .ok_or_else(AppError::provider_unsupported)?;
        (authority.rsplit('@').next().unwrap_or(authority), path)
    } else if let Some(rest) = url.strip_prefix("ssh://") {
        let (authority, path) = rest
            .split_once('/')
            .ok_or_else(AppError::provider_unsupported)?;
        (
            authority
                .rsplit('@')
                .next()
                .unwrap_or(authority)
                .split(':')
                .next()
                .unwrap_or(authority),
            path,
        )
    } else if let Some((authority, path)) = url.rsplit_once(':') {
        if !path.contains('/') {
            return Err(AppError::provider_unsupported());
        }
        (
            authority
                .rsplit('@')
                .next()
                .unwrap_or(authority),
            path,
        )
    } else {
        return Err(AppError::provider_unsupported());
    };

    let provider = match host.trim_end_matches('/').to_ascii_lowercase().as_str() {
        "github.com" => Provider::Github,
        "gitlab.com" => Provider::Gitlab,
        _ => return Err(AppError::provider_unsupported()),
    };
    let path = path.trim_matches('/');
    let (owner, name) = path
        .split_once('/')
        .ok_or_else(AppError::provider_unsupported)?;
    let name = name.strip_suffix(".git").unwrap_or(name);
    if name.contains('/') {
        return Err(AppError::provider_unsupported());
    }
    let repo = validate_repo(&format!("{owner}/{name}"))
        .map_err(|_| AppError::provider_unsupported())?;
    Ok(Remote { provider, repo })
}
#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;
    use std::process::Command;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::{Provider, parse_remote, resolve_context, validate_repo};

    static NEXT_DIR: AtomicUsize = AtomicUsize::new(0);

    struct TempRoot(PathBuf);

    impl TempRoot {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "workctl-resolve-{}-{}",
                std::process::id(),
                NEXT_DIR.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).expect("create temporary Git root");
            Self(path)
        }
    }

    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn resolves_config_remote_and_explicit_precedence() {
        let root = TempRoot::new();
        assert!(
            Command::new("git")
                .args(["init", "--quiet"])
                .current_dir(&root.0)
                .status()
                .expect("run git init")
                .success()
        );
        assert!(
            Command::new("git")
                .args([
                    "remote",
                    "add",
                    "origin",
                    "git@github.com:remote-owner/remote-repo.git",
                ])
                .current_dir(&root.0)
                .status()
                .expect("add origin")
                .success()
        );
        fs::write(
            root.0.join(".workctl.json"),
            r#"{"provider":"gitlab","workItemProvider":"github"}"#,
        )
        .expect("write shared configuration");

        let resolved = resolve_context(None, None, &root.0).expect("resolve GitHub context");
        assert_eq!(resolved.repo, "remote-owner/remote-repo");

        fs::write(
            root.0.join(".workctl.local.json"),
            r#"{"workItemProvider":"gitlab"}"#,
        )
        .expect("write local override");
        assert_eq!(
            resolve_context(None, None, &root.0).unwrap_err().code,
            "provider_unsupported"
        );

        let explicit = resolve_context(
            Some(Provider::Github),
            Some("explicit-owner/explicit-repo"),
            &root.0,
        )
        .expect("explicit overrides");
        assert_eq!(explicit.repo, "explicit-owner/explicit-repo");
        fs::write(root.0.join(".workctl.json"), r#"{"repo":"owner/repo"}"#)
            .expect("write invalid shared configuration");
        assert_eq!(
            resolve_context(
                Some(Provider::Github),
                Some("explicit-owner/explicit-repo"),
                &root.0,
            )
            .unwrap_err()
            .code,
            "config"
        );
    }
    #[test]
    fn recognizes_supported_https_and_ssh_remote_forms() {
        for remote in [
            "https://github.com/owner/repo.git",
            "git@github.com:owner/repo.git",
            "ssh://git@github.com/owner/repo.git",
        ] {
            let parsed = parse_remote(remote).expect("supported remote");
            assert_eq!(parsed.provider, Provider::Github);
            assert_eq!(parsed.repo, "owner/repo");
        }
    }

    #[test]
    fn rejects_unknown_hosts_and_repository_path_injection() {
        assert_eq!(
            parse_remote("https://example.com/owner/repo").unwrap_err().code,
            "provider_unsupported"
        );
        assert_eq!(
            validate_repo("owner/repo/extra").unwrap_err().code,
            "invalid_input"
        );
        assert_eq!(
            validate_repo("owner/repo?query").unwrap_err().code,
            "invalid_input"
        );
    }

    #[test]
    fn recognizes_gitlab_as_unsupported_provider_candidate() {
        let parsed = parse_remote("git@gitlab.com:owner/repo.git").expect("valid remote");
        assert_eq!(parsed.provider, Provider::Gitlab);
    }
}

use crate::error::GitError;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;
use terminus_process::{NormalizedSpawn, ProcessManager};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorktreeCreate {
    pub path: PathBuf,
    pub branch: String,
    pub base_ref: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommitResult {
    pub revision: String,
    pub branch: String,
    pub message: String,
}

/// `GitOps` runs structured git commands through `ProcessManager`. Every
/// invocation disables untrusted hooks and sanitizes config includes.
#[derive(Debug, Clone)]
pub struct GitOps {
    process: Arc<ProcessManager>,
    git_binary: String,
}

impl GitOps {
    pub fn new(process: Arc<ProcessManager>, git_binary: impl Into<String>) -> Self {
        Self {
            process,
            git_binary: git_binary.into(),
        }
    }

    /// Returns the sanitized env map applied to every git invocation.
    ///
    /// - `GIT_CONFIG_NOSYSTEM=1` — ignore system config
    /// - `GIT_CONFIG_GLOBAL=/dev/null` — ignore user config
    /// - `GIT_TEMPLATE_DIR=` (empty) — disable template-installed hooks
    /// - `GIT_TERMINAL_PROMPT=0` — never prompt for credentials
    fn sanitized_env(&self) -> BTreeMap<String, String> {
        let mut env = BTreeMap::new();
        env.insert("GIT_CONFIG_NOSYSTEM".into(), "1".into());
        env.insert("GIT_CONFIG_GLOBAL".into(), "/dev/null".into());
        env.insert("GIT_TEMPLATE_DIR".into(), String::new());
        env.insert("GIT_TERMINAL_PROMPT".into(), "0".into());
        env
    }

    /// Run a git command and capture stdout. The first arg is the
    /// subcommand (e.g. `rev-parse`); `args` are the rest.
    async fn run_git(
        &self,
        working_dir: Option<PathBuf>,
        args: &[&str],
    ) -> Result<Vec<u8>, GitError> {
        let mut full_args = Vec::with_capacity(args.len() + 2);
        // Disable untrusted hooks for the duration of this command.
        full_args.push("-c");
        full_args.push("core.hooksPath=/dev/null");
        full_args.extend_from_slice(args);
        let spawn = NormalizedSpawn {
            program: self.git_binary.clone(),
            args: full_args.iter().map(|s| s.to_string()).collect(),
            env: self.sanitized_env(),
            working_dir,
            timeout_ms: 30_000,
            shell: false,
        };
        let (_outcome, mut rx) = self.process.spawn(spawn).await?;
        let mut stdout = Vec::new();
        let mut exit_code: i32 = -1;
        while let Some(ev) = rx.recv().await {
            match ev {
                terminus_kernel_protocol::ProcessEvent::Stdout(c) => {
                    stdout.extend_from_slice(&c.bytes);
                }
                terminus_kernel_protocol::ProcessEvent::Exited(e) => {
                    exit_code = e.exit_code;
                }
                _ => {}
            }
        }
        if exit_code != 0 {
            return Err(GitError::OperationFailed(format!(
                "git {} exited with {}",
                args.join(" "),
                exit_code
            )));
        }
        Ok(stdout)
    }

    /// Get the current HEAD revision.
    pub async fn head_revision(&self, working_dir: PathBuf) -> Result<String, GitError> {
        let out = self
            .run_git(Some(working_dir), &["rev-parse", "HEAD"])
            .await?;
        let s = String::from_utf8_lossy(&out).trim().to_string();
        if s.is_empty() {
            return Err(GitError::InvalidRef("HEAD is empty".into()));
        }
        Ok(s)
    }

    /// Create a worktree at `path` on `branch` based on `base_ref`.
    pub async fn create_worktree(&self, request: WorktreeCreate) -> Result<(), GitError> {
        let path_str = request.path.to_string_lossy().to_string();
        let _ = self
            .run_git(
                None,
                &[
                    "worktree",
                    "add",
                    "-b",
                    &request.branch,
                    &path_str,
                    &request.base_ref,
                ],
            )
            .await?;
        Ok(())
    }

    /// Stage a path and commit with the given message. Returns the new
    /// revision.
    pub async fn commit(
        &self,
        working_dir: PathBuf,
        pathspec: &str,
        message: &str,
    ) -> Result<CommitResult, GitError> {
        self.run_git(Some(working_dir.clone()), &["add", "--", pathspec])
            .await?;
        self.run_git(
            Some(working_dir.clone()),
            &["commit", "-m", message, "--no-verify"],
        )
        .await?;
        let revision = self.head_revision(working_dir.clone()).await?;
        let branch = String::from_utf8_lossy(
            &self
                .run_git(Some(working_dir), &["rev-parse", "--abbrev-ref", "HEAD"])
                .await?,
        )
        .trim()
        .to_string();
        Ok(CommitResult {
            revision,
            branch,
            message: message.to_string(),
        })
    }

    /// True if the working directory is a git repository.
    pub async fn is_repo(&self, working_dir: PathBuf) -> bool {
        self.run_git(Some(working_dir), &["rev-parse", "--git-dir"])
            .await
            .is_ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;
    use terminus_artifacts::ArtifactStore;

    fn mgr() -> (tempfile::TempDir, Arc<ProcessManager>) {
        let dir = tempdir().unwrap();
        let store = ArtifactStore::open(dir.path()).unwrap();
        (dir, Arc::new(ProcessManager::new(Arc::new(store))))
    }

    #[tokio::test]
    async fn head_revision_of_init_repo() {
        let (dir, mgr) = mgr();
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        // Init the repo with git.
        let init_env: BTreeMap<String, String> = BTreeMap::new();
        let init_spawn = NormalizedSpawn {
            program: "git".into(),
            args: vec!["init".into(), repo.to_string_lossy().to_string()],
            env: init_env,
            working_dir: None,
            timeout_ms: 10_000,
            shell: false,
        };
        let (_o, mut rx) = mgr.spawn(init_spawn).await.unwrap();
        while rx.recv().await.is_some() {}
        // Configure user locally (the kernel sanitizes global config).
        for (k, v) in [("user.name", "Test"), ("user.email", "test@example.com")] {
            let spawn = NormalizedSpawn {
                program: "git".into(),
                args: vec!["config".into(), k.into(), v.into()],
                env: BTreeMap::new(),
                working_dir: Some(repo.clone()),
                timeout_ms: 5_000,
                shell: false,
            };
            let (_o, mut rx) = mgr.spawn(spawn).await.unwrap();
            while rx.recv().await.is_some() {}
        }
        std::fs::write(repo.join("README.md"), "hello\n").unwrap();
        let ops = GitOps::new(mgr, "git");
        let result = ops
            .commit(repo.clone(), "README.md", "initial commit")
            .await
            .unwrap();
        assert!(!result.revision.is_empty());
        assert!(
            result.branch == "main" || result.branch == "master",
            "unexpected branch: {}",
            result.branch
        );
        let head = ops.head_revision(repo).await.unwrap();
        assert_eq!(head, result.revision);
    }

    #[tokio::test]
    async fn is_repo_detects_non_repo() {
        let (dir, mgr) = mgr();
        let ops = GitOps::new(mgr, "git");
        let not_repo = dir.path().join("empty");
        std::fs::create_dir_all(&not_repo).unwrap();
        assert!(!ops.is_repo(not_repo).await);
    }

    #[tokio::test]
    async fn sanitized_env_disables_hooks() {
        let (_dir, mgr) = mgr();
        let ops = GitOps::new(mgr, "git");
        let env = ops.sanitized_env();
        assert_eq!(
            env.get("GIT_CONFIG_NOSYSTEM").map(String::as_str),
            Some("1")
        );
        assert_eq!(
            env.get("GIT_CONFIG_GLOBAL").map(String::as_str),
            Some("/dev/null")
        );
        assert_eq!(
            env.get("GIT_TERMINAL_PROMPT").map(String::as_str),
            Some("0")
        );
    }
}

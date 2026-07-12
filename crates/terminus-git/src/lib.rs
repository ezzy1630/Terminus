//! Protected Git operations (SPEC.md Section 14.5, 13.5).
//!
//! `GitOps` provides structured calls for protected worktree/commit/branch/
//! merge operations. The implementation shells out to a pinned `git` binary
//! through `forge-process::ProcessManager`, so every invocation goes through
//! the kernel's policy and audit path.
//!
//! Untrusted hooks are disabled and config includes are sanitized.

#![forbid(unsafe_code)]

mod error;
mod ops;

pub use error::GitError;
pub use ops::{CommitResult, GitOps, WorktreeCreate};

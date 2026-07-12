//! Protected Git operations (SPEC.md Section 14.5, 13.5).
//!
//! `GitOps` provides structured calls for protected worktree/commit/branch/
//! merge operations. The implementation shells out to a pinned `git` binary
//! through `terminus-process::ProcessManager`, so every invocation goes through
//! the kernel's policy and audit path.
//!
//! Untrusted hooks are disabled and config includes are sanitized.

#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]
#![forbid(unsafe_code)]

mod error;
mod ops;

pub use error::GitError;
pub use ops::{CommitResult, GitOps, WorktreeCreate};

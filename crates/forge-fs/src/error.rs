//! Typed errors for path resolution.

use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum PathError {
    #[error("path is absolute; workspace-relative paths are required")]
    AbsolutePath,
    #[error("path contains a parent component (`..`) that escapes the workspace root")]
    ParentTraversal,
    #[error("path component `{0}` is empty")]
    EmptyComponent(String),
    #[error("path contains a backslash; use forward slash separators")]
    Backslash,
    #[error("path contains a NUL byte")]
    NulByte,
    #[error("path is not valid UTF-8")]
    InvalidUtf8,
    #[error("path contains a Windows drive or UNC prefix")]
    WindowsDeviceOrUnc,
    #[error("path points at a protected resource: {0}")]
    Protected(String),
    #[error("symlink at `{0}` escapes the workspace root")]
    SymlinkEscape(String),
    #[error("symlink resolution failed for `{0}`")]
    SymlinkResolutionFailed(String),
    #[error("path is not inside the workspace root after canonicalization")]
    OutsideWorkspace,
    #[error("workspace root is not absolute")]
    RootNotAbsolute,
    #[error("workspace uri error: {0}")]
    Uri(String),
}

//! Workspace-relative path resolution for the Forge kernel.
//!
//! This crate implements the path-handling rules from SPEC.md Section 31.5:
//!
//! - Public paths are UTF-8 workspace-relative paths using `/` separators.
//! - Absolute paths from models or extensions are rejected.
//! - The kernel resolves each path component without following unapproved
//!   symlinks; a symlink that escapes the workspace root is denied.
//! - Protected paths such as `.git`, Forge state, credential stores, and
//!   sandbox control sockets are protected even when their parent is writable.
//!
//! The API is intentionally small and easy to property-test.

#![forbid(unsafe_code)]

mod error;
mod protected;
mod resolver;
mod safe_path;
mod uri;

pub use error::PathError;
pub use protected::{is_protected_component, ProtectedResource, PROTECTED_PREFIXES};
pub use resolver::{HostResolution, PathResolver, ResolvedPath};
pub use safe_path::SafePath;
pub use uri::{WorkspaceUri, WorkspaceUriError, WorkspaceUriKind};

/// Convenience re-export of common kernel protocol types used in this crate.
pub use forge_kernel_protocol::WorkspacePath;

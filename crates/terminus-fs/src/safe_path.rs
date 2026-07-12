//! `SafePath` — a newtype for a canonical workspace-relative path that has
//! already passed validation.

use crate::error::PathError;
use crate::protected::first_protected_component;
use serde::{Deserialize, Serialize};
use std::fmt;

/// A workspace-relative path that has passed lexical validation:
/// - no absolute prefix
/// - no `..` traversal
/// - no backslashes
/// - no NUL bytes
/// - no Windows drive/UNC prefixes
/// - components are non-empty
///
/// Note: `SafePath` does NOT resolve symlinks; that is the job of
/// `PathResolver::resolve`. A `SafePath` is safe to use as a *target* but the
/// caller still needs `PathResolver` before touching the filesystem.
#[derive(Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SafePath {
    inner: String,
}

impl SafePath {
    /// Lexically validate a workspace-relative path.
    pub fn new(relative_path: &str) -> Result<Self, PathError> {
        validate_lexical(relative_path)?;
        // Reject paths that start with a protected component.
        if let Some((component, _)) = first_protected_component(relative_path) {
            return Err(PathError::Protected(component));
        }
        Ok(Self {
            inner: relative_path.to_string(),
        })
    }

    /// Construct a `SafePath` for a protected resource (e.g. `.git/HEAD`) —
    /// this is intended for *read-only* inspection by the kernel itself and
    /// is gated behind an explicit `allow_protected` flag. Model-driven code
    /// MUST NOT use this constructor.
    pub fn new_protected(relative_path: &str) -> Result<Self, PathError> {
        validate_lexical(relative_path)?;
        Ok(Self {
            inner: relative_path.to_string(),
        })
    }

    /// The validated relative path string.
    pub fn as_str(&self) -> &str {
        &self.inner
    }

    /// Iterate over non-empty components.
    pub fn components(&self) -> impl Iterator<Item = &str> {
        self.inner.split('/').filter(|c| !c.is_empty())
    }

    /// Number of non-empty components.
    pub fn depth(&self) -> usize {
        self.components().count()
    }

    /// True if the path is the workspace root (`.` or empty).
    pub fn is_root(&self) -> bool {
        self.inner.is_empty() || self.inner == "."
    }
}

impl fmt::Debug for SafePath {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Debug::fmt(&self.inner, f)
    }
}

impl fmt::Display for SafePath {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.inner)
    }
}

/// Validate a path lexically. Does NOT touch the filesystem.
pub(crate) fn validate_lexical(path: &str) -> Result<(), PathError> {
    if path.contains('\0') {
        return Err(PathError::NulByte);
    }
    if path.is_empty() {
        return Ok(());
    }
    // Reject backslashes — paths are POSIX-style at the public boundary.
    if path.contains('\\') {
        return Err(PathError::Backslash);
    }
    // Reject Windows drive letters / UNC prefixes.
    if path.len() >= 2 {
        let bytes = path.as_bytes();
        if bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
            return Err(PathError::WindowsDeviceOrUnc);
        }
    }
    if path.starts_with("//") || path.starts_with("\\\\") {
        return Err(PathError::WindowsDeviceOrUnc);
    }
    // Absolute paths are rejected.
    if path.starts_with('/') {
        return Err(PathError::AbsolutePath);
    }
    // Check each component.
    for component in path.split('/') {
        if component.is_empty() {
            // empty component (e.g. `a//b`) is treated as a stray separator.
            continue;
        }
        if component == "." {
            continue;
        }
        if component == ".." {
            // `..` is never allowed in a workspace-relative path.
            return Err(PathError::ParentTraversal);
        }
        // Detect Windows reserved device names inside any component.
        if is_windows_device_name(component) {
            return Err(PathError::WindowsDeviceOrUnc);
        }
    }
    Ok(())
}

fn is_windows_device_name(component: &str) -> bool {
    let lower = component.to_ascii_lowercase();
    let stem = lower.split('.').next().unwrap_or(&lower);
    matches!(stem, "con" | "prn" | "aux" | "nul")
        || (stem.starts_with("com") && stem.len() == 4 && stem.as_bytes()[3].is_ascii_digit())
        || (stem.starts_with("lpt") && stem.len() == 4 && stem.as_bytes()[3].is_ascii_digit())
}

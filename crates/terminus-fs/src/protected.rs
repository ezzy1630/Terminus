//! Protected-path policy (SPEC.md Section 13.3, 31.5).
//!
//! The following paths are protected against model-driven writes regardless
//! of where the workspace lives:
//!
//! - `.git`, `.terminus` — version control and Terminus state
//! - `terminus-state://`, `secret-store://`, `host://` — internal URI schemes
//! - `credentials`, `secrets`, `.ssh`, `.aws`, `.env` — common secret files

/// A category of protected resource.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ProtectedResource {
    VersionControl,
    ForgeState,
    SecretStore,
    Host,
    Credentials,
}

/// Path components (case-sensitive) that mark a path as protected.
pub const PROTECTED_PREFIXES: &[(&str, ProtectedResource)] = &[
    (".git", ProtectedResource::VersionControl),
    (".hg", ProtectedResource::VersionControl),
    (".svn", ProtectedResource::VersionControl),
    (".terminus", ProtectedResource::ForgeState),
    ("terminus-state", ProtectedResource::ForgeState),
    ("secret-store", ProtectedResource::SecretStore),
    ("credentials", ProtectedResource::Credentials),
    ("secrets", ProtectedResource::Credentials),
    (".ssh", ProtectedResource::Credentials),
    (".aws", ProtectedResource::Credentials),
    (".env", ProtectedResource::Credentials),
    ("host", ProtectedResource::Host),
];

/// Returns true if `component` matches a protected path prefix.
///
/// This checks individual path components rather than substrings, so a path
/// like `src/.gitignore` is NOT considered protected even though it contains
/// the substring `.git`.
pub fn is_protected_component(component: &str) -> Option<ProtectedResource> {
    if component.is_empty() {
        return None;
    }
    // Exact component match.
    for (prefix, kind) in PROTECTED_PREFIXES {
        if component == *prefix {
            return Some(*kind);
        }
    }
    // A path component may still be a protected file basename like `.env.local`.
    if matches!(
        component,
        ".env" | ".env.local" | ".env.production" | ".env.development"
    ) {
        return Some(ProtectedResource::Credentials);
    }
    None
}

/// True if the leading component of `relative_path` is protected.
pub fn first_protected_component(relative_path: &str) -> Option<(String, ProtectedResource)> {
    for component in relative_path.split('/') {
        if component.is_empty() {
            continue;
        }
        if let Some(kind) = is_protected_component(component) {
            return Some((component.to_string(), kind));
        }
    }
    None
}

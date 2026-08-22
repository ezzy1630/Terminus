//! `PathResolver` — turns a `SafePath` into an absolute host path while
//! refusing to follow symlinks that escape the workspace root.

use crate::error::PathError;
use crate::safe_path::SafePath;
use std::path::{Path, PathBuf};

/// A path on the host filesystem resolved by `PathResolver`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostResolution {
    /// Absolute path inside the workspace root.
    pub host_path: PathBuf,
    /// True if the resolved path currently exists.
    pub exists: bool,
    /// True if any component on the path was a symlink.
    pub contained_symlink: bool,
}

/// A path resolved by `PathResolver`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedPath {
    pub host: HostResolution,
    pub relative: SafePath,
}

/// Resolver anchored at an absolute workspace root.
#[derive(Debug, Clone)]
pub struct PathResolver {
    root: PathBuf,
}

impl PathResolver {
    /// Construct a resolver for the given workspace root. The root MUST be an
    /// absolute, existing directory; symlinks in the root path itself are
    /// canonicalized once at construction time.
    pub fn new(root: impl Into<PathBuf>) -> Result<Self, PathError> {
        let raw = root.into();
        if !raw.is_absolute() {
            return Err(PathError::RootNotAbsolute);
        }
        let canonical = std::fs::canonicalize(&raw)
            .map_err(|e| PathError::SymlinkResolutionFailed(format!("{e}")))?;
        Ok(Self { root: canonical })
    }

    /// Construct a resolver without canonicalizing the root. Useful in tests
    /// that want to assert behavior against non-existent roots.
    pub fn new_unchecked(root: impl Into<PathBuf>) -> Result<Self, PathError> {
        let raw = root.into();
        if !raw.is_absolute() {
            return Err(PathError::RootNotAbsolute);
        }
        Ok(Self { root: raw })
    }

    /// The canonical workspace root.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Resolve a `SafePath` to an absolute host path, denying symlink escapes.
    ///
    /// Algorithm:
    /// 1. Start at the canonical root.
    /// 2. Walk each non-empty component. If the current path plus the
    ///    component is a symlink, read its target; if the target resolves
    ///    outside the root, deny.
    /// 3. Otherwise advance into the component.
    /// 4. If the component does not exist, allow advancement (the path may
    ///    be about to be created); the final existence flag is reported.
    pub fn resolve(&self, safe: &SafePath) -> Result<ResolvedPath, PathError> {
        let mut current = self.root.clone();
        let mut contained_symlink = false;
        for component in safe.components() {
            current.push(component);
            match std::fs::symlink_metadata(&current) {
                Ok(meta) => {
                    if meta.file_type().is_symlink() {
                        contained_symlink = true;
                        let target = std::fs::read_link(&current)
                            .map_err(|e| PathError::SymlinkResolutionFailed(format!("{e}")))?;
                        let resolved = if target.is_absolute() {
                            target
                        } else {
                            current.parent().unwrap_or(&self.root).join(target)
                        };
                        let canon = match std::fs::canonicalize(&resolved) {
                            Ok(c) => c,
                            Err(_) => {
                                // Symlink target does not exist (dangling).
                                return Err(PathError::SymlinkEscape(format!(
                                    "dangling symlink at {}",
                                    current.display()
                                )));
                            }
                        };
                        if !canon.starts_with(&self.root) {
                            return Err(PathError::SymlinkEscape(current.display().to_string()));
                        }
                        // Advance to the canonicalized target.
                        current = canon;
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    // Allowed — caller may be about to create it.
                }
                Err(e) => {
                    return Err(PathError::SymlinkResolutionFailed(format!(
                        "{current:?}: {e}"
                    )));
                }
            }
        }
        let exists = std::fs::metadata(&current).is_ok();
        Ok(ResolvedPath {
            host: HostResolution {
                host_path: current,
                exists,
                contained_symlink,
            },
            relative: safe.clone(),
        })
    }

    /// Resolve and verify the path is inside the root by re-checking the
    /// canonical form. This is a defence-in-depth check used before writes.
    pub fn resolve_strict(&self, safe: &SafePath) -> Result<ResolvedPath, PathError> {
        let resolved = self.resolve(safe)?;
        if !resolved.host.host_path.starts_with(&self.root) {
            return Err(PathError::OutsideWorkspace);
        }
        Ok(resolved)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    #[cfg(unix)]
    use std::os::unix::fs::symlink;
    use tempfile::tempdir;

    fn make_resolver() -> (tempfile::TempDir, PathResolver) {
        let dir = tempdir().expect("tempdir");
        let resolver = PathResolver::new(dir.path()).expect("resolver");
        (dir, resolver)
    }

    #[test]
    fn rejects_absolute_path() {
        let err = SafePath::new("/etc/passwd").unwrap_err();
        assert_eq!(err, PathError::AbsolutePath);
    }

    #[test]
    fn rejects_parent_traversal() {
        let err = SafePath::new("../etc/passwd").unwrap_err();
        assert_eq!(err, PathError::ParentTraversal);
        let err = SafePath::new("a/../../etc").unwrap_err();
        assert_eq!(err, PathError::ParentTraversal);
    }

    #[test]
    fn rejects_backslash() {
        let err = SafePath::new("a\\b").unwrap_err();
        assert_eq!(err, PathError::Backslash);
    }

    #[test]
    fn rejects_protected_prefix() {
        let err = SafePath::new(".git/HEAD").unwrap_err();
        assert!(matches!(err, PathError::Protected(_)));
        let err = SafePath::new(".env").unwrap_err();
        assert!(matches!(err, PathError::Protected(_)));
    }

    #[test]
    fn allows_dotgitignore_inside_subdir() {
        // `.gitignore` is NOT a protected component (only `.git` is).
        let path = SafePath::new("src/.gitignore").expect("ok");
        assert_eq!(path.as_str(), "src/.gitignore");
    }

    #[test]
    fn resolves_simple_path() {
        let (dir, resolver) = make_resolver();
        let safe = SafePath::new("src/main.rs").unwrap();
        fs::create_dir_all(dir.path().join("src")).unwrap();
        fs::write(dir.path().join("src/main.rs"), "fn main() {}").unwrap();
        let resolved = resolver.resolve(&safe).unwrap();
        assert!(resolved.host.exists);
        assert!(!resolved.host.contained_symlink);
    }

    #[test]
    fn resolves_nonexistent_target() {
        let (_dir, resolver) = make_resolver();
        let safe = SafePath::new("does/not/exist.txt").unwrap();
        let resolved = resolver.resolve(&safe).unwrap();
        assert!(!resolved.host.exists);
    }

    #[cfg(unix)]
    #[test]
    fn denies_symlink_escape() {
        let (dir, resolver) = make_resolver();
        let outside = tempdir().expect("tempdir");
        fs::write(outside.path().join("secret"), "shh").unwrap();
        fs::create_dir_all(dir.path().join("link")).unwrap();
        symlink(outside.path(), dir.path().join("link/escape")).unwrap();
        let safe = SafePath::new("link/escape/secret").unwrap();
        let err = resolver.resolve(&safe).unwrap_err();
        assert!(matches!(err, PathError::SymlinkEscape(_)));
    }

    #[cfg(unix)]
    #[test]
    fn allows_symlink_inside_workspace() {
        let (dir, resolver) = make_resolver();
        fs::create_dir_all(dir.path().join("real")).unwrap();
        fs::write(dir.path().join("real/file.txt"), "hi").unwrap();
        symlink("real", dir.path().join("alias")).unwrap();
        let safe = SafePath::new("alias/file.txt").unwrap();
        let resolved = resolver.resolve(&safe).unwrap();
        assert!(resolved.host.exists);
        assert!(resolved.host.contained_symlink);
    }
}

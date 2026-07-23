//! Property tests for path resolution (SPEC §46.3).
//!
//! Invariant: canonical path resolution never escapes its workspace root.

#![cfg(test)]
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::fs;
use std::path::PathBuf;
use tempfile::tempdir;
use terminus_fs::{PathResolver, SafePath};

fn random_component(seed: u64) -> String {
    let alphabet = b"abcdefghijklmnopqrstuvwxyz0123456789_-";
    let mut out = String::new();
    let mut x = seed;
    for _ in 0..8 {
        out.push(alphabet[(x as usize) % alphabet.len()] as char);
        x = x.wrapping_mul(1103515245).wrapping_add(12345);
    }
    out
}

#[test]
fn resolved_paths_never_escape_root() {
    let dir = tempdir().expect("tempdir");
    let resolver = PathResolver::new(dir.path()).expect("resolver");
    let root = resolver.root().to_path_buf();

    for seed in 0u64..256 {
        let rel = format!(
            "{}/{}/{}",
            random_component(seed),
            random_component(seed ^ 0x9e37),
            random_component(seed.wrapping_mul(7))
        );
        let Ok(safe) = SafePath::new(&rel) else {
            continue;
        };
        match resolver.resolve(&safe) {
            Ok(resolved) => {
                assert!(
                    resolved.host.host_path.starts_with(&root),
                    "escaped root: {:?}",
                    resolved.host.host_path
                );
            }
            Err(_) => {
                // Fail-closed is acceptable; must not succeed outside root.
            }
        }
    }
}

#[test]
fn symlink_escape_is_denied() {
    let dir = tempdir().expect("tempdir");
    let outside = tempdir().expect("outside");
    let link = dir.path().join("escape");
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(outside.path(), &link).expect("symlink");
    }
    #[cfg(not(unix))]
    {
        let _ = (outside, link);
        return;
    }
    let resolver = PathResolver::new(dir.path()).expect("resolver");
    let safe = SafePath::new("escape/secret.txt").expect("safe");
    let err = resolver.resolve(&safe).expect_err("must deny escape");
    let msg = format!("{err}");
    assert!(
        msg.contains("escape") || msg.contains("Symlink") || msg.contains("symlink"),
        "unexpected error: {msg}"
    );
}

#[test]
fn parent_traversal_rejected_lexically() {
    for candidate in ["../x", "a/../../b", "/etc/passwd", r"a\b", ""] {
        if candidate.is_empty() {
            // empty may be root — skip
            continue;
        }
        let result = SafePath::new(candidate);
        if candidate.contains("..") || candidate.starts_with('/') || candidate.contains('\\') {
            assert!(result.is_err(), "should reject {candidate}");
        }
    }
}

#[test]
fn resolve_strict_stays_inside_root() {
    let dir = tempdir().expect("tempdir");
    fs::create_dir_all(dir.path().join("src")).expect("mkdir");
    fs::write(dir.path().join("src/main.rs"), b"fn main() {}").expect("write");
    let resolver = PathResolver::new(dir.path()).expect("resolver");
    let safe = SafePath::new("src/main.rs").expect("safe");
    let resolved = resolver.resolve_strict(&safe).expect("resolve");
    assert!(resolved.host.host_path.starts_with(resolver.root()));
    let _ = PathBuf::from("unused");
}

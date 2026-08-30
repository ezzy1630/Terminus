//! Build identity for the kernel.
//!
//! `KernelInfo.build_revision` is what a control plane, an audit record, or a
//! bug report uses to say *which* kernel produced an effect. It used to be the
//! literal string `"dev"`, which identifies nothing. This script resolves a
//! real revision at compile time and hands it to the crate as
//! `TERMINUS_BUILD_REVISION`.
//!
//! Resolution order:
//! 1. an explicit `TERMINUS_BUILD_REVISION` in the environment (reproducible
//!    and vendored builds, where the source is present but `.git` is not);
//! 2. `git rev-parse HEAD` in the enclosing checkout;
//! 3. `<cargo package version>+src.<content hash>` — a deterministic
//!    fingerprint of the crate's own sources.
//!
//! This script must never fail a build: every step is fallible and falls
//! through to the next. It also never panics, so the workspace's
//! `unwrap_used`/`expect_used`/`panic` denials hold here too.

use std::path::{Path, PathBuf};
use std::process::Command;

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    // The fallback fingerprint hashes these, so a source edit has to
    // re-resolve the revision.
    println!("cargo:rerun-if-changed=src");
    println!("cargo:rerun-if-env-changed=TERMINUS_BUILD_REVISION");
    watch_git_head();

    let revision = env_override()
        .or_else(git_commit)
        .unwrap_or_else(source_fingerprint);
    println!("cargo:rustc-env=TERMINUS_BUILD_REVISION={revision}");
}

/// An explicitly supplied revision wins: a release pipeline knows its own
/// provenance better than this script does.
fn env_override() -> Option<String> {
    let value = std::env::var("TERMINUS_BUILD_REVISION").ok()?;
    let value = sanitize(value.trim());
    (!value.is_empty()).then_some(value)
}

/// Re-run when HEAD moves. `--git-common-dir` rather than `--git-dir` so a
/// linked worktree watches the shared ref store instead of its own stub.
fn watch_git_head() {
    let Some(common) = git_output(&["rev-parse", "--git-common-dir"]) else {
        return;
    };
    let dir = PathBuf::from(&common);
    let dir = if dir.is_absolute() {
        dir
    } else {
        match std::env::var("CARGO_MANIFEST_DIR") {
            Ok(manifest) => PathBuf::from(manifest).join(dir),
            Err(_) => dir,
        }
    };
    for path in [dir.join("HEAD"), dir.join("refs"), dir.join("packed-refs")] {
        if path.exists() {
            println!("cargo:rerun-if-changed={}", path.display());
        }
    }
}

fn git_commit() -> Option<String> {
    let sha = git_output(&["rev-parse", "HEAD"])?;
    let looks_like_a_sha =
        sha.len() >= 7 && sha.len() <= 64 && sha.chars().all(|c| c.is_ascii_hexdigit());
    looks_like_a_sha.then_some(sha)
}

fn git_output(args: &[&str]) -> Option<String> {
    let output = Command::new("git").args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8(output.stdout).ok()?;
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_string())
}

/// No git: identify the build by what it was actually built from. The hash
/// covers every `.rs` path and its bytes, so two checkouts of the same source
/// agree and any edit changes the value.
fn source_fingerprint() -> String {
    let version = std::env::var("CARGO_PKG_VERSION").unwrap_or_else(|_| "0.0.0".to_string());
    let mut sources = Vec::new();
    if let Ok(manifest) = std::env::var("CARGO_MANIFEST_DIR") {
        collect_rust_sources(&PathBuf::from(manifest).join("src"), &mut sources);
    }
    sources.sort();

    // FNV-1a/64. A build-dependency on a hash crate would buy a stronger
    // digest that nothing here needs: this value is an identifier, never a
    // security boundary.
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for path in &sources {
        for byte in path.to_string_lossy().as_bytes() {
            hash = fnv1a(hash, *byte);
        }
        if let Ok(bytes) = std::fs::read(path) {
            for byte in bytes {
                hash = fnv1a(hash, byte);
            }
        }
    }
    format!("{version}+src.{hash:016x}")
}

const fn fnv1a(hash: u64, byte: u8) -> u64 {
    (hash ^ byte as u64).wrapping_mul(0x0000_0100_0000_01b3)
}

fn collect_rust_sources(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_rust_sources(&path, out);
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            out.push(path);
        }
    }
}

/// Keep the value on one line and free of characters that would corrupt the
/// `cargo:rustc-env=` directive or a downstream JSON/audit field.
fn sanitize(value: &str) -> String {
    value
        .chars()
        .filter(|c| !c.is_control() && *c != '\n' && *c != '\r')
        .take(128)
        .collect()
}

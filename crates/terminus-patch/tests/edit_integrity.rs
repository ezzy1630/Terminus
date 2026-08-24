//! Regression tests for edit-integrity fixes in the patch engine:
//! rollback restores the pre-transaction state when one path is edited
//! twice, CRLF files keep their line endings, non-UTF-8 sources are
//! rejected instead of lossily rewritten, and unified diffs are verified
//! against file content before application.

#![cfg(test)]
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::fs;
use tempfile::tempdir;
use terminus_fs::PathResolver;
use terminus_kernel_protocol::{
    InsertContent, LineRange, PatchCommitMode, PatchEdit, ReplaceExactText, ReplaceRange,
    UnifiedDiff, WorkspaceBaseline, WorkspacePath,
};
use terminus_patch::{PatchEngine, ValidationProfile};

fn engine() -> (tempfile::TempDir, PatchEngine) {
    let dir = tempdir().expect("tempdir");
    let ws = dir.path().join("workspace");
    fs::create_dir_all(&ws).expect("mkdir");
    let resolver = PathResolver::new(&ws).expect("resolver");
    let engine = PatchEngine::new(
        resolver,
        dir.path().join("journal"),
        dir.path().join("state"),
    )
    .expect("engine");
    (dir, engine)
}

fn baseline() -> WorkspaceBaseline {
    WorkspaceBaseline {
        workspace_id: "ws-int".into(),
        repository_revision: "rev0".into(),
        dirty_digest: "clean".into(),
        sources: Vec::new(),
    }
}

fn ws_path(rel: &str) -> WorkspacePath {
    WorkspacePath::new("ws-int", rel)
}

fn hash_of(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(bytes);
    format!("sha256:{:x}", h.finalize())
}

/// A transaction that edits the same path twice must roll back BOTH edits,
/// not just the last one. The second snapshot used to clobber the first in
/// the rollback map, so the worktree kept edit #1 while reporting
/// "rolled back".
#[test]
fn rollback_after_same_path_edited_twice_restores_original() {
    let (dir, engine) = engine();
    let original = b"alpha beta gamma\n";
    fs::write(dir.path().join("workspace/file.txt"), original).expect("write");

    let first = PatchEdit::ReplaceExactText(ReplaceExactText {
        path: ws_path("file.txt"),
        expected_sha256: hash_of(original),
        expected_utf8: b"beta".to_vec(),
        replacement_utf8: b"BETA".to_vec(),
        require_unique: true,
    });
    // The second edit succeeds; a third edit then fails mid-transaction and
    // forces the rollback path.
    let second = PatchEdit::Insert(InsertContent {
        path: ws_path("file.txt"),
        expected_sha256: hash_of(b"alpha BETA gamma\n"),
        anchor_kind: "text".into(),
        anchor: "gamma".into(),
        position: "before".into(),
        content_utf8: b"DELTA ".to_vec(),
    });
    // Anchor cannot be found -> apply_edit errors after both prior edits.
    let third = PatchEdit::ReplaceExactText(ReplaceExactText {
        path: ws_path("file.txt"),
        expected_sha256: hash_of(b"alpha BETA DELTA gamma\n"),
        expected_utf8: b"does-not-exist".to_vec(),
        replacement_utf8: b"x".to_vec(),
        require_unique: false,
    });

    let result = engine.apply(
        "tx-twice",
        &baseline(),
        &[first, second, third],
        PatchCommitMode::ApplyToWorktree,
        ValidationProfile::SyntaxOnly,
    );
    assert!(result.is_err(), "third edit must fail");
    let restored = fs::read(dir.path().join("workspace/file.txt")).expect("read");
    assert_eq!(
        restored, original,
        "rollback must restore the pre-transaction content, not an intermediate state"
    );
}

/// replace_range on a CRLF file must not rewrite the whole file to LF.
#[test]
fn replace_range_preserves_crlf_line_endings() {
    let (dir, engine) = engine();
    let original = b"line one\r\nline two\r\nline three\r\n";
    fs::write(dir.path().join("workspace/win.txt"), original).expect("write");

    let edit = PatchEdit::ReplaceRange(ReplaceRange {
        path: ws_path("win.txt"),
        expected_sha256: hash_of(original),
        range: LineRange {
            start_line: 2,
            end_line: 2,
        },
        replacement_utf8: b"line TWO edited".to_vec(),
    });
    let resp = engine
        .apply(
            "tx-crlf",
            &baseline(),
            &[edit],
            PatchCommitMode::ApplyToWorktree,
            ValidationProfile::SyntaxOnly,
        )
        .expect("apply");
    assert_eq!(resp.state, "applied");
    let after = fs::read(dir.path().join("workspace/win.txt")).expect("read");
    assert_eq!(after, b"line one\r\nline TWO edited\r\nline three\r\n");
}

/// Editing the final line must not append a trailing newline to a file that
/// had none.
#[test]
fn replace_range_does_not_force_trailing_newline() {
    let (dir, engine) = engine();
    let original = b"a\nb\nc";
    fs::write(dir.path().join("workspace/noeol.txt"), original).expect("write");

    let edit = PatchEdit::ReplaceRange(ReplaceRange {
        path: ws_path("noeol.txt"),
        expected_sha256: hash_of(original),
        range: LineRange {
            start_line: 3,
            end_line: 3,
        },
        replacement_utf8: b"C".to_vec(),
    });
    engine
        .apply(
            "tx-noeol",
            &baseline(),
            &[edit],
            PatchCommitMode::ApplyToWorktree,
            ValidationProfile::SyntaxOnly,
        )
        .expect("apply");
    let after = fs::read(dir.path().join("workspace/noeol.txt")).expect("read");
    assert_eq!(after, b"a\nb\nC");
}

/// A non-UTF-8 source must be rejected without rewriting it with U+FFFD.
#[test]
fn replace_exact_text_rejects_non_utf8_source() {
    let (dir, engine) = engine();
    let original: &[u8] = &[0x68, 0x69, 0xff, 0x0a]; // "hi\xff\n" — invalid UTF-8
    fs::write(dir.path().join("workspace/bin.dat"), original).expect("write");

    let edit = PatchEdit::ReplaceExactText(ReplaceExactText {
        path: ws_path("bin.dat"),
        expected_sha256: hash_of(original),
        expected_utf8: b"hi".to_vec(),
        replacement_utf8: b"yo".to_vec(),
        require_unique: true,
    });
    let result = engine.apply(
        "tx-bin",
        &baseline(),
        &[edit],
        PatchCommitMode::ApplyToWorktree,
        ValidationProfile::SyntaxOnly,
    );
    assert!(result.is_err(), "non-UTF-8 source must be rejected");
    let after = fs::read(dir.path().join("workspace/bin.dat")).expect("read");
    assert_eq!(after, original, "source bytes must be untouched");
}

/// A unified diff whose context does not match the file is rejected instead
/// of being applied at drifted offsets.
#[test]
fn unified_diff_rejects_context_mismatch() {
    let (dir, engine) = engine();
    let original = b"one\ntwo\nthree\n";
    fs::write(dir.path().join("workspace/code.txt"), original).expect("write");

    // Hunk claims context "two" at line 1, but line 1 is "one".
    let diff = "--- a/code.txt\n+++ b/code.txt\n@@ -1,2 +1,2 @@\n-two\n+TWO\n three\n";
    let edit = PatchEdit::UnifiedDiff(UnifiedDiff {
        repository_revision: "rev0".into(),
        diff_utf8: diff.as_bytes().to_vec(),
    });
    let result = engine.apply(
        "tx-drift",
        &baseline(),
        &[edit],
        PatchCommitMode::ApplyToWorktree,
        ValidationProfile::SyntaxOnly,
    );
    assert!(result.is_err(), "drifted hunk must be rejected");
    let after = fs::read(dir.path().join("workspace/code.txt")).expect("read");
    assert_eq!(after, original, "file must be untouched on rejection");
}

/// Deletions past end-of-file are rejected rather than silently skipped.
#[test]
fn unified_diff_rejects_deletion_past_eof() {
    let (dir, engine) = engine();
    let original = b"only line\n";
    fs::write(dir.path().join("workspace/short.txt"), original).expect("write");

    let diff = "--- a/short.txt\n+++ b/short.txt\n@@ -5,1 +5,1 @@\n-only line\n-replaced\n";
    let edit = PatchEdit::UnifiedDiff(UnifiedDiff {
        repository_revision: "rev0".into(),
        diff_utf8: diff.as_bytes().to_vec(),
    });
    let result = engine.apply(
        "tx-past-eof",
        &baseline(),
        &[edit],
        PatchCommitMode::ApplyToWorktree,
        ValidationProfile::SyntaxOnly,
    );
    assert!(result.is_err(), "hunk past EOF must be rejected");
    let after = fs::read(dir.path().join("workspace/short.txt")).expect("read");
    assert_eq!(after, original);
}

/// A malformed hunk header fails closed instead of defaulting to line 1.
#[test]
fn unified_diff_rejects_malformed_hunk_header() {
    let (dir, engine) = engine();
    let original = b"data\n";
    fs::write(dir.path().join("workspace/h.txt"), original).expect("write");

    let diff = "--- a/h.txt\n+++ b/h.txt\n@@ -NaN +1 @@\n-data\n+DATA\n";
    let edit = PatchEdit::UnifiedDiff(UnifiedDiff {
        repository_revision: "rev0".into(),
        diff_utf8: diff.as_bytes().to_vec(),
    });
    let result = engine.apply(
        "tx-bad-header",
        &baseline(),
        &[edit],
        PatchCommitMode::ApplyToWorktree,
        ValidationProfile::SyntaxOnly,
    );
    assert!(result.is_err(), "malformed header must be rejected");
    let after = fs::read(dir.path().join("workspace/h.txt")).expect("read");
    assert_eq!(after, original);
}

/// A well-formed multi-hunk diff still applies cleanly through the verified
/// applier, including second-hunk offset tracking.
#[test]
fn unified_diff_applies_multi_hunk_with_offsets() {
    let (dir, engine) = engine();
    let original = b"a\nb\nc\nd\ne\n";
    fs::write(dir.path().join("workspace/multi.txt"), original).expect("write");

    let diff =
        "--- a/multi.txt\n+++ b/multi.txt\n@@ -1,2 +1,2 @@\n a\n-b\n+b2\n@@ -4 +4 @@\n-d\n+D\n";
    let edit = PatchEdit::UnifiedDiff(UnifiedDiff {
        repository_revision: "rev0".into(),
        diff_utf8: diff.as_bytes().to_vec(),
    });
    let resp = engine
        .apply(
            "tx-multi",
            &baseline(),
            &[edit],
            PatchCommitMode::ApplyToWorktree,
            ValidationProfile::SyntaxOnly,
        )
        .expect("apply");
    assert_eq!(resp.state, "applied");
    let after = fs::read(dir.path().join("workspace/multi.txt")).expect("read");
    // Second hunk addresses pre-image line 4 ("d"); net delta from hunk one
    // is zero (one deletion, one insertion).
    assert_eq!(after, b"a\nb2\nc\nD\ne\n");
}

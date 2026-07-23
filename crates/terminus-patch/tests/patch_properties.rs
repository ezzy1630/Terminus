//! Property + fuzz-smoke tests for patch / unified diff (SPEC §46.3, §46.4).

#![cfg(test)]
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::fs;
use tempfile::tempdir;
use terminus_fs::PathResolver;
use terminus_kernel_protocol::{
    CreateFile, PatchCommitMode, PatchEdit, ReplaceExactText, UnifiedDiff, WorkspaceBaseline,
    WorkspacePath,
};
use terminus_patch::{parse_unified_diff, target_path, PatchEngine, ValidationProfile};

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
        workspace_id: "ws-prop".into(),
        repository_revision: "rev0".into(),
        dirty_digest: "clean".into(),
        sources: Vec::new(),
    }
}

fn ws_path(rel: &str) -> WorkspacePath {
    WorkspacePath::new("ws-prop", rel)
}

fn hash_of(text: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(text.as_bytes());
    format!("sha256:{:x}", h.finalize())
}

#[test]
fn create_then_identity_replace_preserves_bytes() {
    let (dir, engine) = engine();
    let create = PatchEdit::CreateFile(CreateFile {
        path: ws_path("note.txt"),
        must_not_exist: true,
        content: b"hello world\n".to_vec(),
        media_type: "text/plain".into(),
    });
    let resp = engine
        .apply(
            "tx-create",
            &baseline(),
            &[create],
            PatchCommitMode::ApplyToWorktree,
            ValidationProfile::TaskDefault,
        )
        .expect("create");
    assert_eq!(resp.state, "applied");

    let original = fs::read(dir.path().join("workspace/note.txt")).expect("read");
    let expected = hash_of("hello world\n");
    let replace = PatchEdit::ReplaceExactText(ReplaceExactText {
        path: ws_path("note.txt"),
        expected_sha256: expected,
        expected_utf8: b"hello".to_vec(),
        replacement_utf8: b"hello".to_vec(),
        require_unique: true,
    });
    let resp2 = engine
        .apply(
            "tx-replace",
            &baseline(),
            &[replace],
            PatchCommitMode::ApplyToWorktree,
            ValidationProfile::TaskDefault,
        )
        .expect("replace");
    assert_eq!(resp2.state, "applied");
    let after = fs::read(dir.path().join("workspace/note.txt")).expect("read after");
    assert_eq!(after, original);
}

#[test]
fn unified_diff_parser_never_panics_on_arbitrary_bytes() {
    let mut seed = 0xC0FFEE_u64;
    for _ in 0..2_000 {
        let mut buf = Vec::with_capacity(64);
        for _ in 0..64 {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
            buf.push((seed >> 33) as u8);
        }
        let _ = parse_unified_diff(&buf);
    }
}

#[test]
fn unified_diff_target_path_prefers_new() {
    let parsed =
        parse_unified_diff(b"--- a/old.txt\n+++ b/new.txt\n@@ -1 +1 @@\n-a\n+b\n").expect("parse");
    assert_eq!(target_path(&parsed), "new.txt");
}

#[test]
fn apply_malformed_unified_diff_does_not_corrupt_unrelated_file() {
    let (dir, engine) = engine();
    fs::write(dir.path().join("workspace/keep.txt"), b"keep\n").expect("write");
    let edit = PatchEdit::UnifiedDiff(UnifiedDiff {
        repository_revision: "rev0".into(),
        diff_utf8: b"not a diff at all @@ garbage".to_vec(),
    });
    let _ = engine.apply(
        "tx-bad-diff",
        &baseline(),
        &[edit],
        PatchCommitMode::ApplyToWorktree,
        ValidationProfile::TaskDefault,
    );
    let keep = fs::read(dir.path().join("workspace/keep.txt")).expect("keep");
    assert_eq!(keep, b"keep\n");
}

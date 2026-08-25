//! Tests for hashline (hash-anchored line replacement) edits in the patch engine.

#![cfg(test)]
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::fs;
use tempfile::tempdir;
use terminus_fs::PathResolver;
use terminus_kernel_protocol::{
    PatchCommitMode, PatchEdit, ReplaceHashline, WorkspaceBaseline, WorkspacePath,
};
use terminus_patch::{compute_line_hash, PatchEngine, ValidationProfile};

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
        workspace_id: "ws-hashline".into(),
        repository_revision: "rev0".into(),
        dirty_digest: "clean".into(),
        sources: Vec::new(),
    }
}

fn ws_path(rel: &str) -> WorkspacePath {
    WorkspacePath::new("ws-hashline", rel)
}

fn hash_of(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(bytes);
    format!("sha256:{:x}", h.finalize())
}

#[test]
fn replace_hashline_matches_and_applies() {
    let (dir, engine) = engine();
    let initial_content = "fn main() {\n    println!(\"hello\");\n    let x = 1;\n}\n";
    let target = dir.path().join("workspace/src/main.rs");
    fs::create_dir_all(target.parent().unwrap()).unwrap();
    fs::write(&target, initial_content).unwrap();

    let lines: Vec<&str> = initial_content.lines().collect();
    let line2_hash = compute_line_hash(lines[1]); // println!("hello");
    let line3_hash = compute_line_hash(lines[2]); // let x = 1;

    let edit = PatchEdit::ReplaceHashline(ReplaceHashline {
        path: ws_path("src/main.rs"),
        expected_sha256: hash_of(initial_content.as_bytes()),
        line_hashes: vec![line2_hash, line3_hash],
        start_line: 2,
        end_line: 3,
        replacement_utf8: b"    println!(\"world\");\n    let x = 42;".to_vec(),
    });

    let res = engine
        .apply(
            "tx-hashline-1",
            &baseline(),
            &[edit],
            PatchCommitMode::ApplyToWorktree,
            ValidationProfile::TaskDefault,
        )
        .expect("patch must succeed");

    assert_eq!(res.state, "applied");
    let updated = fs::read_to_string(&target).unwrap();
    assert_eq!(
        updated,
        "fn main() {\n    println!(\"world\");\n    let x = 42;\n}\n"
    );
}

#[test]
fn replace_hashline_rejects_stale_line_hash() {
    let (dir, engine) = engine();
    let initial_content = "line 1\nline 2\nline 3\n";
    let target = dir.path().join("workspace/file.txt");
    fs::write(&target, initial_content).unwrap();

    let wrong_hash = "deadbeef".to_string();

    let edit = PatchEdit::ReplaceHashline(ReplaceHashline {
        path: ws_path("file.txt"),
        expected_sha256: hash_of(initial_content.as_bytes()),
        line_hashes: vec![wrong_hash],
        start_line: 2,
        end_line: 2,
        replacement_utf8: b"line 2 modified".to_vec(),
    });

    let err = engine
        .apply(
            "tx-hashline-2",
            &baseline(),
            &[edit],
            PatchCommitMode::ApplyToWorktree,
            ValidationProfile::TaskDefault,
        )
        .expect_err("stale line hash must fail");

    match err {
        terminus_patch::PatchError::AnchorStale(msg) => {
            assert!(msg.contains("line hash mismatch at file.txt:2"));
        }
        other => panic!("expected AnchorStale, got {other:?}"),
    }

    // Worktree untouched
    assert_eq!(fs::read_to_string(&target).unwrap(), initial_content);
}

#[test]
fn replace_hashline_multi_file_rollback_on_conflict() {
    let (dir, engine) = engine();
    let f1_content = "aaa\nbbb\nccc\n";
    let f2_content = "111\n222\n333\n";
    let p1 = dir.path().join("workspace/f1.txt");
    let p2 = dir.path().join("workspace/f2.txt");
    fs::write(&p1, f1_content).unwrap();
    fs::write(&p2, f2_content).unwrap();

    let f1_line2_hash = compute_line_hash("bbb");
    let f2_line2_bad_hash = "00000000".to_string();

    let edit1 = PatchEdit::ReplaceHashline(ReplaceHashline {
        path: ws_path("f1.txt"),
        expected_sha256: hash_of(f1_content.as_bytes()),
        line_hashes: vec![f1_line2_hash],
        start_line: 2,
        end_line: 2,
        replacement_utf8: b"BBB".to_vec(),
    });

    let edit2 = PatchEdit::ReplaceHashline(ReplaceHashline {
        path: ws_path("f2.txt"),
        expected_sha256: hash_of(f2_content.as_bytes()),
        line_hashes: vec![f2_line2_bad_hash],
        start_line: 2,
        end_line: 2,
        replacement_utf8: b"222_modified".to_vec(),
    });

    let err = engine
        .apply(
            "tx-hashline-3",
            &baseline(),
            &[edit1, edit2],
            PatchCommitMode::ApplyToWorktree,
            ValidationProfile::TaskDefault,
        )
        .expect_err("second edit failure must roll back entire transaction");

    match err {
        terminus_patch::PatchError::AnchorStale(msg) => {
            assert!(msg.contains("line hash mismatch at f2.txt:2"));
        }
        other => panic!("expected AnchorStale, got {other:?}"),
    }

    // Both files must remain in their original state (f1 rolled back!)
    assert_eq!(fs::read_to_string(&p1).unwrap(), f1_content);
    assert_eq!(fs::read_to_string(&p2).unwrap(), f2_content);
}

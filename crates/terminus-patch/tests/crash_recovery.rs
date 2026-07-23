use tempfile::tempdir;
use terminus_fs::PathResolver;
use terminus_kernel_protocol::{
    CreateFile, PatchCommitMode, PatchEdit, UnifiedDiff, WorkspaceBaseline, WorkspacePath,
};
use terminus_patch::{JournalEntry, JournalRecord, PatchEngine, ValidationProfile};

fn mock_baseline() -> WorkspaceBaseline {
    WorkspaceBaseline {
        workspace_id: "ws-test".to_string(),
        repository_revision: "rev-1".to_string(),
        dirty_digest: "clean".to_string(),
        sources: Vec::new(),
    }
}

#[test]
fn forced_crash_recovery_at_snapshot_step() {
    let tmp = tempdir().unwrap();
    let root = tmp.path().join("workspace");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("test.txt"), "hello world\n").unwrap();

    let resolver = PathResolver::new(&root).unwrap();
    let journal_dir = tmp.path().join("journals");
    let state_dir = tmp.path().join("state");

    let engine = PatchEngine::new(resolver, journal_dir.clone(), state_dir.clone()).unwrap();

    let tx_id = "tx-crash-1";
    let overlay_dir = state_dir.join(format!("tx-{tx_id}"));
    std::fs::create_dir_all(&overlay_dir).unwrap();

    let snapshot_file = overlay_dir.join("test.txt-snap");
    std::fs::write(&snapshot_file, "hello world\n").unwrap();

    std::fs::write(root.join("test.txt"), "CORRUPTED CONTENT").unwrap();

    let mut journal = JournalRecord::new(tx_id.to_string());
    journal.push(JournalEntry::TransactionStarted {
        transaction_id: tx_id.to_string(),
        baseline_workspace_id: "ws-test".to_string(),
        edit_count: 1,
    });
    journal.push(JournalEntry::FileSnapshotted {
        relative_path: "test.txt".to_string(),
        snapshot_path: snapshot_file.to_string_lossy().to_string(),
        original_hash: "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
            .to_string(),
    });
    journal.write_to(&journal_dir).unwrap();

    let resp = engine.reconcile(tx_id).unwrap();
    assert_eq!(resp.state, "rolled_back");

    let restored = std::fs::read_to_string(root.join("test.txt")).unwrap();
    assert_eq!(restored, "hello world\n");
}

#[test]
fn forced_crash_recovery_at_edit_step() {
    let tmp = tempdir().unwrap();
    let root = tmp.path().join("workspace");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("a.py"), "def foo(): pass\n").unwrap();

    let resolver = PathResolver::new(&root).unwrap();
    let journal_dir = tmp.path().join("journals");
    let state_dir = tmp.path().join("state");

    let engine = PatchEngine::new(resolver, journal_dir.clone(), state_dir.clone()).unwrap();

    let tx_id = "tx-crash-2";
    let overlay_dir = state_dir.join(format!("tx-{tx_id}"));
    std::fs::create_dir_all(&overlay_dir).unwrap();

    let snapshot_file = overlay_dir.join("a.py-snap");
    std::fs::write(&snapshot_file, "def foo(): pass\n").unwrap();

    std::fs::write(root.join("a.py"), "def foo(): BAD_SYNTAX\n").unwrap();

    let mut journal = JournalRecord::new(tx_id.to_string());
    journal.push(JournalEntry::FileSnapshotted {
        relative_path: "a.py".to_string(),
        snapshot_path: snapshot_file.to_string_lossy().to_string(),
        original_hash: "hash123".to_string(),
    });
    journal.push(JournalEntry::EditApplied {
        relative_path: "a.py".to_string(),
        edit: PatchEdit::CreateFile(CreateFile {
            path: WorkspacePath {
                workspace_id: "ws".to_string(),
                relative_path: "a.py".to_string(),
            },
            media_type: "text/plain".to_string(),
            content: b"def foo(): BAD_SYNTAX\n".to_vec(),
            must_not_exist: false,
        }),
        new_hash: "hashbad".to_string(),
    });
    journal.write_to(&journal_dir).unwrap();

    let resp = engine.reconcile(tx_id).unwrap();
    assert_eq!(resp.state, "rolled_back");

    let restored = std::fs::read_to_string(root.join("a.py")).unwrap();
    assert_eq!(restored, "def foo(): pass\n");
}

#[test]
fn unified_diff_patch_application() {
    let tmp = tempdir().unwrap();
    let root = tmp.path().join("workspace");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("code.ts"), "const x = 1;\nconst y = 2;\n").unwrap();

    let resolver = PathResolver::new(&root).unwrap();
    let journal_dir = tmp.path().join("journals");
    let state_dir = tmp.path().join("state");

    let engine = PatchEngine::new(resolver, journal_dir, state_dir).unwrap();

    let diff = "--- a/code.ts\n+++ b/code.ts\n@@ -1,2 +1,2 @@\n-const x = 1;\n+const x = 100;\n const y = 2;\n";
    let edit = PatchEdit::UnifiedDiff(UnifiedDiff {
        repository_revision: "rev-1".to_string(),
        diff_utf8: diff.as_bytes().to_vec(),
    });

    let resp = engine
        .apply(
            "tx-diff-1",
            &mock_baseline(),
            &[edit],
            PatchCommitMode::ApplyToWorktree,
            ValidationProfile::SyntaxOnly,
        )
        .unwrap();

    assert_eq!(resp.state, "applied");
    let content = std::fs::read_to_string(root.join("code.ts")).unwrap();
    assert_eq!(content, "const x = 100;\nconst y = 2;\n");
}

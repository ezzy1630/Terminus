use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use terminus_kernel_protocol::PatchEdit;

/// A single journal entry recording one atomic step of a transaction.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum JournalEntry {
    TransactionStarted {
        transaction_id: String,
        baseline_workspace_id: String,
        edit_count: usize,
    },
    FileSnapshotted {
        relative_path: String,
        snapshot_path: String,
        original_hash: String,
    },
    EditApplied {
        relative_path: String,
        edit: PatchEdit,
        new_hash: String,
    },
    ValidationRun {
        check_id: String,
        status: String,
    },
    CommitSucceeded {
        final_dirty_digest: String,
    },
    RollbackCompleted,
}

/// The full journal record persisted to disk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JournalRecord {
    pub transaction_id: String,
    pub entries: Vec<JournalEntry>,
    pub started_at: String,
    pub finished_at: Option<String>,
}

impl JournalRecord {
    pub fn new(transaction_id: impl Into<String>) -> Self {
        Self {
            transaction_id: transaction_id.into(),
            entries: Vec::new(),
            started_at: now_rfc3339(),
            finished_at: None,
        }
    }

    pub fn push(&mut self, entry: JournalEntry) {
        self.entries.push(entry);
    }

    pub fn finish(&mut self) {
        self.finished_at = Some(now_rfc3339());
    }

    pub fn write_to(&self, dir: &std::path::Path) -> Result<PathBuf, std::io::Error> {
        std::fs::create_dir_all(dir)?;
        let path = dir.join(format!("{}.json", self.transaction_id));
        let json = serde_json::to_vec_pretty(self)?;
        std::fs::write(&path, json)?;
        Ok(path)
    }
}

fn now_rfc3339() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let dur = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    format!("{}.{:06}+00:00", dur.as_secs(), dur.subsec_micros())
}

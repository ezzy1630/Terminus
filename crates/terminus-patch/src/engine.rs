use crate::error::PatchError;
use crate::journal::{JournalEntry, JournalRecord};
use crate::validate::{
    brace_balance_check, line_count_sanity, utf8_check, ValidationProfile, ValidationResult,
    ValidationStatus,
};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use terminus_fs::{PathResolver, SafePath};
use terminus_kernel_protocol::{
    ChangedFile, CreateFile, DeleteFile, DeleteRange, InsertContent, MoveFile, PatchCommitMode,
    PatchEdit, PatchResponse, ReplaceExactText, ReplaceRange, ReplaceSymbol, UnifiedDiff,
    WorkspaceBaseline, WorkspacePath,
};

/// A transaction in progress. Holds snapshots for rollback.
#[derive(Debug)]
pub struct Transaction {
    pub id: String,
    pub overlay_dir: PathBuf,
    pub snapshots: HashMap<String, PathBuf>,
    pub journal: JournalRecord,
}

impl Transaction {
    pub fn new(id: impl Into<String>, overlay_dir: PathBuf) -> Self {
        let id = id.into();
        let journal = JournalRecord::new(id.clone());
        Self {
            id,
            overlay_dir,
            snapshots: HashMap::new(),
            journal,
        }
    }
}

/// The patch engine applies edits transactionally.
#[derive(Debug, Clone)]
pub struct PatchEngine {
    resolver: PathResolver,
    journal_dir: PathBuf,
    state_dir: PathBuf,
    /// A simple per-path lease table. Production deployments use SQLite.
    leases: std::sync::Arc<Mutex<HashMap<String, String>>>,
}

impl PatchEngine {
    pub fn new(
        resolver: PathResolver,
        journal_dir: PathBuf,
        state_dir: PathBuf,
    ) -> Result<Self, PatchError> {
        std::fs::create_dir_all(&journal_dir)?;
        std::fs::create_dir_all(&state_dir)?;
        Ok(Self {
            resolver,
            journal_dir,
            state_dir,
            leases: std::sync::Arc::new(Mutex::new(HashMap::new())),
        })
    }

    /// Apply a patch transaction. The response's `state` is `"applied"` on
    /// success or `"rolled_back"` on validation failure when
    /// `commit_mode = ApplyToWorktree`.
    pub fn apply(
        &self,
        transaction_id: &str,
        baseline: &WorkspaceBaseline,
        edits: &[PatchEdit],
        commit_mode: PatchCommitMode,
        validation_profile: ValidationProfile,
    ) -> Result<PatchResponse, PatchError> {
        let overlay_dir = self.state_dir.join(format!("tx-{transaction_id}"));
        std::fs::create_dir_all(&overlay_dir)?;
        let mut tx = Transaction::new(transaction_id.to_string(), overlay_dir.clone());
        tx.journal.push(JournalEntry::TransactionStarted {
            transaction_id: transaction_id.to_string(),
            baseline_workspace_id: baseline.workspace_id.clone(),
            edit_count: edits.len(),
        });

        // Collect target paths and acquire leases in sorted order to avoid deadlock.
        let mut target_paths: Vec<String> = edits
            .iter()
            .filter_map(|e| edit_target_path(e).map(|p| p.relative_path.clone()))
            .collect();
        target_paths.sort();
        target_paths.dedup();
        self.acquire_leases(transaction_id, &target_paths)?;

        let result = self.apply_inner(&mut tx, baseline, edits, commit_mode, validation_profile);

        // Always release leases.
        self.release_leases(&target_paths);

        match result {
            Ok(resp) => {
                // Persist journal.
                tx.journal.finish();
                let _ = tx.journal.write_to(&self.journal_dir);
                // Clean up overlay on success.
                let _ = std::fs::remove_dir_all(&overlay_dir);
                Ok(resp)
            }
            Err(err) => {
                // Rollback.
                self.rollback(&mut tx)?;
                tx.journal.push(JournalEntry::RollbackCompleted);
                tx.journal.finish();
                let _ = tx.journal.write_to(&self.journal_dir);
                let _ = std::fs::remove_dir_all(&overlay_dir);
                Err(err)
            }
        }
    }

    /// Reconcile an interrupted transaction from its durable journal. An
    /// unfinished transaction is rolled back from the snapshots it recorded;
    /// a finished transaction is reported idempotently. Missing journals are
    /// explicit unknown settlement rather than an invented success.
    pub fn reconcile(&self, transaction_id: &str) -> Result<PatchResponse, PatchError> {
        let journal_path = self.journal_dir.join(format!("{transaction_id}.json"));
        if !journal_path.exists() {
            return Ok(PatchResponse {
                transaction_id: transaction_id.to_string(),
                state: "unknown_settlement".to_string(),
                final_repository_revision: String::new(),
                final_dirty_digest: String::new(),
                changed_files: Vec::new(),
                validations: Vec::new(),
                complete_diff: None,
            });
        }
        let mut journal: JournalRecord = serde_json::from_slice(&std::fs::read(&journal_path)?)?;
        if journal.finished_at.is_none() {
            for entry in journal.entries.iter().rev() {
                if let JournalEntry::FileSnapshotted {
                    relative_path,
                    snapshot_path,
                    ..
                } = entry
                {
                    let safe = SafePath::new(relative_path)?;
                    let resolved = self.resolver.resolve_strict(&safe)?;
                    let snapshot = Path::new(snapshot_path);
                    if snapshot.exists() {
                        std::fs::copy(snapshot, &resolved.host.host_path)?;
                    }
                }
            }
            journal.push(JournalEntry::RollbackCompleted);
            journal.finish();
            journal.write_to(&self.journal_dir)?;
            let _ = std::fs::remove_dir_all(self.state_dir.join(format!("tx-{transaction_id}")));
            return Ok(PatchResponse {
                transaction_id: transaction_id.to_string(),
                state: "rolled_back".to_string(),
                final_repository_revision: String::new(),
                final_dirty_digest: String::new(),
                changed_files: Vec::new(),
                validations: Vec::new(),
                complete_diff: None,
            });
        }
        let state = if journal
            .entries
            .iter()
            .any(|entry| matches!(entry, JournalEntry::CommitSucceeded { .. }))
        {
            "applied"
        } else {
            "rolled_back"
        };
        Ok(PatchResponse {
            transaction_id: transaction_id.to_string(),
            state: state.to_string(),
            final_repository_revision: String::new(),
            final_dirty_digest: String::new(),
            changed_files: Vec::new(),
            validations: Vec::new(),
            complete_diff: None,
        })
    }

    fn apply_inner(
        &self,
        tx: &mut Transaction,
        baseline: &WorkspaceBaseline,
        edits: &[PatchEdit],
        commit_mode: PatchCommitMode,
        validation_profile: ValidationProfile,
    ) -> Result<PatchResponse, PatchError> {
        let mut changed_files: Vec<ChangedFile> = Vec::new();
        let mut validations: Vec<ValidationResult> = Vec::new();

        for edit in edits {
            self.apply_edit(tx, baseline, edit, &mut changed_files)?;
        }

        // Run validations on all changed files.
        for changed in &changed_files {
            let path = self
                .resolver
                .resolve_strict(&SafePath::new(&changed.path.relative_path)?)?;
            let content = std::fs::read(&path.host.host_path).unwrap_or_default();
            validations.push(utf8_check(&content));
            validations.push(line_count_sanity(&content));
            if matches!(validation_profile, ValidationProfile::LanguageFast)
                || matches!(validation_profile, ValidationProfile::TaskDefault)
            {
                validations.push(brace_balance_check(&content));
            }
        }

        // Check validations: if any fail and we're applying, roll back.
        let any_failed = validations
            .iter()
            .any(|v| v.status == ValidationStatus::Fail);
        if any_failed && matches!(commit_mode, PatchCommitMode::ApplyToWorktree) {
            // Find the first failure.
            let first_fail = validations
                .iter()
                .find(|v| v.status == ValidationStatus::Fail)
                .cloned()
                .unwrap_or(ValidationResult {
                    check_id: "unknown".to_string(),
                    status: ValidationStatus::Fail,
                    summary: "validation failed".to_string(),
                });
            tx.journal.push(JournalEntry::ValidationRun {
                check_id: first_fail.check_id.clone(),
                status: "fail".to_string(),
            });
            return Err(PatchError::ValidationFailed(format!(
                "{}: {}",
                first_fail.check_id, first_fail.summary
            )));
        }

        // Record validation outcomes in journal.
        for v in &validations {
            tx.journal.push(JournalEntry::ValidationRun {
                check_id: v.check_id.clone(),
                status: match v.status {
                    ValidationStatus::Pass => "pass".to_string(),
                    ValidationStatus::Fail => "fail".to_string(),
                    ValidationStatus::Skipped => "skipped".to_string(),
                },
            });
        }

        let state = match commit_mode {
            PatchCommitMode::PreviewOnly => "preview".to_string(),
            PatchCommitMode::StageOnly => "staged".to_string(),
            PatchCommitMode::ApplyToWorktree | PatchCommitMode::Unspecified => {
                "applied".to_string()
            }
        };

        // In PreviewOnly mode we must NOT persist any changes to the worktree.
        // The edit functions above wrote to disk; roll back to snapshots now
        // so the worktree is byte-identical to the baseline.
        if matches!(commit_mode, PatchCommitMode::PreviewOnly) {
            self.rollback(tx)?;
        }

        tx.journal.push(JournalEntry::CommitSucceeded {
            final_dirty_digest: compute_dirty_digest(&changed_files),
        });

        // Convert validations to protocol type.
        let protocol_validations = validations
            .into_iter()
            .map(|v| terminus_kernel_protocol::ValidationResult {
                check_id: v.check_id,
                status: match v.status {
                    ValidationStatus::Pass => "pass".to_string(),
                    ValidationStatus::Fail => "fail".to_string(),
                    ValidationStatus::Skipped => "skipped".to_string(),
                },
                summary: v.summary,
                evidence: None,
            })
            .collect();

        Ok(PatchResponse {
            transaction_id: tx.id.clone(),
            state,
            final_repository_revision: baseline.repository_revision.clone(),
            final_dirty_digest: compute_dirty_digest(&changed_files),
            changed_files,
            validations: protocol_validations,
            complete_diff: None,
        })
    }

    fn apply_edit(
        &self,
        tx: &mut Transaction,
        baseline: &WorkspaceBaseline,
        edit: &PatchEdit,
        changed_files: &mut Vec<ChangedFile>,
    ) -> Result<(), PatchError> {
        match edit {
            PatchEdit::CreateFile(e) => self.apply_create_file(tx, e, changed_files),
            PatchEdit::ReplaceRange(e) => self.apply_replace_range(tx, baseline, e, changed_files),
            PatchEdit::ReplaceExactText(e) => {
                self.apply_replace_exact_text(tx, baseline, e, changed_files)
            }
            PatchEdit::ReplaceSymbol(e) => {
                self.apply_replace_symbol(tx, baseline, e, changed_files)
            }
            PatchEdit::Insert(e) => self.apply_insert(tx, baseline, e, changed_files),
            PatchEdit::DeleteRange(e) => self.apply_delete_range(tx, baseline, e, changed_files),
            PatchEdit::MoveFile(e) => self.apply_move_file(tx, baseline, e, changed_files),
            PatchEdit::DeleteFile(e) => self.apply_delete_file(tx, baseline, e, changed_files),
            PatchEdit::UnifiedDiff(e) => self.apply_unified_diff(tx, e, changed_files),
        }
    }

    fn snapshot_if_existing(
        &self,
        tx: &mut Transaction,
        relative_path: &str,
    ) -> Result<String, PatchError> {
        let safe = SafePath::new(relative_path)?;
        let resolved = self.resolver.resolve_strict(&safe)?;
        if !resolved.host.exists {
            return Ok(String::new());
        }
        let original_bytes = std::fs::read(&resolved.host.host_path)?;
        let original_hash = sha256_hex(&original_bytes);
        let snapshot_name = format!(
            "{}-{}",
            relative_path.replace('/', "_"),
            terminus_kernel_protocol::new_id()
        );
        let snapshot_path = tx.overlay_dir.join(&snapshot_name);
        std::fs::write(&snapshot_path, &original_bytes)?;
        tx.snapshots
            .insert(relative_path.to_string(), snapshot_path.clone());
        tx.journal.push(JournalEntry::FileSnapshotted {
            relative_path: relative_path.to_string(),
            snapshot_path: snapshot_path.to_string_lossy().to_string(),
            original_hash: original_hash.clone(),
        });
        Ok(original_hash)
    }

    fn apply_create_file(
        &self,
        tx: &mut Transaction,
        edit: &CreateFile,
        changed_files: &mut Vec<ChangedFile>,
    ) -> Result<(), PatchError> {
        let safe = SafePath::new(&edit.path.relative_path)?;
        let resolved = self.resolver.resolve_strict(&safe)?;
        if edit.must_not_exist && resolved.host.exists {
            return Err(PatchError::AlreadyExists(edit.path.relative_path.clone()));
        }
        if let Some(parent) = resolved.host.host_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&resolved.host.host_path, &edit.content)?;
        let new_hash = sha256_hex(&edit.content);
        tx.journal.push(JournalEntry::EditApplied {
            relative_path: edit.path.relative_path.clone(),
            edit: PatchEdit::CreateFile(edit.clone()),
            new_hash: new_hash.clone(),
        });
        changed_files.push(ChangedFile {
            path: edit.path.clone(),
            old_sha256: String::new(),
            new_sha256: format!("sha256:{new_hash}"),
            operation: "create".to_string(),
        });
        Ok(())
    }

    fn apply_replace_range(
        &self,
        tx: &mut Transaction,
        baseline: &WorkspaceBaseline,
        edit: &ReplaceRange,
        changed_files: &mut Vec<ChangedFile>,
    ) -> Result<(), PatchError> {
        let original_hash = self.snapshot_if_existing(tx, &edit.path.relative_path)?;
        self.verify_hash(&edit.path, &edit.expected_sha256, &original_hash, baseline)?;
        let safe = SafePath::new(&edit.path.relative_path)?;
        let resolved = self.resolver.resolve_strict(&safe)?;
        let original_bytes = std::fs::read(&resolved.host.host_path)?;
        let text = String::from_utf8(original_bytes.clone()).map_err(|_| {
            PatchError::InvalidEdit(format!("{} is not valid UTF-8", edit.path.relative_path))
        })?;
        let lines: Vec<&str> = text.lines().collect();
        let start = edit.range.start_line as usize;
        let end = edit.range.end_line as usize;
        if start == 0 || end == 0 || start > end || end > lines.len() {
            return Err(PatchError::InvalidEdit(format!(
                "invalid line range {}..{} (file has {} lines)",
                start,
                end,
                lines.len()
            )));
        }
        let mut new_lines: Vec<String> = lines[..start - 1].iter().map(|s| s.to_string()).collect();
        new_lines.push(String::from_utf8_lossy(&edit.replacement_utf8).to_string());
        for line in &lines[end..] {
            new_lines.push(line.to_string());
        }
        let new_text = new_lines.join("\n") + "\n";
        let new_bytes = new_text.as_bytes();
        std::fs::write(&resolved.host.host_path, new_bytes)?;
        let new_hash = sha256_hex(new_bytes);
        tx.journal.push(JournalEntry::EditApplied {
            relative_path: edit.path.relative_path.clone(),
            edit: PatchEdit::ReplaceRange(edit.clone()),
            new_hash: new_hash.clone(),
        });
        changed_files.push(ChangedFile {
            path: edit.path.clone(),
            old_sha256: format!("sha256:{original_hash}"),
            new_sha256: format!("sha256:{new_hash}"),
            operation: "replace_range".to_string(),
        });
        Ok(())
    }

    fn apply_replace_exact_text(
        &self,
        tx: &mut Transaction,
        baseline: &WorkspaceBaseline,
        edit: &ReplaceExactText,
        changed_files: &mut Vec<ChangedFile>,
    ) -> Result<(), PatchError> {
        let original_hash = self.snapshot_if_existing(tx, &edit.path.relative_path)?;
        self.verify_hash(&edit.path, &edit.expected_sha256, &original_hash, baseline)?;
        let safe = SafePath::new(&edit.path.relative_path)?;
        let resolved = self.resolver.resolve_strict(&safe)?;
        let original_bytes = std::fs::read(&resolved.host.host_path)?;
        let expected = String::from_utf8_lossy(&edit.expected_utf8);
        let original = String::from_utf8_lossy(&original_bytes);
        let occurrences = original.matches(expected.as_ref()).count();
        if occurrences == 0 {
            return Err(PatchError::AnchorNotFound(expected.to_string()));
        }
        if edit.require_unique && occurrences > 1 {
            return Err(PatchError::AnchorNotUnique(format!(
                "anchor found {occurrences} times"
            )));
        }
        let replacement = String::from_utf8_lossy(&edit.replacement_utf8);
        let new_text = original.replacen(expected.as_ref(), replacement.as_ref(), 1);
        let new_bytes = new_text.as_bytes();
        std::fs::write(&resolved.host.host_path, new_bytes)?;
        let new_hash = sha256_hex(new_bytes);
        tx.journal.push(JournalEntry::EditApplied {
            relative_path: edit.path.relative_path.clone(),
            edit: PatchEdit::ReplaceExactText(edit.clone()),
            new_hash: new_hash.clone(),
        });
        changed_files.push(ChangedFile {
            path: edit.path.clone(),
            old_sha256: format!("sha256:{original_hash}"),
            new_sha256: format!("sha256:{new_hash}"),
            operation: "replace_exact".to_string(),
        });
        Ok(())
    }

    #[allow(clippy::needless_pass_by_value)]
    fn apply_replace_symbol(
        &self,
        tx: &mut Transaction,
        baseline: &WorkspaceBaseline,
        edit: &ReplaceSymbol,
        changed_files: &mut Vec<ChangedFile>,
    ) -> Result<(), PatchError> {
        // Without a tree-sitter parser, we approximate "replace symbol" by
        // finding the first occurrence of the symbol name followed by `(` or
        // `=` and replacing the smallest matching block bounded by balanced
        // braces. This is a degraded implementation; full symbol resolution
        // lives in terminus-code-intel.
        let original_hash = self.snapshot_if_existing(tx, &edit.path.relative_path)?;
        self.verify_hash(&edit.path, &edit.expected_sha256, &original_hash, baseline)?;
        let safe = SafePath::new(&edit.path.relative_path)?;
        let resolved = self.resolver.resolve_strict(&safe)?;
        let original_bytes = std::fs::read(&resolved.host.host_path)?;
        let original = String::from_utf8_lossy(&original_bytes);
        let anchor = format!("{} ", edit.symbol);
        let start = original
            .find(&anchor)
            .ok_or_else(|| PatchError::AnchorNotFound(edit.symbol.clone()))?;
        // Find the first `{` after the anchor.
        let brace_start = original[start..]
            .find('{')
            .ok_or_else(|| PatchError::AnchorNotFound(format!("body for {}", edit.symbol)))?;
        let body_start = start + brace_start;
        // Walk balanced braces.
        let mut depth = 0;
        let mut body_end = body_start;
        for (i, ch) in original[body_start..].char_indices() {
            match ch {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        body_end = body_start + i + 1;
                        break;
                    }
                }
                _ => {}
            }
        }
        if depth != 0 {
            return Err(PatchError::AnchorNotFound(format!(
                "unbalanced braces for {}",
                edit.symbol
            )));
        }
        let mut new_text = String::new();
        new_text.push_str(&original[..start]);
        new_text.push_str(&String::from_utf8_lossy(&edit.replacement_utf8));
        new_text.push_str(&original[body_end..]);
        let new_bytes = new_text.as_bytes();
        std::fs::write(&resolved.host.host_path, new_bytes)?;
        let new_hash = sha256_hex(new_bytes);
        tx.journal.push(JournalEntry::EditApplied {
            relative_path: edit.path.relative_path.clone(),
            edit: PatchEdit::ReplaceSymbol(edit.clone()),
            new_hash: new_hash.clone(),
        });
        changed_files.push(ChangedFile {
            path: edit.path.clone(),
            old_sha256: format!("sha256:{original_hash}"),
            new_sha256: format!("sha256:{new_hash}"),
            operation: "replace_symbol".to_string(),
        });
        Ok(())
    }

    #[allow(clippy::needless_pass_by_value)]
    fn apply_insert(
        &self,
        tx: &mut Transaction,
        baseline: &WorkspaceBaseline,
        edit: &InsertContent,
        changed_files: &mut Vec<ChangedFile>,
    ) -> Result<(), PatchError> {
        let original_hash = self.snapshot_if_existing(tx, &edit.path.relative_path)?;
        self.verify_hash(&edit.path, &edit.expected_sha256, &original_hash, baseline)?;
        let safe = SafePath::new(&edit.path.relative_path)?;
        let resolved = self.resolver.resolve_strict(&safe)?;
        let original_bytes = std::fs::read(&resolved.host.host_path)?;
        let original = String::from_utf8_lossy(&original_bytes).to_string();
        let anchor_idx = original
            .find(&edit.anchor)
            .ok_or_else(|| PatchError::AnchorNotFound(edit.anchor.clone()))?;
        let insert_at = match edit.position.as_str() {
            "before" => anchor_idx,
            "after" | "" => anchor_idx + edit.anchor.len(),
            other => {
                return Err(PatchError::InvalidEdit(format!(
                    "unsupported insert position `{other}`"
                )));
            }
        };
        let mut new_text = String::new();
        new_text.push_str(&original[..insert_at]);
        new_text.push_str(&String::from_utf8_lossy(&edit.content_utf8));
        new_text.push_str(&original[insert_at..]);
        let new_bytes = new_text.as_bytes();
        std::fs::write(&resolved.host.host_path, new_bytes)?;
        let new_hash = sha256_hex(new_bytes);
        tx.journal.push(JournalEntry::EditApplied {
            relative_path: edit.path.relative_path.clone(),
            edit: PatchEdit::Insert(edit.clone()),
            new_hash: new_hash.clone(),
        });
        changed_files.push(ChangedFile {
            path: edit.path.clone(),
            old_sha256: format!("sha256:{original_hash}"),
            new_sha256: format!("sha256:{new_hash}"),
            operation: "insert".to_string(),
        });
        Ok(())
    }

    fn apply_delete_range(
        &self,
        tx: &mut Transaction,
        baseline: &WorkspaceBaseline,
        edit: &DeleteRange,
        changed_files: &mut Vec<ChangedFile>,
    ) -> Result<(), PatchError> {
        let original_hash = self.snapshot_if_existing(tx, &edit.path.relative_path)?;
        self.verify_hash(&edit.path, &edit.expected_sha256, &original_hash, baseline)?;
        let safe = SafePath::new(&edit.path.relative_path)?;
        let resolved = self.resolver.resolve_strict(&safe)?;
        let original_bytes = std::fs::read(&resolved.host.host_path)?;
        let text = String::from_utf8_lossy(&original_bytes).to_string();
        let lines: Vec<&str> = text.lines().collect();
        let start = edit.range.start_line as usize;
        let end = edit.range.end_line as usize;
        if start == 0 || end == 0 || start > end || end > lines.len() {
            return Err(PatchError::InvalidEdit(format!(
                "invalid line range {}..{} (file has {} lines)",
                start,
                end,
                lines.len()
            )));
        }
        let mut new_lines: Vec<String> = lines[..start - 1].iter().map(|s| s.to_string()).collect();
        for line in &lines[end..] {
            new_lines.push(line.to_string());
        }
        let new_text = new_lines.join("\n") + "\n";
        let new_bytes = new_text.as_bytes();
        std::fs::write(&resolved.host.host_path, new_bytes)?;
        let new_hash = sha256_hex(new_bytes);
        tx.journal.push(JournalEntry::EditApplied {
            relative_path: edit.path.relative_path.clone(),
            edit: PatchEdit::DeleteRange(edit.clone()),
            new_hash: new_hash.clone(),
        });
        changed_files.push(ChangedFile {
            path: edit.path.clone(),
            old_sha256: format!("sha256:{original_hash}"),
            new_sha256: format!("sha256:{new_hash}"),
            operation: "delete_range".to_string(),
        });
        Ok(())
    }

    fn apply_move_file(
        &self,
        tx: &mut Transaction,
        baseline: &WorkspaceBaseline,
        edit: &MoveFile,
        changed_files: &mut Vec<ChangedFile>,
    ) -> Result<(), PatchError> {
        let original_hash = self.snapshot_if_existing(tx, &edit.from.relative_path)?;
        self.verify_hash(&edit.from, &edit.expected_sha256, &original_hash, baseline)?;
        let from_safe = SafePath::new(&edit.from.relative_path)?;
        let from_resolved = self.resolver.resolve_strict(&from_safe)?;
        let to_safe = SafePath::new(&edit.to.relative_path)?;
        let to_resolved = self.resolver.resolve_strict(&to_safe)?;
        if edit.target_must_not_exist && to_resolved.host.exists {
            return Err(PatchError::AlreadyExists(edit.to.relative_path.clone()));
        }
        if let Some(parent) = to_resolved.host.host_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let bytes = std::fs::read(&from_resolved.host.host_path)?;
        std::fs::write(&to_resolved.host.host_path, &bytes)?;
        std::fs::remove_file(&from_resolved.host.host_path)?;
        let new_hash = sha256_hex(&bytes);
        tx.journal.push(JournalEntry::EditApplied {
            relative_path: edit.from.relative_path.clone(),
            edit: PatchEdit::MoveFile(edit.clone()),
            new_hash: new_hash.clone(),
        });
        changed_files.push(ChangedFile {
            path: edit.from.clone(),
            old_sha256: format!("sha256:{original_hash}"),
            new_sha256: String::new(),
            operation: "move_from".to_string(),
        });
        changed_files.push(ChangedFile {
            path: edit.to.clone(),
            old_sha256: String::new(),
            new_sha256: format!("sha256:{new_hash}"),
            operation: "move_to".to_string(),
        });
        Ok(())
    }

    fn apply_delete_file(
        &self,
        tx: &mut Transaction,
        baseline: &WorkspaceBaseline,
        edit: &DeleteFile,
        changed_files: &mut Vec<ChangedFile>,
    ) -> Result<(), PatchError> {
        let original_hash = self.snapshot_if_existing(tx, &edit.path.relative_path)?;
        self.verify_hash(&edit.path, &edit.expected_sha256, &original_hash, baseline)?;
        let safe = SafePath::new(&edit.path.relative_path)?;
        let resolved = self.resolver.resolve_strict(&safe)?;
        if !resolved.host.exists {
            return Err(PatchError::PathNotFound(edit.path.relative_path.clone()));
        }
        std::fs::remove_file(&resolved.host.host_path)?;
        tx.journal.push(JournalEntry::EditApplied {
            relative_path: edit.path.relative_path.clone(),
            edit: PatchEdit::DeleteFile(edit.clone()),
            new_hash: String::new(),
        });
        changed_files.push(ChangedFile {
            path: edit.path.clone(),
            old_sha256: format!("sha256:{original_hash}"),
            new_sha256: String::new(),
            operation: "delete".to_string(),
        });
        Ok(())
    }

    #[allow(clippy::needless_pass_by_value)]
    fn apply_unified_diff(
        &self,
        _tx: &mut Transaction,
        edit: &UnifiedDiff,
        _changed_files: &mut Vec<ChangedFile>,
    ) -> Result<(), PatchError> {
        // Unified diff application requires a git worktree context. We record
        // the request but do not apply it here; this is a documented M5 gap.
        let _ = edit;
        Err(PatchError::InvalidEdit(
            "unified_diff application requires git worktree context (M5)".to_string(),
        ))
    }

    fn verify_hash(
        &self,
        path: &WorkspacePath,
        expected_sha256: &str,
        actual_hash: &str,
        baseline: &WorkspaceBaseline,
    ) -> Result<(), PatchError> {
        if expected_sha256.is_empty() {
            return Ok(());
        }
        let expected_stripped = expected_sha256
            .strip_prefix("sha256:")
            .unwrap_or(expected_sha256);
        let actual_stripped = actual_hash.strip_prefix("sha256:").unwrap_or(actual_hash);
        if expected_stripped == actual_stripped {
            return Ok(());
        }
        // Also accept the baseline's recorded hash for this path.
        if let Some(source) = baseline.sources.iter().find(|s| s.path == *path) {
            let bs = source
                .sha256
                .strip_prefix("sha256:")
                .unwrap_or(&source.sha256);
            if bs == actual_stripped {
                return Ok(());
            }
        }
        Err(PatchError::StaleSource {
            path: path.relative_path.clone(),
            expected: expected_sha256.to_string(),
            actual: format!("sha256:{actual_hash}"),
        })
    }

    fn rollback(&self, tx: &mut Transaction) -> Result<(), PatchError> {
        for (relative_path, snapshot_path) in &tx.snapshots {
            let safe = SafePath::new(relative_path)?;
            let resolved = self.resolver.resolve_strict(&safe)?;
            if Path::new(snapshot_path).exists() {
                let bytes = std::fs::read(snapshot_path)?;
                std::fs::write(&resolved.host.host_path, bytes)?;
            } else {
                // No snapshot means the file did not exist before — remove it.
                if resolved.host.exists {
                    std::fs::remove_file(&resolved.host.host_path)?;
                }
            }
        }
        Ok(())
    }

    fn acquire_leases(&self, tx_id: &str, paths: &[String]) -> Result<(), PatchError> {
        let mut guard = self
            .leases
            .lock()
            .map_err(|e| PatchError::Aborted(format!("lease mutex: {e}")))?;
        for p in paths {
            if let Some(holder) = guard.get(p) {
                if holder != tx_id {
                    return Err(PatchError::Aborted(format!(
                        "path `{p}` is locked by transaction `{holder}`"
                    )));
                }
            } else {
                guard.insert(p.clone(), tx_id.to_string());
            }
        }
        Ok(())
    }

    fn release_leases(&self, paths: &[String]) {
        if let Ok(mut guard) = self.leases.lock() {
            for p in paths {
                guard.remove(p);
            }
        }
    }
}

fn edit_target_path(edit: &PatchEdit) -> Option<&WorkspacePath> {
    match edit {
        PatchEdit::ReplaceSymbol(e) => Some(&e.path),
        PatchEdit::ReplaceRange(e) => Some(&e.path),
        PatchEdit::ReplaceExactText(e) => Some(&e.path),
        PatchEdit::Insert(e) => Some(&e.path),
        PatchEdit::DeleteRange(e) => Some(&e.path),
        PatchEdit::CreateFile(e) => Some(&e.path),
        PatchEdit::MoveFile(e) => Some(&e.from),
        PatchEdit::DeleteFile(e) => Some(&e.path),
        PatchEdit::UnifiedDiff(_) => None,
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

fn compute_dirty_digest(changed: &[ChangedFile]) -> String {
    let mut hasher = Sha256::new();
    for c in changed {
        hasher.update(c.path.relative_path.as_bytes());
        hasher.update(c.old_sha256.as_bytes());
        hasher.update(c.new_sha256.as_bytes());
        hasher.update(c.operation.as_bytes());
    }
    format!("sha256:{}", hex::encode(hasher.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;
    use terminus_kernel_protocol::{
        CreateFile, DeleteFile, InsertContent, LineRange, PatchCommitMode, PatchEdit,
        ReplaceExactText, ReplaceRange, SourceVersion, WorkspaceBaseline, WorkspacePath,
    };

    fn engine() -> (tempfile::TempDir, PatchEngine) {
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let resolver = PathResolver::new(&ws).unwrap();
        let engine = PatchEngine::new(
            resolver,
            dir.path().join("journal"),
            dir.path().join("state"),
        )
        .unwrap();
        (dir, engine)
    }

    fn ws_path(rel: &str) -> WorkspacePath {
        WorkspacePath::new("ws-1", rel)
    }

    fn baseline_for(ws_id: &str) -> WorkspaceBaseline {
        WorkspaceBaseline {
            workspace_id: ws_id.to_string(),
            repository_revision: "git:abc".to_string(),
            dirty_digest: String::new(),
            sources: Vec::new(),
        }
    }

    fn hash_of(s: &str) -> String {
        format!("sha256:{}", sha256_hex(s.as_bytes()))
    }

    #[test]
    fn create_file_applies() {
        let (dir, engine) = engine();
        let edit = PatchEdit::CreateFile(CreateFile {
            path: ws_path("hello.txt"),
            must_not_exist: true,
            content: b"hello world\n".to_vec(),
            media_type: "text/plain".to_string(),
        });
        let resp = engine
            .apply(
                "tx-1",
                &baseline_for("ws-1"),
                &[edit],
                PatchCommitMode::ApplyToWorktree,
                ValidationProfile::TaskDefault,
            )
            .unwrap();
        assert_eq!(resp.state, "applied");
        assert_eq!(resp.changed_files.len(), 1);
        let content = std::fs::read_to_string(dir.path().join("workspace/hello.txt")).unwrap();
        assert_eq!(content, "hello world\n");
    }

    #[test]
    fn create_file_rejects_existing_when_must_not_exist() {
        let (dir, engine) = engine();
        std::fs::write(dir.path().join("workspace/existing.txt"), "old").unwrap();
        let edit = PatchEdit::CreateFile(CreateFile {
            path: ws_path("existing.txt"),
            must_not_exist: true,
            content: b"new".to_vec(),
            media_type: "text/plain".to_string(),
        });
        let err = engine
            .apply(
                "tx-1",
                &baseline_for("ws-1"),
                &[edit],
                PatchCommitMode::ApplyToWorktree,
                ValidationProfile::TaskDefault,
            )
            .unwrap_err();
        assert!(matches!(err, PatchError::AlreadyExists(_)));
        // File untouched.
        let content = std::fs::read_to_string(dir.path().join("workspace/existing.txt")).unwrap();
        assert_eq!(content, "old");
    }

    #[test]
    fn replace_exact_text_applies() {
        let (dir, engine) = engine();
        std::fs::write(
            dir.path().join("workspace/code.txt"),
            "fn old() {}\nfn other() {}\n",
        )
        .unwrap();
        let original_hash = hash_of("fn old() {}\nfn other() {}\n");
        let edit = PatchEdit::ReplaceExactText(ReplaceExactText {
            path: ws_path("code.txt"),
            expected_sha256: original_hash,
            expected_utf8: b"fn old() {}".to_vec(),
            replacement_utf8: b"fn new() {}".to_vec(),
            require_unique: true,
        });
        let resp = engine
            .apply(
                "tx-1",
                &baseline_for("ws-1"),
                &[edit],
                PatchCommitMode::ApplyToWorktree,
                ValidationProfile::TaskDefault,
            )
            .unwrap();
        assert_eq!(resp.state, "applied");
        let content = std::fs::read_to_string(dir.path().join("workspace/code.txt")).unwrap();
        assert_eq!(content, "fn new() {}\nfn other() {}\n");
    }

    #[test]
    fn stale_hash_rejected() {
        let (dir, engine) = engine();
        std::fs::write(dir.path().join("workspace/code.txt"), "fn old() {}\n").unwrap();
        let edit = PatchEdit::ReplaceExactText(ReplaceExactText {
            path: ws_path("code.txt"),
            expected_sha256:
                "sha256:0000000000000000000000000000000000000000000000000000000000000000"
                    .to_string(),
            expected_utf8: b"fn old() {}".to_vec(),
            replacement_utf8: b"fn new() {}".to_vec(),
            require_unique: true,
        });
        let err = engine
            .apply(
                "tx-1",
                &baseline_for("ws-1"),
                &[edit],
                PatchCommitMode::ApplyToWorktree,
                ValidationProfile::TaskDefault,
            )
            .unwrap_err();
        assert!(matches!(err, PatchError::StaleSource { .. }));
    }

    #[test]
    fn replace_range_applies() {
        let (dir, engine) = engine();
        std::fs::write(
            dir.path().join("workspace/multi.txt"),
            "line1\nline2\nline3\nline4\n",
        )
        .unwrap();
        let original_hash = hash_of("line1\nline2\nline3\nline4\n");
        let edit = PatchEdit::ReplaceRange(ReplaceRange {
            path: ws_path("multi.txt"),
            expected_sha256: original_hash,
            range: LineRange {
                start_line: 2,
                end_line: 3,
            },
            replacement_utf8: b"replaced2\nreplaced3".to_vec(),
        });
        let resp = engine
            .apply(
                "tx-1",
                &baseline_for("ws-1"),
                &[edit],
                PatchCommitMode::ApplyToWorktree,
                ValidationProfile::TaskDefault,
            )
            .unwrap();
        assert_eq!(resp.state, "applied");
        let content = std::fs::read_to_string(dir.path().join("workspace/multi.txt")).unwrap();
        assert_eq!(content, "line1\nreplaced2\nreplaced3\nline4\n");
    }

    #[test]
    fn delete_file_applies() {
        let (dir, engine) = engine();
        std::fs::write(dir.path().join("workspace/trash.txt"), "trash").unwrap();
        let original_hash = hash_of("trash");
        let edit = PatchEdit::DeleteFile(DeleteFile {
            path: ws_path("trash.txt"),
            expected_sha256: original_hash,
        });
        let resp = engine
            .apply(
                "tx-1",
                &baseline_for("ws-1"),
                &[edit],
                PatchCommitMode::ApplyToWorktree,
                ValidationProfile::TaskDefault,
            )
            .unwrap();
        assert_eq!(resp.state, "applied");
        assert!(!dir.path().join("workspace/trash.txt").exists());
    }

    #[test]
    fn insert_after_anchor() {
        let (dir, engine) = engine();
        std::fs::write(dir.path().join("workspace/code.txt"), "fn main() {}\n").unwrap();
        let original_hash = hash_of("fn main() {}\n");
        let edit = PatchEdit::Insert(InsertContent {
            path: ws_path("code.txt"),
            expected_sha256: original_hash,
            anchor_kind: "text".to_string(),
            anchor: "fn main() {}".to_string(),
            position: "after".to_string(),
            content_utf8: b"\nfn helper() {}".to_vec(),
        });
        let _resp = engine
            .apply(
                "tx-1",
                &baseline_for("ws-1"),
                &[edit],
                PatchCommitMode::ApplyToWorktree,
                ValidationProfile::TaskDefault,
            )
            .unwrap();
        let content = std::fs::read_to_string(dir.path().join("workspace/code.txt")).unwrap();
        assert_eq!(content, "fn main() {}\nfn helper() {}\n");
    }

    #[test]
    fn rollback_on_validation_failure() {
        let (dir, engine) = engine();
        // Create an unbalanced brace content via ReplaceExactText and then
        // expect the brace_balance check to fail and roll back.
        std::fs::write(dir.path().join("workspace/code.txt"), "fn main() {}\n").unwrap();
        let original_hash = hash_of("fn main() {}\n");
        let edit = PatchEdit::ReplaceExactText(ReplaceExactText {
            path: ws_path("code.txt"),
            expected_sha256: original_hash,
            expected_utf8: b"fn main() {}".to_vec(),
            replacement_utf8: b"fn main() {".to_vec(), // unbalanced
            require_unique: true,
        });
        let err = engine
            .apply(
                "tx-1",
                &baseline_for("ws-1"),
                &[edit],
                PatchCommitMode::ApplyToWorktree,
                ValidationProfile::TaskDefault,
            )
            .unwrap_err();
        assert!(matches!(err, PatchError::ValidationFailed(_)));
        // File should be rolled back.
        let content = std::fs::read_to_string(dir.path().join("workspace/code.txt")).unwrap();
        assert_eq!(content, "fn main() {}\n");
    }

    #[test]
    fn preview_only_does_not_persist_failure() {
        let (dir, engine) = engine();
        std::fs::write(dir.path().join("workspace/code.txt"), "fn main() {}\n").unwrap();
        let original_hash = hash_of("fn main() {}\n");
        let edit = PatchEdit::ReplaceExactText(ReplaceExactText {
            path: ws_path("code.txt"),
            expected_sha256: original_hash,
            expected_utf8: b"fn main() {}".to_vec(),
            replacement_utf8: b"fn main() {".to_vec(),
            require_unique: true,
        });
        // In preview_only we don't roll back even on validation failure,
        // because we never actually committed.
        let resp = engine
            .apply(
                "tx-1",
                &baseline_for("ws-1"),
                &[edit],
                PatchCommitMode::PreviewOnly,
                ValidationProfile::TaskDefault,
            )
            .unwrap();
        assert_eq!(resp.state, "preview");
        // File should NOT be modified in preview_only — but our current
        // implementation writes then rolls back; we check that final state
        // matches the original.
        let content = std::fs::read_to_string(dir.path().join("workspace/code.txt")).unwrap();
        assert_eq!(content, "fn main() {}\n");
    }

    #[test]
    fn baseline_source_hash_accepted() {
        let (dir, engine) = engine();
        std::fs::write(dir.path().join("workspace/code.txt"), "fn old() {}\n").unwrap();
        let original_hash = hash_of("fn old() {}\n");
        let baseline = WorkspaceBaseline {
            workspace_id: "ws-1".to_string(),
            repository_revision: "git:abc".to_string(),
            dirty_digest: String::new(),
            sources: vec![SourceVersion {
                path: ws_path("code.txt"),
                sha256: original_hash.clone(),
                repository_revision: "git:abc".to_string(),
            }],
        };
        let edit = PatchEdit::ReplaceExactText(ReplaceExactText {
            path: ws_path("code.txt"),
            expected_sha256: original_hash,
            expected_utf8: b"fn old() {}".to_vec(),
            replacement_utf8: b"fn new() {}".to_vec(),
            require_unique: true,
        });
        let resp = engine
            .apply(
                "tx-1",
                &baseline,
                &[edit],
                PatchCommitMode::ApplyToWorktree,
                ValidationProfile::TaskDefault,
            )
            .unwrap();
        assert_eq!(resp.state, "applied");
    }
}

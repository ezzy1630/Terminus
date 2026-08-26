use crate::error::PatchError;
use crate::journal::{JournalEntry, JournalRecord};
use crate::unified_diff::{parse_unified_diff, target_path, HunkLine};
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
    PatchEdit, PatchResponse, ReplaceExactText, ReplaceHashline, ReplaceRange, ReplaceSymbol,
    UnifiedDiff, WorkspaceBaseline, WorkspacePath,
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
                    } else {
                        // An empty/missing snapshot records that the file did
                        // not exist before this transaction created it, so
                        // rollback must remove it.
                        if resolved.host.exists {
                            std::fs::remove_file(&resolved.host.host_path)?;
                        }
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
            PatchEdit::ReplaceHashline(e) => {
                self.apply_replace_hashline(tx, baseline, e, changed_files)
            }
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
            PatchEdit::UnifiedDiff(e) => self.apply_unified_diff(tx, baseline, e, changed_files),
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
            // Register the path with no snapshot file: if this transaction
            // creates it, rollback must remove it again instead of leaving a
            // created file behind while reporting "rolled_back".
            tx.snapshots.entry(relative_path.to_string()).or_default();
            return Ok(String::new());
        }
        let original_bytes = std::fs::read(&resolved.host.host_path)?;
        let current_hash = sha256_hex(&original_bytes);
        if tx.snapshots.contains_key(relative_path) {
            // First snapshot wins. A second edit of the same path within one
            // transaction snapshots the already-edited content; overwriting
            // the entry would leave rollback/reconcile restoring that
            // intermediate state instead of the pre-transaction state. The
            // current hash is still returned so this edit's source-hash
            // verification anchors against the content actually on disk.
            return Ok(current_hash);
        }
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
            original_hash: current_hash.clone(),
        });
        Ok(current_hash)
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
        // Created files have no prior snapshot; register an empty one so a
        // validation-failure rollback removes the file instead of leaving it.
        // First registration wins (a later edit of the same path within this
        // transaction must not replace the "did not exist" marker).
        if !tx.snapshots.contains_key(edit.path.relative_path.as_str()) {
            tx.snapshots
                .insert(edit.path.relative_path.clone(), PathBuf::new());
            tx.journal.push(JournalEntry::FileSnapshotted {
                relative_path: edit.path.relative_path.clone(),
                snapshot_path: String::new(),
                original_hash: String::new(),
            });
        }
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
        let text = String::from_utf8(original_bytes).map_err(|_| {
            PatchError::InvalidEdit(format!("{} is not valid UTF-8", edit.path.relative_path))
        })?;
        let new_text = replace_line_range(
            &text,
            edit.range.start_line as usize,
            edit.range.end_line as usize,
            Some(&String::from_utf8_lossy(&edit.replacement_utf8)),
        )?;
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

    fn apply_replace_hashline(
        &self,
        tx: &mut Transaction,
        baseline: &WorkspaceBaseline,
        edit: &ReplaceHashline,
        changed_files: &mut Vec<ChangedFile>,
    ) -> Result<(), PatchError> {
        let original_hash = self.snapshot_if_existing(tx, &edit.path.relative_path)?;
        self.verify_hash(&edit.path, &edit.expected_sha256, &original_hash, baseline)?;
        let safe = SafePath::new(&edit.path.relative_path)?;
        let resolved = self.resolver.resolve_strict(&safe)?;
        let original_bytes = std::fs::read(&resolved.host.host_path)?;
        let text = String::from_utf8(original_bytes).map_err(|_| {
            PatchError::InvalidEdit(format!("{} is not valid UTF-8", edit.path.relative_path))
        })?;

        let lines: Vec<&str> = text.lines().collect();
        let start = edit.start_line as usize;
        let end = edit.end_line as usize;
        if start < 1 || start > lines.len() || end < start || end > lines.len() {
            return Err(PatchError::AnchorStale(format!(
                "range [{start}, {end}] out of bounds for {} ({} lines)",
                edit.path.relative_path,
                lines.len()
            )));
        }

        let expected_line_count = end - start + 1;
        if edit.line_hashes.len() != expected_line_count {
            return Err(PatchError::AnchorStale(format!(
                "line hash count {} does not match range length {} for {}",
                edit.line_hashes.len(),
                expected_line_count,
                edit.path.relative_path,
            )));
        }

        // Verify each line's hash
        for (i, line_idx) in (start..=end).enumerate() {
            let line_content = lines[line_idx - 1];
            let computed_hash = compute_line_hash(line_content);
            let expected_hash = &edit.line_hashes[i];
            if !line_hash_matches(expected_hash, line_content) {
                return Err(PatchError::AnchorStale(format!(
                    "line hash mismatch at {}:{}: expected {}, got {}",
                    edit.path.relative_path, line_idx, expected_hash, computed_hash
                )));
            }
        }

        let replacement = String::from_utf8(edit.replacement_utf8.clone()).map_err(|_| {
            PatchError::InvalidEdit(format!(
                "replacement for {} is not valid UTF-8",
                edit.path.relative_path
            ))
        })?;
        let new_text = replace_line_range(&text, start, end, Some(&replacement))?;
        let new_bytes = new_text.as_bytes();
        std::fs::write(&resolved.host.host_path, new_bytes)?;
        let new_hash = sha256_hex(new_bytes);
        tx.journal.push(JournalEntry::EditApplied {
            relative_path: edit.path.relative_path.clone(),
            edit: PatchEdit::ReplaceHashline(edit.clone()),
            new_hash: new_hash.clone(),
        });
        changed_files.push(ChangedFile {
            path: edit.path.clone(),
            old_sha256: format!("sha256:{original_hash}"),
            new_sha256: format!("sha256:{new_hash}"),
            operation: "replace_hashline".to_string(),
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
        // Fail closed on non-UTF-8 sources: a lossy decode would persist
        // U+FFFD replacement characters over the original bytes.
        let expected = std::str::from_utf8(&edit.expected_utf8)
            .map_err(|_| PatchError::InvalidEdit("expected_utf8 is not valid UTF-8".to_string()))?;
        let original = String::from_utf8(original_bytes).map_err(|_| {
            PatchError::InvalidEdit(format!("{} is not valid UTF-8", edit.path.relative_path))
        })?;
        let occurrences = original.matches(expected).count();
        let replacement = std::str::from_utf8(&edit.replacement_utf8).map_err(|_| {
            PatchError::InvalidEdit(format!(
                "replacement for {} is not valid UTF-8",
                edit.path.relative_path
            ))
        })?;
        let (new_text, fallback_strategy) = if occurrences == 0 {
            // Literal anchor failed. Try tolerant resolvers (ADR-0046)
            // before failing the transaction on whitespace or indentation
            // drift between the model's expectation and the real file.
            match crate::fallback::resolve_fuzzy_anchor(&original, expected) {
                Some(matched) => {
                    let eol = crate::fallback::dominant_eol(&original);
                    // Normalize the replacement to the document's dominant
                    // line ending; span splicing preserves separators.
                    let adjusted = replacement.replace("\r\n", eol);
                    (
                        crate::fallback::splice(&original, matched, &adjusted),
                        Some(matched.strategy),
                    )
                }
                None => return Err(PatchError::AnchorNotFound(expected.to_string())),
            }
        } else if edit.require_unique && occurrences > 1 {
            return Err(PatchError::AnchorNotUnique(format!(
                "anchor found {occurrences} times"
            )));
        } else {
            (original.replacen(expected, replacement, 1), None)
        };
        let new_bytes = new_text.as_bytes();
        std::fs::write(&resolved.host.host_path, new_bytes)?;
        let new_hash = sha256_hex(new_bytes);
        tx.journal.push(JournalEntry::EditApplied {
            relative_path: edit.path.relative_path.clone(),
            edit: PatchEdit::ReplaceExactText(edit.clone()),
            new_hash: new_hash.clone(),
        });
        let operation = match fallback_strategy {
            Some(strategy) => format!(
                "replace_exact_fallback_{}",
                crate::fallback::strategy_name(strategy)
            ),
            None => "replace_exact".to_string(),
        };
        changed_files.push(ChangedFile {
            path: edit.path.clone(),
            old_sha256: format!("sha256:{original_hash}"),
            new_sha256: format!("sha256:{new_hash}"),
            operation,
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
        let original = String::from_utf8(original_bytes).map_err(|_| {
            PatchError::InvalidEdit(format!("{} is not valid UTF-8", edit.path.relative_path))
        })?;
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
        let original = String::from_utf8(original_bytes).map_err(|_| {
            PatchError::InvalidEdit(format!("{} is not valid UTF-8", edit.path.relative_path))
        })?;
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
        let text = String::from_utf8(original_bytes).map_err(|_| {
            PatchError::InvalidEdit(format!("{} is not valid UTF-8", edit.path.relative_path))
        })?;
        let new_text = replace_line_range(
            &text,
            edit.range.start_line as usize,
            edit.range.end_line as usize,
            None,
        )?;
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

    fn apply_unified_diff(
        &self,
        tx: &mut Transaction,
        baseline: &WorkspaceBaseline,
        edit: &UnifiedDiff,
        changed_files: &mut Vec<ChangedFile>,
    ) -> Result<(), PatchError> {
        // Use the strict structured parser instead of a hand-rolled scan:
        // malformed headers and hunk bodies are rejected here rather than
        // silently defaulted to line 1.
        let parsed = parse_unified_diff(&edit.diff_utf8)?;
        let target_path = target_path(&parsed);
        if target_path.is_empty() {
            return Err(PatchError::InvalidEdit(
                "unified diff has no ---/+++ target path".to_string(),
            ));
        }

        let original_hash = self.snapshot_if_existing(tx, &target_path)?;
        // A unified diff carries no expected_sha256 field; anchor it to the
        // workspace baseline instead so a file changed since the transaction's
        // baseline is rejected rather than silently overwritten.
        if let Some(source) = baseline
            .sources
            .iter()
            .find(|s| s.path.relative_path == target_path)
        {
            let bs = source
                .sha256
                .strip_prefix("sha256:")
                .unwrap_or(&source.sha256);
            let actual = original_hash
                .strip_prefix("sha256:")
                .unwrap_or(&original_hash);
            if !bs.is_empty() && bs != actual {
                return Err(PatchError::StaleSource {
                    path: target_path.clone(),
                    expected: source.sha256.clone(),
                    actual: original_hash,
                });
            }
        }
        let safe = SafePath::new(&target_path)?;
        let resolved = self.resolver.resolve_strict(&safe)?;
        let original_bytes = std::fs::read(&resolved.host.host_path)?;
        let original_text = String::from_utf8(original_bytes)
            .map_err(|_| PatchError::InvalidEdit(format!("{target_path} is not valid UTF-8")))?;

        let mut lines: Vec<String> = original_text.lines().map(ToString::to_string).collect();
        // Net line delta from earlier hunks; hunk headers address the
        // pre-diff file, so later hunks must be shifted by this amount.
        let mut line_offset: i64 = 0;

        for hunk in &parsed.hunks {
            #[allow(clippy::cast_possible_truncation, clippy::cast_possible_wrap)]
            let mut pos = {
                let start = i64::try_from(hunk.old_start).unwrap_or(i64::MAX);
                (start - 1 + line_offset).max(0) as usize
            };
            for hunk_line in &hunk.lines {
                match hunk_line {
                    HunkLine::Context { text } | HunkLine::Delete { text } => {
                        // Verify the file actually contains what the diff
                        // expects before touching it. Blind application of a
                        // drifted hunk silently corrupts unrelated lines.
                        match lines.get(pos) {
                            Some(actual) if actual == text => {}
                            other => {
                                return Err(PatchError::InvalidEdit(format!(
                                    "unified diff context mismatch at line {}: diff expects {text:?}, file has {:?}",
                                    pos + 1,
                                    other
                                )));
                            }
                        }
                        if matches!(hunk_line, HunkLine::Delete { .. }) {
                            lines.remove(pos);
                            line_offset -= 1;
                        } else {
                            pos += 1;
                        }
                    }
                    HunkLine::Add { text } => {
                        if pos > lines.len() {
                            return Err(PatchError::InvalidEdit(format!(
                                "unified diff insertion past end of file at line {}",
                                pos + 1
                            )));
                        }
                        lines.insert(pos, text.clone());
                        pos += 1;
                        line_offset += 1;
                    }
                    HunkLine::Other { raw } => {
                        // `\ No newline at end of file` markers carry no
                        // content; anything else is fail-closed.
                        if !raw.starts_with('\\') {
                            return Err(PatchError::InvalidEdit(format!(
                                "unrecognized unified diff line: {raw:?}"
                            )));
                        }
                    }
                }
            }
        }

        let newline = if original_text.contains("\r\n") {
            "\r\n"
        } else {
            "\n"
        };
        let trailing_newline = original_text.ends_with('\n');
        let new_text = if lines.is_empty() {
            String::new()
        } else {
            let mut joined = lines.join(newline);
            if trailing_newline {
                joined.push_str(newline);
            }
            joined
        };
        let new_bytes = new_text.as_bytes();
        if let Some(parent) = resolved.host.host_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&resolved.host.host_path, new_bytes)?;
        let new_hash = sha256_hex(new_bytes);
        tx.journal.push(JournalEntry::EditApplied {
            relative_path: target_path.clone(),
            edit: PatchEdit::UnifiedDiff(edit.clone()),
            new_hash: new_hash.clone(),
        });
        changed_files.push(ChangedFile {
            path: WorkspacePath {
                workspace_id: String::new(),
                relative_path: target_path,
            },
            old_sha256: format!("sha256:{original_hash}"),
            new_sha256: format!("sha256:{new_hash}"),
            operation: "unified_diff".to_string(),
        });
        Ok(())
    }

    fn verify_hash(
        &self,
        path: &WorkspacePath,
        expected_sha256: &str,
        actual_hash: &str,
        baseline: &WorkspaceBaseline,
    ) -> Result<(), PatchError> {
        // Source-hash anchoring is mandatory (crate AGENTS.md): an empty
        // expectation would silently turn a hash-anchored patch into an
        // unconditional overwrite of whatever is on disk.
        if expected_sha256.is_empty() {
            return Err(PatchError::InvalidEdit(format!(
                "edit on `{}` must specify expected_sha256",
                path.relative_path
            )));
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
        // Track what this call acquired so a partial conflict rolls back the
        // leases taken so far; otherwise they would be held until process
        // exit and block every future transaction touching those paths.
        let mut acquired: Vec<String> = Vec::new();
        for p in paths {
            let conflict = match guard.get(p) {
                Some(holder) if holder.as_str() != tx_id => Some(holder.clone()),
                Some(_) => None,
                None => {
                    guard.insert(p.clone(), tx_id.to_string());
                    acquired.push(p.clone());
                    None
                }
            };
            if let Some(holder) = conflict {
                for a in &acquired {
                    guard.remove(a);
                }
                return Err(PatchError::Aborted(format!(
                    "path `{p}` is locked by transaction `{holder}`"
                )));
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

fn edit_target_path(edit: &PatchEdit) -> Option<WorkspacePath> {
    match edit {
        PatchEdit::ReplaceSymbol(e) => Some(e.path.clone()),
        PatchEdit::ReplaceRange(e) => Some(e.path.clone()),
        PatchEdit::ReplaceHashline(e) => Some(e.path.clone()),
        PatchEdit::ReplaceExactText(e) => Some(e.path.clone()),
        PatchEdit::Insert(e) => Some(e.path.clone()),
        PatchEdit::DeleteRange(e) => Some(e.path.clone()),
        PatchEdit::CreateFile(e) => Some(e.path.clone()),
        PatchEdit::MoveFile(e) => Some(e.from.clone()),
        PatchEdit::DeleteFile(e) => Some(e.path.clone()),
        PatchEdit::UnifiedDiff(e) => {
            // Extract the same target path apply_unified_diff will use so
            // unified-diff edits participate in per-path leasing.
            let s = String::from_utf8_lossy(&e.diff_utf8);
            let mut target = String::new();
            for l in s.lines() {
                if let Some(p) = l.strip_prefix("+++ b/") {
                    target = p.to_string();
                    break;
                } else if let Some(p) = l.strip_prefix("--- a/") {
                    if target.is_empty() {
                        target = p.to_string();
                    }
                }
            }
            if target.is_empty() {
                None
            } else {
                Some(WorkspacePath::new("", target))
            }
        }
    }
}

pub fn compute_line_hash(line: &str) -> String {
    let full = sha256_hex(line.as_bytes());
    full[..8].to_string()
}

fn line_hash_matches(expected: &str, line: &str) -> bool {
    let normalized = expected
        .trim()
        .strip_prefix("sha256:")
        .unwrap_or(expected.trim())
        .to_ascii_lowercase();
    let candidates = [line.to_string(), format!("{line}\r")];
    candidates.iter().any(|candidate| {
        let short = compute_line_hash(candidate);
        let full = sha256_hex(candidate.as_bytes());
        (normalized.len() == 8 && normalized == short)
            || (normalized.len() == 64 && normalized == full)
    })
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

/// Replace (or delete, when `replacement` is `None`) the 1-based inclusive
/// line range `start..=end` while preserving the file's newline style and
/// trailing-newline state. `str::lines()` strips `\r` and the previous
/// rebuild joined with `\n` unconditionally, which rewrote every line ending
/// in a CRLF file and forced a trailing newline onto files that lacked one.
fn replace_line_range(
    text: &str,
    start: usize,
    end: usize,
    replacement: Option<&str>,
) -> Result<String, PatchError> {
    let lines: Vec<&str> = text.lines().collect();
    if start == 0 || end == 0 || start > end || end > lines.len() {
        return Err(PatchError::InvalidEdit(format!(
            "invalid line range {start}..{end} (file has {} lines)",
            lines.len()
        )));
    }
    let newline = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let trailing_newline = text.ends_with('\n');
    let mut new_lines: Vec<String> = lines[..start - 1].iter().map(ToString::to_string).collect();
    if let Some(replacement) = replacement {
        // Match the host file's line endings inside inserted content.
        let unified = replacement.replace("\r\n", "\n");
        new_lines.push(unified.replace('\n', newline));
    }
    for line in &lines[end..] {
        new_lines.push((*line).to_string());
    }
    if new_lines.is_empty() {
        return Ok(String::new());
    }
    let mut new_text = new_lines.join(newline);
    if trailing_newline {
        new_text.push_str(newline);
    }
    Ok(new_text)
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
    #[test]
    fn acquire_leases_rolls_back_partial_acquisition_on_conflict() {
        let (_dir, engine) = engine();
        {
            let mut guard = engine.leases.lock().unwrap();
            guard.insert("b.txt".to_string(), "tx-other".to_string());
        }
        let err = engine
            .acquire_leases("tx-mine", &["a.txt".to_string(), "b.txt".to_string()])
            .unwrap_err();
        assert!(err.to_string().contains("locked by transaction"));
        // The lease taken on a.txt before the conflict must have been
        // rolled back; otherwise it would be held until process exit.
        let guard = engine.leases.lock().unwrap();
        assert!(!guard.contains_key("a.txt"));
        assert!(!guard.contains_key("b.txt") || guard["b.txt"] == "tx-other");
    }
    #[test]
    fn rollback_removes_files_created_by_failed_transaction() {
        let (dir, engine) = engine();
        std::fs::write(dir.path().join("workspace/code.txt"), "fn main() {}\n").unwrap();
        let create = PatchEdit::CreateFile(CreateFile {
            path: ws_path("new_file.txt"),
            must_not_exist: true,
            content: b"created".to_vec(),
            media_type: "text/plain".to_string(),
        });
        // Second edit fails hash verification, aborting the transaction.
        let stale = PatchEdit::ReplaceExactText(ReplaceExactText {
            path: ws_path("code.txt"),
            expected_sha256: "sha256:deadbeef".to_string(),
            expected_utf8: b"fn main() {}".to_vec(),
            replacement_utf8: b"fn replaced() {}".to_vec(),
            require_unique: true,
        });
        let result = engine.apply(
            "tx-create-fail",
            &baseline_for("ws-1"),
            &[create, stale],
            PatchCommitMode::ApplyToWorktree,
            ValidationProfile::TaskDefault,
        );
        assert!(result.is_err());
        assert!(!dir.path().join("workspace/new_file.txt").exists());
        let content = std::fs::read_to_string(dir.path().join("workspace/code.txt")).unwrap();
        assert_eq!(content, "fn main() {}\n");
    }

    #[test]
    fn crash_recovery_removes_created_files() {
        let tmp = tempdir().unwrap();
        let ws = tmp.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        std::fs::write(ws.join("created.txt"), "created\n").unwrap();
        let resolver = PathResolver::new(&ws).unwrap();
        let journal_dir = tmp.path().join("journals");
        let state_dir = tmp.path().join("state");
        std::fs::create_dir_all(&state_dir).unwrap();
        let engine = PatchEngine::new(resolver, journal_dir.clone(), state_dir.clone()).unwrap();

        let mut journal = JournalRecord::new("tx-created".to_string());
        journal.push(JournalEntry::TransactionStarted {
            transaction_id: "tx-created".to_string(),
            baseline_workspace_id: "ws-1".to_string(),
            edit_count: 1,
        });
        // Empty snapshot path records that created.txt did not pre-exist.
        journal.push(JournalEntry::FileSnapshotted {
            relative_path: "created.txt".to_string(),
            snapshot_path: String::new(),
            original_hash: String::new(),
        });
        journal.write_to(&journal_dir).unwrap();

        let resp = engine.reconcile("tx-created").unwrap();
        assert_eq!(resp.state, "rolled_back");
        assert!(!ws.join("created.txt").exists());
    }
}

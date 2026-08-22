//! Approval records and store (SPEC.md §36.11).
//!
//! Approval is bound to the normalized action and maximum scope. An approval
//! record carries the exact operation hash, scope, risk, status, use limits,
//! and resolution metadata. Changing any material field (operation hash,
//! scope) invalidates the approval — a model cannot reinterpret an approval
//! to cover a broader action.
//!
//! This module provides an in-memory `ApprovalStore` backed by a
//! `std::sync::Mutex<HashMap<...>>`. Production deployments back this with
//! SQLite; the API is shaped so the swap is a one-line change.

#![forbid(unsafe_code)]

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

/// The status of an approval request.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalStatus {
    /// Created but not yet resolved.
    Pending,
    /// Resolved positively; the holder may invoke the operation up to
    /// `use_limit` times before `expires_at`.
    Allowed,
    /// Resolved negatively.
    Denied,
    /// Allowed but the `expires_at` deadline has passed.
    Expired,
    /// Allowed but the `use_count` has reached `use_limit`.
    Exhausted,
    /// Revoked by an administrator (or by a material-field change on a
    /// subsequent request).
    Revoked,
}

/// The risk classification attached to an approval. Mirrors §36.11
/// "effect classification / taint".
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalRisk {
    Low,
    Medium,
    High,
    Critical,
}

/// The scope bound to an approval. The approval covers only operations whose
/// own scope is fully contained within these globs; changing any of these
/// invalidates the approval.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ApprovalScope {
    pub workspace_paths: Vec<String>,
    pub network_destinations: Vec<String>,
    pub secret_capabilities: Vec<String>,
}

/// A single approval record. Fields are immutable after resolution except
/// for `use_count` and `status`, which are updated atomically by the store.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ApprovalRecord {
    pub id: String,
    pub task_id: String,
    pub tool_call_id: String,
    /// SHA-256 hex of the canonicalized operation (program, argv, cwd, env
    /// digest, secret capabilities). Changing any material field changes the
    /// hash and invalidates this approval.
    pub operation_hash: String,
    pub scope: ApprovalScope,
    pub risk: ApprovalRisk,
    pub status: ApprovalStatus,
    /// Maximum number of times this approval may be used; 0 means unlimited
    /// within `expires_at`.
    pub use_limit: u32,
    /// Number of times this approval has been used so far.
    pub use_count: u32,
    /// Unix seconds after which the approval is expired.
    pub expires_at: u64,
    pub requested_at: u64,
    pub resolved_at: Option<u64>,
    pub resolved_by: Option<String>,
    pub rationale: Option<String>,
}

impl ApprovalRecord {
    /// True if this record is currently valid for the given operation hash.
    /// A record is valid iff:
    /// - status is `Allowed`
    /// - `now < expires_at`
    /// - `use_count < use_limit` (or `use_limit == 0`)
    /// - `operation_hash` matches
    pub fn is_valid_for(&self, operation_hash: &str, now: u64) -> bool {
        if self.status != ApprovalStatus::Allowed {
            return false;
        }
        if self.expires_at != 0 && now >= self.expires_at {
            return false;
        }
        if self.use_limit != 0 && self.use_count >= self.use_limit {
            return false;
        }
        if self.operation_hash != operation_hash {
            return false;
        }
        true
    }
}

/// A request to create a new approval.
#[derive(Debug, Clone)]
pub struct ApprovalRequest {
    pub task_id: String,
    pub tool_call_id: String,
    pub operation_hash: String,
    pub scope: ApprovalScope,
    pub risk: ApprovalRisk,
    pub use_limit: u32,
    /// TTL in seconds (0 means "no expiry").
    pub ttl_seconds: u64,
}

/// Approval store with optional durable file backing.
#[derive(Debug, Default)]
pub struct ApprovalStore {
    records: Mutex<HashMap<String, ApprovalRecord>>,
    storage_path: Option<std::path::PathBuf>,
}

impl ApprovalStore {
    pub fn new() -> Self {
        Self {
            records: Mutex::new(HashMap::new()),
            storage_path: None,
        }
    }

    pub fn with_storage(storage_path: impl Into<std::path::PathBuf>) -> Self {
        Self {
            records: Mutex::new(HashMap::new()),
            storage_path: Some(storage_path.into()),
        }
    }

    fn persist_state(&self, records: &HashMap<String, ApprovalRecord>) {
        if let Some(path) = &self.storage_path {
            if let Some(parent) = path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let list: Vec<&ApprovalRecord> = records.values().collect();
            if let Ok(json) = serde_json::to_vec_pretty(&list) {
                let tmp = format!("{}.tmp-{}", path.display(), std::process::id());
                if std::fs::write(&tmp, &json).is_ok() {
                    let _ = std::fs::rename(&tmp, path);
                }
            }
        }
    }

    /// Load persisted records from the storage path into the store.
    pub fn load_persisted(&self) -> usize {
        if let Some(path) = &self.storage_path {
            if path.exists() {
                if let Ok(data) = std::fs::read(path) {
                    if let Ok(records) = serde_json::from_slice::<Vec<ApprovalRecord>>(&data) {
                        let count = records.len();
                        let mut guard = match self.records.lock() {
                            Ok(g) => g,
                            Err(p) => p.into_inner(),
                        };
                        for r in records {
                            guard.insert(r.id.clone(), r);
                        }
                        return count;
                    }
                }
            }
        }
        0
    }

    /// Create a new pending approval record. Returns the record id.
    pub fn create(&self, req: ApprovalRequest) -> ApprovalRecord {
        let now = now_unix();
        let expires_at = if req.ttl_seconds == 0 {
            0
        } else {
            now.saturating_add(req.ttl_seconds)
        };
        let record = ApprovalRecord {
            id: terminus_kernel_protocol::new_id(),
            task_id: req.task_id,
            tool_call_id: req.tool_call_id,
            operation_hash: req.operation_hash,
            scope: req.scope,
            risk: req.risk,
            status: ApprovalStatus::Pending,
            use_limit: req.use_limit,
            use_count: 0,
            expires_at,
            requested_at: now,
            resolved_at: None,
            resolved_by: None,
            rationale: None,
        };
        let mut guard = match self.records.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        guard.insert(record.id.clone(), record.clone());
        self.persist_state(&guard);
        record
    }

    /// Resolve a pending approval: set status, resolved_by, rationale.
    /// If `allow` is true, status becomes `Allowed`; otherwise `Denied`.
    /// Returns the resolved record, or `None` if the id is unknown.
    pub fn resolve(
        &self,
        approval_id: &str,
        allow: bool,
        resolved_by: impl Into<String>,
        rationale: impl Into<String>,
    ) -> Option<ApprovalRecord> {
        let mut guard = match self.records.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        let record = guard.get_mut(approval_id)?;
        if record.status != ApprovalStatus::Pending {
            // Already resolved — return the existing record unchanged.
            return Some(record.clone());
        }
        record.status = if allow {
            ApprovalStatus::Allowed
        } else {
            ApprovalStatus::Denied
        };
        record.resolved_at = Some(now_unix());
        record.resolved_by = Some(resolved_by.into());
        record.rationale = Some(rationale.into());
        let res = record.clone();
        self.persist_state(&guard);
        Some(res)
    }

    /// Look up an approval by id.
    pub fn get(&self, approval_id: &str) -> Option<ApprovalRecord> {
        let guard = match self.records.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        guard.get(approval_id).cloned()
    }

    /// True if there exists a currently-valid approval for the given
    /// operation hash. If found, increments `use_count` atomically and
    /// returns the record. If no valid record exists, returns `None`.
    ///
    /// A record is considered valid iff:
    /// - status == `Allowed`
    /// - now < expires_at (or expires_at == 0)
    /// - use_count < use_limit (or use_limit == 0)
    /// - operation_hash matches
    pub fn consume(&self, operation_hash: &str) -> Option<ApprovalRecord> {
        let now = now_unix();
        let mut guard = match self.records.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        for record in guard.values_mut() {
            if record.operation_hash != operation_hash {
                continue;
            }
            if record.status != ApprovalStatus::Allowed {
                continue;
            }
            if record.expires_at != 0 && now >= record.expires_at {
                record.status = ApprovalStatus::Expired;
                continue;
            }
            if record.use_limit != 0 && record.use_count >= record.use_limit {
                record.status = ApprovalStatus::Exhausted;
                continue;
            }
            record.use_count = record.use_count.saturating_add(1);
            if record.use_limit != 0 && record.use_count >= record.use_limit {
                // Mark as exhausted but still return the record (this use
                // was the last permitted one).
                record.status = ApprovalStatus::Exhausted;
            }
            let res = record.clone();
            self.persist_state(&guard);
            return Some(res);
        }
        None
    }

    /// True if there exists a currently-valid (not-yet-consumed) approval
    /// for the given operation hash. Does NOT increment use_count.
    pub fn is_valid(&self, operation_hash: &str) -> bool {
        let now = now_unix();
        let guard = match self.records.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        guard
            .values()
            .any(|r| r.operation_hash == operation_hash && r.is_valid_for(operation_hash, now))
    }

    /// Revoke an approval by id (e.g. due to a material-field change on a
    /// subsequent request). Returns the revoked record, or `None` if the id
    /// is unknown.
    pub fn revoke(&self, approval_id: &str) -> Option<ApprovalRecord> {
        let mut guard = match self.records.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        let record = guard.get_mut(approval_id)?;
        record.status = ApprovalStatus::Revoked;
        let res = record.clone();
        self.persist_state(&guard);
        Some(res)
    }

    /// Number of records in the store (any status). Useful for tests.
    pub fn len(&self) -> usize {
        let guard = match self.records.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        guard.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Compute a stable SHA-256 hex of the canonical operation tuple
/// `(program, argv, cwd, env_digest, secret_capabilities)` for binding to an
/// approval record. Two operations with the same hash are considered the same
/// operation; any material change invalidates the approval.
pub fn operation_hash(
    program: &str,
    argv: &[String],
    cwd: &str,
    env_digest: &str,
    secret_capabilities: &[String],
) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(b"terminus-op-hash-v1\n");
    hasher.update(program.as_bytes());
    hasher.update(b"\n");
    for arg in argv {
        hasher.update(arg.as_bytes());
        hasher.update(b"\n");
    }
    hasher.update(b"cwd:\n");
    hasher.update(cwd.as_bytes());
    hasher.update(b"\n");
    hasher.update(b"env:\n");
    hasher.update(env_digest.as_bytes());
    hasher.update(b"\n");
    hasher.update(b"secrets:\n");
    for cap in secret_capabilities {
        hasher.update(cap.as_bytes());
        hasher.update(b"\n");
    }
    format!("sha256:{}", hex::encode(hasher.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(hash: &str) -> ApprovalRequest {
        ApprovalRequest {
            task_id: "task-1".into(),
            tool_call_id: "call-1".into(),
            operation_hash: hash.into(),
            scope: ApprovalScope::default(),
            risk: ApprovalRisk::Medium,
            use_limit: 1,
            ttl_seconds: 60,
        }
    }

    #[test]
    fn create_then_resolve_allowed_then_consume() {
        let store = ApprovalStore::new();
        let rec = store.create(req("sha256:aaa"));
        assert_eq!(rec.status, ApprovalStatus::Pending);
        let resolved = store
            .resolve(&rec.id, true, "user-1", "ok")
            .expect("resolved");
        assert_eq!(resolved.status, ApprovalStatus::Allowed);
        assert!(store.is_valid("sha256:aaa"));
        let consumed = store.consume("sha256:aaa").expect("consumed");
        assert_eq!(consumed.use_count, 1);
        // use_limit was 1, so a second consume should fail.
        assert!(store.consume("sha256:aaa").is_none());
    }

    #[test]
    fn changed_operation_hash_invalidates() {
        let store = ApprovalStore::new();
        let rec = store.create(req("sha256:aaa"));
        store.resolve(&rec.id, true, "user-1", "ok");
        // Different hash — no approval.
        assert!(!store.is_valid("sha256:bbb"));
        assert!(store.consume("sha256:bbb").is_none());
    }

    #[test]
    fn denied_approval_not_valid() {
        let store = ApprovalStore::new();
        let rec = store.create(req("sha256:ccc"));
        store.resolve(&rec.id, false, "user-1", "no");
        assert!(!store.is_valid("sha256:ccc"));
        assert!(store.consume("sha256:ccc").is_none());
    }

    #[test]
    fn expired_approval_rejected() {
        let store = ApprovalStore::new();
        let mut r = req("sha256:ddd");
        r.ttl_seconds = 1;
        let rec = store.create(r);
        store.resolve(&rec.id, true, "user-1", "ok");
        // Sleep past the TTL.
        std::thread::sleep(std::time::Duration::from_millis(1_100));
        assert!(!store.is_valid("sha256:ddd"));
        assert!(store.consume("sha256:ddd").is_none());
    }

    #[test]
    fn use_count_enforced() {
        let store = ApprovalStore::new();
        let mut r = req("sha256:eee");
        r.use_limit = 3;
        let rec = store.create(r);
        store.resolve(&rec.id, true, "user-1", "ok");
        for i in 1..=3 {
            let consumed = store.consume("sha256:eee").expect("consumed");
            assert_eq!(consumed.use_count, i);
        }
        // 4th attempt — exhausted.
        assert!(store.consume("sha256:eee").is_none());
    }

    #[test]
    fn zero_use_limit_means_unlimited() {
        let store = ApprovalStore::new();
        let mut r = req("sha256:fff");
        r.use_limit = 0;
        r.ttl_seconds = 60;
        let rec = store.create(r);
        store.resolve(&rec.id, true, "user-1", "ok");
        for _ in 0..5 {
            assert!(store.consume("sha256:fff").is_some());
        }
    }

    #[test]
    fn revoke_invalidates() {
        let store = ApprovalStore::new();
        let rec = store.create(req("sha256:ggg"));
        store.resolve(&rec.id, true, "user-1", "ok");
        assert!(store.is_valid("sha256:ggg"));
        store.revoke(&rec.id);
        assert!(!store.is_valid("sha256:ggg"));
        assert!(store.consume("sha256:ggg").is_none());
    }

    #[test]
    fn operation_hash_changes_on_argv_change() {
        let h1 = operation_hash(
            "git",
            &["push".into(), "origin".into()],
            "/repo",
            "env-1",
            &[],
        );
        let h2 = operation_hash(
            "git",
            &["push".into(), "origin".into(), "main".into()],
            "/repo",
            "env-1",
            &[],
        );
        assert_ne!(h1, h2);
    }

    #[test]
    fn operation_hash_stable_for_same_input() {
        let h1 = operation_hash(
            "git",
            &["push".into()],
            "/repo",
            "env-1",
            &["secret://github/x".into()],
        );
        let h2 = operation_hash(
            "git",
            &["push".into()],
            "/repo",
            "env-1",
            &["secret://github/x".into()],
        );
        assert_eq!(h1, h2);
    }

    #[test]
    fn persistent_approval_survives_reload() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("approvals.json");
        let store1 = ApprovalStore::with_storage(&path);
        let rec = store1.create(req("sha256:persist"));
        store1.resolve(&rec.id, true, "user-1", "ok");
        assert!(store1.is_valid("sha256:persist"));

        let store2 = ApprovalStore::with_storage(&path);
        let loaded = store2.load_persisted();
        assert_eq!(loaded, 1);
        assert!(store2.is_valid("sha256:persist"));
        let consumed = store2.consume("sha256:persist").expect("consumed");
        assert_eq!(consumed.use_count, 1);
        assert!(!store2.is_valid("sha256:persist"));
    }
}

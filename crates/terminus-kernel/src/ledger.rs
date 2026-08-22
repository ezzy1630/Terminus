//! Transactional Effect Ledger & Authorization Store for Rust Kernel (SPEC §14, §16).
//!
//! Provides durable, crash-safe state machines for kernel effect tracking,
//! semantic idempotency verification, and authorization instance single-use consumption.

#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

/// 17-state Transactional Effect State per SPEC §16.1.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum KernelEffectState {
    Proposed,
    PolicyChecked,
    AuthorizationRequired,
    Authorized,
    Prepared,
    Dispatched,
    Observed,
    Validated,
    Committed,
    Denied,
    Cancelled,
    Uncertain,
    Reconciling,
    Compensating,
    Compensated,
    Residue,
    ManualReconcile,
}

impl KernelEffectState {
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Committed | Self::Denied | Self::Cancelled | Self::Compensated
        )
    }

    pub const fn can_transition_to(self, next: Self) -> bool {
        matches!(
            (self, next),
            (
                Self::Proposed,
                Self::PolicyChecked | Self::Denied | Self::Cancelled
            ) | (
                Self::PolicyChecked,
                Self::AuthorizationRequired | Self::Authorized | Self::Denied | Self::Cancelled,
            ) | (
                Self::AuthorizationRequired,
                Self::Authorized | Self::Denied | Self::Cancelled,
            ) | (Self::Authorized, Self::Prepared | Self::Cancelled)
                | (Self::Prepared, Self::Dispatched | Self::Cancelled)
                | (
                    Self::Dispatched,
                    Self::Observed | Self::Uncertain | Self::Cancelled,
                )
                | (
                    Self::Observed,
                    Self::Validated | Self::Compensating | Self::Uncertain,
                )
                | (Self::Validated, Self::Committed | Self::Compensating)
                | (Self::Uncertain, Self::Reconciling | Self::ManualReconcile)
                | (
                    Self::Reconciling,
                    Self::Observed
                        | Self::Validated
                        | Self::Compensating
                        | Self::ManualReconcile
                        | Self::Committed,
                )
                | (
                    Self::Compensating,
                    Self::Compensated | Self::Residue | Self::ManualReconcile,
                )
                | (Self::Residue, Self::ManualReconcile)
                | (
                    Self::ManualReconcile,
                    Self::Committed | Self::Compensated | Self::Residue,
                )
        )
    }
}

/// Durable Authorization Instance representation in the kernel.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct KernelAuthorizationInstance {
    pub id: String,
    pub principal: String,
    pub task_id: String,
    pub task_version: u32,
    pub effect_class: String,
    pub max_scope: Vec<String>,
    pub use_limit: u32,
    pub consumed_count: u32,
    pub expires_at: u64,
    pub approval_hash: Option<String>,
    pub human_approval_id: Option<String>,
}

impl KernelAuthorizationInstance {
    pub fn is_valid_for(
        &self,
        task_id: &str,
        task_version: u32,
        effect_class: &str,
        approval_hash: Option<&str>,
        now: u64,
    ) -> bool {
        if self.task_id != task_id {
            return false;
        }
        if self.task_version != task_version {
            return false;
        }
        if self.expires_at != 0 && now >= self.expires_at {
            return false;
        }
        if self.use_limit != 0 && self.consumed_count >= self.use_limit {
            return false;
        }
        if self.effect_class != effect_class && self.effect_class != "ADMIN" {
            return false;
        }
        if let (Some(expected), Some(actual)) = (self.approval_hash.as_deref(), approval_hash) {
            if expected != actual {
                return false;
            }
        }
        true
    }
}

/// Durable Effect Record representation in the kernel.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KernelEffectRecord {
    pub id: String,
    pub task_id: String,
    pub attempt_id: String,
    pub principal: String,
    pub intent_type: String,
    pub effect_class: String,
    pub semantic_idempotency_key: String,
    pub authorization_id: Option<String>,
    pub state: KernelEffectState,
    pub uncertainty_reason: Option<String>,
    pub compensation_ref: Option<String>,
    pub version: u32,
    pub created_at: u64,
    pub settled_at: Option<u64>,
}

/// Thread-safe, crash-resilient kernel Effect Ledger.
#[derive(Debug, Default)]
pub struct KernelEffectLedger {
    effects: Mutex<HashMap<String, KernelEffectRecord>>,
    semantic_index: Mutex<HashMap<String, String>>,
    authorizations: Mutex<HashMap<String, KernelAuthorizationInstance>>,
    storage_path: Option<PathBuf>,
}

impl KernelEffectLedger {
    pub fn new() -> Self {
        Self {
            effects: Mutex::new(HashMap::new()),
            semantic_index: Mutex::new(HashMap::new()),
            authorizations: Mutex::new(HashMap::new()),
            storage_path: None,
        }
    }

    pub fn with_storage(path: impl Into<PathBuf>) -> Self {
        Self {
            effects: Mutex::new(HashMap::new()),
            semantic_index: Mutex::new(HashMap::new()),
            authorizations: Mutex::new(HashMap::new()),
            storage_path: Some(path.into()),
        }
    }

    fn persist_state(
        &self,
        effects: &HashMap<String, KernelEffectRecord>,
        authzs: &HashMap<String, KernelAuthorizationInstance>,
    ) {
        if let Some(path) = &self.storage_path {
            if let Some(parent) = path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            #[derive(Serialize)]
            struct PersistedLedger<'a> {
                effects: &'a HashMap<String, KernelEffectRecord>,
                authorizations: &'a HashMap<String, KernelAuthorizationInstance>,
            }
            let payload = PersistedLedger {
                effects,
                authorizations: authzs,
            };
            if let Ok(json) = serde_json::to_vec_pretty(&payload) {
                let tmp = format!("{}.tmp-{}", path.display(), std::process::id());
                if std::fs::write(&tmp, &json).is_ok() {
                    let _ = std::fs::rename(&tmp, path);
                }
            }
        }
    }

    pub fn load_persisted(&self) -> usize {
        if let Some(path) = &self.storage_path {
            if path.exists() {
                if let Ok(data) = std::fs::read(path) {
                    #[derive(Deserialize)]
                    struct PersistedLedger {
                        effects: HashMap<String, KernelEffectRecord>,
                        authorizations: HashMap<String, KernelAuthorizationInstance>,
                    }
                    if let Ok(p) = serde_json::from_slice::<PersistedLedger>(&data) {
                        let mut e_guard = match self.effects.lock() {
                            Ok(g) => g,
                            Err(e) => e.into_inner(),
                        };
                        let mut s_guard = match self.semantic_index.lock() {
                            Ok(g) => g,
                            Err(e) => e.into_inner(),
                        };
                        let mut a_guard = match self.authorizations.lock() {
                            Ok(g) => g,
                            Err(e) => e.into_inner(),
                        };
                        let count = p.effects.len();
                        for (k, v) in p.effects {
                            s_guard.insert(v.semantic_idempotency_key.clone(), k.clone());
                            e_guard.insert(k, v);
                        }
                        *a_guard = p.authorizations;
                        return count;
                    }
                }
            }
        }
        0
    }

    pub fn register_authorization(&self, authz: KernelAuthorizationInstance) {
        let mut a_guard = match self.authorizations.lock() {
            Ok(g) => g,
            Err(e) => e.into_inner(),
        };
        a_guard.insert(authz.id.clone(), authz);
        let e_guard = match self.effects.lock() {
            Ok(g) => g,
            Err(e) => e.into_inner(),
        };
        self.persist_state(&e_guard, &a_guard);
    }

    pub fn consume_authorization(
        &self,
        authz_id: &str,
        task_id: &str,
        task_version: u32,
        effect_class: &str,
        approval_hash: Option<&str>,
    ) -> Option<KernelAuthorizationInstance> {
        let now = now_unix();
        let mut a_guard = match self.authorizations.lock() {
            Ok(g) => g,
            Err(e) => e.into_inner(),
        };
        let authz = a_guard.get_mut(authz_id)?;
        if !authz.is_valid_for(task_id, task_version, effect_class, approval_hash, now) {
            return None;
        }
        authz.consumed_count = authz.consumed_count.saturating_add(1);
        let result = authz.clone();
        let e_guard = match self.effects.lock() {
            Ok(g) => g,
            Err(e) => e.into_inner(),
        };
        self.persist_state(&e_guard, &a_guard);
        Some(result)
    }

    pub fn propose_effect(
        &self,
        task_id: &str,
        attempt_id: &str,
        principal: &str,
        intent_type: &str,
        effect_class: &str,
        semantic_idempotency_key: &str,
    ) -> KernelEffectRecord {
        let mut s_guard = match self.semantic_index.lock() {
            Ok(g) => g,
            Err(e) => e.into_inner(),
        };
        let mut e_guard = match self.effects.lock() {
            Ok(g) => g,
            Err(e) => e.into_inner(),
        };

        if let Some(existing_id) = s_guard.get(semantic_idempotency_key) {
            if let Some(existing) = e_guard.get(existing_id) {
                return existing.clone();
            }
        }

        let now = now_unix();
        let id = terminus_kernel_protocol::new_id();
        let record = KernelEffectRecord {
            id: id.clone(),
            task_id: task_id.to_string(),
            attempt_id: attempt_id.to_string(),
            principal: principal.to_string(),
            intent_type: intent_type.to_string(),
            effect_class: effect_class.to_string(),
            semantic_idempotency_key: semantic_idempotency_key.to_string(),
            authorization_id: None,
            state: KernelEffectState::Proposed,
            uncertainty_reason: None,
            compensation_ref: None,
            version: 1,
            created_at: now,
            settled_at: None,
        };

        s_guard.insert(semantic_idempotency_key.to_string(), id.clone());
        e_guard.insert(id, record.clone());

        let a_guard = match self.authorizations.lock() {
            Ok(g) => g,
            Err(e) => e.into_inner(),
        };
        self.persist_state(&e_guard, &a_guard);
        record
    }

    pub fn transition_effect(
        &self,
        effect_id: &str,
        target_state: KernelEffectState,
        authorization_id: Option<String>,
        uncertainty_reason: Option<String>,
    ) -> Result<KernelEffectRecord, String> {
        let mut e_guard = match self.effects.lock() {
            Ok(g) => g,
            Err(e) => e.into_inner(),
        };
        let effect = e_guard
            .get_mut(effect_id)
            .ok_or_else(|| format!("Effect not found: {effect_id}"))?;

        if !effect.state.can_transition_to(target_state) {
            return Err(format!(
                "Illegal effect state transition from {:?} to {:?}",
                effect.state, target_state
            ));
        }

        effect.state = target_state;
        effect.version = effect.version.saturating_add(1);
        if let Some(authz) = authorization_id {
            effect.authorization_id = Some(authz);
        }
        if let Some(reason) = uncertainty_reason {
            effect.uncertainty_reason = Some(reason);
        }
        if target_state.is_terminal() {
            effect.settled_at = Some(now_unix());
        }

        let result = effect.clone();
        let a_guard = match self.authorizations.lock() {
            Ok(g) => g,
            Err(e) => e.into_inner(),
        };
        self.persist_state(&e_guard, &a_guard);
        Ok(result)
    }

    pub fn get_effect(&self, effect_id: &str) -> Option<KernelEffectRecord> {
        let e_guard = match self.effects.lock() {
            Ok(g) => g,
            Err(e) => e.into_inner(),
        };
        e_guard.get(effect_id).cloned()
    }
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn effect_transitions_and_idempotency() {
        let ledger = KernelEffectLedger::new();
        let eff1 = ledger.propose_effect(
            "t1",
            "att1",
            "user1",
            "file.write",
            "LOCAL_FS_WRITE",
            "key-123",
        );
        assert_eq!(eff1.state, KernelEffectState::Proposed);

        // Same semantic key -> returns identical effect record
        let eff2 = ledger.propose_effect(
            "t1",
            "att1",
            "user1",
            "file.write",
            "LOCAL_FS_WRITE",
            "key-123",
        );
        assert_eq!(eff1.id, eff2.id);

        // Transition through valid pipeline
        let eff_authed = ledger
            .transition_effect(&eff1.id, KernelEffectState::PolicyChecked, None, None)
            .unwrap();
        assert_eq!(eff_authed.state, KernelEffectState::PolicyChecked);

        let eff_prep = ledger
            .transition_effect(
                &eff1.id,
                KernelEffectState::Authorized,
                Some("authz-1".into()),
                None,
            )
            .unwrap();
        assert_eq!(eff_prep.state, KernelEffectState::Authorized);

        let eff_disp = ledger
            .transition_effect(&eff1.id, KernelEffectState::Prepared, None, None)
            .unwrap();
        assert_eq!(eff_disp.state, KernelEffectState::Prepared);
        let eff_obs = ledger
            .transition_effect(&eff1.id, KernelEffectState::Dispatched, None, None)
            .unwrap();
        assert_eq!(eff_obs.state, KernelEffectState::Dispatched);
        let eff_val = ledger
            .transition_effect(&eff1.id, KernelEffectState::Observed, None, None)
            .unwrap();
        assert_eq!(eff_val.state, KernelEffectState::Observed);
        let eff_comm = ledger
            .transition_effect(&eff1.id, KernelEffectState::Validated, None, None)
            .unwrap();
        assert_eq!(eff_comm.state, KernelEffectState::Validated);
        let eff_final = ledger
            .transition_effect(&eff1.id, KernelEffectState::Committed, None, None)
            .unwrap();
        assert_eq!(eff_final.state, KernelEffectState::Committed);
        assert!(eff_final.settled_at.is_some());
    }

    #[test]
    fn authorization_consumption_and_cross_task_rejection() {
        let ledger = KernelEffectLedger::new();
        let authz = KernelAuthorizationInstance {
            id: "auth-100".to_string(),
            principal: "user-1".to_string(),
            task_id: "task-abc".to_string(),
            task_version: 1,
            effect_class: "LOCAL_FS_WRITE".to_string(),
            max_scope: vec!["src/**".to_string()],
            use_limit: 1,
            consumed_count: 0,
            expires_at: now_unix() + 3600,
            approval_hash: Some("sha256:hash1".to_string()),
            human_approval_id: None,
        };
        ledger.register_authorization(authz);

        // 1. Cross task rejection
        assert!(ledger
            .consume_authorization(
                "auth-100",
                "task-diff",
                1,
                "LOCAL_FS_WRITE",
                Some("sha256:hash1")
            )
            .is_none());

        // 2. Stale task version rejection
        assert!(ledger
            .consume_authorization(
                "auth-100",
                "task-abc",
                2,
                "LOCAL_FS_WRITE",
                Some("sha256:hash1")
            )
            .is_none());

        // 3. Altered approval hash rejection
        assert!(ledger
            .consume_authorization(
                "auth-100",
                "task-abc",
                1,
                "LOCAL_FS_WRITE",
                Some("sha256:altered")
            )
            .is_none());

        // 4. Valid single use
        let consumed = ledger
            .consume_authorization(
                "auth-100",
                "task-abc",
                1,
                "LOCAL_FS_WRITE",
                Some("sha256:hash1"),
            )
            .expect("consumed");
        assert_eq!(consumed.consumed_count, 1);

        // 5. Exhaustion rejection (use_limit was 1)
        assert!(ledger
            .consume_authorization(
                "auth-100",
                "task-abc",
                1,
                "LOCAL_FS_WRITE",
                Some("sha256:hash1")
            )
            .is_none());
    }

    #[test]
    fn persistent_ledger_survives_reload() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("effect_ledger.json");

        let ledger1 = KernelEffectLedger::with_storage(&path);
        let eff = ledger1.propose_effect(
            "t-persist",
            "att1",
            "u1",
            "exec",
            "EXEC_LOCAL",
            "idem-persist-1",
        );
        ledger1
            .transition_effect(&eff.id, KernelEffectState::PolicyChecked, None, None)
            .unwrap();

        let ledger2 = KernelEffectLedger::with_storage(&path);
        let loaded = ledger2.load_persisted();
        assert_eq!(loaded, 1);
        let reloaded = ledger2.get_effect(&eff.id).expect("loaded effect");
        assert_eq!(reloaded.state, KernelEffectState::PolicyChecked);
    }
}

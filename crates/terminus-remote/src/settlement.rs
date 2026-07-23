//! Remote cancellation and settlement. Disconnect never invents success.

use crate::error::RemoteError;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Mirrors domain `SideEffectState` for remote effect tracking.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum EffectState {
    Proposed,
    Approved,
    Started,
    Settled,
    Failed,
    Unknown,
    Reconciling,
    ManualReview,
}

/// A durable remote effect record shared by local and remote paths.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DurableEffectRecord {
    pub effect_id: String,
    pub task_id: String,
    pub workspace_id: String,
    pub kernel_identity: String,
    pub state: EffectState,
    pub execution_mode: ExecutionMode,
    pub evidence_refs: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionMode {
    Local,
    Remote,
}

#[derive(Debug, Default)]
pub struct SettlementLedger {
    effects: HashMap<String, DurableEffectRecord>,
}

impl SettlementLedger {
    pub fn insert(&mut self, record: DurableEffectRecord) -> Result<(), RemoteError> {
        if self.effects.contains_key(&record.effect_id) {
            return Err(RemoteError::Settlement(format!(
                "effect already exists: {}",
                record.effect_id
            )));
        }
        self.effects.insert(record.effect_id.clone(), record);
        Ok(())
    }

    pub fn get(&self, effect_id: &str) -> Option<&DurableEffectRecord> {
        self.effects.get(effect_id)
    }

    pub fn transition(
        &mut self,
        effect_id: &str,
        next: EffectState,
    ) -> Result<&DurableEffectRecord, RemoteError> {
        let current = self
            .effects
            .get(effect_id)
            .ok_or_else(|| RemoteError::Settlement(format!("unknown effect {effect_id}")))?
            .state;
        if !allowed_transition(current, next) {
            return Err(RemoteError::Settlement(format!(
                "illegal transition {current:?} -> {next:?}"
            )));
        }
        let entry = self
            .effects
            .get_mut(effect_id)
            .ok_or_else(|| RemoteError::Settlement(format!("unknown effect {effect_id}")))?;
        entry.state = next;
        Ok(entry)
    }

    /// On transport disconnect while Started: move to Unknown (never Settled).
    pub fn on_disconnect(&mut self, effect_id: &str) -> Result<&DurableEffectRecord, RemoteError> {
        let state = self
            .effects
            .get(effect_id)
            .ok_or_else(|| RemoteError::Settlement(format!("unknown effect {effect_id}")))?
            .state;
        match state {
            EffectState::Started => self.transition(effect_id, EffectState::Unknown),
            EffectState::Proposed | EffectState::Approved => {
                self.transition(effect_id, EffectState::Failed)
            }
            EffectState::Settled
            | EffectState::Failed
            | EffectState::Unknown
            | EffectState::ManualReview
            | EffectState::Reconciling => self
                .effects
                .get(effect_id)
                .ok_or_else(|| RemoteError::Settlement(format!("unknown effect {effect_id}"))),
        }
    }

    /// Cancel an in-flight effect. Terminal success is forbidden here.
    pub fn cancel(&mut self, effect_id: &str) -> Result<&DurableEffectRecord, RemoteError> {
        let state = self
            .effects
            .get(effect_id)
            .ok_or_else(|| RemoteError::Settlement(format!("unknown effect {effect_id}")))?
            .state;
        match state {
            EffectState::Settled => Err(RemoteError::Settlement(
                "cannot cancel a settled effect".into(),
            )),
            EffectState::Failed | EffectState::ManualReview => self
                .effects
                .get(effect_id)
                .ok_or_else(|| RemoteError::Settlement(format!("unknown effect {effect_id}"))),
            EffectState::Started | EffectState::Unknown | EffectState::Reconciling => {
                self.transition(effect_id, EffectState::ManualReview)
            }
            EffectState::Proposed | EffectState::Approved => {
                self.transition(effect_id, EffectState::Failed)
            }
        }
    }

    /// Compare local vs remote durable records for semantic equivalence.
    pub fn equivalent(local: &DurableEffectRecord, remote: &DurableEffectRecord) -> bool {
        local.effect_id == remote.effect_id
            && local.task_id == remote.task_id
            && local.workspace_id == remote.workspace_id
            && local.state == remote.state
            && local.evidence_refs == remote.evidence_refs
    }
}

fn allowed_transition(from: EffectState, to: EffectState) -> bool {
    matches!(
        (from, to),
        (EffectState::Proposed, EffectState::Approved)
            | (EffectState::Proposed, EffectState::Failed)
            | (EffectState::Approved, EffectState::Started)
            | (EffectState::Approved, EffectState::Failed)
            | (EffectState::Started, EffectState::Settled)
            | (EffectState::Started, EffectState::Failed)
            | (EffectState::Started, EffectState::Unknown)
            | (EffectState::Started, EffectState::ManualReview)
            | (EffectState::Unknown, EffectState::ManualReview)
            | (EffectState::Unknown, EffectState::Reconciling)
            | (EffectState::Unknown, EffectState::Settled)
            | (EffectState::Unknown, EffectState::Failed)
            | (EffectState::Reconciling, EffectState::Settled)
            | (EffectState::Reconciling, EffectState::Failed)
            | (EffectState::Reconciling, EffectState::ManualReview)
            | (EffectState::ManualReview, EffectState::Settled)
            | (EffectState::ManualReview, EffectState::Failed)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn started(mode: ExecutionMode) -> DurableEffectRecord {
        DurableEffectRecord {
            effect_id: "eff-1".into(),
            task_id: "task-1".into(),
            workspace_id: "ws-1".into(),
            kernel_identity: "kernel:k1".into(),
            state: EffectState::Started,
            execution_mode: mode,
            evidence_refs: vec!["artifact://sha256/aa".into()],
        }
    }

    #[test]
    fn disconnect_cannot_settle() {
        let mut ledger = SettlementLedger::default();
        ledger.insert(started(ExecutionMode::Remote)).expect("ins");
        let after = ledger.on_disconnect("eff-1").expect("disc");
        assert_eq!(after.state, EffectState::Unknown);
        assert!(ledger.transition("eff-1", EffectState::Settled).is_ok());
    }

    #[test]
    fn local_remote_equivalence_ignores_mode() {
        let mut local = started(ExecutionMode::Local);
        local.state = EffectState::Settled;
        let mut remote = started(ExecutionMode::Remote);
        remote.state = EffectState::Settled;
        assert!(SettlementLedger::equivalent(&local, &remote));
    }

    #[test]
    fn cancel_started_goes_manual_review() {
        let mut ledger = SettlementLedger::default();
        ledger.insert(started(ExecutionMode::Remote)).expect("ins");
        let after = ledger.cancel("eff-1").expect("cancel");
        assert_eq!(after.state, EffectState::ManualReview);
    }
}

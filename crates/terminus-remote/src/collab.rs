//! Collaboration roles and session handoff.

use crate::error::RemoteError;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CollaborationRole {
    Owner,
    Editor,
    Viewer,
    Auditor,
}

impl CollaborationRole {
    pub fn can_handoff(self) -> bool {
        matches!(self, Self::Owner)
    }

    pub fn can_mutate(self) -> bool {
        matches!(self, Self::Owner | Self::Editor)
    }

    pub fn can_export_audit(self) -> bool {
        matches!(self, Self::Owner | Self::Auditor)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionMembership {
    pub session_id: String,
    pub principal_id: String,
    pub role: CollaborationRole,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HandoffRecord {
    pub session_id: String,
    pub from_principal: String,
    pub to_principal: String,
    pub new_role_for_recipient: CollaborationRole,
    pub previous_owner_role: CollaborationRole,
}

#[derive(Debug, Default)]
pub struct CollaborationRegistry {
    /// session_id → principal_id → membership
    members: HashMap<String, HashMap<String, SessionMembership>>,
}

impl CollaborationRegistry {
    pub fn grant(&mut self, membership: SessionMembership) -> Result<(), RemoteError> {
        let session = self
            .members
            .entry(membership.session_id.clone())
            .or_default();
        if membership.role == CollaborationRole::Owner {
            let owners: Vec<_> = session
                .values()
                .filter(|m| m.role == CollaborationRole::Owner)
                .map(|m| m.principal_id.clone())
                .collect();
            if !owners.is_empty() && !owners.contains(&membership.principal_id) {
                return Err(RemoteError::Handoff(
                    "session already has an owner; use handoff".into(),
                ));
            }
        }
        session.insert(membership.principal_id.clone(), membership);
        Ok(())
    }

    pub fn role(&self, session_id: &str, principal_id: &str) -> Option<CollaborationRole> {
        self.members
            .get(session_id)
            .and_then(|m| m.get(principal_id))
            .map(|m| m.role)
    }

    /// Transfer ownership. Previous owner becomes Editor by default.
    pub fn handoff(
        &mut self,
        session_id: &str,
        from_principal: &str,
        to_principal: &str,
    ) -> Result<HandoffRecord, RemoteError> {
        let from_role = self.role(session_id, from_principal).ok_or_else(|| {
            RemoteError::Handoff(format!("{from_principal} is not a session member"))
        })?;
        if !from_role.can_handoff() {
            return Err(RemoteError::Handoff(
                "only the owner may hand off a session".into(),
            ));
        }
        if from_principal == to_principal {
            return Err(RemoteError::Handoff("cannot hand off to self".into()));
        }
        let session = self
            .members
            .get_mut(session_id)
            .ok_or_else(|| RemoteError::Handoff("unknown session".into()))?;

        if let Some(existing) = session.get_mut(from_principal) {
            existing.role = CollaborationRole::Editor;
        }
        session.insert(
            to_principal.to_string(),
            SessionMembership {
                session_id: session_id.to_string(),
                principal_id: to_principal.to_string(),
                role: CollaborationRole::Owner,
            },
        );
        Ok(HandoffRecord {
            session_id: session_id.to_string(),
            from_principal: from_principal.to_string(),
            to_principal: to_principal.to_string(),
            new_role_for_recipient: CollaborationRole::Owner,
            previous_owner_role: CollaborationRole::Editor,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handoff_transfers_owner() {
        let mut reg = CollaborationRegistry::default();
        reg.grant(SessionMembership {
            session_id: "s1".into(),
            principal_id: "alice".into(),
            role: CollaborationRole::Owner,
        })
        .expect("grant");
        let record = reg.handoff("s1", "alice", "bob").expect("handoff");
        assert_eq!(record.new_role_for_recipient, CollaborationRole::Owner);
        assert_eq!(reg.role("s1", "bob"), Some(CollaborationRole::Owner));
        assert_eq!(reg.role("s1", "alice"), Some(CollaborationRole::Editor));
    }

    #[test]
    fn viewer_cannot_handoff() {
        let mut reg = CollaborationRegistry::default();
        reg.grant(SessionMembership {
            session_id: "s1".into(),
            principal_id: "alice".into(),
            role: CollaborationRole::Owner,
        })
        .expect("o");
        reg.grant(SessionMembership {
            session_id: "s1".into(),
            principal_id: "carol".into(),
            role: CollaborationRole::Viewer,
        })
        .expect("v");
        assert!(reg.handoff("s1", "carol", "dave").is_err());
    }
}

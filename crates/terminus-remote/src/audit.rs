//! Audit export controls with redaction.

use crate::collab::{CollaborationRegistry, CollaborationRole};
use crate::error::RemoteError;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuditExportRequest {
    pub session_id: String,
    pub principal_id: String,
    pub include_artifacts: bool,
    pub include_secret_adjacent: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuditExportBundle {
    pub session_id: String,
    pub exported_by: String,
    pub redacted_fields: Vec<String>,
    pub payload: Value,
}

/// Redacts secret-adjacent keys and enforces role gates.
pub fn export_audit(
    collab: &CollaborationRegistry,
    request: &AuditExportRequest,
    mut payload: Value,
) -> Result<AuditExportBundle, RemoteError> {
    let role = collab
        .role(&request.session_id, &request.principal_id)
        .ok_or_else(|| RemoteError::AuditDenied("not a session member".into()))?;
    if !role.can_export_audit() {
        return Err(RemoteError::AuditDenied(format!(
            "role {role:?} cannot export audit"
        )));
    }
    let mut redacted = Vec::new();
    if !request.include_secret_adjacent {
        redact_object(&mut payload, &mut redacted);
    }
    if !request.include_artifacts {
        if let Some(obj) = payload.as_object_mut() {
            if obj.remove("artifacts").is_some() {
                redacted.push("artifacts".into());
            }
        }
    }
    // Viewers cannot export even if somehow granted — double-check Owner/Auditor.
    if matches!(role, CollaborationRole::Viewer | CollaborationRole::Editor) {
        return Err(RemoteError::AuditDenied(
            "editors and viewers cannot export audit bundles".into(),
        ));
    }
    Ok(AuditExportBundle {
        session_id: request.session_id.clone(),
        exported_by: request.principal_id.clone(),
        redacted_fields: redacted,
        payload,
    })
}

fn redact_object(value: &mut Value, redacted: &mut Vec<String>) {
    match value {
        Value::Object(map) => {
            let keys: Vec<String> = map.keys().cloned().collect();
            for key in keys {
                if is_secret_adjacent(&key) {
                    map.insert(key.clone(), Value::String("[REDACTED]".into()));
                    redacted.push(key);
                } else if let Some(child) = map.get_mut(&key) {
                    redact_object(child, redacted);
                }
            }
        }
        Value::Array(items) => {
            for item in items {
                redact_object(item, redacted);
            }
        }
        _ => {}
    }
}

fn is_secret_adjacent(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    lower.contains("secret")
        || lower.contains("password")
        || lower.contains("token")
        || lower.contains("credential")
        || lower.ends_with("_key")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::collab::SessionMembership;
    use serde_json::json;

    #[test]
    fn owner_export_redacts_secrets() {
        let mut reg = CollaborationRegistry::default();
        reg.grant(SessionMembership {
            session_id: "s1".into(),
            principal_id: "alice".into(),
            role: CollaborationRole::Owner,
        })
        .expect("grant");
        let bundle = export_audit(
            &reg,
            &AuditExportRequest {
                session_id: "s1".into(),
                principal_id: "alice".into(),
                include_artifacts: true,
                include_secret_adjacent: false,
            },
            json!({"task": "t1", "api_token": "sekrit", "nested": {"password": "x"}}),
        )
        .expect("export");
        assert!(bundle
            .redacted_fields
            .iter()
            .any(|f| f.contains("token") || f == "api_token"));
        assert_eq!(bundle.payload["api_token"], "[REDACTED]");
    }

    #[test]
    fn viewer_denied() {
        let mut reg = CollaborationRegistry::default();
        reg.grant(SessionMembership {
            session_id: "s1".into(),
            principal_id: "alice".into(),
            role: CollaborationRole::Owner,
        })
        .expect("o");
        reg.grant(SessionMembership {
            session_id: "s1".into(),
            principal_id: "v".into(),
            role: CollaborationRole::Viewer,
        })
        .expect("v");
        assert!(export_audit(
            &reg,
            &AuditExportRequest {
                session_id: "s1".into(),
                principal_id: "v".into(),
                include_artifacts: false,
                include_secret_adjacent: false,
            },
            json!({}),
        )
        .is_err());
    }
}

use crate::error::SecretError;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;

/// Metadata about a secret — never includes the raw value.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SecretMetadata {
    pub uri: String,
    pub provider: String,
    pub scope: String,
    pub issued_at_unix: u64,
    pub expires_at_unix: u64,
    pub redaction_patterns: Vec<String>,
    pub allowed_destinations: Vec<String>,
}

/// A short-lived handle to a secret value. The value is held in memory and
/// wiped (zeroed) on drop.
pub struct SecretHandle {
    pub metadata: SecretMetadata,
    value: Vec<u8>,
}

impl SecretHandle {
    pub fn value(&self) -> &[u8] {
        &self.value
    }

    /// Returns the env var name + value to inject into a child process. The
    /// caller is responsible for not logging this.
    pub fn as_env_pair(&self, var_name: &str) -> (String, String) {
        (
            var_name.to_string(),
            String::from_utf8_lossy(&self.value).to_string(),
        )
    }
}

impl Drop for SecretHandle {
    fn drop(&mut self) {
        // Best-effort wipe. We can't guarantee the compiler won't have moved
        // the bytes, but we zero what we still own.
        for byte in self.value.iter_mut() {
            *byte = 0;
        }
    }
}

impl std::fmt::Debug for SecretHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SecretHandle")
            .field("metadata", &self.metadata)
            .field("value", &"<redacted>")
            .finish()
    }
}

/// A provider trait that produces a `SecretHandle` for a URI. Production
/// deployments wire this to OAuth2, vault, etc.
pub trait SecretProvider: Send + Sync {
    fn resolve(&self, uri: &str) -> Result<SecretHandle, SecretError>;
}

/// An in-memory provider for tests. Maps `secret://provider/scope` to a
/// static value.
#[derive(Debug, Default, Clone)]
pub struct InMemoryProvider {
    entries: std::sync::Arc<Mutex<HashMap<String, Vec<u8>>>>,
}

impl InMemoryProvider {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&self, uri: impl Into<String>, value: Vec<u8>) {
        self.entries
            .lock()
            .map_err(|e| SecretError::ProviderUnavailable(format!("mutex: {e}")).to_string())
            .ok();
        if let Ok(mut g) = self.entries.lock() {
            g.insert(uri.into(), value);
        }
    }
}

impl SecretProvider for InMemoryProvider {
    fn resolve(&self, uri: &str) -> Result<SecretHandle, SecretError> {
        let guard = self
            .entries
            .lock()
            .map_err(|e| SecretError::ProviderUnavailable(format!("mutex: {e}")))?;
        let value = guard
            .get(uri)
            .ok_or_else(|| SecretError::UnknownCapability(uri.to_string()))?
            .clone();
        let (provider, scope) = parse_uri(uri)?;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        Ok(SecretHandle {
            metadata: SecretMetadata {
                uri: uri.to_string(),
                provider,
                scope,
                issued_at_unix: now,
                expires_at_unix: now + 3600,
                redaction_patterns: vec![format!("REDACTED:{}", uri)],
                allowed_destinations: Vec::new(),
            },
            value,
        })
    }
}

/// The secret broker holds a set of providers and an audit log.
#[derive(Clone)]
pub struct SecretBroker {
    providers: std::sync::Arc<Mutex<HashMap<String, std::sync::Arc<dyn SecretProvider>>>>,
    audit: std::sync::Arc<crate::audit::SecretAuditLog>,
}

impl std::fmt::Debug for SecretBroker {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SecretBroker")
            .field("providers_count", &self.providers.lock().map(|g| g.len()).unwrap_or(0))
            .field("audit", &self.audit)
            .finish()
    }
}

impl SecretBroker {
    pub fn new() -> Self {
        Self {
            providers: std::sync::Arc::new(Mutex::new(HashMap::new())),
            audit: std::sync::Arc::new(crate::audit::SecretAuditLog::new()),
        }
    }

    pub fn register_provider(&self, provider_name: &str, provider: std::sync::Arc<dyn SecretProvider>) {
        if let Ok(mut g) = self.providers.lock() {
            g.insert(provider_name.to_string(), provider);
        }
    }

    /// Request a secret. Records the use in the audit log.
    pub fn request(&self, uri: &str, requested_by: &str) -> Result<SecretHandle, SecretError> {
        let (provider_name, _scope) = parse_uri(uri)?;
        let provider = {
            let g = self
                .providers
                .lock()
                .map_err(|e| SecretError::ProviderUnavailable(format!("mutex: {e}")))?;
            g.get(&provider_name)
                .cloned()
                .ok_or_else(|| SecretError::UnknownCapability(uri.to_string()))?
        };
        let handle = provider.resolve(uri)?;
        self.audit.record_use(uri, requested_by, &handle.metadata);
        Ok(handle)
    }

    pub fn audit_log(&self) -> std::sync::Arc<crate::audit::SecretAuditLog> {
        std::sync::Arc::clone(&self.audit)
    }
}

impl Default for SecretBroker {
    fn default() -> Self {
        Self::new()
    }
}

fn parse_uri(uri: &str) -> Result<(String, String), SecretError> {
    let rest = uri
        .strip_prefix("secret://")
        .ok_or_else(|| SecretError::InvalidUri(uri.to_string()))?;
    let (provider, scope) = rest
        .split_once('/')
        .ok_or_else(|| SecretError::InvalidUri(uri.to_string()))?;
    if provider.is_empty() || scope.is_empty() {
        return Err(SecretError::InvalidUri(uri.to_string()));
    }
    Ok((provider.to_string(), scope.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_returns_handle() {
        let broker = SecretBroker::new();
        let provider = std::sync::Arc::new(InMemoryProvider::new());
        provider.register("secret://github/repo-read", b"ghp_xxx".to_vec());
        broker.register_provider("github", provider);
        let handle = broker
            .request("secret://github/repo-read", "task-1")
            .unwrap();
        assert_eq!(handle.value(), b"ghp_xxx");
    }

    #[test]
    fn unknown_uri_rejected() {
        let broker = SecretBroker::new();
        let provider = std::sync::Arc::new(InMemoryProvider::new());
        broker.register_provider("github", provider);
        let err = broker
            .request("secret://github/missing", "task-1")
            .unwrap_err();
        assert!(matches!(err, SecretError::UnknownCapability(_)));
    }

    #[test]
    fn audit_log_records_use() {
        let broker = SecretBroker::new();
        let provider = std::sync::Arc::new(InMemoryProvider::new());
        provider.register("secret://github/repo-read", b"ghp_xxx".to_vec());
        broker.register_provider("github", provider);
        let _handle = broker
            .request("secret://github/repo-read", "task-1")
            .unwrap();
        let log = broker.audit_log();
        let entries = log.entries();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].uri, "secret://github/repo-read");
        assert_eq!(entries[0].requested_by, "task-1");
    }

    #[test]
    fn secret_handle_debug_does_not_leak_value() {
        let broker = SecretBroker::new();
        let provider = std::sync::Arc::new(InMemoryProvider::new());
        provider.register("secret://github/repo-read", b"ghp_xxx".to_vec());
        broker.register_provider("github", provider);
        let handle = broker
            .request("secret://github/repo-read", "task-1")
            .unwrap();
        let s = format!("{handle:?}");
        assert!(s.contains("<redacted>"));
        assert!(!s.contains("ghp_xxx"));
    }
}

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
///
/// ADR-0035 §1: raw-value access is crate-private. The only sanctioned
/// consumer outside this crate is the L7 connector broker
/// (`terminus-connector`), via [`SecretHandle::http_header_pair`], which
/// injects the credential into the exact bound request. Models, tools,
/// artifacts, and logs never receive the material.
pub struct SecretHandle {
    pub metadata: SecretMetadata,
    value: Vec<u8>,
}

impl SecretHandle {
    pub(crate) fn from_value(metadata: SecretMetadata, value: Vec<u8>) -> Self {
        Self { metadata, value }
    }

    /// SHA-256 digest of the credential material. Safe to persist with the
    /// grant claims; reveals nothing about the value.
    pub fn digest(&self) -> String {
        crate::grant::credential_digest(&self.value)
    }

    /// Build an HTTP header pair injecting the credential. This accessor is
    /// part of the Phase-4 trusted computing base (ADR-0035): the ONLY
    /// sanctioned caller is the L7 connector broker while executing the
    /// grant-bound request. The returned pair MUST be placed directly into
    /// the outgoing request and MUST NOT be logged, serialized, or stored.
    pub fn http_header_pair(&self, auth_scheme: &str) -> Result<(String, String), SecretError> {
        let value = String::from_utf8(self.value.clone())
            .map_err(|_| SecretError::InvalidGrant("credential is not valid UTF-8".into()))?;
        Ok((
            "Authorization".to_string(),
            format!("{auth_scheme} {value}"),
        ))
    }

    /// Build a named-header pair for APIs that use a custom key header
    /// (e.g. `X-Api-Key`). Same trusted-connector-only contract as
    /// [`SecretHandle::http_header_pair`].
    pub fn named_header_pair(&self, header_name: &str) -> Result<(String, String), SecretError> {
        if header_name.eq_ignore_ascii_case("authorization") {
            return self.http_header_pair("Bearer");
        }
        let value = String::from_utf8(self.value.clone())
            .map_err(|_| SecretError::InvalidGrant("credential is not valid UTF-8".into()))?;
        Ok((header_name.to_string(), value))
    }

    /// Replace the in-memory bytes with zeros.
    fn wipe(&mut self) {
        for byte in self.value.iter_mut() {
            *byte = 0;
        }
    }
}

impl Drop for SecretHandle {
    fn drop(&mut self) {
        // Best-effort wipe. We can't guarantee the compiler won't have moved
        // the bytes, but we zero what we still own.
        self.wipe();
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
/// deployments wire this to workload identities, OAuth2 token exchange, or
/// vault dynamic credentials (SPEC §17.2).
pub trait SecretProvider: Send + Sync {
    fn resolve(&self, uri: &str) -> Result<SecretHandle, SecretError>;
}

/// A production provider that can persist and remove credentials. Writes are
/// accepted only through the privileged kernel SecretService.
pub trait WritableSecretProvider: SecretProvider {
    fn store(&self, uri: &str, value: &[u8]) -> Result<(), SecretError>;
    fn delete(&self, uri: &str) -> Result<(), SecretError>;
}

/// **Fixture-only** in-memory provider (maturity: `fixture`, ADR-0035 §1).
/// Maps `secret://provider/scope` to a static value. Production wiring MUST
/// use a provider that mints short-lived, operation-scoped credentials;
/// registering this provider in a production kernel configuration is a
/// conformance violation.
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

impl WritableSecretProvider for InMemoryProvider {
    fn store(&self, uri: &str, value: &[u8]) -> Result<(), SecretError> {
        parse_uri(uri)?;
        self.entries
            .lock()
            .map_err(|error| SecretError::ProviderUnavailable(format!("mutex: {error}")))?
            .insert(uri.to_string(), value.to_vec());
        Ok(())
    }

    fn delete(&self, uri: &str) -> Result<(), SecretError> {
        parse_uri(uri)?;
        self.entries
            .lock()
            .map_err(|error| SecretError::ProviderUnavailable(format!("mutex: {error}")))?
            .remove(uri);
        Ok(())
    }
}

#[derive(Clone)]
pub struct SecretBroker {
    providers: std::sync::Arc<Mutex<HashMap<String, std::sync::Arc<dyn SecretProvider>>>>,
    writable_providers:
        std::sync::Arc<Mutex<HashMap<String, std::sync::Arc<dyn WritableSecretProvider>>>>,
    revocations: std::sync::Arc<Mutex<std::collections::HashSet<String>>>,
    audit: std::sync::Arc<crate::audit::SecretAuditLog>,
}

impl std::fmt::Debug for SecretBroker {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SecretBroker")
            .field(
                "providers_count",
                &self.providers.lock().map(|g| g.len()).unwrap_or(0),
            )
            .field(
                "revocations_count",
                &self.revocations.lock().map(|g| g.len()).unwrap_or(0),
            )
            .field("audit", &self.audit)
            .finish()
    }
}

impl SecretBroker {
    pub fn new() -> Self {
        Self {
            providers: std::sync::Arc::new(Mutex::new(HashMap::new())),
            writable_providers: std::sync::Arc::new(Mutex::new(HashMap::new())),
            revocations: std::sync::Arc::new(Mutex::new(std::collections::HashSet::new())),
            audit: std::sync::Arc::new(crate::audit::SecretAuditLog::new()),
        }
    }

    pub fn register_provider(
        &self,
        provider_name: &str,
        provider: std::sync::Arc<dyn SecretProvider>,
    ) {
        if let Ok(mut g) = self.providers.lock() {
            g.insert(provider_name.to_string(), provider);
        }
    }

    pub fn register_writable_provider(
        &self,
        provider_name: &str,
        provider: std::sync::Arc<dyn WritableSecretProvider>,
    ) {
        if let Ok(mut providers) = self.providers.lock() {
            providers.insert(provider_name.to_string(), provider.clone());
        }
        if let Ok(mut providers) = self.writable_providers.lock() {
            providers.insert(provider_name.to_string(), provider);
        }
    }

    pub fn store(&self, uri: &str, value: &[u8]) -> Result<(), SecretError> {
        let (provider_name, _scope) = parse_uri(uri)?;
        let provider = self
            .writable_providers
            .lock()
            .map_err(|error| SecretError::ProviderUnavailable(format!("mutex: {error}")))?
            .get(&provider_name)
            .cloned()
            .ok_or_else(|| SecretError::UnknownCapability(uri.to_string()))?;
        provider.store(uri, value)
    }

    pub fn delete(&self, uri: &str) -> Result<(), SecretError> {
        let (provider_name, _scope) = parse_uri(uri)?;
        let provider = self
            .writable_providers
            .lock()
            .map_err(|error| SecretError::ProviderUnavailable(format!("mutex: {error}")))?
            .get(&provider_name)
            .cloned()
            .ok_or_else(|| SecretError::UnknownCapability(uri.to_string()))?;
        provider.delete(uri)
    }

    pub fn revoke(&self, uri: &str) {
        if let Ok(mut g) = self.revocations.lock() {
            g.insert(uri.to_string());
        }
    }

    pub fn is_revoked(&self, uri: &str) -> bool {
        self.revocations
            .lock()
            .map(|g| g.contains(uri))
            .unwrap_or(false)
    }

    /// Request a secret. Records the use in the audit log.
    pub fn request(&self, uri: &str, requested_by: &str) -> Result<SecretHandle, SecretError> {
        if self.is_revoked(uri) {
            return Err(SecretError::CapabilityRevoked(uri.to_string()));
        }
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
    fn request_returns_metadata_only_handle() {
        let broker = SecretBroker::new();
        let provider = std::sync::Arc::new(InMemoryProvider::new());
        provider.register("secret://github/repo-read", b"ghp_xxx".to_vec());
        broker.register_provider("github", provider);
        let handle = broker
            .request("secret://github/repo-read", "task-1")
            .unwrap();
        assert_eq!(handle.metadata.uri, "secret://github/repo-read");
    }

    #[test]
    fn digest_is_stable_and_value_free() {
        let broker = SecretBroker::new();
        let provider = std::sync::Arc::new(InMemoryProvider::new());
        provider.register("secret://github/repo-read", b"ghp_xxx".to_vec());
        broker.register_provider("github", provider);
        let handle = broker
            .request("secret://github/repo-read", "task-1")
            .unwrap();
        let digest = handle.digest();
        assert!(!digest.contains("ghp"));
        assert_eq!(digest.len(), 64);
    }

    #[test]
    fn header_pair_injects_scheme() {
        let broker = SecretBroker::new();
        let provider = std::sync::Arc::new(InMemoryProvider::new());
        provider.register("secret://github/repo-read", b"ghp_xxx".to_vec());
        broker.register_provider("github", provider);
        let handle = broker
            .request("secret://github/repo-read", "task-1")
            .unwrap();
        let (name, value) = handle.http_header_pair("Bearer").unwrap();
        assert_eq!(name, "Authorization");
        assert_eq!(value, "Bearer ghp_xxx");
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

    #[test]
    fn test_revocation_rejects_request() {
        let broker = SecretBroker::new();
        let provider = std::sync::Arc::new(InMemoryProvider::new());
        provider.register("secret://github/repo-read", b"ghp_xxx".to_vec());
        broker.register_provider("github", provider);
        broker.revoke("secret://github/repo-read");
        let err = broker
            .request("secret://github/repo-read", "task-1")
            .unwrap_err();
        assert!(matches!(err, SecretError::CapabilityRevoked(_)));
    }

    #[test]
    fn writable_provider_round_trip_stays_behind_broker() {
        let broker = SecretBroker::new();
        let provider = std::sync::Arc::new(InMemoryProvider::new());
        broker.register_writable_provider("opencode", provider);
        broker
            .store("secret://opencode/zen", b"opaque-test-value")
            .unwrap();
        let handle = broker.request("secret://opencode/zen", "task-1").unwrap();
        assert_eq!(handle.digest().len(), 64);
        assert!(!format!("{handle:?}").contains("opaque-test-value"));
        drop(handle);
        broker.delete("secret://opencode/zen").unwrap();
        assert!(broker.request("secret://opencode/zen", "task-1").is_err());
    }
}

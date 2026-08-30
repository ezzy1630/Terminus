use crate::cache::SecretCache;
use crate::error::SecretError;
use crate::namespace::unix_time;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

/// Wall-clock ceiling on one credential resolve.
///
/// A resolve is synchronous host work: on macOS it ends in
/// `SecKeychainFindGenericPassword`, which blocks until the user answers a
/// `SecurityAgent` prompt when the calling binary's code identity is not on the
/// keychain item's ACL — a certainty for an ad-hoc-signed dev build, which
/// gets a fresh identity on every rebuild. Left unbounded on a tokio worker
/// that parks the runtime thread and the control plane's 30 s unary deadline
/// fires with `DEADLINE_EXCEEDED` and no explanation.
///
/// 15 s sits below that deadline with room for the rest of a mint, so the
/// caller sees the actionable message in [`SecretError::ResolveTimeout`]
/// instead of a timeout with no cause.
pub const SECRET_RESOLVE_TIMEOUT: Duration = Duration::from_secs(15);

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

/// Metadata-only result of probing a credential store. This deliberately
/// distinguishes an absent entry from an unavailable provider so callers do
/// not turn keychain, backend, or policy failures into false absence.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SecretPresence {
    Present,
    Missing,
    Unavailable,
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
    /// Resolved-credential cache. Collapses the two provider reads one
    /// request makes (mint + execute) into one; see [`crate::cache`].
    cache: std::sync::Arc<SecretCache>,
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
            cache: std::sync::Arc::new(SecretCache::new()),
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
        // Invalidate before AND after the write: before, so a concurrent
        // reader cannot re-populate the old value from a resolve that was
        // already in flight when the write landed; after, so the entry is
        // gone even if the write failed part-way.
        self.cache.invalidate(uri);
        let result = provider.store(uri, value);
        self.cache.invalidate(uri);
        result
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
        self.cache.invalidate(uri);
        let result = provider.delete(uri);
        self.cache.invalidate(uri);
        result
    }

    /// Probe a secret capability without returning or caching its bytes.
    ///
    /// The provider resolves into a kernel-owned [`SecretHandle`] which is
    /// immediately dropped. Only an explicit unknown entry is `Missing`;
    /// provider, policy, keychain, and backend failures are `Unavailable`.
    pub fn inspect(&self, uri: &str) -> Result<SecretPresence, SecretError> {
        if self.is_revoked(uri) {
            return Ok(SecretPresence::Unavailable);
        }
        let (provider_name, _scope) = parse_uri(uri)?;
        let provider = {
            let providers = self
                .providers
                .lock()
                .map_err(|error| SecretError::ProviderUnavailable(format!("mutex: {error}")))?;
            providers.get(&provider_name).cloned()
        };
        let Some(provider) = provider else {
            return Ok(SecretPresence::Unavailable);
        };
        match provider.resolve(uri) {
            Ok(_handle) => Ok(SecretPresence::Present),
            Err(SecretError::UnknownCapability(_)) => Ok(SecretPresence::Missing),
            Err(_error) => Ok(SecretPresence::Unavailable),
        }
    }

    /// Bounded metadata-only probe for async transports. Keychain providers
    /// may block behind an OS prompt, so never run this resolve on a tokio
    /// worker thread.
    pub async fn inspect_async(&self, uri: &str) -> Result<SecretPresence, SecretError> {
        let broker = self.clone();
        let owned_uri = uri.to_string();
        let resolve = tokio::task::spawn_blocking(move || broker.inspect(&owned_uri));
        match tokio::time::timeout(SECRET_RESOLVE_TIMEOUT, resolve).await {
            Ok(Ok(result)) => result,
            Ok(Err(join_error)) => Err(SecretError::ProviderUnavailable(format!(
                "secret inspect task failed: {join_error}"
            ))),
            Err(_elapsed) => Ok(SecretPresence::Unavailable),
        }
    }

    pub fn revoke(&self, uri: &str) {
        if let Ok(mut g) = self.revocations.lock() {
            g.insert(uri.to_string());
        }
        // A revoked URI must not survive in the cache: `request` refuses it,
        // but nothing should still be holding its bytes.
        self.cache.invalidate(uri);
    }

    pub fn is_revoked(&self, uri: &str) -> bool {
        self.revocations
            .lock()
            .map(|g| g.contains(uri))
            .unwrap_or(false)
    }

    /// Request a secret **synchronously**. Records the use in the audit log.
    ///
    /// This blocks the calling thread for as long as the provider takes.
    /// Async callers MUST use [`SecretBroker::request_async`]: a keychain
    /// provider can park for minutes behind an OS approval prompt, and
    /// parking a tokio worker thread there stalls unrelated work on the same
    /// runtime.
    pub fn request(&self, uri: &str, requested_by: &str) -> Result<SecretHandle, SecretError> {
        let provider = match self.begin_request(uri)? {
            RequestStep::Cached(handle) => {
                self.audit.record_use(uri, requested_by, &handle.metadata);
                return Ok(handle);
            }
            RequestStep::Resolve(provider) => provider,
        };
        let handle = provider.resolve(uri)?;
        self.finish_request(uri, requested_by, &handle);
        Ok(handle)
    }

    /// Request a secret from an async context.
    ///
    /// A cache hit never leaves the calling task. A miss runs the provider's
    /// synchronous resolve on the blocking pool under
    /// [`SECRET_RESOLVE_TIMEOUT`], so the async runtime keeps making progress
    /// while an OS keychain prompt is on screen, and the caller gets an
    /// actionable [`SecretError::ResolveTimeout`] instead of a bare deadline.
    ///
    /// # Errors
    /// Propagates the provider's own failure, or returns
    /// [`SecretError::ResolveTimeout`] when the resolve does not complete in
    /// time. The abandoned resolve is left to finish on the blocking pool —
    /// it cannot be cancelled — and its handle is dropped (and wiped) there.
    pub async fn request_async(
        &self,
        uri: &str,
        requested_by: &str,
    ) -> Result<SecretHandle, SecretError> {
        self.request_with_timeout(uri, requested_by, SECRET_RESOLVE_TIMEOUT)
            .await
    }

    /// [`Self::request_async`] with an explicit ceiling. Production callers
    /// use `request_async`; this exists so the ceiling itself is testable
    /// without a 15 s test.
    ///
    /// # Errors
    /// See [`Self::request_async`].
    pub async fn request_with_timeout(
        &self,
        uri: &str,
        requested_by: &str,
        timeout: Duration,
    ) -> Result<SecretHandle, SecretError> {
        let provider = match self.begin_request(uri)? {
            RequestStep::Cached(handle) => {
                self.audit.record_use(uri, requested_by, &handle.metadata);
                return Ok(handle);
            }
            RequestStep::Resolve(provider) => provider,
        };
        let owned_uri = uri.to_string();
        let resolve = tokio::task::spawn_blocking(move || provider.resolve(&owned_uri));
        let handle = match tokio::time::timeout(timeout, resolve).await {
            Ok(Ok(resolved)) => resolved?,
            Ok(Err(join_error)) => {
                return Err(SecretError::ProviderUnavailable(format!(
                    "secret resolve task failed: {join_error}"
                )));
            }
            Err(_elapsed) => {
                tracing::warn!(
                    target: "terminus_kernel_audit",
                    event = "secret.resolve_timeout",
                    secret_uri = %uri,
                    requested_by = %requested_by,
                    timeout_secs = timeout.as_secs(),
                    "credential resolve exceeded its ceiling; an OS keychain prompt is \
                     probably waiting for approval"
                );
                return Err(SecretError::ResolveTimeout {
                    uri: uri.to_string(),
                    timeout_secs: timeout.as_secs(),
                });
            }
        };
        self.finish_request(uri, requested_by, &handle);
        Ok(handle)
    }

    /// Revocation check, URI parse, provider lookup, and cache probe — the
    /// part [`Self::request`] and [`Self::request_async`] share.
    fn begin_request(&self, uri: &str) -> Result<RequestStep, SecretError> {
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
        // The provider must exist before a cache hit is honoured: a URI whose
        // provider was unregistered is not resolvable, cached or not.
        if let Some(handle) = self.cache.get(uri, unix_time()?) {
            return Ok(RequestStep::Cached(handle));
        }
        Ok(RequestStep::Resolve(provider))
    }

    /// Cache the resolved credential and record the use. The audit entry is
    /// written on every request, cache hit or miss.
    fn finish_request(&self, uri: &str, requested_by: &str, handle: &SecretHandle) {
        if let Ok(now) = unix_time() {
            self.cache.insert(&handle.metadata, &handle.value, now);
        }
        self.audit.record_use(uri, requested_by, &handle.metadata);
    }

    pub fn audit_log(&self) -> std::sync::Arc<crate::audit::SecretAuditLog> {
        std::sync::Arc::clone(&self.audit)
    }
}

/// Outcome of the shared pre-resolve steps.
enum RequestStep {
    /// A live cached credential; no provider call is needed.
    Cached(SecretHandle),
    /// The registered provider to resolve through.
    Resolve(std::sync::Arc<dyn SecretProvider>),
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
    fn inspect_distinguishes_present_missing_and_unavailable() {
        let broker = SecretBroker::new();
        let provider = std::sync::Arc::new(InMemoryProvider::new());
        provider.register("secret://fixture/present", b"fixture-value".to_vec());
        broker.register_provider("fixture", provider);

        assert_eq!(
            broker.inspect("secret://fixture/present").unwrap(),
            SecretPresence::Present
        );
        assert_eq!(
            broker.inspect("secret://fixture/missing").unwrap(),
            SecretPresence::Missing
        );
        assert_eq!(
            broker.inspect("secret://unregistered/value").unwrap(),
            SecretPresence::Unavailable,
            "an absent backend is not authoritative absence"
        );
    }

    #[derive(Debug)]
    struct UnavailableProvider;

    impl SecretProvider for UnavailableProvider {
        fn resolve(&self, _uri: &str) -> Result<SecretHandle, SecretError> {
            Err(SecretError::ProviderUnavailable(
                "fixture backend unavailable".to_string(),
            ))
        }
    }

    #[test]
    fn inspect_maps_backend_failure_to_unavailable_without_exposing_bytes() {
        let broker = SecretBroker::new();
        broker.register_provider("fixture", std::sync::Arc::new(UnavailableProvider));

        assert_eq!(
            broker.inspect("secret://fixture/value").unwrap(),
            SecretPresence::Unavailable
        );
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

    // ---------- resolve cache + non-blocking resolve ----------

    /// Counts resolves and controls how long each one takes and how long the
    /// lease it hands back is valid for.
    #[derive(Debug)]
    struct ProbeProvider {
        value: Vec<u8>,
        lease_secs: u64,
        delay: Duration,
        resolves: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    }

    impl ProbeProvider {
        fn new(value: &[u8], lease_secs: u64) -> Self {
            Self {
                value: value.to_vec(),
                lease_secs,
                delay: Duration::ZERO,
                resolves: std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            }
        }

        fn with_delay(mut self, delay: Duration) -> Self {
            self.delay = delay;
            self
        }

        fn counter(&self) -> std::sync::Arc<std::sync::atomic::AtomicUsize> {
            std::sync::Arc::clone(&self.resolves)
        }
    }

    impl SecretProvider for ProbeProvider {
        fn resolve(&self, uri: &str) -> Result<SecretHandle, SecretError> {
            self.resolves
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if !self.delay.is_zero() {
                std::thread::sleep(self.delay);
            }
            let now = unix_time()?;
            let (provider, scope) = parse_uri(uri)?;
            Ok(SecretHandle::from_value(
                SecretMetadata {
                    uri: uri.to_string(),
                    provider,
                    scope,
                    issued_at_unix: now,
                    expires_at_unix: now.saturating_add(self.lease_secs),
                    redaction_patterns: Vec::new(),
                    allowed_destinations: Vec::new(),
                },
                self.value.clone(),
            ))
        }
    }

    const PROBE_URI: &str = "secret://fixture/probe";

    #[test]
    fn second_request_inside_the_lease_is_served_from_cache() {
        let broker = SecretBroker::new();
        let provider = ProbeProvider::new(b"probe-value", 300);
        let resolves = provider.counter();
        broker.register_provider("fixture", std::sync::Arc::new(provider));

        let first = broker.request(PROBE_URI, "task-1").unwrap();
        let second = broker.request(PROBE_URI, "task-1").unwrap();
        assert_eq!(resolves.load(std::sync::atomic::Ordering::SeqCst), 1);
        // Same material, so the grant digest pinned at mint time still
        // matches the header injected at execute time.
        assert_eq!(first.digest(), second.digest());
        // The audit log records each use, not each resolve.
        assert_eq!(broker.audit_log().entries().len(), 2);
    }

    #[test]
    fn expired_lease_forces_a_fresh_resolve() {
        let broker = SecretBroker::new();
        // A zero-second lease is already elapsed when it is handed back.
        let provider = ProbeProvider::new(b"probe-value", 0);
        let resolves = provider.counter();
        broker.register_provider("fixture", std::sync::Arc::new(provider));

        broker.request(PROBE_URI, "task-1").unwrap();
        broker.request(PROBE_URI, "task-1").unwrap();
        assert_eq!(resolves.load(std::sync::atomic::Ordering::SeqCst), 2);
    }

    #[test]
    fn store_invalidates_the_cached_value() {
        let broker = SecretBroker::new();
        let provider = std::sync::Arc::new(InMemoryProvider::new());
        broker.register_writable_provider("opencode", provider);
        broker
            .store("secret://opencode/zen", b"first-value")
            .unwrap();
        let first = broker.request("secret://opencode/zen", "task-1").unwrap();
        broker
            .store("secret://opencode/zen", b"second-value")
            .unwrap();
        let second = broker.request("secret://opencode/zen", "task-1").unwrap();
        assert_ne!(
            first.digest(),
            second.digest(),
            "a rotated credential must not be served from cache"
        );
    }

    #[test]
    fn delete_invalidates_the_cached_value() {
        let broker = SecretBroker::new();
        let provider = std::sync::Arc::new(InMemoryProvider::new());
        broker.register_writable_provider("opencode", provider);
        broker
            .store("secret://opencode/zen", b"first-value")
            .unwrap();
        broker.request("secret://opencode/zen", "task-1").unwrap();
        broker.delete("secret://opencode/zen").unwrap();
        assert!(broker.request("secret://opencode/zen", "task-1").is_err());
    }

    #[test]
    fn revoke_invalidates_the_cached_value() {
        let broker = SecretBroker::new();
        let provider = ProbeProvider::new(b"probe-value", 300);
        broker.register_provider("fixture", std::sync::Arc::new(provider));
        broker.request(PROBE_URI, "task-1").unwrap();
        broker.revoke(PROBE_URI);
        let error = broker.request(PROBE_URI, "task-1").unwrap_err();
        assert!(matches!(error, SecretError::CapabilityRevoked(_)));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 1)]
    async fn async_request_passes_a_fast_provider_through() {
        let broker = SecretBroker::new();
        let provider = ProbeProvider::new(b"probe-value", 300);
        let resolves = provider.counter();
        broker.register_provider("fixture", std::sync::Arc::new(provider));

        let handle = broker.request_async(PROBE_URI, "task-1").await.unwrap();
        assert_eq!(handle.metadata.uri, PROBE_URI);
        // The second request never reaches the provider at all.
        let cached = broker.request_async(PROBE_URI, "task-1").await.unwrap();
        assert_eq!(handle.digest(), cached.digest());
        assert_eq!(resolves.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert_eq!(broker.audit_log().entries().len(), 2);
    }

    /// A provider that blocks longer than the ceiling must yield the
    /// actionable error, and the single-worker runtime must keep scheduling
    /// other tasks the whole time it is blocked.
    #[tokio::test(flavor = "multi_thread", worker_threads = 1)]
    async fn async_request_times_out_without_stalling_the_runtime() {
        let broker = SecretBroker::new();
        let provider = ProbeProvider::new(b"probe-value", 300)
            // An order of magnitude past the (test-shortened) ceiling below,
            // and short enough that the abandoned blocking task does not hold
            // the test binary open.
            .with_delay(Duration::from_secs(1));
        broker.register_provider("fixture", std::sync::Arc::new(provider));

        let ticks = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let ticker = {
            let ticks = std::sync::Arc::clone(&ticks);
            tokio::spawn(async move {
                for _ in 0..5 {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                    ticks.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                }
            })
        };

        // Same code path as `request_async`, with the production ceiling
        // replaced so the test does not sleep for 15 s.
        let error = broker
            .request_with_timeout(PROBE_URI, "task-1", Duration::from_millis(100))
            .await
            .unwrap_err();
        let message = error.to_string();
        assert!(
            matches!(error, SecretError::ResolveTimeout { .. }),
            "expected a resolve timeout, got {message}"
        );
        assert!(message.contains(PROBE_URI), "{message}");
        assert!(message.contains("did not complete within"), "{message}");
        assert!(
            message.contains("TERMINUS_SECRETS_BACKEND=file"),
            "the error must name the remedy: {message}"
        );
        // The value never appears in the error.
        assert!(!message.contains("probe-value"), "{message}");

        ticker.await.unwrap();
        assert_eq!(
            ticks.load(std::sync::atomic::Ordering::SeqCst),
            5,
            "the runtime must keep making progress while a resolve is parked"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 1)]
    async fn async_request_propagates_a_provider_failure() {
        let broker = SecretBroker::new();
        let provider = std::sync::Arc::new(InMemoryProvider::new());
        broker.register_provider("fixture", provider);
        let error = broker
            .request_async("secret://fixture/missing", "task-1")
            .await
            .unwrap_err();
        assert!(matches!(error, SecretError::UnknownCapability(_)));
    }
}

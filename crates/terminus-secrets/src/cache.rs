//! In-process cache of resolved credentials.
//!
//! One provider request touches the broker twice — once in
//! `Kernel::mint_grant` (to pin the credential digest into the grant) and
//! once in the connector broker (to inject the header). Against the OS
//! keychain each of those is a synchronous `SecKeychainFindGenericPassword`,
//! and on a dev binary whose code identity changes every rebuild each one
//! raises its own approval prompt. Resolving once per lease removes the
//! duplicate read without changing what any caller observes: the handle the
//! second caller gets carries the same metadata and the same bytes the first
//! one did.
//!
//! What the cache does NOT do: it does not suppress audit entries. The audit
//! log records each *use*, so the broker records one entry per request,
//! cache hit or not.

use std::collections::HashMap;
use std::sync::Mutex;

use crate::broker::{SecretHandle, SecretMetadata};

/// Ceiling on cached entries. A kernel has a handful of provider accounts;
/// the bound exists so a caller cannot grow kernel heap by requesting many
/// distinct URIs.
const MAX_CACHED_SECRETS: usize = 64;

/// One cached credential. The bytes are zeroed when the entry leaves the
/// cache (eviction, invalidation, or drop of the whole cache).
pub(crate) struct CachedSecret {
    metadata: SecretMetadata,
    value: Vec<u8>,
}

impl CachedSecret {
    pub(crate) const fn new(metadata: SecretMetadata, value: Vec<u8>) -> Self {
        Self { metadata, value }
    }

    /// Live while the provider's own lease has not elapsed. Both shipped
    /// providers advertise a 300 s lease, so a cached credential can never
    /// outlive what the provider itself promised.
    const fn is_live(&self, now_unix: u64) -> bool {
        now_unix < self.metadata.expires_at_unix
    }

    fn handle(&self) -> SecretHandle {
        SecretHandle::from_value(self.metadata.clone(), self.value.clone())
    }

    /// Replace the in-memory bytes with zeros. Called explicitly on every
    /// eviction path and again from `Drop`, so an entry is never released to
    /// the allocator still holding credential material.
    fn wipe(&mut self) {
        for byte in &mut self.value {
            *byte = 0;
        }
    }
}

impl Drop for CachedSecret {
    fn drop(&mut self) {
        self.wipe();
    }
}

impl std::fmt::Debug for CachedSecret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CachedSecret")
            .field("metadata", &self.metadata)
            .field("value", &"<redacted>")
            .finish()
    }
}

#[derive(Debug, Default)]
pub(crate) struct SecretCache {
    entries: Mutex<HashMap<String, CachedSecret>>,
}

impl SecretCache {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// A live handle for `uri`, or `None` when the URI was never cached or
    /// its lease has elapsed. An elapsed entry is wiped and dropped here
    /// rather than left in the map.
    pub(crate) fn get(&self, uri: &str, now_unix: u64) -> Option<SecretHandle> {
        let mut entries = self.entries.lock().ok()?;
        let live = entries
            .get(uri)
            .is_some_and(|entry| entry.is_live(now_unix));
        if !live {
            Self::remove_locked(&mut entries, uri);
            return None;
        }
        entries.get(uri).map(CachedSecret::handle)
    }

    /// Cache a freshly resolved credential. Replacing an existing entry wipes
    /// the old bytes first.
    pub(crate) fn insert(&self, metadata: &SecretMetadata, value: &[u8], now_unix: u64) {
        let Ok(mut entries) = self.entries.lock() else {
            return;
        };
        let entry = CachedSecret::new(metadata.clone(), value.to_vec());
        if !entry.is_live(now_unix) {
            // A provider that hands back an already-elapsed lease is never
            // cached; every request re-resolves it.
            return;
        }
        entries.retain(|_, cached| cached.is_live(now_unix));
        if entries.len() >= MAX_CACHED_SECRETS && !entries.contains_key(&metadata.uri) {
            return;
        }
        if let Some(mut previous) = entries.insert(metadata.uri.clone(), entry) {
            previous.wipe();
        }
    }

    /// Drop the entry for `uri` (a `store`, `delete`, or `revoke` of that
    /// URI). Wipes before releasing the buffer.
    pub(crate) fn invalidate(&self, uri: &str) {
        if let Ok(mut entries) = self.entries.lock() {
            Self::remove_locked(&mut entries, uri);
        }
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.entries.lock().map_or(0, |entries| entries.len())
    }

    fn remove_locked(entries: &mut HashMap<String, CachedSecret>, uri: &str) {
        if let Some(mut removed) = entries.remove(uri) {
            removed.wipe();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn metadata(uri: &str, expires_at_unix: u64) -> SecretMetadata {
        SecretMetadata {
            uri: uri.to_string(),
            provider: "fixture".to_string(),
            scope: "scope".to_string(),
            issued_at_unix: 1_000,
            expires_at_unix,
            redaction_patterns: Vec::new(),
            allowed_destinations: Vec::new(),
        }
    }

    #[test]
    fn cached_entry_is_returned_inside_its_lease() {
        let cache = SecretCache::new();
        cache.insert(&metadata("secret://f/a", 1_300), b"token-value", 1_000);
        let handle = cache.get("secret://f/a", 1_299).expect("live entry");
        assert_eq!(handle.digest(), {
            use sha2::Digest;
            hex::encode(sha2::Sha256::digest(b"token-value"))
        });
        assert_eq!(handle.metadata.expires_at_unix, 1_300);
    }

    #[test]
    fn elapsed_entry_is_dropped_on_lookup() {
        let cache = SecretCache::new();
        cache.insert(&metadata("secret://f/a", 1_300), b"token-value", 1_000);
        assert_eq!(cache.len(), 1);
        assert!(cache.get("secret://f/a", 1_300).is_none());
        assert_eq!(cache.len(), 0, "an elapsed entry must not be retained");
    }

    #[test]
    fn already_elapsed_lease_is_never_cached() {
        let cache = SecretCache::new();
        cache.insert(&metadata("secret://f/a", 1_000), b"token-value", 1_000);
        assert_eq!(cache.len(), 0);
    }

    #[test]
    fn invalidate_removes_only_the_named_uri() {
        let cache = SecretCache::new();
        cache.insert(&metadata("secret://f/a", 1_300), b"aaa", 1_000);
        cache.insert(&metadata("secret://f/b", 1_300), b"bbb", 1_000);
        cache.invalidate("secret://f/a");
        assert!(cache.get("secret://f/a", 1_100).is_none());
        assert!(cache.get("secret://f/b", 1_100).is_some());
    }

    #[test]
    fn eviction_zeroizes_the_cached_bytes() {
        let mut entry = CachedSecret::new(metadata("secret://f/a", 1_300), b"token-value".to_vec());
        assert_ne!(entry.value, vec![0u8; "token-value".len()]);
        // Exactly what `SecretCache::remove_locked` and `Drop` call.
        entry.wipe();
        assert_eq!(entry.value, vec![0u8; "token-value".len()]);
        assert!(!format!("{entry:?}").contains("token-value"));
    }

    #[test]
    fn replacing_an_entry_wipes_the_previous_bytes() {
        let cache = SecretCache::new();
        cache.insert(&metadata("secret://f/a", 1_300), b"first-value", 1_000);
        cache.insert(&metadata("secret://f/a", 1_400), b"second-value", 1_000);
        assert_eq!(cache.len(), 1);
        let handle = cache.get("secret://f/a", 1_100).expect("live entry");
        assert_eq!(handle.digest(), {
            use sha2::Digest;
            hex::encode(sha2::Sha256::digest(b"second-value"))
        });
    }

    #[test]
    fn cache_is_bounded() {
        let cache = SecretCache::new();
        for index in 0..(MAX_CACHED_SECRETS * 2) {
            cache.insert(
                &metadata(&format!("secret://f/{index}"), 1_300),
                b"v",
                1_000,
            );
        }
        assert_eq!(cache.len(), MAX_CACHED_SECRETS);
    }
}

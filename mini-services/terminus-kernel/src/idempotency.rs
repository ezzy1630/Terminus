//! Small in-memory idempotency dedup. SPEC §30.5 mandates that mutating
//! requests accept an `Idempotency-Key` header. The kernel does not yet
//! have a full SQLite-backed idempotency store; this map deduplicates
//! in-flight requests with the same key + normalized body hash and returns
//! the same response.

use sha2::Digest;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

/// An entry in the idempotency map.
#[derive(Debug)]
struct Entry {
    request_hash: String,
    response: serde_json::Value,
    created_at: Instant,
}

/// A bounded, TTL-evicting in-memory idempotency map.
#[derive(Debug, Default)]
pub struct IdempotencyMap {
    inner: Mutex<HashMap<String, Entry>>,
    ttl: Duration,
}

impl IdempotencyMap {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
            ttl: Duration::from_secs(3600),
        }
    }

    /// Look up a cached response. Returns `Some(response)` only if the
    /// `key` exists, its `request_hash` matches, and it has not expired.
    /// Returns `None` if the key is absent, the hash differs (caller should
    /// return IDEMPOTENCY_KEY_CONFLICT), or the entry expired.
    pub async fn lookup(&self, key: &str, request_hash: &str) -> IdempotencyLookup {
        let mut guard = self.inner.lock().await;
        // Evict expired entries opportunistically.
        guard.retain(|_, e| e.created_at.elapsed() < self.ttl);
        match guard.get(key) {
            Some(entry) if entry.request_hash != request_hash => IdempotencyLookup::Conflict,
            Some(entry) => IdempotencyLookup::Hit(entry.response.clone()),
            None => IdempotencyLookup::Miss,
        }
    }

    /// Store a response keyed by `key` and `request_hash`.
    pub async fn store(&self, key: String, request_hash: String, response: serde_json::Value) {
        let mut guard = self.inner.lock().await;
        // Bounded: keep at most 1024 entries.
        if guard.len() >= 1024 {
            // Drop the oldest entry.
            if let Some((oldest_key, _)) = guard
                .iter()
                .min_by_key(|(_, e)| e.created_at)
                .map(|(k, v)| (k.clone(), v.created_at))
            {
                guard.remove(&oldest_key);
            }
        }
        guard.insert(
            key,
            Entry {
                request_hash,
                response,
                created_at: Instant::now(),
            },
        );
    }
}

pub enum IdempotencyLookup {
    Hit(serde_json::Value),
    Miss,
    Conflict,
}

/// Compute a stable hash of a request body for idempotency comparison.
pub fn request_hash(body: &serde_json::Value) -> String {
    // Canonical JSON serialization (sorted keys) — serde_json already
    // serializes objects in insertion order, so we re-serialize through a
    // BTreeMap walk to get sorted keys. For our purposes, a simple
    // determinstic repr is sufficient.
    let canonical = canonicalize(body);
    let mut hasher = sha2::Sha256::new();
    sha2::Digest::update(&mut hasher, canonical.as_bytes());
    format!("sha256:{}", hex::encode(sha2::Digest::finalize(hasher)))
}

fn canonicalize(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let mut s = String::from("{");
            for (i, k) in keys.iter().enumerate() {
                if i > 0 {
                    s.push(',');
                }
                s.push_str(&serde_json::to_string(k).unwrap_or_else(|_| String::from("\"\"")));
                s.push(':');
                s.push_str(&canonicalize(&map[*k]));
            }
            s.push('}');
            s
        }
        serde_json::Value::Array(arr) => {
            let inner: Vec<String> = arr.iter().map(canonicalize).collect();
            format!("[{}]", inner.join(","))
        }
        other => other.to_string(),
    }
}

/// Convenience alias so handlers can refer to `Arc<IdempotencyMap>`.
pub type SharedIdempotencyMap = Arc<IdempotencyMap>;

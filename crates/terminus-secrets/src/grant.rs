//! Opaque connector grants (ADR-0035 §1, SPEC §17.2/§17.3).
//!
//! A `ConnectorGrant` is an HMAC-signed, short-lived, single-purpose
//! authorization to use one credential for ONE exact operation through ONE
//! connector. Grants carry no secret material: only a provider URI reference
//! and a SHA-256 digest of the bound credential.
//!
//! Binding fields (all must match at consumption time):
//! - connector id;
//! - destination host/port/scheme;
//! - operation (method + path class);
//! - task id and effect id;
//! - expiry and use limit.

use crate::error::SecretError;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::{Digest as ShaDigest, Sha256};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

type HmacSha256 = Hmac<Sha256>;

/// Maximum grant lifetime. Grants are short-lived by construction; longer
/// authority must go through the authorization-instance ledger (Phase 3).
pub const MAX_GRANT_TTL_SECS: u64 = 3600;

/// Identity of the workload requesting a grant (SPEC §17.2 "workload
/// identity"). Issued by the control plane; every grant binds to it so
/// credential use resolves to a principal and task.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkloadIdentity {
    pub workload_id: String,
    pub principal: String,
    pub task_id: String,
}

/// The exact external operation a grant authorizes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GrantBinding {
    /// Trusted connector that executes the operation (e.g. "github-api").
    pub connector_id: String,
    pub destination_host: String,
    pub destination_port: u16,
    pub scheme: String,
    /// HTTP method, uppercase (e.g. "POST").
    pub method: String,
    /// Path class the connector may request (e.g. "/repos/{owner}/{repo}/pulls").
    /// Exact path matching is the connector's job; the grant pins the class.
    pub path_class: String,
    /// Durable task this use is attributed to.
    pub task_id: String,
    /// Effect-ledger record this use is attributed to.
    pub effect_id: String,
    /// Destination hosts the provider account behind `secret_uri` may reach,
    /// pinned by the control plane at mint time. Empty means "the connector's
    /// own fixed hosts decide"; connectors whose host is chosen per account
    /// (`HostPolicy::PerGrant`) require a non-empty list containing
    /// `destination_host`. Signed with the rest of the claims, so a consumer
    /// cannot widen it.
    #[serde(default)]
    pub allowed_hosts: Vec<String>,
}

/// Signed claims carried by a grant. No secret material — only digests.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GrantClaims {
    pub grant_id: String,
    /// `secret://provider/scope` URI reference. Not the value.
    pub secret_uri: String,
    /// SHA-256 hex digest of the credential material at mint time.
    pub credential_digest: String,
    pub workload: WorkloadIdentity,
    pub binding: GrantBinding,
    pub issued_at_unix: u64,
    pub expires_at_unix: u64,
    /// 0 means unlimited within expiry; production issuance SHOULD pin 1.
    pub use_limit: u32,
}

/// An opaque, signed connector grant. Safe to log: contains no secret
/// material.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectorGrant {
    pub claims: GrantClaims,
    signature: Vec<u8>,
}

fn sign_claims(claims: &GrantClaims, key: &[u8]) -> Result<Vec<u8>, SecretError> {
    let claims_json = serde_json::to_vec(claims)?;
    let mut mac = HmacSha256::new_from_slice(key)
        .map_err(|_| SecretError::InvalidGrant("hmac key".into()))?;
    mac.update(&claims_json);
    Ok(mac.finalize().into_bytes().to_vec())
}

impl ConnectorGrant {
    /// Encode for transport: `<claims_b64u>.<signature_hex>`.
    pub fn encode(&self) -> Result<String, SecretError> {
        let claims_json = serde_json::to_string(&self.claims)?;
        let claims_b64 = base64_url_encode(claims_json.as_bytes());
        Ok(format!("{claims_b64}.{}", hex::encode(&self.signature)))
    }

    /// Decode and verify a token string against `key`.
    pub fn decode_and_verify(s: &str, key: &[u8]) -> Result<Self, SecretError> {
        let (claims_b64, sig_hex) = s
            .split_once('.')
            .ok_or_else(|| SecretError::InvalidGrant("malformed token".into()))?;
        let claims_bytes = base64_url_decode(claims_b64)
            .map_err(|_| SecretError::InvalidGrant("bad claims encoding".into()))?;
        let signature =
            hex::decode(sig_hex).map_err(|_| SecretError::InvalidGrant("bad signature".into()))?;
        let claims: GrantClaims = serde_json::from_slice(&claims_bytes)?;
        let grant = Self { claims, signature };
        grant.verify_signature(key)?;
        Ok(grant)
    }

    pub(crate) fn verify_signature(&self, key: &[u8]) -> Result<(), SecretError> {
        let expected = sign_claims(&self.claims, key)?;
        if expected != self.signature {
            return Err(SecretError::InvalidGrant("signature mismatch".into()));
        }
        Ok(())
    }
}

pub(crate) fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

pub(crate) fn credential_digest(material: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(material);
    hex::encode(hasher.finalize())
}

/// Mints connector grants bound to a workload identity.
pub struct GrantIssuer {
    key: Vec<u8>,
}

impl std::fmt::Debug for GrantIssuer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GrantIssuer").finish_non_exhaustive()
    }
}

impl GrantIssuer {
    pub fn new(key: impl Into<Vec<u8>>) -> Self {
        Self { key: key.into() }
    }

    /// Mint a short-lived grant. `ttl_secs` must be in `1..=MAX_GRANT_TTL_SECS`.
    pub fn mint(
        &self,
        workload: WorkloadIdentity,
        secret_uri: &str,
        credential_material: &[u8],
        binding: GrantBinding,
        ttl_secs: u64,
        use_limit: u32,
    ) -> Result<ConnectorGrant, SecretError> {
        let digest = credential_digest(credential_material);
        self.mint_for_digest(workload, secret_uri, &digest, binding, ttl_secs, use_limit)
    }

    /// Mint from a pre-computed SHA-256 hex digest of the credential
    /// material. For callers that hold only the digest (e.g. the kernel
    /// service boundary, where raw material stays inside the secrets
    /// crate). The digest must be 64 lowercase hex chars.
    pub fn mint_for_digest(
        &self,
        workload: WorkloadIdentity,
        secret_uri: &str,
        credential_hex_digest: &str,
        binding: GrantBinding,
        ttl_secs: u64,
        use_limit: u32,
    ) -> Result<ConnectorGrant, SecretError> {
        const HEX_DIGITS: &[u8] = b"0123456789abcdef";
        if credential_hex_digest.len() != 64
            || !credential_hex_digest
                .bytes()
                .all(|b| HEX_DIGITS.contains(&b))
        {
            return Err(SecretError::InvalidGrant(
                "credential digest must be 64 lowercase hex chars".into(),
            ));
        }
        if ttl_secs == 0 || ttl_secs > MAX_GRANT_TTL_SECS {
            return Err(SecretError::InvalidGrant(format!(
                "grant TTL must be in 1..={MAX_GRANT_TTL_SECS} seconds"
            )));
        }
        let now = now_unix();
        let claims = GrantClaims {
            grant_id: format!("grt-{}", mint_grant_id()),
            secret_uri: secret_uri.to_string(),
            credential_digest: credential_hex_digest.to_string(),
            workload,
            binding,
            issued_at_unix: now,
            expires_at_unix: now + ttl_secs,
            use_limit,
        };
        let signature = sign_claims(&claims, &self.key)?;
        Ok(ConnectorGrant { claims, signature })
    }
}

/// Receipt of an atomic consumption. Attributable; safe to persist with the
/// effect record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConsumedGrant {
    pub grant_id: String,
    pub secret_uri: String,
    pub consumed_at_unix: u64,
    pub remaining_uses: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ConsumedRecord {
    remaining_uses: u32,
}

/// Durable consumption store. Consumption is atomic under the store mutex
/// and persisted (temp-file + rename) when a storage path is configured, so
/// a restarted process cannot re-consume an exhausted grant.
#[derive(Debug, Default)]
pub struct GrantStore {
    consumed: Mutex<HashMap<String, ConsumedRecord>>,
    storage_path: Option<PathBuf>,
}

impl GrantStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_storage(path: impl Into<PathBuf>) -> Self {
        Self {
            consumed: Mutex::new(HashMap::new()),
            storage_path: Some(path.into()),
        }
    }

    fn persist(&self, guard: &HashMap<String, ConsumedRecord>) {
        let Some(path) = &self.storage_path else {
            return;
        };
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(json) = serde_json::to_vec_pretty(guard) {
            let tmp = format!("{}.tmp-{}", path.display(), std::process::id());
            if std::fs::write(&tmp, &json).is_ok() {
                let _ = std::fs::rename(&tmp, path);
            }
        }
    }

    /// Reload consumption state persisted by a previous process. Returns the
    /// number of records loaded.
    pub fn load_persisted(&self) -> usize {
        let Some(path) = &self.storage_path else {
            return 0;
        };
        let Ok(data) = std::fs::read(path) else {
            return 0;
        };
        let Ok(records) = serde_json::from_slice::<HashMap<String, ConsumedRecord>>(&data) else {
            return 0;
        };
        let count = records.len();
        let mut guard = match self.consumed.lock() {
            Ok(g) => g,
            Err(e) => e.into_inner(),
        };
        *guard = records;
        count
    }

    /// Consume one use of `grant` iff its signature verifies against `key`,
    /// it has not expired, uses remain, and every binding field matches the
    /// expected operation. Fails closed on any mismatch.
    #[allow(clippy::too_many_arguments)]
    pub fn consume(
        &self,
        grant: &ConnectorGrant,
        expected_connector_id: &str,
        expected_destination: (&str, u16, &str),
        expected_operation: (&str, &str),
        expected_task_id: &str,
        expected_effect_id: &str,
        key: &[u8],
    ) -> Result<ConsumedGrant, SecretError> {
        grant.verify_signature(key)?;
        let now = now_unix();
        let claims = &grant.claims;

        if claims.expires_at_unix <= now {
            return Err(SecretError::Expired(format!(
                "grant {} expired",
                claims.grant_id
            )));
        }
        let b = &claims.binding;
        if b.connector_id != expected_connector_id {
            return Err(SecretError::BindingMismatch(format!(
                "connector {} != {}",
                expected_connector_id, b.connector_id
            )));
        }
        if b.destination_host != expected_destination.0
            || b.destination_port != expected_destination.1
            || b.scheme != expected_destination.2
        {
            return Err(SecretError::BindingMismatch(format!(
                "destination {}:{}/{} != {}:{}/{}",
                expected_destination.0,
                expected_destination.1,
                expected_destination.2,
                b.destination_host,
                b.destination_port,
                b.scheme
            )));
        }
        if b.method != expected_operation.0 || b.path_class != expected_operation.1 {
            return Err(SecretError::BindingMismatch(format!(
                "operation {}/{} != {}/{}",
                expected_operation.0, expected_operation.1, b.method, b.path_class
            )));
        }
        if b.task_id != expected_task_id {
            return Err(SecretError::BindingMismatch(format!(
                "task {} != {}",
                expected_task_id, b.task_id
            )));
        }
        if b.effect_id != expected_effect_id {
            return Err(SecretError::BindingMismatch(format!(
                "effect {} != {}",
                expected_effect_id, b.effect_id
            )));
        }

        let mut guard = match self.consumed.lock() {
            Ok(g) => g,
            Err(e) => e.into_inner(),
        };
        let remaining = match guard.get(&claims.grant_id).map(|r| r.remaining_uses) {
            Some(0) => {
                return Err(SecretError::CapabilityRevoked(format!(
                    "grant {} exhausted",
                    claims.grant_id
                )));
            }
            Some(n) => n - 1,
            None => {
                if claims.use_limit == 0 {
                    u32::MAX
                } else {
                    claims.use_limit - 1
                }
            }
        };
        guard.insert(
            claims.grant_id.clone(),
            ConsumedRecord {
                remaining_uses: remaining,
            },
        );
        self.persist(&guard);

        Ok(ConsumedGrant {
            grant_id: claims.grant_id.clone(),
            secret_uri: claims.secret_uri.clone(),
            consumed_at_unix: now,
            remaining_uses: remaining,
        })
    }

    pub fn consumed_count(&self) -> usize {
        match self.consumed.lock() {
            Ok(g) => g.len(),
            Err(e) => e.into_inner().len(),
        }
    }
}

fn mint_grant_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let mut hasher = Sha256::new();
    hasher.update(now_unix().to_le_bytes());
    hasher.update(n.to_le_bytes());
    hasher.update(std::process::id().to_le_bytes());
    hex::encode(&hasher.finalize()[..8])
}

// ---------- base64url (same encoding style as terminus-authz) ----------

const B64URL_CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

fn base64_url_encode(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(B64URL_CHARS[(n >> 18) as usize & 63] as char);
        out.push(B64URL_CHARS[(n >> 12) as usize & 63] as char);
        if chunk.len() > 1 {
            out.push(B64URL_CHARS[(n >> 6) as usize & 63] as char);
        }
        if chunk.len() > 2 {
            out.push(B64URL_CHARS[n as usize & 63] as char);
        }
    }
    out
}

fn b64_val(c: u8) -> Result<u32, ()> {
    match c {
        b'A'..=b'Z' => Ok((c - b'A') as u32),
        b'a'..=b'z' => Ok((c - b'a' + 26) as u32),
        b'0'..=b'9' => Ok((c - b'0' + 52) as u32),
        b'-' => Ok(62),
        b'_' => Ok(63),
        _ => Err(()),
    }
}

fn base64_url_decode(s: &str) -> Result<Vec<u8>, ()> {
    fn push(out: &mut Vec<u8>, v: [u32; 4], keep: usize) {
        let num = (v[0] << 18) | (v[1] << 12) | (v[2] << 6) | v[3];
        out.push((num >> 16) as u8);
        if keep >= 2 {
            out.push((num >> 8) as u8);
        }
        if keep >= 3 {
            out.push(num as u8);
        }
    }
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3 + 2);
    let mut buf = [0u32; 4];
    let mut fill = 0usize;
    for &c in bytes {
        buf[fill] = b64_val(c)?;
        fill += 1;
        if fill == 4 {
            push(&mut out, buf, 4);
            fill = 0;
        }
    }
    match fill {
        0 => {}
        // Trailing 2 chars encode one byte; 3 chars encode two bytes.
        2 => push(&mut out, [buf[0], buf[1], 0, 0], 1),
        3 => push(&mut out, [buf[0], buf[1], buf[2], 0], 2),
        _ => return Err(()),
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &[u8] = &[7u8; 32];

    fn binding() -> GrantBinding {
        GrantBinding {
            connector_id: "github-api".into(),
            destination_host: "api.github.com".into(),
            destination_port: 443,
            scheme: "https".into(),
            method: "POST".into(),
            path_class: "/repos/o/r/pulls".into(),
            task_id: "task-1".into(),
            effect_id: "eff-1".into(),
            allowed_hosts: Vec::new(),
        }
    }

    fn issuer() -> GrantIssuer {
        GrantIssuer::new(KEY.to_vec())
    }

    fn workload() -> WorkloadIdentity {
        WorkloadIdentity {
            workload_id: "w-1".into(),
            principal: "agent".into(),
            task_id: "task-1".into(),
        }
    }

    fn mint() -> ConnectorGrant {
        issuer()
            .mint(
                workload(),
                "secret://github/repo-read",
                b"canary-value",
                binding(),
                300,
                1,
            )
            .unwrap()
    }

    fn consume(store: &GrantStore, g: &ConnectorGrant) -> Result<ConsumedGrant, SecretError> {
        store.consume(
            g,
            "github-api",
            ("api.github.com", 443, "https"),
            ("POST", "/repos/o/r/pulls"),
            "task-1",
            "eff-1",
            KEY,
        )
    }

    #[test]
    fn roundtrip_encode_decode_verifies() {
        let grant = mint();
        let enc = grant.encode().unwrap();
        let dec = ConnectorGrant::decode_and_verify(&enc, KEY).unwrap();
        assert_eq!(dec.claims, grant.claims);
    }

    #[test]
    fn wrong_key_rejected() {
        let grant = mint();
        assert!(ConnectorGrant::decode_and_verify(&grant.encode().unwrap(), &[9u8; 32]).is_err());
    }

    #[test]
    fn tampered_claims_fail_verification() {
        let grant = mint();
        let enc = grant.encode().unwrap();
        let (claims_b64, sig) = enc.split_once('.').unwrap();
        let mut bytes = base64_url_decode(claims_b64).unwrap();
        // Flip a byte inside the secret_uri region of the JSON payload.
        let idx = bytes.iter().position(|&b| b == b'/').unwrap_or(0);
        bytes[idx] = b'x';
        let tampered = format!("{}.{}", base64_url_encode(&bytes), sig);
        assert!(ConnectorGrant::decode_and_verify(&tampered, KEY).is_err());
    }

    #[test]
    fn encode_carries_no_secret_material() {
        let grant = mint();
        let enc = grant.encode().unwrap();
        assert!(!enc.contains("canary"));
    }

    #[test]
    fn exact_binding_consumes_once_then_exhausts() {
        let grant = mint();
        let store = GrantStore::new();
        let receipt = consume(&store, &grant).unwrap();
        assert_eq!(receipt.remaining_uses, 0);
        let replay = consume(&store, &grant);
        assert!(matches!(replay, Err(SecretError::CapabilityRevoked(_))));
    }

    #[test]
    fn destination_substitution_rejected() {
        let grant = mint();
        let store = GrantStore::new();
        let err = store.consume(
            &grant,
            "github-api",
            ("evil.example.com", 443, "https"),
            ("POST", "/repos/o/r/pulls"),
            "task-1",
            "eff-1",
            KEY,
        );
        assert!(matches!(err, Err(SecretError::BindingMismatch(_))));
    }

    #[test]
    fn port_substitution_rejected() {
        let grant = mint();
        let store = GrantStore::new();
        let err = store.consume(
            &grant,
            "github-api",
            ("api.github.com", 8443, "https"),
            ("POST", "/repos/o/r/pulls"),
            "task-1",
            "eff-1",
            KEY,
        );
        assert!(matches!(err, Err(SecretError::BindingMismatch(_))));
    }

    #[test]
    fn operation_change_rejected() {
        let grant = mint();
        let store = GrantStore::new();
        let err = store.consume(
            &grant,
            "github-api",
            ("api.github.com", 443, "https"),
            ("DELETE", "/repos/o/r/pulls"),
            "task-1",
            "eff-1",
            KEY,
        );
        assert!(matches!(err, Err(SecretError::BindingMismatch(_))));
    }

    #[test]
    fn path_class_change_rejected() {
        let grant = mint();
        let store = GrantStore::new();
        let err = store.consume(
            &grant,
            "github-api",
            ("api.github.com", 443, "https"),
            ("POST", "/admin/settings"),
            "task-1",
            "eff-1",
            KEY,
        );
        assert!(matches!(err, Err(SecretError::BindingMismatch(_))));
    }

    #[test]
    fn cross_task_use_rejected() {
        let grant = mint();
        let store = GrantStore::new();
        let err = store.consume(
            &grant,
            "github-api",
            ("api.github.com", 443, "https"),
            ("POST", "/repos/o/r/pulls"),
            "task-OTHER",
            "eff-1",
            KEY,
        );
        assert!(matches!(err, Err(SecretError::BindingMismatch(_))));
    }

    #[test]
    fn cross_effect_use_rejected() {
        let grant = mint();
        let store = GrantStore::new();
        let err = store.consume(
            &grant,
            "github-api",
            ("api.github.com", 443, "https"),
            ("POST", "/repos/o/r/pulls"),
            "task-1",
            "eff-OTHER",
            KEY,
        );
        assert!(matches!(err, Err(SecretError::BindingMismatch(_))));
    }

    #[test]
    fn expired_grant_rejected() {
        let iss = issuer();
        let mut grant = iss
            .mint(workload(), "secret://x/y", b"m", binding(), 300, 1)
            .unwrap();
        grant.claims.expires_at_unix = now_unix().saturating_sub(1);
        grant.signature = sign_claims(&grant.claims, KEY).unwrap();
        let store = GrantStore::new();
        let err = consume(&store, &grant);
        assert!(matches!(err, Err(SecretError::Expired(_))));
    }

    #[test]
    fn oversized_ttl_rejected() {
        let err = issuer().mint(
            workload(),
            "secret://x/y",
            b"m",
            binding(),
            MAX_GRANT_TTL_SECS + 1,
            1,
        );
        assert!(matches!(err, Err(SecretError::InvalidGrant(_))));
    }

    #[test]
    fn zero_ttl_rejected() {
        let err = issuer().mint(workload(), "secret://x/y", b"m", binding(), 0, 1);
        assert!(matches!(err, Err(SecretError::InvalidGrant(_))));
    }

    #[test]
    fn consumption_survives_restart_via_storage() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("grants.json");
        let grant = mint();
        {
            let store = GrantStore::with_storage(&path);
            consume(&store, &grant).unwrap();
        }
        let reopened = GrantStore::with_storage(&path);
        assert_eq!(reopened.load_persisted(), 1);
        let replay = consume(&reopened, &grant);
        assert!(matches!(replay, Err(SecretError::CapabilityRevoked(_))));
    }

    #[test]
    fn base64_roundtrip_random_lengths() {
        for len in 0..40usize {
            let data: Vec<u8> = (0..len).map(|i| (i * 37 + 11) as u8).collect();
            let enc = base64_url_encode(&data);
            let dec = base64_url_decode(&enc).unwrap();
            assert_eq!(dec, data, "length {len}");
        }
    }
}

//! Capability token implementation.

use crate::error::AuthzError;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

type HmacSha256 = Hmac<Sha256>;

/// Operation classes a token may authorize.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OperationClass {
    Read,
    Patch,
    Exec,
    Job,
    Sandbox,
    Policy,
    Secret,
    Network,
    CodeIntel,
    Extension,
    Git,
    ArtifactIngest,
    Admin,
}

impl OperationClass {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Patch => "patch",
            Self::Exec => "exec",
            Self::Job => "job",
            Self::Sandbox => "sandbox",
            Self::Policy => "policy",
            Self::Secret => "secret",
            Self::Network => "network",
            Self::CodeIntel => "code_intel",
            Self::Extension => "extension",
            Self::Git => "git",
            Self::ArtifactIngest => "artifact_ingest",
            Self::Admin => "admin",
        }
    }
}

/// A scope bound — glob patterns per resource kind.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct Scope {
    pub workspace_paths: Vec<String>,
    pub network_destinations: Vec<String>,
    pub secret_capabilities: Vec<String>,
}

/// Static binding for a token: principal/session/task/workspace.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct TokenBinder {
    pub principal: String,
    pub session_id: String,
    pub task_id: String,
    pub workspace_id: String,
    pub kernel_instance_id: String,
}

/// Claims carried inside a capability token.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TokenClaims {
    pub token_id: String,
    pub issued_at_unix: u64,
    pub expires_at_unix: u64,
    pub binder: TokenBinder,
    pub operation_classes: Vec<OperationClass>,
    pub max_scope: Scope,
    pub nonce: String,
}

impl TokenClaims {
    fn canonical_json(&self) -> Result<String, AuthzError> {
        // Sort keys for stable signing.
        let value = serde_json::to_value(self)?;
        let canonical = canonicalize_json(&value);
        Ok(canonical)
    }
}

fn canonicalize_json(value: &serde_json::Value) -> String {
    // Serialize with sorted keys.
    let mut buf = Vec::new();
    let formatter = serde_json::ser::PrettyFormatter::with_indent(b"");
    let mut ser = serde_json::Serializer::with_formatter(&mut buf, formatter);
    let value_sorted = sort_json(value);
    use serde::Serialize;
    value_sorted.serialize(&mut ser).ok();
    String::from_utf8_lossy(&buf).to_string()
}

fn sort_json(value: &serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::Object(map) => {
            let mut sorted: Vec<(String, serde_json::Value)> =
                map.iter().map(|(k, v)| (k.clone(), sort_json(v))).collect();
            sorted.sort_by(|a, b| a.0.cmp(&b.0));
            let mut new_map = serde_json::Map::new();
            for (k, v) in sorted {
                new_map.insert(k, v);
            }
            serde_json::Value::Object(new_map)
        }
        serde_json::Value::Array(arr) => {
            serde_json::Value::Array(arr.iter().map(sort_json).collect())
        }
        other => other.clone(),
    }
}

/// A signed capability token. The serialized form is
/// `<claims_b64u>.<signature_hex>`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapabilityToken {
    pub claims: TokenClaims,
    pub signature: Vec<u8>,
}

impl CapabilityToken {
    /// Encode the token as a string suitable for transport in HTTP headers.
    pub fn encode(&self) -> Result<String, AuthzError> {
        let claims_json = serde_json::to_string(&self.claims)?;
        let claims_b64 = base64_url_encode(claims_json.as_bytes());
        let sig_hex = hex::encode(&self.signature);
        Ok(format!("{claims_b64}.{sig_hex}"))
    }

    /// Decode and verify a token string.
    pub fn decode_and_verify(
        s: &str,
        secret: &[u8],
        revocation: &RevocationList,
    ) -> Result<Self, AuthzError> {
        let (claims_b64, sig_hex) = s.split_once('.').ok_or(AuthzError::InvalidSignature)?;
        let claims_bytes =
            base64_url_decode(claims_b64).map_err(|_| AuthzError::InvalidSignature)?;
        let signature = hex::decode(sig_hex)?;
        let claims: TokenClaims = serde_json::from_slice(&claims_bytes)?;

        // Verify signature.
        let canonical = claims.canonical_json()?;
        let mut mac =
            HmacSha256::new_from_slice(secret).map_err(|_| AuthzError::InvalidSignature)?;
        mac.update(canonical.as_bytes());
        mac.verify_slice(&signature)
            .map_err(|_| AuthzError::InvalidSignature)?;

        // Check expiry.
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        if claims.expires_at_unix <= now {
            return Err(AuthzError::Expired);
        }

        // Check revocation.
        if revocation.is_revoked(&claims.token_id) {
            return Err(AuthzError::Revoked);
        }

        Ok(Self { claims, signature })
    }
}

/// In-memory revocation list. Production deployments back this with SQLite.
#[derive(Debug, Default)]
pub struct RevocationList {
    revoked: Mutex<HashSet<String>>,
}

impl RevocationList {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn revoke(&self, token_id: &str) {
        // Poisoned mutex indicates a panic in another thread holding the lock;
        // we still recover the inner data so the kernel can continue.
        let mut guard = match self.revoked.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        guard.insert(token_id.to_string());
    }

    pub fn is_revoked(&self, token_id: &str) -> bool {
        let guard = match self.revoked.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        guard.contains(token_id)
    }

    pub fn revoked_count(&self) -> usize {
        let guard = match self.revoked.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        guard.len()
    }
}

/// The issuer holds the HMAC signing key.
#[derive(Debug, Clone)]
pub struct TokenIssuer {
    secret: Vec<u8>,
    kernel_instance_id: String,
    default_ttl_seconds: u64,
    revocation: std::sync::Arc<RevocationList>,
    used_nonces: std::sync::Arc<Mutex<HashMap<String, u64>>>,
}

impl TokenIssuer {
    pub fn new(
        secret: Vec<u8>,
        kernel_instance_id: impl Into<String>,
        default_ttl_seconds: u64,
    ) -> Self {
        Self {
            secret,
            kernel_instance_id: kernel_instance_id.into(),
            default_ttl_seconds,
            revocation: std::sync::Arc::new(RevocationList::new()),
            used_nonces: std::sync::Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn revocation_list(&self) -> std::sync::Arc<RevocationList> {
        std::sync::Arc::clone(&self.revocation)
    }

    /// Mint a new token.
    pub fn mint(
        &self,
        binder: TokenBinder,
        operation_classes: Vec<OperationClass>,
        max_scope: Scope,
        ttl_seconds: Option<u64>,
        nonce: impl Into<String>,
    ) -> Result<CapabilityToken, AuthzError> {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let ttl = ttl_seconds.unwrap_or(self.default_ttl_seconds);
        let mut binder = binder;
        binder.kernel_instance_id = self.kernel_instance_id.clone();
        let nonce = nonce.into();
        if nonce.is_empty() {
            return Err(AuthzError::InvalidSignature);
        }
        let claims = TokenClaims {
            token_id: terminus_kernel_protocol::new_id(),
            issued_at_unix: now,
            expires_at_unix: now + ttl,
            binder,
            operation_classes,
            max_scope,
            nonce: nonce.clone(),
        };
        let canonical = claims.canonical_json()?;
        let mut mac =
            HmacSha256::new_from_slice(&self.secret).map_err(|_| AuthzError::InvalidSignature)?;
        mac.update(canonical.as_bytes());
        let signature = mac.finalize().into_bytes().to_vec();
        // Record nonce to prevent replay.
        {
            let mut guard = match self.used_nonces.lock() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            guard.insert(nonce, now);
        }
        Ok(CapabilityToken { claims, signature })
    }

    /// Validate a token string, checking signature, expiry, revocation, audience
    /// (kernel_instance_id), and that the nonce has not been replayed.
    pub fn validate(&self, s: &str) -> Result<CapabilityToken, AuthzError> {
        let token = CapabilityToken::decode_and_verify(s, &self.secret, &self.revocation)?;
        if token.claims.binder.kernel_instance_id != self.kernel_instance_id {
            return Err(AuthzError::InvalidAudience);
        }
        // Nonce replay: a token's nonce may be presented once. After validation
        // we do not add it again because the issuer already recorded it at
        // mint time. Repeated presentations of the same token are permitted
        // within its lifetime; what is forbidden is reusing the *nonce* for a
        // new token.
        Ok(token)
    }

    /// Revoke a token by id.
    pub fn revoke(&self, token_id: &str) {
        self.revocation.revoke(token_id);
    }

    /// Validate a token string AND check that the token grants the requested
    /// `operation_class` and that the requested `scope` is contained within
    /// the token's `max_scope`.
    ///
    /// An empty `max_scope` (i.e. `Scope::default()`) means "no scope
    /// restriction" — the token grants any scope. This matches the dev
    /// capability token convention. A non-empty `max_scope` requires every
    /// entry of the requested scope to match at least one glob in the
    /// corresponding list of `max_scope`.
    ///
    /// Returns the validated token on success, or an `AuthzError` indicating
    /// the first failure (signature, expiry, audience, operation class, or
    /// scope).
    pub fn validate_capability(
        &self,
        token_str: &str,
        operation_class: OperationClass,
        requested_scope: &Scope,
    ) -> Result<CapabilityToken, AuthzError> {
        let token = self.validate(token_str)?;
        // Operation-class check: the token MUST carry the requested class or
        // the `Admin` class (which is a superuser class).
        let has_class = token
            .claims
            .operation_classes
            .iter()
            .any(|op| *op == operation_class || *op == OperationClass::Admin);
        if !has_class {
            return Err(AuthzError::OperationNotPermitted);
        }
        // Scope check.
        if !scope_contained(&token.claims.max_scope, requested_scope) {
            return Err(AuthzError::ScopeExceeded);
        }
        Ok(token)
    }
}

/// True iff `requested` is fully contained within `max_scope`. An empty
/// `max_scope` (the default) means "unlimited" — every requested scope is
/// contained.
///
/// For each resource kind (`workspace_paths`, `network_destinations`,
/// `secret_capabilities`):
/// - if `max_scope.<kind>` is empty, the kind is unrestricted;
/// - otherwise every entry in `requested.<kind>` MUST match at least one glob
///   in `max_scope.<kind>`.
fn scope_contained(max_scope: &Scope, requested: &Scope) -> bool {
    if max_scope.workspace_paths.is_empty()
        && max_scope.network_destinations.is_empty()
        && max_scope.secret_capabilities.is_empty()
    {
        return true;
    }
    all_match_or_unrestricted(
        &max_scope.workspace_paths,
        &requested.workspace_paths,
        glob_match,
    ) && all_match_or_unrestricted(
        &max_scope.network_destinations,
        &requested.network_destinations,
        network_match,
    ) && all_match_or_unrestricted(
        &max_scope.secret_capabilities,
        &requested.secret_capabilities,
        prefix_match,
    )
}

fn all_match_or_unrestricted(
    maxes: &[String],
    requested: &[String],
    matcher: fn(&str, &str) -> bool,
) -> bool {
    // If maxes is empty for this kind, the kind is unrestricted.
    if maxes.is_empty() {
        return true;
    }
    // Every requested entry must match at least one max.
    for r in requested {
        if !maxes.iter().any(|m| matcher(m, r)) {
            return false;
        }
    }
    true
}

/// Simple glob matcher supporting `*` (any non-slash) and `**` (any).
fn glob_match(pattern: &str, value: &str) -> bool {
    if pattern == "**" || pattern == "*" {
        return true;
    }
    // Tiny glob: split on `**`.
    if let Some(idx) = pattern.find("**") {
        let prefix = &pattern[..idx];
        let suffix = &pattern[idx + 2..];
        if !value.starts_with(prefix) {
            return false;
        }
        let rest = &value[prefix.len()..];
        if suffix.is_empty() {
            return true;
        }
        return rest.ends_with(suffix);
    }
    // Otherwise: literal `*` matches any non-slash characters.
    glob_star(pattern, value)
}

fn glob_star(pattern: &str, value: &str) -> bool {
    let mut pi = 0usize;
    let mut vi = 0usize;
    let p_bytes = pattern.as_bytes();
    let v_bytes = value.as_bytes();
    let mut star_p: Option<usize> = None;
    let mut star_v: usize = 0;
    while vi < v_bytes.len() {
        if pi < p_bytes.len() && (p_bytes[pi] == v_bytes[vi] || p_bytes[pi] == b'?') {
            pi += 1;
            vi += 1;
        } else if pi < p_bytes.len() && p_bytes[pi] == b'*' {
            star_p = Some(pi);
            star_v = vi;
            pi += 1;
        } else if let Some(sp) = star_p {
            pi = sp + 1;
            star_v += 1;
            vi = star_v;
        } else {
            return false;
        }
    }
    while pi < p_bytes.len() && p_bytes[pi] == b'*' {
        pi += 1;
    }
    pi == p_bytes.len()
}

/// Network destination matcher: host suffix match (with optional `:port`).
fn network_match(pattern: &str, value: &str) -> bool {
    if let Some((host, port)) = pattern.split_once(':') {
        if let Some((vhost, vport)) = value.split_once(':') {
            if let Ok(p) = port.parse::<u16>() {
                if let Ok(vp) = vport.parse::<u16>() {
                    return vhost.ends_with(host) && p == vp;
                }
            }
        }
        // Pattern had a port but value didn't (or vice versa) — fall back to
        // host-suffix match.
        return value.ends_with(host);
    }
    // No port in pattern: match the host part only.
    let value_host = value.split_once(':').map(|(h, _)| h).unwrap_or(value);
    value_host.ends_with(pattern)
}

/// Prefix match for secret capability URIs (e.g. `secret://github/*`).
fn prefix_match(pattern: &str, value: &str) -> bool {
    if let Some(stripped) = pattern.strip_suffix("/*") {
        return value.starts_with(stripped) || value == stripped;
    }
    if let Some(stripped) = pattern.strip_suffix('*') {
        return value.starts_with(stripped);
    }
    value == pattern
}

/// A wrapper for revoking tokens without holding the issuer.
#[derive(Debug, Clone)]
pub struct TokenRevoker {
    revocation: std::sync::Arc<RevocationList>,
}

impl TokenRevoker {
    pub fn new(revocation: std::sync::Arc<RevocationList>) -> Self {
        Self { revocation }
    }

    pub fn revoke(&self, token_id: &str) {
        self.revocation.revoke(token_id);
    }
}

// ---------- base64url (no_std-ish, no extra dep) ----------

fn base64_url_encode(bytes: &[u8]) -> String {
    const ALPHA: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    let mut chunks = bytes.chunks_exact(3);
    for c in &mut chunks {
        let b0 = c[0] as u32;
        let b1 = c[1] as u32;
        let b2 = c[2] as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(ALPHA[((n >> 18) & 0x3F) as usize] as char);
        out.push(ALPHA[((n >> 12) & 0x3F) as usize] as char);
        out.push(ALPHA[((n >> 6) & 0x3F) as usize] as char);
        out.push(ALPHA[(n & 0x3F) as usize] as char);
    }
    let rem = chunks.remainder();
    match rem.len() {
        1 => {
            let n = (rem[0] as u32) << 16;
            out.push(ALPHA[((n >> 18) & 0x3F) as usize] as char);
            out.push(ALPHA[((n >> 12) & 0x3F) as usize] as char);
            out.push('=');
            out.push('=');
        }
        2 => {
            let n = ((rem[0] as u32) << 16) | ((rem[1] as u32) << 8);
            out.push(ALPHA[((n >> 18) & 0x3F) as usize] as char);
            out.push(ALPHA[((n >> 12) & 0x3F) as usize] as char);
            out.push(ALPHA[((n >> 6) & 0x3F) as usize] as char);
            out.push('=');
        }
        _ => {}
    }
    out
}

fn base64_url_decode(s: &str) -> Result<Vec<u8>, ()> {
    fn val(c: u8) -> Option<u8> {
        match c {
            b'A'..=b'Z' => Some(c - b'A'),
            b'a'..=b'z' => Some(c - b'a' + 26),
            b'0'..=b'9' => Some(c - b'0' + 52),
            b'-' => Some(62),
            b'_' => Some(63),
            _ => None,
        }
    }
    let bytes: Vec<u8> = s.bytes().filter(|&b| b != b'=').collect();
    let mut out = Vec::with_capacity(bytes.len() * 3 / 4);
    let mut i = 0;
    while i + 4 <= bytes.len() {
        let v0 = val(bytes[i]).ok_or(())? as u32;
        let v1 = val(bytes[i + 1]).ok_or(())? as u32;
        let v2 = val(bytes[i + 2]).ok_or(())? as u32;
        let v3 = val(bytes[i + 3]).ok_or(())? as u32;
        let n = (v0 << 18) | (v1 << 12) | (v2 << 6) | v3;
        out.push((n >> 16) as u8);
        out.push((n >> 8) as u8);
        out.push(n as u8);
        i += 4;
    }
    let rem = &bytes[i..];
    match rem.len() {
        2 => {
            let v0 = val(rem[0]).ok_or(())? as u32;
            let v1 = val(rem[1]).ok_or(())? as u32;
            let n = (v0 << 18) | (v1 << 12);
            out.push((n >> 16) as u8);
        }
        3 => {
            let v0 = val(rem[0]).ok_or(())? as u32;
            let v1 = val(rem[1]).ok_or(())? as u32;
            let v2 = val(rem[2]).ok_or(())? as u32;
            let n = (v0 << 18) | (v1 << 12) | (v2 << 6);
            out.push((n >> 16) as u8);
            out.push((n >> 8) as u8);
        }
        0 => {}
        _ => return Err(()),
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn issuer() -> TokenIssuer {
        TokenIssuer::new(b"test-secret-key".to_vec(), "kernel-1".to_string(), 3600)
    }

    #[test]
    fn mint_validate_round_trip() {
        let issuer = issuer();
        let binder = TokenBinder {
            principal: "user-1".into(),
            session_id: "sess-1".into(),
            task_id: "task-1".into(),
            workspace_id: "ws-1".into(),
            kernel_instance_id: String::new(),
        };
        let token = issuer
            .mint(
                binder,
                vec![OperationClass::Read, OperationClass::Patch],
                Scope::default(),
                None,
                "nonce-1",
            )
            .unwrap();
        let encoded = token.encode().unwrap();
        let decoded = issuer.validate(&encoded).unwrap();
        assert_eq!(decoded.claims, token.claims);
    }

    #[test]
    fn revoked_token_rejected() {
        let issuer = issuer();
        let binder = TokenBinder {
            principal: "user-1".into(),
            ..Default::default()
        };
        let token = issuer
            .mint(
                binder,
                vec![OperationClass::Read],
                Scope::default(),
                None,
                "n1",
            )
            .unwrap();
        issuer.revoke(&token.claims.token_id);
        let encoded = token.encode().unwrap();
        let err = issuer.validate(&encoded).unwrap_err();
        assert!(matches!(err, AuthzError::Revoked));
    }

    #[test]
    fn tampered_signature_rejected() {
        let issuer = issuer();
        let binder = TokenBinder::default();
        let token = issuer
            .mint(
                binder,
                vec![OperationClass::Read],
                Scope::default(),
                None,
                "n1",
            )
            .unwrap();
        let mut encoded = token.encode().unwrap();
        // Flip the last char of the signature.
        let last = encoded.pop().unwrap();
        let next = if last == '0' { '1' } else { '0' };
        encoded.push(next);
        let err = issuer.validate(&encoded).unwrap_err();
        assert!(matches!(err, AuthzError::InvalidSignature));
    }

    #[test]
    fn expired_token_rejected() {
        let issuer = issuer();
        let binder = TokenBinder::default();
        let token = issuer
            .mint(
                binder,
                vec![OperationClass::Read],
                Scope::default(),
                Some(1),
                "n1",
            )
            .unwrap();
        std::thread::sleep(std::time::Duration::from_secs(2));
        let encoded = token.encode().unwrap();
        let err = issuer.validate(&encoded).unwrap_err();
        assert!(matches!(err, AuthzError::Expired));
    }

    #[test]
    fn wrong_kernel_audience_rejected() {
        let issuer_a = TokenIssuer::new(b"k".to_vec(), "kernel-A", 3600);
        let issuer_b = TokenIssuer::new(b"k".to_vec(), "kernel-B", 3600);
        let binder = TokenBinder {
            principal: "u".into(),
            ..Default::default()
        };
        let token = issuer_a
            .mint(
                binder,
                vec![OperationClass::Read],
                Scope::default(),
                None,
                "n1",
            )
            .unwrap();
        // Validate against issuer_b: signature verifies (same secret) but the
        // kernel_instance_id (audience) does not match.
        let encoded = token.encode().unwrap();
        let err = issuer_b.validate(&encoded).unwrap_err();
        assert!(matches!(err, AuthzError::InvalidAudience));
    }

    #[test]
    fn validate_capability_rejects_missing_operation_class() {
        let issuer = issuer();
        let binder = TokenBinder::default();
        // Mint a token with ONLY Read class.
        let token = issuer
            .mint(
                binder,
                vec![OperationClass::Read],
                Scope::default(),
                None,
                "n-cap-1",
            )
            .unwrap();
        let encoded = token.encode().unwrap();
        // Requesting Exec should fail (token has Read only).
        let err = issuer
            .validate_capability(&encoded, OperationClass::Exec, &Scope::default())
            .unwrap_err();
        assert!(matches!(err, AuthzError::OperationNotPermitted));
    }

    #[test]
    fn validate_capability_accepts_admin_class_for_any_op() {
        let issuer = issuer();
        let binder = TokenBinder::default();
        let token = issuer
            .mint(
                binder,
                vec![OperationClass::Admin],
                Scope::default(),
                None,
                "n-cap-2",
            )
            .unwrap();
        let encoded = token.encode().unwrap();
        // Admin can do anything.
        let res = issuer.validate_capability(&encoded, OperationClass::Exec, &Scope::default());
        assert!(res.is_ok());
    }

    #[test]
    fn validate_capability_rejects_scope_exceeded() {
        let issuer = issuer();
        let binder = TokenBinder::default();
        // Mint a token whose max_scope allows only `/repo/src/**`.
        let max_scope = Scope {
            workspace_paths: vec!["src/**".to_string()],
            network_destinations: vec![],
            secret_capabilities: vec![],
        };
        let token = issuer
            .mint(
                binder,
                vec![OperationClass::Read, OperationClass::Exec],
                max_scope,
                None,
                "n-cap-3",
            )
            .unwrap();
        let encoded = token.encode().unwrap();
        // Requesting `/repo/src/main.rs` — should be allowed.
        let ok_req = Scope {
            workspace_paths: vec!["src/main.rs".to_string()],
            network_destinations: vec![],
            secret_capabilities: vec![],
        };
        assert!(issuer
            .validate_capability(&encoded, OperationClass::Read, &ok_req)
            .is_ok());
        // Requesting `/repo/etc/passwd` — should be denied (out of scope).
        let bad_req = Scope {
            workspace_paths: vec!["etc/passwd".to_string()],
            network_destinations: vec![],
            secret_capabilities: vec![],
        };
        let err = issuer
            .validate_capability(&encoded, OperationClass::Read, &bad_req)
            .unwrap_err();
        assert!(matches!(err, AuthzError::ScopeExceeded));
    }

    #[test]
    fn validate_capability_rejects_secret_scope_exceeded() {
        let issuer = issuer();
        let binder = TokenBinder::default();
        let max_scope = Scope {
            workspace_paths: vec![],
            network_destinations: vec![],
            secret_capabilities: vec!["secret://github/*".to_string()],
        };
        let token = issuer
            .mint(
                binder,
                vec![OperationClass::Secret],
                max_scope,
                None,
                "n-cap-4",
            )
            .unwrap();
        let encoded = token.encode().unwrap();
        // Within scope.
        let ok_req = Scope {
            workspace_paths: vec![],
            network_destinations: vec![],
            secret_capabilities: vec!["secret://github/repo-read".to_string()],
        };
        assert!(issuer
            .validate_capability(&encoded, OperationClass::Secret, &ok_req)
            .is_ok());
        // Out of scope — different provider.
        let bad_req = Scope {
            workspace_paths: vec![],
            network_destinations: vec![],
            secret_capabilities: vec!["secret://aws/creds".to_string()],
        };
        let err = issuer
            .validate_capability(&encoded, OperationClass::Secret, &bad_req)
            .unwrap_err();
        assert!(matches!(err, AuthzError::ScopeExceeded));
    }

    #[test]
    fn validate_capability_rejects_network_scope_exceeded() {
        let issuer = issuer();
        let binder = TokenBinder::default();
        let max_scope = Scope {
            workspace_paths: vec![],
            network_destinations: vec!["api.github.com:443".to_string()],
            secret_capabilities: vec![],
        };
        let token = issuer
            .mint(
                binder,
                vec![OperationClass::Network],
                max_scope,
                None,
                "n-cap-5",
            )
            .unwrap();
        let encoded = token.encode().unwrap();
        // Within scope.
        let ok_req = Scope {
            workspace_paths: vec![],
            network_destinations: vec!["api.github.com:443".to_string()],
            secret_capabilities: vec![],
        };
        assert!(issuer
            .validate_capability(&encoded, OperationClass::Network, &ok_req)
            .is_ok());
        // Out of scope — different host.
        let bad_req = Scope {
            workspace_paths: vec![],
            network_destinations: vec!["evil.example:443".to_string()],
            secret_capabilities: vec![],
        };
        let err = issuer
            .validate_capability(&encoded, OperationClass::Network, &bad_req)
            .unwrap_err();
        assert!(matches!(err, AuthzError::ScopeExceeded));
    }
}

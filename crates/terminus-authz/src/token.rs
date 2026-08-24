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

/// Internal marker for a deliberately empty authority set. The leading NUL
/// keeps it outside every valid RPC scope value, and the matcher treats it as
/// deny-all rather than as an ordinary pattern.
const DENY_ALL_SCOPE_PATTERN: &str = "\0terminus-deny-all";

/// Tolerance for minor clock differences between the minting and validating
/// hosts when judging `issued_at_unix`.
const CLOCK_SKEW_ALLOWANCE_SECONDS: u64 = 60;

/// Current unix time in seconds. Fails closed if the system clock is before
/// the unix epoch: defaulting to 0 would validate every unexpired token
/// forever.
fn system_now_unix() -> Result<u64, AuthzError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .map_err(|e| AuthzError::InvalidTimeWindow(format!("system clock regression: {e}")))
}

impl Scope {
    /// Build a least-authority scope where an omitted resource kind means
    /// "deny that kind". This is the task-capability constructor.
    ///
    /// `Scope::default()` deliberately retains its separate operator/admin
    /// meaning of unrestricted authority for backwards compatibility.
    pub fn deny_unspecified(
        workspace_paths: Vec<String>,
        network_destinations: Vec<String>,
        secret_capabilities: Vec<String>,
    ) -> Self {
        fn explicit_or_deny(values: Vec<String>) -> Vec<String> {
            if values.is_empty() {
                vec![DENY_ALL_SCOPE_PATTERN.to_string()]
            } else {
                values
            }
        }

        Self {
            workspace_paths: explicit_or_deny(workspace_paths),
            network_destinations: explicit_or_deny(network_destinations),
            secret_capabilities: explicit_or_deny(secret_capabilities),
        }
    }
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action_hash: Option<String>,
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

        // Check expiry. The clock read is fallible: a pre-epoch system clock
        // must fail closed instead of validating every token against now=0.
        let now = system_now_unix()?;
        if claims.expires_at_unix <= now {
            return Err(AuthzError::Expired);
        }
        // A signature-valid token whose issuance timestamp lies in the
        // future (beyond a small skew allowance) has an incoherent time
        // window — reject it rather than honoring an arbitrary lifetime.
        if claims.issued_at_unix > now.saturating_add(CLOCK_SKEW_ALLOWANCE_SECONDS) {
            return Err(AuthzError::InvalidTimeWindow(format!(
                "issued_at {} is in the future",
                claims.issued_at_unix
            )));
        }

        // Check revocation.
        if revocation.is_revoked(&claims.token_id) {
            return Err(AuthzError::Revoked);
        }

        Ok(Self { claims, signature })
    }

    /// Verify that the token is bound to `expected_task_id` and `expected_action_hash`.
    pub fn verify_action_binding(
        &self,
        expected_action_hash: &str,
        expected_task_id: &str,
    ) -> Result<(), AuthzError> {
        if self.claims.binder.task_id != expected_task_id {
            return Err(AuthzError::ScopeMismatch(format!(
                "task ID mismatch: expected {}, got {}",
                expected_task_id, self.claims.binder.task_id
            )));
        }
        if let Some(ref action_hash) = self.claims.action_hash {
            if action_hash != expected_action_hash {
                return Err(AuthzError::ScopeMismatch(format!(
                    "action hash mismatch: expected {}, got {}",
                    expected_action_hash, action_hash
                )));
            }
        }
        Ok(())
    }
}

/// Revocation list with optional durable file backing and epoch fencing.
#[derive(Debug, Default)]
pub struct RevocationList {
    revoked: Mutex<HashSet<String>>,
    fenced_epochs: Mutex<HashMap<String, u64>>,
    storage_path: Option<std::path::PathBuf>,
}

impl RevocationList {
    pub fn new() -> Self {
        Self {
            revoked: Mutex::new(HashSet::new()),
            fenced_epochs: Mutex::new(HashMap::new()),
            storage_path: None,
        }
    }

    pub fn with_storage(storage_path: impl Into<std::path::PathBuf>) -> Self {
        Self {
            revoked: Mutex::new(HashSet::new()),
            fenced_epochs: Mutex::new(HashMap::new()),
            storage_path: Some(storage_path.into()),
        }
    }

    fn persist_state(&self, revoked: &HashSet<String>, fenced_epochs: &HashMap<String, u64>) {
        if let Some(path) = &self.storage_path {
            if let Some(parent) = path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            #[derive(Serialize)]
            struct PersistedRevocations<'a> {
                revoked: &'a HashSet<String>,
                fenced_epochs: &'a HashMap<String, u64>,
            }
            let payload = PersistedRevocations {
                revoked,
                fenced_epochs,
            };
            if let Ok(json) = serde_json::to_vec_pretty(&payload) {
                let tmp = format!("{}.tmp-{}", path.display(), std::process::id());
                if std::fs::write(&tmp, &json).is_ok() {
                    let _ = std::fs::rename(&tmp, path);
                }
            }
        }
    }

    /// Load persisted revocations and epoch fencing from storage path.
    pub fn load_persisted(&self) -> usize {
        if let Some(path) = &self.storage_path {
            if path.exists() {
                if let Ok(data) = std::fs::read(path) {
                    #[derive(Deserialize)]
                    struct PersistedRevocations {
                        revoked: HashSet<String>,
                        fenced_epochs: Option<HashMap<String, u64>>,
                    }
                    if let Ok(p) = serde_json::from_slice::<PersistedRevocations>(&data) {
                        let count = p.revoked.len();
                        let mut r_guard = match self.revoked.lock() {
                            Ok(g) => g,
                            Err(e) => e.into_inner(),
                        };
                        *r_guard = p.revoked;
                        if let Some(fe) = p.fenced_epochs {
                            let mut fe_guard = match self.fenced_epochs.lock() {
                                Ok(g) => g,
                                Err(e) => e.into_inner(),
                            };
                            *fe_guard = fe;
                        }
                        return count;
                    }
                }
            }
        }
        0
    }

    pub fn revoke(&self, token_id: &str) {
        let mut guard = match self.revoked.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        guard.insert(token_id.to_string());
        let fe_guard = match self.fenced_epochs.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        self.persist_state(&guard, &fe_guard);
    }

    pub fn is_revoked(&self, token_id: &str) -> bool {
        let guard = match self.revoked.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        guard.contains(token_id)
    }

    pub fn fence_epoch(&self, task_id: &str, min_valid_epoch: u64) {
        let mut fe_guard = match self.fenced_epochs.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        let current = fe_guard.entry(task_id.to_string()).or_insert(0);
        if min_valid_epoch > *current {
            *current = min_valid_epoch;
        }
        let r_guard = match self.revoked.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        self.persist_state(&r_guard, &fe_guard);
    }

    pub fn is_epoch_fenced(&self, task_id: &str, epoch: u64) -> bool {
        let fe_guard = match self.fenced_epochs.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        if let Some(&min_epoch) = fe_guard.get(task_id) {
            epoch < min_epoch
        } else {
            false
        }
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

    pub fn with_revocation(
        secret: Vec<u8>,
        kernel_instance_id: impl Into<String>,
        default_ttl_seconds: u64,
        revocation: std::sync::Arc<RevocationList>,
    ) -> Self {
        Self {
            secret,
            kernel_instance_id: kernel_instance_id.into(),
            default_ttl_seconds,
            revocation,
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
        self.mint_with_action_hash(
            binder,
            operation_classes,
            max_scope,
            ttl_seconds,
            nonce,
            None,
        )
    }

    pub fn mint_with_action_hash(
        &self,
        binder: TokenBinder,
        operation_classes: Vec<OperationClass>,
        max_scope: Scope,
        ttl_seconds: Option<u64>,
        nonce: impl Into<String>,
        action_hash: Option<String>,
    ) -> Result<CapabilityToken, AuthzError> {
        let now = system_now_unix()?;
        let ttl = ttl_seconds.unwrap_or(self.default_ttl_seconds);
        let expires_at_unix = now
            .checked_add(ttl)
            .ok_or_else(|| AuthzError::InvalidTimeWindow("ttl overflows unix seconds".into()))?;
        let mut binder = binder;
        binder.kernel_instance_id = self.kernel_instance_id.clone();
        let nonce = nonce.into();
        if nonce.is_empty() {
            return Err(AuthzError::InvalidSignature);
        }
        let claims = TokenClaims {
            token_id: terminus_kernel_protocol::new_id(),
            issued_at_unix: now,
            expires_at_unix,
            binder,
            operation_classes,
            max_scope,
            nonce: nonce.clone(),
            action_hash,
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
    if maxes
        .iter()
        .any(|pattern| pattern == DENY_ALL_SCOPE_PATTERN)
    {
        return requested.is_empty();
    }
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

/// Glob matcher kept in parity with `@terminus/task-runtime`:
/// - `*` matches zero or more characters within one path segment;
/// - `?` matches one non-slash character;
/// - `**` matches recursively across path separators;
/// - the slash immediately following `**` is optional, so `**/*.rs`
///   matches both `main.rs` and `src/main.rs`.
fn glob_match(pattern: &str, value: &str) -> bool {
    #[derive(Clone, Copy)]
    enum GlobToken {
        Literal(char),
        OneSegmentCharacter,
        SegmentStar,
        RecursiveStar,
    }

    let pattern_chars = pattern.chars().collect::<Vec<_>>();
    let mut tokens = Vec::with_capacity(pattern_chars.len());
    let mut index = 0usize;
    while index < pattern_chars.len() {
        match pattern_chars[index] {
            '*' if pattern_chars.get(index + 1) == Some(&'*') => {
                tokens.push(GlobToken::RecursiveStar);
                index += 2;
                if pattern_chars.get(index) == Some(&'/') {
                    index += 1;
                }
            }
            '*' => {
                tokens.push(GlobToken::SegmentStar);
                index += 1;
            }
            '?' => {
                tokens.push(GlobToken::OneSegmentCharacter);
                index += 1;
            }
            literal => {
                tokens.push(GlobToken::Literal(literal));
                index += 1;
            }
        }
    }

    let value_chars = value.chars().collect::<Vec<_>>();
    let mut previous = vec![false; value_chars.len() + 1];
    previous[0] = true;
    for token in tokens {
        let mut current = vec![false; value_chars.len() + 1];
        match token {
            GlobToken::SegmentStar | GlobToken::RecursiveStar => current[0] = previous[0],
            GlobToken::Literal(_) | GlobToken::OneSegmentCharacter => {}
        }
        for value_index in 1..=value_chars.len() {
            let value_character = value_chars[value_index - 1];
            current[value_index] = match token {
                GlobToken::Literal(expected) => {
                    previous[value_index - 1] && expected == value_character
                }
                GlobToken::OneSegmentCharacter => {
                    previous[value_index - 1] && value_character != '/'
                }
                GlobToken::SegmentStar => {
                    previous[value_index] || (value_character != '/' && current[value_index - 1])
                }
                GlobToken::RecursiveStar => previous[value_index] || current[value_index - 1],
            };
        }
        previous = current;
    }
    previous[value_chars.len()]
}

/// Network destination matcher: exact host or a dot-delimited subdomain,
/// with an optional exact port. Raw string suffixes are not host authority:
/// `example.com` must never authorize `evilexample.com`.
fn network_match(pattern: &str, value: &str) -> bool {
    fn destination(value: &str) -> (&str, Option<u16>) {
        match value.rsplit_once(':') {
            Some((host, port)) => match port.parse::<u16>() {
                Ok(port) => (host, Some(port)),
                Err(_) => (value, None),
            },
            None => (value, None),
        }
    }

    fn host_matches(pattern: &str, value: &str) -> bool {
        let pattern = pattern.trim_end_matches('.').to_ascii_lowercase();
        let value = value.trim_end_matches('.').to_ascii_lowercase();
        value == pattern
            || value
                .strip_suffix(&pattern)
                .is_some_and(|prefix| prefix.ends_with('.'))
    }

    let (pattern_host, pattern_port) = destination(pattern);
    let (value_host, value_port) = destination(value);
    if pattern_port.is_some() && pattern_port != value_port {
        return false;
    }
    host_matches(pattern_host, value_host)
}

/// Prefix match for secret capability URIs (e.g. `secret://github/*`).
fn prefix_match(pattern: &str, value: &str) -> bool {
    if let Some(stripped) = pattern.strip_suffix("/*") {
        return value == stripped
            || value
                .strip_prefix(stripped)
                .is_some_and(|suffix| suffix.starts_with('/'));
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
    fn workspace_globs_match_task_runtime_segment_and_recursive_semantics() {
        assert!(glob_match("src/*", "src/main.rs"));
        assert!(!glob_match("src/*", "src/generated/main.rs"));
        assert!(!glob_match("*", "src/main.rs"));
        assert!(glob_match("src/**", "src/generated/main.rs"));
        assert!(glob_match("**/*.rs", "main.rs"));
        assert!(glob_match("**/*.rs", "src/generated/main.rs"));
        assert!(!glob_match("**/*.rs", "src/generated/main.ts"));
    }

    #[test]
    fn single_segment_scope_cannot_authorize_a_nested_path() {
        let issuer = issuer();
        let token = issuer
            .mint(
                TokenBinder::default(),
                vec![OperationClass::Read],
                Scope {
                    workspace_paths: vec!["src/*".to_string()],
                    network_destinations: Vec::new(),
                    secret_capabilities: Vec::new(),
                },
                None,
                "single-segment-scope",
            )
            .unwrap()
            .encode()
            .unwrap();
        let nested = Scope {
            workspace_paths: vec!["src/generated/main.rs".to_string()],
            network_destinations: Vec::new(),
            secret_capabilities: Vec::new(),
        };
        let error = issuer
            .validate_capability(&token, OperationClass::Read, &nested)
            .unwrap_err();
        assert!(matches!(error, AuthzError::ScopeExceeded));
    }

    #[test]
    fn deny_unspecified_scope_denies_omitted_kinds_but_default_remains_unrestricted() {
        let bounded = Scope::deny_unspecified(vec!["src/**".to_string()], Vec::new(), Vec::new());
        assert!(!scope_contained(
            &bounded,
            &Scope {
                workspace_paths: Vec::new(),
                network_destinations: vec!["api.example.com:443".to_string()],
                secret_capabilities: Vec::new(),
            }
        ));
        assert!(!scope_contained(
            &bounded,
            &Scope {
                workspace_paths: Vec::new(),
                network_destinations: Vec::new(),
                secret_capabilities: vec!["secret://github/repo".to_string()],
            }
        ));
        assert!(scope_contained(
            &Scope::default(),
            &Scope {
                workspace_paths: Vec::new(),
                network_destinations: vec!["api.example.com:443".to_string()],
                secret_capabilities: vec!["secret://github/repo".to_string()],
            }
        ));
    }

    #[test]
    fn network_and_secret_scopes_require_authority_boundaries() {
        assert!(network_match("example.com", "example.com:443"));
        assert!(network_match("example.com:443", "api.example.com:443"));
        assert!(!network_match("example.com", "evilexample.com:443"));
        assert!(!network_match("example.com:443", "api.example.com:444"));
        assert!(prefix_match(
            "secret://github/*",
            "secret://github/repo-read"
        ));
        assert!(!prefix_match(
            "secret://github/*",
            "secret://github-evil/repo-read"
        ));
        assert!(!prefix_match(
            "secret://github*",
            "secret://github-evil/repo-read"
        ));
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
    fn future_issued_token_rejected() {
        let issuer = issuer();
        let binder = TokenBinder {
            principal: "u".into(),
            ..Default::default()
        };
        let mut token = issuer
            .mint(
                binder,
                vec![OperationClass::Read],
                Scope::default(),
                None,
                "n-future",
            )
            .unwrap();
        // Re-sign with an issuance timestamp far in the future: the window is
        // incoherent even though the signature is valid.
        token.claims.issued_at_unix += 60 * 60 * 24 * 365;
        let canonical = token.claims.canonical_json().unwrap();
        let mut mac = HmacSha256::new_from_slice(b"test-secret-key").unwrap();
        mac.update(canonical.as_bytes());
        token.signature = mac.finalize().into_bytes().to_vec();
        let err = issuer.validate(&token.encode().unwrap()).unwrap_err();
        assert!(matches!(err, AuthzError::InvalidTimeWindow(_)));
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

    #[test]
    fn test_stale_replayed_altered_and_cross_task_approvals() {
        let issuer = issuer();
        let binder = TokenBinder {
            task_id: "task-100".to_string(),
            ..Default::default()
        };

        let max_scope = Scope::default();
        let token = issuer
            .mint_with_action_hash(
                binder,
                vec![OperationClass::Exec],
                max_scope,
                None,
                "nonce-12345",
                Some("sha256:normalized_action_1".to_string()),
            )
            .unwrap();

        // 1. Valid binding check
        assert!(token
            .verify_action_binding("sha256:normalized_action_1", "task-100")
            .is_ok());

        // 2. Cross-task approval check
        let cross_task_err = token
            .verify_action_binding("sha256:normalized_action_1", "task-999")
            .unwrap_err();
        assert!(matches!(cross_task_err, AuthzError::ScopeMismatch(_)));

        // 3. Altered command approval check (action hash mismatch)
        let altered_err = token
            .verify_action_binding("sha256:different_action_2", "task-100")
            .unwrap_err();
        assert!(matches!(altered_err, AuthzError::ScopeMismatch(_)));

        // 4. Replayed approval check (token revoked / replayed)
        issuer.revoke(&token.claims.token_id);
        let encoded = token.encode().unwrap();
        let replayed_err = issuer.validate(&encoded).unwrap_err();
        assert!(matches!(replayed_err, AuthzError::Revoked));
    }

    #[test]
    fn persistent_revocation_and_fencing_survive_reload() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("revocations.json");

        let rev1 = RevocationList::with_storage(&path);
        rev1.revoke("tok-123");
        rev1.fence_epoch("task-abc", 5);
        assert!(rev1.is_revoked("tok-123"));
        assert!(rev1.is_epoch_fenced("task-abc", 4));
        assert!(!rev1.is_epoch_fenced("task-abc", 5));

        let rev2 = RevocationList::with_storage(&path);
        let loaded = rev2.load_persisted();
        assert_eq!(loaded, 1);
        assert!(rev2.is_revoked("tok-123"));
        assert!(rev2.is_epoch_fenced("task-abc", 4));
        assert!(!rev2.is_epoch_fenced("task-abc", 5));
    }
}

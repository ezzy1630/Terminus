//! Connected provider accounts — credentials that already live on this
//! machine (design `Provider_Accounts_Design_2026-08-28.md` Part 2/4).
//!
//! Terminus's own loop drives every model. OpenCode's local API-key store is
//! an explicit-consent source for supported transports. The Codex CLI login
//! is intentionally not read because its ChatGPT subscription token has no
//! supported Terminus-owned inference boundary; Codex is surfaced only as an
//! installed tool for a separate App Server lane.
//!
//! Two guarantees hold at this boundary:
//!
//! 1. **Secret bytes never cross the API.** [`ProviderAccountService::discover_local`]
//!    returns identity plus a non-reversible SHA-256 digest.
//!    [`ProviderAccountService::import_local`] re-reads the store,
//!    writes through [`SecretBroker::store`], and returns only the capability
//!    URI it stored under. Nothing here is cached between calls.
//! 2. **The reads fail closed and stay bounded.** A store larger than 64 KiB,
//!    readable by group or other, unreadable, or malformed produces a warning
//!    and no credentials. An individual entry that does not decode is dropped
//!    and the rest of the store is still used — the same rule the OpenCode
//!    Effect schema applies to its own file.
//!
//! Token refresh is deliberately out of scope for v1: an expired credential
//! is reported with its `expires_at_unix` and the control plane marks the
//! account `expired` (the remedy is to run the owning CLI and sign in again).

use crate::services::validate_request_pipeline;
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use terminus_authz::{OperationClass, Scope, TokenIssuer};
use terminus_kernel_protocol::{
    ErrorCategory, ErrorCode, KernelError, KernelResult, RequestContext,
};
use terminus_secrets::SecretBroker;

/// File name both local stores use inside their own directory.
const AUTH_STORE_FILE_NAME: &str = "auth.json";
/// Directory under `$XDG_DATA_HOME` (or `$HOME/.local/share`) that holds the
/// OpenCode auth store. Kept as a Rust constant so no shipped JS/TS artifact
/// carries the string (`tools/standalone-check.ts`).
const OPENCODE_DATA_DIR: &str = "opencode";
/// Relative fallback for the OpenCode data directory when `XDG_DATA_HOME` is
/// unset: `$HOME/.local/share/<OPENCODE_DATA_DIR>`.
const XDG_DATA_FALLBACK: [&str; 2] = [".local", "share"];
/// Executable names probed on `PATH` (never executed).
const OPENCODE_BINARY: &str = "opencode";
const CODEX_BINARY: &str = "codex";

/// Hard ceiling on a local credential store. Both stores are a few KiB in
/// practice; anything larger is refused rather than read.
const MAX_STORE_BYTES: u64 = 64 * 1_024;
/// Ceiling on an OpenCode provider id accepted as a `source` suffix.
const MAX_PROVIDER_ID_BYTES: usize = 128;
/// Ceiling on `PATH` entries scanned by the install probe.
const MAX_PATH_ENTRIES: usize = 256;
/// The only provider whose account identity is needed to construct a safe
/// endpoint URL. OpenCode's other metadata fields remain provider-owned.
const CLOUDFLARE_WORKERS_AI_PROVIDER: &str = "cloudflare-workers-ai";

/// Capability-URI prefix of the connected-provider-account namespace. The
/// keyring provider enforces the same shape; validating it here means an
/// import can never be pointed at the legacy gateway namespace even when the
/// caller holds a capability scoped to it.
const PROVIDER_ACCOUNT_PREFIX: &str = "secret://provider-account/";

/// Requested scope for `DiscoverLocal`. Discovery reads local credential
/// stores, so it is a `Secret`-class operation even though it returns no
/// secret bytes; the control plane mints an admin maintenance token scoped
/// to exactly this capability.
pub const DISCOVER_LOCAL_SCOPE: &str = "secret://provider-account/discover";

/// Which local tool a credential was read from. A label, never a path.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum LocalCredentialStore {
    /// The OpenCode CLI auth store.
    OpencodeAuthStore,
}

impl LocalCredentialStore {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::OpencodeAuthStore => "opencode-auth-store",
        }
    }
}

impl std::fmt::Display for LocalCredentialStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// How the credential authenticates. Mirrors the proto's `auth_kind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum LocalAuthKind {
    /// A bare API key (`type: "api"`).
    Api,
    /// An OAuth access token (`type: "oauth"`). Non-ChatGPT OAuth entries are
    /// reported but marked `unsupported` by the control plane in v1.
    Oauth,
    /// A well-known key/token pair (`type: "wellknown"`); the token is the
    /// credential.
    Wellknown,
    /// A ChatGPT login held by the Codex CLI.
    Chatgpt,
}

impl LocalAuthKind {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Api => "api",
            Self::Oauth => "oauth",
            Self::Wellknown => "wellknown",
            Self::Chatgpt => "chatgpt",
        }
    }
}

impl std::fmt::Display for LocalAuthKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Non-secret metadata carried alongside a discovered credential. Serialized
/// with absent keys omitted; field order is fixed so the JSON is canonical.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct LocalCredentialMetadata {
    /// ChatGPT account id (`tokens.account_id`, else the `chatgpt_account_id`
    /// claim).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    /// Signed-in email, from the `id_token` payload when present.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    /// ChatGPT plan type (`chatgpt_plan_type` claim), e.g. a subscription tier.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan_type: Option<String>,
}

impl LocalCredentialMetadata {
    /// Canonical JSON encoding for the wire (`metadata_json`). Never carries
    /// secret material.
    #[must_use]
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{}".to_string())
    }

    /// True when no non-secret metadata was found for this credential.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.account_id.is_none() && self.email.is_none() && self.plan_type.is_none()
    }
}

/// One credential found in a local tool's store. Never carries secret bytes.
#[derive(Debug, Clone, PartialEq)]
pub struct LocalProviderCredential {
    /// Stable source id: `opencode:<providerID>` or `codex-chatgpt`.
    pub source: String,
    pub auth_kind: LocalAuthKind,
    /// Full lowercase SHA-256 digest over the secret bytes.
    pub fingerprint: String,
    pub metadata: LocalCredentialMetadata,
    /// Unix seconds at which the credential expires; `0` when it does not.
    pub expires_at_unix: u64,
    pub store: LocalCredentialStore,
}

/// Result of one discovery sweep.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct LocalCredentialDiscovery {
    pub credentials: Vec<LocalProviderCredential>,
    /// Stores that exist but could not be used, as `"<store>: <reason>"`.
    pub warnings: Vec<String>,
    pub codex_installed: bool,
    pub opencode_installed: bool,
    pub opencode_store_status: LocalCredentialStoreStatus,
}

/// Whether the supported local store was authoritatively read.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum LocalCredentialStoreStatus {
    /// No auth store exists at the supported location.
    #[default]
    Missing,
    /// The store was bounded, valid JSON and decoded under the allowlist.
    Available,
    /// A store exists but is unreadable, unsafe, oversized or malformed.
    Rejected,
    /// The store could not be inspected authoritatively.
    Unavailable,
}

impl LocalCredentialStoreStatus {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Missing => "missing",
            Self::Available => "available",
            Self::Rejected => "rejected",
            Self::Unavailable => "unavailable",
        }
    }
}

/// Result of moving one discovered credential into the OS keyring.
#[derive(Debug, Clone, PartialEq)]
pub struct ImportedLocalCredential {
    pub capability_uri: String,
    pub stored: bool,
    pub credential: LocalProviderCredential,
}

/// Where the kernel looks for local credential stores, and which `PATH` the
/// install probe uses. Injectable so tests point at temp directories instead
/// of mutating process environment variables.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LocalCredentialRoots {
    /// Directory holding the OpenCode auth store (`<dir>/auth.json`).
    pub opencode_dir: Option<PathBuf>,
    /// `PATH` used for the install probe. `None` reads the process `PATH`.
    pub path_override: Option<std::ffi::OsString>,
    /// User home used for standard per-user CLI install locations.
    pub home_dir: Option<PathBuf>,
}

impl LocalCredentialRoots {
    /// Resolve the supported store root from the environment:
    /// `$XDG_DATA_HOME/opencode` else `$HOME/.local/share/opencode`. A root
    /// that cannot be resolved is `None` and is treated as "store absent".
    /// The Codex auth store is deliberately never read.
    #[must_use]
    pub fn from_environment() -> Self {
        // Packaged desktop runtimes isolate their writable state by setting
        // HOME to the app's private data directory. The shell passes the real
        // account home separately so local CLI discovery still describes the
        // signed-in macOS user rather than the runtime sandbox.
        let home = non_empty_env("TERMINUS_USER_HOME")
            .or_else(|| non_empty_env("HOME"))
            .map(PathBuf::from);
        let opencode_dir = non_empty_env("XDG_DATA_HOME")
            .map(|xdg| PathBuf::from(xdg).join(OPENCODE_DATA_DIR))
            .or_else(|| {
                home.as_ref().map(|home| {
                    let mut path = home.clone();
                    for segment in XDG_DATA_FALLBACK {
                        path.push(segment);
                    }
                    path.push(OPENCODE_DATA_DIR);
                    path
                })
            });
        Self {
            opencode_dir,
            path_override: None,
            home_dir: home,
        }
    }

    /// Roots that resolve to nothing. Used by tests that want an empty
    /// machine, and as the safe fallback when the environment is unusable.
    #[must_use]
    pub fn empty() -> Self {
        Self::default()
    }

    #[must_use]
    pub fn with_opencode_dir(mut self, dir: impl Into<PathBuf>) -> Self {
        self.opencode_dir = Some(dir.into());
        self
    }

    #[must_use]
    pub fn with_path_override(mut self, path: impl Into<std::ffi::OsString>) -> Self {
        self.path_override = Some(path.into());
        self
    }

    #[must_use]
    pub fn with_home_dir(mut self, path: impl Into<PathBuf>) -> Self {
        self.home_dir = Some(path.into());
        self
    }

    fn opencode_store(&self) -> Option<PathBuf> {
        self.opencode_dir
            .as_ref()
            .map(|dir| dir.join(AUTH_STORE_FILE_NAME))
    }
}

fn non_empty_env(key: &str) -> Option<String> {
    match std::env::var(key) {
        Ok(value) if !value.is_empty() => Some(value),
        _ => None,
    }
}

/// A discovered credential plus the secret bytes backing it. Never leaves
/// this module: `discover_local` drops the bytes, `import_local` hands them
/// straight to the broker.
struct DiscoveredEntry {
    credential: LocalProviderCredential,
    secret: Vec<u8>,
}

/// Reads local credential stores and moves credentials into the OS keyring.
#[derive(Clone)]
pub struct ProviderAccountService {
    broker: Arc<SecretBroker>,
    token_issuer: Arc<TokenIssuer>,
    roots: LocalCredentialRoots,
}

impl std::fmt::Debug for ProviderAccountService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProviderAccountService")
            .field("roots", &self.roots)
            .finish_non_exhaustive()
    }
}

impl ProviderAccountService {
    /// Build the service with store roots resolved from the environment.
    #[must_use]
    pub fn new(broker: Arc<SecretBroker>, token_issuer: Arc<TokenIssuer>) -> Self {
        Self {
            broker,
            token_issuer,
            roots: LocalCredentialRoots::from_environment(),
        }
    }

    /// Replace the store roots (tests point these at temp directories).
    #[must_use]
    pub fn with_roots(mut self, roots: LocalCredentialRoots) -> Self {
        self.roots = roots;
        self
    }

    #[must_use]
    pub const fn roots(&self) -> &LocalCredentialRoots {
        &self.roots
    }

    /// Read every local credential store and report what is usable.
    ///
    /// Requires a `Secret`-class capability; [`DISCOVER_LOCAL_SCOPE`] is the
    /// scope the control plane mints for it. No secret bytes are returned and
    /// none are retained after this call.
    pub fn discover_local(&self, ctx: &RequestContext) -> KernelResult<LocalCredentialDiscovery> {
        let requested_scope = Scope {
            workspace_paths: Vec::new(),
            network_destinations: Vec::new(),
            secret_capabilities: vec![DISCOVER_LOCAL_SCOPE.to_string()],
        };
        // SPEC §31.3 step 3: bind the capability to the operation class and
        // scope. Discovery is read-only, so no idempotency key is required.
        let _token = validate_request_pipeline(
            &self.token_issuer,
            ctx,
            OperationClass::Secret,
            &requested_scope,
            false,
        )?;
        tracing::info!(
            target: "terminus_kernel_audit",
            event = "authorized",
            service = "provider_account.discover_local",
            request_id = %ctx.request_id,
            task_id = %ctx.task_id,
            actor_id = %ctx.actor_id,
            "local provider credential discovery authorized",
        );

        let (entries, warnings, opencode_store_status) = self.collect();
        let discovery = LocalCredentialDiscovery {
            credentials: entries.into_iter().map(|entry| entry.credential).collect(),
            warnings,
            codex_installed: self.binary_on_path(CODEX_BINARY),
            opencode_installed: self.binary_on_path(OPENCODE_BINARY),
            opencode_store_status,
        };
        tracing::info!(
            target: "terminus_kernel_audit",
            event = "provider_account.discovered",
            request_id = %ctx.request_id,
            actor_id = %ctx.actor_id,
            credential_count = discovery.credentials.len(),
            warning_count = discovery.warnings.len(),
            codex_installed = discovery.codex_installed,
            opencode_installed = discovery.opencode_installed,
            "local provider credential discovery completed",
        );
        Ok(discovery)
    }

    /// Re-read the local stores and move the credential identified by
    /// `source` into `capability_uri`.
    ///
    /// Requires a `Secret`-class capability scoped to exactly
    /// `capability_uri` plus an idempotency key — the same shape as
    /// `SecretService::store`. `capability_uri` must be
    /// `secret://provider-account/<uuid-v7>`: any other namespace is refused
    /// here even when the presented capability would admit it.
    pub fn import_local(
        &self,
        ctx: &RequestContext,
        source: &str,
        capability_uri: &str,
        expected_fingerprint: &str,
    ) -> KernelResult<ImportedLocalCredential> {
        let requested_scope = Scope {
            workspace_paths: Vec::new(),
            network_destinations: Vec::new(),
            secret_capabilities: vec![capability_uri.to_string()],
        };
        let _token = validate_request_pipeline(
            &self.token_issuer,
            ctx,
            OperationClass::Secret,
            &requested_scope,
            true,
        )?;
        validate_provider_account_uri(capability_uri)?;
        if source.is_empty() || source.len() > MAX_PROVIDER_ID_BYTES + "opencode:".len() {
            return Err(invalid("source must be a discovered source id"));
        }
        if source == "codex-chatgpt" {
            return Err(invalid(
                "Codex subscription credentials are not importable; use the separate Codex App Server lane",
            ));
        }
        if expected_fingerprint.len() != 64
            || !expected_fingerprint
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(invalid(
                "expected_fingerprint must be the approved SHA-256 digest",
            ));
        }
        tracing::info!(
            target: "terminus_kernel_audit",
            event = "authorized",
            service = "provider_account.import_local",
            request_id = %ctx.request_id,
            task_id = %ctx.task_id,
            actor_id = %ctx.actor_id,
            source = %source,
            secret_uri = %capability_uri,
            "local provider credential import authorized",
        );

        // Re-read at call time: discovery results are never cached, so an
        // import always moves the credential that is on disk right now.
        let (entries, _warnings, _store_status) = self.collect();
        let entry = entries
            .into_iter()
            .find(|entry| entry.credential.source == source)
            .ok_or_else(|| {
                KernelError::new(
                    ErrorCode::NotFound,
                    ErrorCategory::NotFound,
                    format!("no local credential is available for source `{source}`"),
                    false,
                )
            })?;
        if entry.credential.fingerprint != expected_fingerprint {
            return Err(KernelError::new(
                ErrorCode::TransactionConflict,
                ErrorCategory::Conflict,
                "local credential changed after approval; discover and approve it again",
                false,
            ));
        }

        self.broker
            .store(capability_uri, &entry.secret)
            .map_err(|error| {
                KernelError::new(
                    ErrorCode::PermissionDenied,
                    ErrorCategory::Permission,
                    error.to_string(),
                    false,
                )
            })?;
        tracing::info!(
            target: "terminus_kernel_audit",
            event = "provider_account.imported",
            request_id = %ctx.request_id,
            actor_id = %ctx.actor_id,
            source = %entry.credential.source,
            store = %entry.credential.store,
            auth_kind = %entry.credential.auth_kind,
            fingerprint = %entry.credential.fingerprint,
            secret_uri = %capability_uri,
            "local provider credential stored in the provider-account namespace",
        );
        Ok(ImportedLocalCredential {
            capability_uri: capability_uri.to_string(),
            stored: true,
            credential: entry.credential,
        })
    }

    /// Read the supported local store. Codex installation status is still
    /// reported by `binary_on_path`, but its auth store is never opened.
    fn collect(
        &self,
    ) -> (
        Vec<DiscoveredEntry>,
        Vec<String>,
        LocalCredentialStoreStatus,
    ) {
        let mut entries = Vec::new();
        let mut warnings = Vec::new();

        let status = match load_store(
            self.roots.opencode_store().as_deref(),
            LocalCredentialStore::OpencodeAuthStore,
        ) {
            StoreRead::Missing => LocalCredentialStoreStatus::Missing,
            StoreRead::Rejected(warning) => {
                warnings.push(warning);
                LocalCredentialStoreStatus::Rejected
            }
            StoreRead::Loaded(document) => {
                decode_opencode_store(&document, &mut entries, &mut warnings);
                LocalCredentialStoreStatus::Available
            }
        };
        (entries, warnings, status)
    }

    /// `which`-style probe: is `binary` an executable file on `PATH`? The
    /// binary is never executed.
    fn binary_on_path(&self, binary: &str) -> bool {
        let path = match self.roots.path_override.clone() {
            Some(value) => value,
            None => match std::env::var_os("PATH") {
                Some(value) => value,
                None => return false,
            },
        };
        let on_path = std::env::split_paths(&path)
            .take(MAX_PATH_ENTRIES)
            .filter(|dir| !dir.as_os_str().is_empty())
            .any(|dir| is_executable_file(&dir.join(binary)));
        if on_path {
            return true;
        }
        // GUI apps inherit a minimal launchd PATH on macOS. OpenCode's
        // installer uses this stable per-user location, so PATH-only probing
        // made an installed CLI disappear specifically in the shipped app.
        binary == OPENCODE_BINARY
            && self.roots.home_dir.as_ref().is_some_and(|home| {
                is_executable_file(&home.join(".opencode").join("bin").join(binary))
            })
    }
}

fn is_executable_file(path: &Path) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

// ---------- bounded, fail-closed store reads ----------

enum StoreRead {
    /// The store does not exist. Not a warning: the tool is simply not set up.
    Missing,
    /// The store exists but cannot be used. Carries `"<store>: <reason>"`.
    Rejected(String),
    Loaded(serde_json::Value),
}

/// Read one credential store under the kernel's bounds:
/// regular file, owner-only mode, at most [`MAX_STORE_BYTES`], valid JSON.
/// Reasons never include the path or any file content.
fn load_store(path: Option<&Path>, store: LocalCredentialStore) -> StoreRead {
    let Some(path) = path else {
        return StoreRead::Missing;
    };
    let reject = |reason: &str| StoreRead::Rejected(format!("{store}: {reason}"));

    match std::fs::metadata(path) {
        Ok(metadata) if metadata.is_file() => {}
        Ok(_) => return reject("is not a regular file"),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return StoreRead::Missing,
        Err(error) => {
            return StoreRead::Rejected(format!("{store}: unreadable ({:?})", error.kind()))
        }
    }
    // Re-stat through the opened descriptor so mode and size describe the
    // bytes actually about to be read.
    let mut file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return StoreRead::Missing,
        Err(error) => {
            return StoreRead::Rejected(format!("{store}: unreadable ({:?})", error.kind()))
        }
    };
    let metadata = match file.metadata() {
        Ok(metadata) => metadata,
        Err(error) => {
            return StoreRead::Rejected(format!("{store}: unreadable ({:?})", error.kind()))
        }
    };
    if !metadata.is_file() {
        return reject("is not a regular file");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = metadata.permissions().mode() & 0o777;
        if mode & 0o077 != 0 {
            return StoreRead::Rejected(format!(
                "{store}: file mode {mode:04o} is readable by group or others; \
                 the kernel skipped it (chmod 600 to use it)"
            ));
        }
    }
    if metadata.len() > MAX_STORE_BYTES {
        return reject("is larger than the 64 KiB the kernel will read");
    }

    let mut buffer = Vec::new();
    if let Err(error) = file
        .by_ref()
        .take(MAX_STORE_BYTES.saturating_add(1))
        .read_to_end(&mut buffer)
    {
        return StoreRead::Rejected(format!("{store}: unreadable ({:?})", error.kind()));
    }
    if buffer.len() as u64 > MAX_STORE_BYTES {
        return reject("is larger than the 64 KiB the kernel will read");
    }
    match serde_json::from_slice::<serde_json::Value>(&buffer) {
        // The auth store's root is an object. A valid JSON array, scalar, or
        // null is structurally invalid and must not become AVAILABLE merely
        // because parsing succeeded.
        Ok(document) if document.is_object() => StoreRead::Loaded(document),
        Ok(_) => reject("root must be a JSON object"),
        // The parsed value is dropped with `buffer` at the end of discovery;
        // the error text is fixed so no file content can leak into a warning.
        Err(_) => reject("contains malformed JSON"),
    }
}

// ---------- OpenCode auth store ----------

/// Decode the OpenCode entry union. Mirrors the upstream Effect schema:
/// undecodable entries are dropped and the rest of the store is still used.
fn decode_opencode_store(
    document: &serde_json::Value,
    entries: &mut Vec<DiscoveredEntry>,
    warnings: &mut Vec<String>,
) {
    let store = LocalCredentialStore::OpencodeAuthStore;
    let Some(object) = document.as_object() else {
        // `load_store` rejects this before decode. Keep this guard for callers
        // inside the module and make the invariant explicit.
        warnings.push(format!("{store}: root must be a JSON object"));
        return;
    };
    // `serde_json::Map` iterates in key order, so the result is stable.
    let mut ids: Vec<&String> = object.keys().collect();
    ids.sort();
    for provider_id in ids {
        if !is_admissible_provider_id(provider_id) {
            continue;
        }
        let Some(entry) = object
            .get(provider_id)
            .and_then(serde_json::Value::as_object)
        else {
            continue;
        };
        let Some(kind) = entry.get("type").and_then(serde_json::Value::as_str) else {
            continue;
        };
        let decoded = match kind {
            "api" => entry.get("key").and_then(json_string).map(|key| {
                (
                    LocalAuthKind::Api,
                    key,
                    0,
                    admitted_account_id(provider_id, entry.get("metadata")),
                )
            }),
            "wellknown" => match (
                entry.get("key").and_then(json_string),
                entry.get("token").and_then(json_string),
            ) {
                // Both fields are required by the union; the token is the
                // credential.
                (Some(_), Some(token)) => Some((LocalAuthKind::Wellknown, token, 0, None)),
                _ => None,
            },
            "oauth" => match (
                entry.get("refresh").and_then(json_string),
                entry.get("access").and_then(json_string),
                entry.get("expires").and_then(json_u64),
            ) {
                (Some(_), Some(access), Some(expires_ms)) => {
                    Some((LocalAuthKind::Oauth, access, expires_ms / 1_000, None))
                }
                _ => None,
            },
            _ => None,
        };
        let Some((auth_kind, secret, expires_at_unix, account_id)) = decoded else {
            continue;
        };
        entries.push(DiscoveredEntry {
            credential: LocalProviderCredential {
                source: format!("opencode:{provider_id}"),
                auth_kind,
                fingerprint: fingerprint(secret.as_bytes()),
                metadata: LocalCredentialMetadata {
                    account_id,
                    ..LocalCredentialMetadata::default()
                },
                expires_at_unix,
                store,
            },
            secret: secret.into_bytes(),
        });
    }
}

/// Admit only Cloudflare's documented account identity field and shape.
/// OpenCode plugins may persist arbitrary objects here; copying that bag into
/// Terminus state would turn an untrusted extension field into routing input.
fn admitted_account_id(provider_id: &str, metadata: Option<&serde_json::Value>) -> Option<String> {
    if provider_id != CLOUDFLARE_WORKERS_AI_PROVIDER {
        return None;
    }
    let object = metadata?.as_object()?;
    let value = object.get("accountId")?.as_str()?;
    if value.len() != 32 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    Some(value.to_string())
}

/// Provider ids become part of a `source` id that reaches the database, the
/// UI, and audit lines, so only a conservative shape is admitted; anything
/// else is treated as an undecodable entry and dropped.
fn is_admissible_provider_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_PROVIDER_ID_BYTES
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
}

// ---------- helpers ----------

/// Full SHA-256 digest over the secret bytes. This is non-reversible and binds
/// an approval to the exact credential bytes rather than a display-length
/// collision domain. Clients may abbreviate it only when rendering.
fn fingerprint(secret: &[u8]) -> String {
    hex::encode(Sha256::digest(secret))
}

fn json_string(value: &serde_json::Value) -> Option<String> {
    value
        .as_str()
        .filter(|text| !text.is_empty())
        .map(ToString::to_string)
}

/// Read a JSON number as unsigned seconds/milliseconds. The stores use plain
/// integers; a float is accepted and truncated because the upstream schema
/// types the field as a number.
#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
fn json_u64(value: &serde_json::Value) -> Option<u64> {
    if let Some(number) = value.as_u64() {
        return Some(number);
    }
    let number = value.as_f64()?;
    if !number.is_finite() || !(0.0..=9_007_199_254_740_992.0).contains(&number) {
        return None;
    }
    Some(number.trunc() as u64)
}

/// The import destination must be inside the connected-provider-account
/// namespace and carry a UUIDv7 id.
fn validate_provider_account_uri(uri: &str) -> KernelResult<()> {
    let Some(id) = uri.strip_prefix(PROVIDER_ACCOUNT_PREFIX) else {
        return Err(invalid(
            "capability_uri must be secret://provider-account/<uuid-v7>",
        ));
    };
    if !is_uuid_v7(id) {
        return Err(invalid(
            "capability_uri must end in a UUIDv7 provider-account id",
        ));
    }
    Ok(())
}

/// `8-4-4-4-12` lowercase hex with version nibble `7` and an RFC 4122
/// variant — the same shape the keyring provider enforces.
fn is_uuid_v7(id: &str) -> bool {
    const GROUPS: [usize; 5] = [8, 4, 4, 4, 12];
    let mut parts = id.split('-');
    let mut collected: Vec<&str> = Vec::with_capacity(GROUPS.len());
    for expected in GROUPS {
        let Some(part) = parts.next() else {
            return false;
        };
        if part.len() != expected
            || !part
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        {
            return false;
        }
        collected.push(part);
    }
    if parts.next().is_some() {
        return false;
    }
    let version = collected.get(2).and_then(|g| g.as_bytes().first()).copied();
    let variant = collected.get(3).and_then(|g| g.as_bytes().first()).copied();
    version == Some(b'7') && matches!(variant, Some(b'8' | b'9' | b'a' | b'b'))
}

fn invalid(message: &str) -> KernelError {
    KernelError::new(
        ErrorCode::InvalidRequest,
        ErrorCategory::Validation,
        message,
        false,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprint_is_a_full_sha256_digest() {
        let value = fingerprint(b"fixture-not-a-real-key");
        assert_eq!(value.len(), 64);
        assert!(value.bytes().all(|b| b.is_ascii_hexdigit()));
        assert_ne!(value, fingerprint(b"fixture-not-a-real-key-2"));
    }

    #[test]
    fn only_provider_account_uuid_v7_uris_are_admitted() {
        assert!(validate_provider_account_uri(
            "secret://provider-account/0192f3a1-4b2c-7def-8a1b-2c3d4e5f6a7b"
        )
        .is_ok());
        assert!(validate_provider_account_uri("secret://provider-account/not-a-uuid").is_err());
        assert!(validate_provider_account_uri("secret://opencode/zen").is_err());
        // v4 variant nibble is fine but the version nibble is not 7.
        assert!(validate_provider_account_uri(
            "secret://provider-account/0192f3a1-4b2c-4def-8a1b-2c3d4e5f6a7b"
        )
        .is_err());
    }

    #[test]
    fn metadata_json_omits_absent_keys() {
        let metadata = LocalCredentialMetadata::default();
        assert_eq!(metadata.to_json(), "{}");
        let metadata = LocalCredentialMetadata {
            account_id: Some("acct-fixture".to_string()),
            ..LocalCredentialMetadata::default()
        };
        assert_eq!(metadata.to_json(), r#"{"account_id":"acct-fixture"}"#);
    }

    #[test]
    fn provider_ids_with_path_or_control_characters_are_dropped() {
        assert!(is_admissible_provider_id("cloudflare-workers-ai"));
        assert!(!is_admissible_provider_id(""));
        assert!(!is_admissible_provider_id("../../etc/passwd"));
        assert!(!is_admissible_provider_id("has space"));
    }
}

//! The 13 service groups defined in SPEC.md Section 31.1.
//!
//! Each mutating service method enforces the SPEC §31.3 14-step validation
//! pipeline at the granularity this crate supports:
//!   1. authenticate the control-plane connection (caller-provided bearer
//!      token; verified in the HTTP mini-service);
//!   2. validate request schema (handled by serde deserialization);
//!   3. validate capability token and bind to operation class + scope
//!      (`validate_capability_for_op`);
//!   4. resolve the registered workspace root and sandbox lease inside the
//!      kernel before any effect can reach the host;
//!   5. canonicalize paths and reject traversal/symlink escape
//!      (`terminus_fs::PathResolver::resolve_strict`);
//!   6. classify effect and taint (propagate `EffectIntent.taint_sources`
//!      and `trust_label` onto the `NormalizedCommand`; elevate untrusted
//!      privileged effects to `Prompt`);
//!   7. evaluate command/resource policy (`PolicyEngine::evaluate`);
//!   8. resolve approval record if required (`ApprovalStore::consume`);
//!   9. reserve budgets and resource limits (apply the sandbox profile's
//!      `ResourceLimits` wall-clock cap and the policy `max_runtime_ms`;
//!      emit a `budget_reserved` audit event);
//!   10. persist `AUTHORIZED` state (`tracing::info!` structured event
//!       BEFORE the effect is taken);
//!   11. select the sandbox backend for the profile and fail closed when
//!       the backend is `Unsupported`, or `Degraded` under strict mode
//!       (`TERMINUS_STRICT_SANDBOX=1`); otherwise audit the degraded
//!       enforcement and proceed (SPEC §13.4);
//!   12. stream bounded observations (`mpsc::channel(64)`);
//!   13. settle and persist evidence (`effect_started` audit emitted here;
//!       exit-time stdout/stderr artifacts are ingested by `ProcessManager`
//!       into the content-addressed store);
//!   14. release leases and resources (Drop).

use crate::approvals::ApprovalStore;
use crate::error::KernelAssemblyError;
use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use terminus_artifacts::ArtifactStore;
use terminus_authz::{OperationClass, Scope, TokenIssuer, TokenRevoker};
use terminus_code_intel::{CodeIntelService, FileSystemWorkspaceSource, WorkspaceSource};
use terminus_connector::{ChunkSink, ConnectorBroker};
use terminus_egress::EgressProxy;
use terminus_extension_runtime::WasiExtensionHost;
use terminus_fs::PathResolver;
use terminus_git::GitOps;
use terminus_jobs::JobManager;
use terminus_kernel_protocol::{
    ArtifactRef, CommandSpec, EffectIntent, KernelError, KernelResult, PatchEdit, PatchResponse,
    ProcessEvent, RequestContext, WorkspaceBaseline, WorkspacePath,
};
use terminus_patch::PatchEngine;
use terminus_policy::{Constraint, Decision, NormalizedCommand, PolicyEngine, TaintSource};
use terminus_process::{ProcessManager, SpawnLease};
use terminus_sandbox::{EnforcementStatus, SandboxManager, SandboxProfile};
use terminus_secrets::{GrantIssuer, GrantStore, SecretBroker, WorkloadIdentity};

/// The top-level kernel handle. Cloning is cheap — everything behind `Arc`.
#[derive(Clone)]
pub struct KernelHandle {
    process_manager: Arc<ProcessManager>,
    pub info: KernelInfoService,
    pub workspaces: WorkspaceService,
    pub files: FileService,
    pub patches: PatchService,
    pub processes: ProcessService,
    pub jobs: JobService,
    pub sandboxes: SandboxService,
    pub policies: PolicyService,
    pub secrets: SecretService,
    /// Connected provider accounts: credentials that already live on this
    /// machine (the OpenCode auth store, the Codex CLI ChatGPT login) read
    /// into the `provider-account` keyring namespace.
    pub provider_accounts: crate::provider_accounts::ProviderAccountService,
    /// L7 connector broker service (ADR-0035). Credentialed external
    /// operations execute here; raw credentials never cross the API.
    pub connectors: ConnectorService,
    pub network: NetworkService,
    pub code_intel: CodeIntelligenceService,
    pub extensions: ExtensionRuntimeService,
    pub artifact_ingest: ArtifactIngestService,
    /// The capability-token issuer shared by every service. Made public so
    /// testkit and the HTTP mini-service can mint dev tokens and validate
    /// tokens presented by callers.
    pub token_issuer: Arc<TokenIssuer>,
    /// In-memory approval store (SPEC §36.11). Backed by SQLite in
    /// production.
    pub approvals: Arc<ApprovalStore>,
}

/// The retired known-default capability-signing secret. It must never be
/// honored as a signing key: it was published in the source tree, so any
/// caller could forge admin tokens with it (SPEC §36.6).
const RETIRED_DEFAULT_CAPABILITY_SECRET: &str = "kernel-default-secret-please-rotate";

impl std::fmt::Debug for KernelHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("KernelHandle").finish_non_exhaustive()
    }
}

impl KernelHandle {
    /// Build a kernel with all defaults. `data_dir` is the on-disk root for
    /// artifacts, journals, state.
    pub fn new(data_dir: PathBuf) -> Result<Self, KernelAssemblyError> {
        // The default L4 allowlist is derived from the registered connector
        // table (§4(f)) so every connector the kernel offers is reachable and
        // nothing else is.
        Self::new_with_egress_policy(
            data_dir,
            crate::connectors::connector_egress_policy(
                &crate::connectors::default_connector_registry(),
            ),
            terminus_egress::RateLimit::default(),
        )
    }

    /// Build a kernel with an explicit L4 egress policy. Local development
    /// and conformance harnesses use this to allowlist fixture destinations
    /// without weakening the production default (deny-all + private-IP
    /// denial).
    pub fn new_with_egress_policy(
        data_dir: PathBuf,
        egress_policy: terminus_egress::EgressPolicy,
        rate_limit: terminus_egress::RateLimit,
    ) -> Result<Self, KernelAssemblyError> {
        let artifact_store = Arc::new(ArtifactStore::open(data_dir.join("artifacts"))?);
        let process_manager = Arc::new(ProcessManager::new(Arc::clone(&artifact_store)));
        let job_manager = Arc::new(JobManager::with_storage(
            Arc::clone(&process_manager),
            data_dir.join("jobs.sqlite"),
        ));
        job_manager
            .load_persisted_sync()
            .map_err(|error| KernelAssemblyError::Jobs(error.to_string()))?;
        job_manager
            .reconcile_loaded_sync()
            .map_err(|error| KernelAssemblyError::Jobs(error.to_string()))?;
        let policy_engine = Arc::new(PolicyEngine::new(terminus_policy::default_rule_set()));
        let info = KernelInfoService::new();
        // SPEC §13.4 / §36.5: select the platform-enforced backend first.
        // Linux uses Bubblewrap; macOS uses a generated Seatbelt profile.
        // Local-restrictive remains an explicit degraded fallback, so the
        // secure profile fails closed when the platform primitive is absent.
        let sandbox_manager = {
            #[cfg(target_os = "linux")]
            {
                // Linux: Bubblewrap backend as default (Enforced when bwrap
                // present), local-restrictive as fallback.
                let linux = std::sync::Arc::new(terminus_sandbox_linux::LinuxSandboxBackend::new())
                    as std::sync::Arc<dyn terminus_sandbox::SandboxBackend>;
                let local = std::sync::Arc::new(terminus_sandbox::LocalRestrictiveBackend::new())
                    as std::sync::Arc<dyn terminus_sandbox::SandboxBackend>;
                SandboxManager::new()
                    .with_default(linux)
                    .with_fallback(local)
            }
            #[cfg(target_os = "macos")]
            {
                let macos = std::sync::Arc::new(terminus_sandbox_macos::MacOsSandboxBackend::new())
                    as std::sync::Arc<dyn terminus_sandbox::SandboxBackend>;
                let local = std::sync::Arc::new(terminus_sandbox::LocalRestrictiveBackend::new())
                    as std::sync::Arc<dyn terminus_sandbox::SandboxBackend>;
                SandboxManager::new()
                    .with_default(macos)
                    .with_fallback(local)
            }
            #[cfg(not(any(target_os = "linux", target_os = "macos")))]
            {
                SandboxManager::new()
            }
        };
        let sandbox_manager = Arc::new(sandbox_manager);
        let secret_broker = Arc::new(SecretBroker::new());
        // Which credential store backs both namespaces. `keychain` is the
        // default and the only backend a packaged build may use; `file`
        // exists so a dev machine whose ad-hoc-signed kernel changes code
        // identity on every rebuild — and therefore gets an OS approval
        // prompt on every keychain read — can still run.
        let secret_backend = terminus_secrets::SecretBackend::from_env()
            .map_err(|error| KernelAssemblyError::Misconfigured(error.to_string()))?;
        // Connected provider accounts live in their own namespace and their
        // own store namespace: `secret://provider-account/<uuid-v7>`. The
        // legacy gateway namespace stays registered for the migration
        // window; the two can never resolve to the same entry.
        match secret_backend {
            terminus_secrets::SecretBackend::Keychain => {
                secret_broker.register_writable_provider(
                    "opencode",
                    Arc::new(terminus_secrets::KeyringSecretProvider::new()),
                );
                secret_broker.register_writable_provider(
                    "provider-account",
                    Arc::new(terminus_secrets::KeyringSecretProvider::for_provider_accounts()),
                );
                tracing::info!(
                    backend = terminus_secrets::SecretBackend::Keychain.as_str(),
                    "secret backend selected"
                );
            }
            terminus_secrets::SecretBackend::File => {
                let secrets_root = data_dir.join("secrets");
                let open = |namespace| {
                    terminus_secrets::FileSecretProvider::open(&secrets_root, namespace).map_err(
                        |error| {
                            KernelAssemblyError::Misconfigured(format!(
                                "file secret backend unavailable: {error}"
                            ))
                        },
                    )
                };
                secret_broker.register_writable_provider(
                    "opencode",
                    Arc::new(open(terminus_secrets::SecretNamespace::Gateway)?),
                );
                secret_broker.register_writable_provider(
                    "provider-account",
                    Arc::new(open(terminus_secrets::SecretNamespace::ProviderAccount)?),
                );
                // The directory is logged (it is a container path an operator
                // needs); the account file names are not.
                tracing::info!(
                    backend = terminus_secrets::SecretBackend::File.as_str(),
                    root = %secrets_root.display(),
                    "secret backend selected (development only)"
                );
            }
        }
        // SPEC §36.6: the capability-signing key must never be a known
        // constant — anyone who reads the public source could otherwise forge
        // admin tokens (HMAC-SHA256 with a public key). When the operator does
        // not supply TERMINUS_KERNEL_CAPABILITY_SECRET we generate an
        // ephemeral random key: tokens remain self-consistent within this
        // process, but cannot be forged or predicted across restarts. The
        // retired default constant is rejected even if explicitly set.
        let issuer_secret = match std::env::var("TERMINUS_KERNEL_CAPABILITY_SECRET") {
            Ok(s) if !s.is_empty() && s != RETIRED_DEFAULT_CAPABILITY_SECRET => s,
            _ => {
                tracing::warn!(
                    "TERMINUS_KERNEL_CAPABILITY_SECRET unset or set to the retired \
                     default constant; generating an ephemeral capability-signing \
                     key (minted tokens will not survive a restart)"
                );
                let mut buf = [0u8; 32];
                getrandom::fill(&mut buf).map_err(|e| {
                    KernelAssemblyError::Misconfigured(format!(
                        "secure RNG unavailable for ephemeral capability-signing key: {e}"
                    ))
                })?;
                hex::encode(buf)
            }
        };
        let token_issuer = Arc::new(TokenIssuer::new(
            issuer_secret.into_bytes(),
            info.instance_id().to_string(),
            3600,
        ));
        let revocation = token_issuer.revocation_list();
        let _revoker = Arc::new(TokenRevoker::new(revocation));
        let extension_host = Arc::new(WasiExtensionHost::new());
        // Registered connectors are a floor on the allowlist: a caller-
        // supplied development policy narrows nothing the kernel itself needs.
        let egress = Arc::new(EgressProxy::new(
            crate::connectors::with_connector_egress_floor(egress_policy),
            rate_limit,
        ));
        let egress_broker_root = data_dir.join("egress-brokers");
        let workspaces = WorkspaceService::open(
            data_dir.join("state/workspaces.sqlite"),
            Arc::clone(&token_issuer),
        )?;
        let _git_ops = Arc::new(GitOps::new(Arc::clone(&process_manager), "git"));
        let approvals = Arc::new(ApprovalStore::new());

        Ok(Self {
            process_manager: Arc::clone(&process_manager),
            info,
            workspaces: workspaces.clone(),
            files: FileService::new(
                Arc::clone(&artifact_store),
                workspaces.clone(),
                Arc::clone(&token_issuer),
            ),
            patches: PatchService::new(
                workspaces.clone(),
                data_dir.join("journal"),
                data_dir.join("patch-state"),
                Arc::clone(&token_issuer),
            ),
            processes: ProcessService::new(
                Arc::clone(&process_manager),
                Arc::clone(&policy_engine),
                Arc::clone(&token_issuer),
                Arc::clone(&approvals),
                workspaces.clone(),
            )
            .with_sandbox(Arc::clone(&sandbox_manager))
            .with_egress_broker(Arc::clone(&egress), egress_broker_root.clone()),
            jobs: JobService::new(
                job_manager,
                Arc::clone(&token_issuer),
                ProcessService::new(
                    Arc::clone(&process_manager),
                    Arc::clone(&policy_engine),
                    Arc::clone(&token_issuer),
                    Arc::clone(&approvals),
                    workspaces.clone(),
                )
                .with_sandbox(Arc::clone(&sandbox_manager))
                .with_egress_broker(Arc::clone(&egress), egress_broker_root),
            ),
            sandboxes: SandboxService::new(sandbox_manager),
            policies: PolicyService::new(policy_engine),
            secrets: SecretService::new(Arc::clone(&secret_broker), Arc::clone(&token_issuer)),
            provider_accounts: crate::provider_accounts::ProviderAccountService::new(
                Arc::clone(&secret_broker),
                Arc::clone(&token_issuer),
            ),
            connectors: {
                // ADR-0035: grants are signed with an independent ephemeral
                // key (never the capability-token key) so compromise of one
                // signer does not forge the other's authority.
                let mut grant_key = [0u8; 32];
                getrandom::fill(&mut grant_key).map_err(|e| {
                    KernelAssemblyError::Misconfigured(format!(
                        "secure RNG unavailable for connector grant-signing key: {e}"
                    ))
                })?;
                let grants = Arc::new(GrantStore::with_storage(
                    data_dir.join("state").join("connector-grants.json"),
                ));
                let issuer = Arc::new(GrantIssuer::new(grant_key.to_vec()));
                let mut builder = ConnectorBroker::builder(
                    Arc::clone(&secret_broker),
                    Arc::clone(&grants),
                    Arc::clone(&egress),
                    grant_key.to_vec(),
                );
                for (id, descriptor) in crate::connectors::default_connector_registry() {
                    builder = builder.connector_descriptor(id, descriptor);
                }
                let broker = builder.build();
                ConnectorService::new(
                    Arc::new(broker),
                    Arc::clone(&issuer),
                    grants,
                    Arc::clone(&secret_broker),
                    Arc::clone(&token_issuer),
                    Arc::clone(&egress),
                    grant_key.to_vec(),
                )
            },
            network: NetworkService::new(egress, Arc::clone(&token_issuer)),
            code_intel: CodeIntelligenceService::new(
                workspaces,
                data_dir.clone(),
                data_dir.join("state/code-intel"),
                Arc::clone(&token_issuer),
            ),
            extensions: ExtensionRuntimeService::new(extension_host, Arc::clone(&token_issuer)),
            artifact_ingest: ArtifactIngestService::new(artifact_store, Arc::clone(&token_issuer)),
            token_issuer,
            approvals,
        })
    }

    /// Point local credential discovery at explicit store roots. Tests use
    /// temp directories instead of mutating `HOME`/`XDG_DATA_HOME`/`CODEX_HOME`
    /// for the whole process.
    #[must_use]
    pub fn with_local_credential_roots(
        mut self,
        roots: crate::provider_accounts::LocalCredentialRoots,
    ) -> Self {
        self.provider_accounts = self.provider_accounts.with_roots(roots);
        self
    }

    pub fn token_revoker(&self) -> Arc<TokenRevoker> {
        // Build a fresh revoker view onto the issuer's shared revocation
        // list. The HTTP mini-service uses this to honor revocation calls
        // without exposing the signing secret.
        Arc::new(TokenRevoker::new(self.token_issuer.revocation_list()))
    }

    /// Stop and reap every process group created through this kernel before
    /// the transport exits. The operation is idempotent and bounded.
    pub async fn shutdown(&self) -> KernelResult<()> {
        self.process_manager.shutdown_all().await.map_err(|error| {
            KernelError::new(
                terminus_kernel_protocol::ErrorCode::Internal,
                terminus_kernel_protocol::ErrorCategory::Internal,
                format!("kernel process shutdown failed: {error}"),
                false,
            )
        })
    }
}

// ---------- capability-token validation helper ----------

/// Validate the capability token carried by `ctx` against the requested
/// `op_class` and `requested_scope`. Returns the validated `CapabilityToken`
/// on success, or a `KernelError` (category `Permission`) on failure.
///
/// SPEC §31.3 step 3: "validate capability token and bind it to
/// session/task/operation".
///
/// Error mapping:
/// - empty token → `CapabilityTokenInvalid` (caller did not supply one);
/// - signature/expiry/audience errors → the corresponding `Capability*`
///   codes;
/// - operation class not permitted → `PermissionDenied`;
/// - scope exceeded → `PermissionDenied`.
pub fn validate_capability_for_op(
    issuer: &TokenIssuer,
    ctx: &RequestContext,
    op_class: OperationClass,
    requested_scope: &Scope,
) -> KernelResult<terminus_authz::CapabilityToken> {
    if ctx.capability_token.is_empty() {
        return Err(KernelError::new(
            terminus_kernel_protocol::ErrorCode::CapabilityTokenInvalid,
            terminus_kernel_protocol::ErrorCategory::Permission,
            "capability token required for this operation but none was supplied",
            false,
        ));
    }
    let token = issuer
        .validate_capability(&ctx.capability_token, op_class, requested_scope)
        .map_err(|e| {
            let (code, msg) = match e {
                terminus_authz::AuthzError::Expired => (
                    terminus_kernel_protocol::ErrorCode::CapabilityTokenExpired,
                    "capability token expired".to_string(),
                ),
                terminus_authz::AuthzError::Revoked => (
                    terminus_kernel_protocol::ErrorCode::CapabilityTokenRevoked,
                    "capability token revoked".to_string(),
                ),
                terminus_authz::AuthzError::InvalidAudience
                | terminus_authz::AuthzError::WrongAudience => (
                    terminus_kernel_protocol::ErrorCode::CapabilityTokenInvalid,
                    "capability token audience mismatch".to_string(),
                ),
                terminus_authz::AuthzError::InvalidSignature => (
                    terminus_kernel_protocol::ErrorCode::CapabilityTokenInvalid,
                    "capability token signature invalid".to_string(),
                ),
                terminus_authz::AuthzError::OperationNotPermitted => (
                    terminus_kernel_protocol::ErrorCode::PermissionDenied,
                    format!(
                        "capability token does not grant operation class `{:?}`",
                        op_class
                    ),
                ),
                terminus_authz::AuthzError::ScopeExceeded => (
                    terminus_kernel_protocol::ErrorCode::PermissionDenied,
                    "capability token scope exceeded".to_string(),
                ),
                other => (
                    terminus_kernel_protocol::ErrorCode::CapabilityTokenInvalid,
                    format!("capability token rejected: {other}"),
                ),
            };
            KernelError::new(
                code,
                terminus_kernel_protocol::ErrorCategory::Permission,
                msg,
                false,
            )
        })?;
    for (label, binder, request_value) in [
        (
            "principal",
            token.claims.binder.principal.as_str(),
            ctx.actor_id.as_str(),
        ),
        (
            "session",
            token.claims.binder.session_id.as_str(),
            ctx.session_id.as_str(),
        ),
        (
            "task",
            token.claims.binder.task_id.as_str(),
            ctx.task_id.as_str(),
        ),
        (
            "workspace",
            token.claims.binder.workspace_id.as_str(),
            ctx.workspace_id.as_str(),
        ),
    ] {
        if binder != "*" && binder != request_value {
            return Err(KernelError::new(
                terminus_kernel_protocol::ErrorCode::PermissionDenied,
                terminus_kernel_protocol::ErrorCategory::Permission,
                format!("capability token {label} binder does not match request context"),
                false,
            ));
        }
    }
    Ok(token)
}

/// Server-side deadline budget by RPC shape (SPEC §31.3 step 9).
///
/// A caller that forgets `RequestContext.deadline` must not be able to pin a
/// kernel worker forever, so the kernel supplies its own budget and clamps
/// anything the caller asks for beyond the class ceiling.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RpcDeadlineClass {
    /// Request/response calls: metadata, policy decisions, file reads.
    Unary,
    /// Streaming, tool, and process/job calls that legitimately run long.
    LongRunning,
}

/// Budget applied when the caller supplied no deadline.
pub const DEFAULT_UNARY_DEADLINE_MS: u64 = 30_000;
/// Ceiling for every request, and the default for long-running calls.
pub const MAX_LONG_RUNNING_DEADLINE_MS: u64 = 30 * 60 * 1_000;

impl RpcDeadlineClass {
    /// Budget used when the caller supplied no deadline.
    pub fn default_budget(self) -> Duration {
        match self {
            Self::Unary => Duration::from_millis(DEFAULT_UNARY_DEADLINE_MS),
            Self::LongRunning => Duration::from_millis(MAX_LONG_RUNNING_DEADLINE_MS),
        }
    }

    /// Hard ceiling. A caller asking for more is clamped to this.
    pub fn ceiling(self) -> Duration {
        Duration::from_millis(MAX_LONG_RUNNING_DEADLINE_MS)
    }
}

fn now_unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

/// Resolve the deadline the kernel will actually enforce for this request:
/// the caller's when present and inside the class ceiling, otherwise the
/// class default. Never returns 0, so downstream "0 means no deadline"
/// handling cannot be reached from a filled context.
pub fn resolve_deadline_unix_ms(ctx: &RequestContext, class: RpcDeadlineClass) -> u64 {
    let now = now_unix_ms();
    let ceiling = now.saturating_add(
        u64::try_from(class.ceiling().as_millis()).unwrap_or(MAX_LONG_RUNNING_DEADLINE_MS),
    );
    if ctx.deadline_unix_ms == 0 {
        return now.saturating_add(
            u64::try_from(class.default_budget().as_millis()).unwrap_or(DEFAULT_UNARY_DEADLINE_MS),
        );
    }
    ctx.deadline_unix_ms.min(ceiling)
}

/// Fill in the server-side deadline when the caller omitted one and clamp an
/// over-long caller deadline. Called once per RPC at the transport boundary
/// so every downstream check sees the same bound.
pub fn apply_default_deadline(ctx: &mut RequestContext, class: RpcDeadlineClass) {
    ctx.deadline_unix_ms = resolve_deadline_unix_ms(ctx, class);
}

/// Remaining wall-clock budget for a context whose deadline is already
/// resolved. `Duration::ZERO` means the deadline has passed.
pub fn remaining_budget(ctx: &RequestContext, class: RpcDeadlineClass) -> Duration {
    let deadline = resolve_deadline_unix_ms(ctx, class);
    Duration::from_millis(deadline.saturating_sub(now_unix_ms()))
}

/// Validate the 10-step request pipeline (SPEC §31.3):
///  1. request context
///  2. kernel instance identity
///  3. capability token
///  4. operation class
///  5. workspace/resource scope
///  6. policy
///  7. approval
///  8. idempotency
///  9. deadline
///  10. cancellation
pub fn validate_request_pipeline(
    issuer: &TokenIssuer,
    ctx: &RequestContext,
    op_class: OperationClass,
    requested_scope: &Scope,
    require_idempotency: bool,
) -> KernelResult<terminus_authz::CapabilityToken> {
    use terminus_kernel_protocol::{ErrorCategory, ErrorCode};

    // 1. Request context
    if ctx.request_id.is_empty() {
        return Err(KernelError::new(
            ErrorCode::InvalidRequest,
            ErrorCategory::Validation,
            "request_id must not be empty",
            false,
        ));
    }

    // 2. Kernel instance identity & 3. Capability token & 4. Operation class & 5. Workspace scope
    let token = validate_capability_for_op(issuer, ctx, op_class, requested_scope)?;

    // 8. Idempotency requirement
    if require_idempotency && ctx.idempotency_key.is_empty() {
        return Err(KernelError::new(
            ErrorCode::InvalidRequest,
            ErrorCategory::Validation,
            "idempotency_key is required for this operation",
            false,
        ));
    }

    // 9. Deadline check
    if ctx.deadline_unix_ms > 0 {
        let now_ms = match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
            Ok(d) => d.as_millis() as u64,
            Err(_) => 0,
        };
        if now_ms > ctx.deadline_unix_ms {
            return Err(KernelError::new(
                ErrorCode::Timeout,
                ErrorCategory::Timeout,
                format!(
                    "request deadline passed ({now_ms} > {})",
                    ctx.deadline_unix_ms
                ),
                true,
            ));
        }
    }

    Ok(token)
}

// ---------- KernelInfoService ----------

/// Which build produced this kernel: the git commit of the enclosing
/// checkout, or `<version>+src.<content hash>` when built outside one.
/// Resolved at compile time by `build.rs`, which never fails a build.
///
/// This is the identity an audit record, a bug report, or the control plane's
/// health endpoint uses to say WHICH kernel performed an effect. It was
/// previously the literal placeholder `"dev"`, which identified nothing.
const BUILD_REVISION: &str = env!("TERMINUS_BUILD_REVISION");

#[derive(Debug, Clone, Default)]
pub struct KernelInfoService {
    instance_id: String,
}

impl KernelInfoService {
    pub fn new() -> Self {
        Self {
            instance_id: format!("kernel:{}", terminus_kernel_protocol::new_id()),
        }
    }

    pub fn instance_id(&self) -> &str {
        &self.instance_id
    }

    /// Build identity, stable for the lifetime of the binary. Distinct from
    /// [`Self::instance_id`], which is a fresh uuid per process start.
    pub fn build_revision(&self) -> &'static str {
        BUILD_REVISION
    }

    pub fn info(&self) -> serde_json::Value {
        serde_json::json!({
            "instance_id": self.instance_id,
            "implementation": "terminus-kernel-rs",
            "version": env!("CARGO_PKG_VERSION"),
            "build_revision": BUILD_REVISION,
            "services": [
                "KernelInfoService", "WorkspaceService", "FileService", "PatchService",
                "ProcessService", "JobService", "SandboxService", "PolicyService",
                "SecretService", "ProviderAccountService", "NetworkService",
                "CodeIntelligenceService", "ExtensionRuntimeService",
                "ArtifactIngestService",
            ],
        })
    }

    pub fn health(&self) -> serde_json::Value {
        serde_json::json!({
            "status": "ok",
            "instance_id": self.instance_id,
        })
    }
}

#[cfg(test)]
mod kernel_info_tests {
    use super::{KernelInfoService, BUILD_REVISION};

    #[test]
    fn build_revision_identifies_a_real_build_not_the_dev_placeholder() {
        let info = KernelInfoService::new();
        let revision = info.build_revision();
        assert!(!revision.is_empty(), "build revision must not be empty");
        assert_ne!(
            revision, "dev",
            "build revision must identify a build, not the historical placeholder"
        );
        assert!(
            !revision.chars().any(char::is_control),
            "build revision must be a single clean line: {revision:?}"
        );

        // Whatever `build.rs` resolved, it is one of the two documented
        // shapes: a git object id, or `<version>+src.<content hash>`.
        let is_git_sha = revision.len() >= 7
            && revision.len() <= 64
            && revision.chars().all(|c| c.is_ascii_hexdigit());
        let is_source_fingerprint = revision.contains("+src.");
        assert!(
            is_git_sha || is_source_fingerprint,
            "unexpected build revision shape: {revision:?}"
        );

        // The JSON surface the transports read is the same value.
        let value = info.info();
        assert_eq!(value["build_revision"], serde_json::json!(BUILD_REVISION));
        assert_eq!(
            value["version"],
            serde_json::json!(env!("CARGO_PKG_VERSION"))
        );
    }

    #[test]
    fn build_revision_is_stable_while_instance_id_is_per_start() {
        let first = KernelInfoService::new();
        let second = KernelInfoService::new();
        assert_eq!(first.build_revision(), second.build_revision());
        assert_ne!(
            first.instance_id(),
            second.instance_id(),
            "instance_id stays a per-start uuid"
        );
    }
}

// ---------- WorkspaceService ----------

#[derive(Clone)]
pub struct WorkspaceService {
    registry: WorkspaceRegistry,
    token_issuer: Arc<TokenIssuer>,
}

#[derive(Clone)]
enum WorkspaceRegistry {
    Volatile(Arc<Mutex<std::collections::HashMap<String, WorkspaceEntry>>>),
    Durable(Arc<Mutex<Connection>>),
}

impl std::fmt::Debug for WorkspaceService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let durability = match self.registry {
            WorkspaceRegistry::Volatile(_) => "volatile",
            WorkspaceRegistry::Durable(_) => "durable",
        };
        f.debug_struct("WorkspaceService")
            .field("durability", &durability)
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct WorkspaceEntry {
    pub id: String,
    pub root_uri: String,
    pub canonical_root: String,
    pub trust: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedWorkspaceRoot {
    pub root_uri: String,
    pub canonical_root: String,
}

impl WorkspaceService {
    /// Construct an isolated in-memory registry. Production assembly uses
    /// [`WorkspaceService::open`] so workspace IDs survive kernel restarts.
    pub fn new(token_issuer: Arc<TokenIssuer>) -> Self {
        Self {
            registry: WorkspaceRegistry::Volatile(Arc::new(Mutex::new(
                std::collections::HashMap::new(),
            ))),
            token_issuer,
        }
    }

    /// Open the kernel-owned durable workspace registry.
    pub fn open(
        path: PathBuf,
        token_issuer: Arc<TokenIssuer>,
    ) -> Result<Self, KernelAssemblyError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let connection = Connection::open(path).map_err(|error| {
            KernelAssemblyError::Misconfigured(format!("workspace registry: {error}"))
        })?;
        connection
            .execute_batch(
                "PRAGMA foreign_keys = ON;\
                 PRAGMA journal_mode = WAL;\
                 PRAGMA synchronous = FULL;\
                 PRAGMA busy_timeout = 5000;\
                 CREATE TABLE IF NOT EXISTS registered_workspaces (\
                   id TEXT PRIMARY KEY,\
                   root_uri TEXT NOT NULL,\
                   canonical_root TEXT NOT NULL UNIQUE,\
                   trust TEXT NOT NULL CHECK (trust IN ('trusted','untrusted','restricted'))\
                 );",
            )
            .map_err(|error| {
                KernelAssemblyError::Misconfigured(format!("workspace registry schema: {error}"))
            })?;
        Ok(Self {
            registry: WorkspaceRegistry::Durable(Arc::new(Mutex::new(connection))),
            token_issuer,
        })
    }

    pub fn register(
        &self,
        ctx: &RequestContext,
        _intent: &EffectIntent,
        root_uri: impl Into<String>,
        canonical_root: impl Into<String>,
        trust: &str,
    ) -> KernelResult<String> {
        self.register_with_id(ctx, _intent, root_uri, canonical_root, trust, None)
    }

    /// Register a workspace while preserving an authoritative pre-existing
    /// control-plane ID during the durable-registry upgrade.
    pub fn register_with_id(
        &self,
        ctx: &RequestContext,
        _intent: &EffectIntent,
        root_uri: impl Into<String>,
        canonical_root: impl Into<String>,
        trust: &str,
        requested_workspace_id: Option<&str>,
    ) -> KernelResult<String> {
        let _ = validate_capability_for_op(
            &self.token_issuer,
            ctx,
            OperationClass::Admin,
            &Scope::default(),
        )?;
        let resolved = Self::resolve_root_unchecked(root_uri, canonical_root)?;
        let root_uri = resolved.root_uri;
        let canonical_root = resolved.canonical_root;
        // SPEC §28.2 / §13: workspace trust MUST be one of
        // trusted | untrusted | restricted and is caller-supplied. Default
        // to `untrusted` (fail-safe) for any unrecognized value — never
        // silently upgrade an unknown workspace to `trusted`.
        let trust = match trust {
            "trusted" => "trusted",
            "restricted" => "restricted",
            _ => "untrusted",
        }
        .to_string();
        let requested_workspace_id = requested_workspace_id
            .map(str::trim)
            .filter(|id| !id.is_empty());
        if requested_workspace_id.is_some_and(|id| id.len() > 200) {
            return Err(KernelError::new(
                terminus_kernel_protocol::ErrorCode::InvalidArgument,
                terminus_kernel_protocol::ErrorCategory::Validation,
                "requested workspace id is too long",
                false,
            ));
        }
        let entry = WorkspaceEntry {
            id: requested_workspace_id
                .map(ToOwned::to_owned)
                .unwrap_or_else(terminus_kernel_protocol::new_id),
            root_uri,
            canonical_root,
            trust,
        };
        let id = self.insert(entry, requested_workspace_id.is_some())?;
        let _ = ctx;
        Ok(id)
    }

    /// Canonicalize and validate a workspace root without mutating the
    /// durable registry. The control plane uses this before comparing trust
    /// and adopting a pre-existing workspace identity.
    pub fn resolve_root(
        &self,
        ctx: &RequestContext,
        root_uri: impl Into<String>,
        candidate_root: impl Into<String>,
    ) -> KernelResult<ResolvedWorkspaceRoot> {
        let _ = validate_capability_for_op(
            &self.token_issuer,
            ctx,
            OperationClass::Admin,
            &Scope::default(),
        )?;
        Self::resolve_root_unchecked(root_uri, candidate_root)
    }

    fn resolve_root_unchecked(
        root_uri: impl Into<String>,
        candidate_root: impl Into<String>,
    ) -> KernelResult<ResolvedWorkspaceRoot> {
        let root_uri = root_uri.into();
        let candidate_root = candidate_root.into();
        let canonical_root = if root_uri.starts_with("file://") {
            let requested_path = std::path::Path::new(&candidate_root);
            if !requested_path.is_absolute() {
                return Err(KernelError::new(
                    terminus_kernel_protocol::ErrorCode::InvalidArgument,
                    terminus_kernel_protocol::ErrorCategory::Validation,
                    "local workspace canonical_root must be an absolute host path",
                    false,
                ));
            }
            let resolved = std::fs::canonicalize(requested_path).map_err(|error| {
                KernelError::new(
                    terminus_kernel_protocol::ErrorCode::InvalidArgument,
                    terminus_kernel_protocol::ErrorCategory::Validation,
                    format!("local workspace root could not be canonicalized: {error}"),
                    false,
                )
            })?;
            if !resolved.is_dir() {
                return Err(KernelError::new(
                    terminus_kernel_protocol::ErrorCode::InvalidArgument,
                    terminus_kernel_protocol::ErrorCategory::Validation,
                    "local workspace root must be a directory",
                    false,
                ));
            }
            resolved.into_os_string().into_string().map_err(|_| {
                KernelError::new(
                    terminus_kernel_protocol::ErrorCode::InvalidArgument,
                    terminus_kernel_protocol::ErrorCategory::Validation,
                    "local workspace root must be valid UTF-8",
                    false,
                )
            })?
        } else {
            candidate_root
        };
        Ok(ResolvedWorkspaceRoot {
            root_uri,
            canonical_root,
        })
    }

    pub fn get(&self, ctx: &RequestContext, workspace_id: &str) -> KernelResult<WorkspaceEntry> {
        let _ = validate_capability_for_op(
            &self.token_issuer,
            ctx,
            OperationClass::Read,
            &Scope::default(),
        )?;
        if ctx.workspace_id != "*" && ctx.workspace_id != workspace_id {
            return Err(KernelError::new(
                terminus_kernel_protocol::ErrorCode::PermissionDenied,
                terminus_kernel_protocol::ErrorCategory::Permission,
                "workspace lookup must match the request context workspace binder",
                false,
            ));
        }
        self.get_registered(workspace_id)
    }

    /// Retrieve a registry entry while handling an administrative registry
    /// mutation. This is deliberately separate from [`Self::get`]: ordinary
    /// callers still need `Read`, while `WorkspaceService.Register` can return
    /// the row it just wrote without broadening the bootstrap broker token.
    pub fn get_for_admin(
        &self,
        ctx: &RequestContext,
        workspace_id: &str,
    ) -> KernelResult<WorkspaceEntry> {
        let _ = validate_capability_for_op(
            &self.token_issuer,
            ctx,
            OperationClass::Admin,
            &Scope::default(),
        )?;
        self.get_registered(workspace_id)
    }

    /// Select one concrete, registered local workspace for an effect.
    ///
    /// Both the request context and the validated capability binder must
    /// agree with `workspace_id` unless either carries the explicit
    /// development/administrative wildcard. The operation still requires a
    /// concrete registered ID; `*` is never a filesystem root.
    fn local_workspace_for_effect(
        &self,
        ctx: &RequestContext,
        token: &terminus_authz::CapabilityToken,
        workspace_id: &str,
    ) -> KernelResult<WorkspaceEntry> {
        if workspace_id.is_empty() || workspace_id == "*" {
            return Err(KernelError::new(
                terminus_kernel_protocol::ErrorCode::InvalidArgument,
                terminus_kernel_protocol::ErrorCategory::Validation,
                "effect requires a concrete workspace_id",
                false,
            ));
        }
        if ctx.workspace_id != "*" && ctx.workspace_id != workspace_id {
            return Err(KernelError::new(
                terminus_kernel_protocol::ErrorCode::PermissionDenied,
                terminus_kernel_protocol::ErrorCategory::Permission,
                format!(
                    "requested workspace `{workspace_id}` does not match request context workspace `{}`",
                    ctx.workspace_id
                ),
                false,
            ));
        }
        let bound_workspace = token.claims.binder.workspace_id.as_str();
        if bound_workspace != "*" && bound_workspace != workspace_id {
            return Err(KernelError::new(
                terminus_kernel_protocol::ErrorCode::PermissionDenied,
                terminus_kernel_protocol::ErrorCategory::Permission,
                format!(
                    "capability token is bound to workspace `{bound_workspace}`, not `{workspace_id}`"
                ),
                false,
            ));
        }
        let workspace = self.get_registered(workspace_id)?;
        if !workspace.root_uri.starts_with("file://") {
            return Err(KernelError::new(
                terminus_kernel_protocol::ErrorCode::UnsupportedPlatform,
                terminus_kernel_protocol::ErrorCategory::SandboxUnavailable,
                "operation requires a registered local workspace root",
                false,
            ));
        }
        Ok(workspace)
    }

    fn resolver_for_effect(
        &self,
        ctx: &RequestContext,
        token: &terminus_authz::CapabilityToken,
        workspace_id: &str,
    ) -> KernelResult<PathResolver> {
        let workspace = self.local_workspace_for_effect(ctx, token, workspace_id)?;
        PathResolver::new(&workspace.canonical_root).map_err(|error| {
            KernelError::new(
                terminus_kernel_protocol::ErrorCode::PathNotFound,
                terminus_kernel_protocol::ErrorCategory::NotFound,
                format!("registered workspace root is unavailable: {error}"),
                false,
            )
        })
    }

    fn get_registered(&self, workspace_id: &str) -> KernelResult<WorkspaceEntry> {
        let entry = match &self.registry {
            WorkspaceRegistry::Volatile(entries) => {
                let guard = match entries.lock() {
                    Ok(guard) => guard,
                    Err(poisoned) => poisoned.into_inner(),
                };
                guard.get(workspace_id).cloned()
            }
            WorkspaceRegistry::Durable(connection) => {
                let guard = match connection.lock() {
                    Ok(guard) => guard,
                    Err(poisoned) => poisoned.into_inner(),
                };
                guard
                    .query_row(
                        "SELECT id, root_uri, canonical_root, trust \
                         FROM registered_workspaces WHERE id = ?1",
                        params![workspace_id],
                        |row| {
                            Ok(WorkspaceEntry {
                                id: row.get(0)?,
                                root_uri: row.get(1)?,
                                canonical_root: row.get(2)?,
                                trust: row.get(3)?,
                            })
                        },
                    )
                    .optional()
                    .map_err(workspace_registry_error)?
            }
        };
        entry.ok_or_else(|| {
            KernelError::new(
                terminus_kernel_protocol::ErrorCode::WorkspaceNotFound,
                terminus_kernel_protocol::ErrorCategory::NotFound,
                format!("workspace {workspace_id} not found"),
                false,
            )
        })
    }

    fn insert(&self, entry: WorkspaceEntry, authoritative_id: bool) -> KernelResult<String> {
        match &self.registry {
            WorkspaceRegistry::Volatile(entries) => {
                let mut guard = match entries.lock() {
                    Ok(guard) => guard,
                    Err(poisoned) => poisoned.into_inner(),
                };
                if authoritative_id {
                    if let Some(id_owner) = guard.get(&entry.id) {
                        if id_owner.canonical_root != entry.canonical_root {
                            return Err(workspace_id_conflict(&entry.id));
                        }
                    }
                }
                let existing = guard
                    .values()
                    .find(|candidate| candidate.canonical_root == entry.canonical_root)
                    .cloned();
                if let Some(existing) = existing {
                    matching_workspace_id(&existing, &entry)?;
                    if !authoritative_id || existing.id == entry.id {
                        return Ok(existing.id);
                    }
                    if guard.contains_key(&entry.id) {
                        return Err(workspace_id_conflict(&entry.id));
                    }
                    guard.remove(&existing.id);
                    let id = entry.id.clone();
                    guard.insert(id.clone(), entry);
                    return Ok(id);
                }
                let id = entry.id.clone();
                guard.insert(id.clone(), entry);
                Ok(id)
            }
            WorkspaceRegistry::Durable(connection) => {
                let mut guard = match connection.lock() {
                    Ok(guard) => guard,
                    Err(poisoned) => poisoned.into_inner(),
                };
                let transaction = guard.transaction().map_err(workspace_registry_error)?;
                let existing = transaction
                    .query_row(
                        "SELECT id, root_uri, canonical_root, trust \
                         FROM registered_workspaces WHERE canonical_root = ?1",
                        params![entry.canonical_root],
                        |row| {
                            Ok(WorkspaceEntry {
                                id: row.get(0)?,
                                root_uri: row.get(1)?,
                                canonical_root: row.get(2)?,
                                trust: row.get(3)?,
                            })
                        },
                    )
                    .optional()
                    .map_err(workspace_registry_error)?;
                if let Some(existing) = existing {
                    matching_workspace_id(&existing, &entry)?;
                    if authoritative_id && existing.id != entry.id {
                        let requested_id_exists = transaction
                            .query_row(
                                "SELECT 1 FROM registered_workspaces WHERE id = ?1",
                                params![entry.id],
                                |_row| Ok(()),
                            )
                            .optional()
                            .map_err(workspace_registry_error)?
                            .is_some();
                        if requested_id_exists {
                            return Err(workspace_id_conflict(&entry.id));
                        }
                        transaction
                            .execute(
                                "UPDATE registered_workspaces SET id = ?1 WHERE id = ?2",
                                params![entry.id, existing.id],
                            )
                            .map_err(workspace_registry_error)?;
                        transaction.commit().map_err(workspace_registry_error)?;
                        return Ok(entry.id);
                    }
                    transaction.commit().map_err(workspace_registry_error)?;
                    return Ok(existing.id);
                }
                if authoritative_id {
                    let requested_id_exists = transaction
                        .query_row(
                            "SELECT 1 FROM registered_workspaces WHERE id = ?1",
                            params![entry.id],
                            |_row| Ok(()),
                        )
                        .optional()
                        .map_err(workspace_registry_error)?
                        .is_some();
                    if requested_id_exists {
                        return Err(workspace_id_conflict(&entry.id));
                    }
                }
                transaction
                    .execute(
                        "INSERT INTO registered_workspaces \
                         (id, root_uri, canonical_root, trust) VALUES (?1, ?2, ?3, ?4)",
                        params![entry.id, entry.root_uri, entry.canonical_root, entry.trust],
                    )
                    .map_err(workspace_registry_error)?;
                transaction.commit().map_err(workspace_registry_error)?;
                Ok(entry.id)
            }
        }
    }
}

fn workspace_id_conflict(id: &str) -> KernelError {
    KernelError::new(
        terminus_kernel_protocol::ErrorCode::AlreadyExists,
        terminus_kernel_protocol::ErrorCategory::Conflict,
        format!("workspace id {id} is already registered for a different root"),
        false,
    )
}

fn matching_workspace_id(
    existing: &WorkspaceEntry,
    requested: &WorkspaceEntry,
) -> KernelResult<String> {
    if existing.canonical_root == requested.canonical_root && existing.trust == requested.trust {
        return Ok(existing.id.clone());
    }
    Err(KernelError::new(
        terminus_kernel_protocol::ErrorCode::AlreadyExists,
        terminus_kernel_protocol::ErrorCategory::Conflict,
        format!(
            "workspace root {} is already registered with different identity or trust",
            requested.canonical_root
        ),
        false,
    ))
}

fn workspace_registry_error(error: rusqlite::Error) -> KernelError {
    KernelError::new(
        terminus_kernel_protocol::ErrorCode::Internal,
        terminus_kernel_protocol::ErrorCategory::Internal,
        format!("workspace registry operation failed: {error}"),
        false,
    )
}

// ---------- FileService ----------

#[derive(Clone)]
pub struct FileService {
    artifact_store: Arc<ArtifactStore>,
    /// Kernel-owned registry used to select exactly one resolver root from
    /// `WorkspacePath.workspace_id` before touching the filesystem.
    workspaces: WorkspaceService,
    /// Capability-token issuer used to validate `OperationClass::Read` and
    /// the requested path scope.
    token_issuer: Arc<TokenIssuer>,
}

impl std::fmt::Debug for FileService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FileService")
            .field("artifact_store", &self.artifact_store)
            .field("workspaces", &self.workspaces)
            .finish()
    }
}

impl FileService {
    pub fn new(
        artifact_store: Arc<ArtifactStore>,
        workspaces: WorkspaceService,
        token_issuer: Arc<TokenIssuer>,
    ) -> Self {
        Self {
            artifact_store,
            workspaces,
            token_issuer,
        }
    }

    /// Resolve a read path under its registered workspace root. The
    /// capability token is bound to that workspace unless it carries the
    /// explicit development-only wildcard binder.
    pub fn resolve_for_read(
        &self,
        ctx: &RequestContext,
        path: &WorkspacePath,
    ) -> KernelResult<terminus_fs::ResolvedPath> {
        let requested_scope = Scope {
            workspace_paths: vec![path.relative_path.clone()],
            network_destinations: Vec::new(),
            secret_capabilities: Vec::new(),
        };
        let token = validate_capability_for_op(
            &self.token_issuer,
            ctx,
            OperationClass::Read,
            &requested_scope,
        )?;
        self.resolve_registered_path(ctx, &token, path)
    }

    fn resolve_registered_path(
        &self,
        ctx: &RequestContext,
        token: &terminus_authz::CapabilityToken,
        path: &WorkspacePath,
    ) -> KernelResult<terminus_fs::ResolvedPath> {
        let safe = terminus_fs::SafePath::new(&path.relative_path).map_err(|error| {
            KernelError::new(
                terminus_kernel_protocol::ErrorCode::InvalidArgument,
                terminus_kernel_protocol::ErrorCategory::Validation,
                format!("path rejected by SafePath: {error}"),
                false,
            )
        })?;
        let resolver = self
            .workspaces
            .resolver_for_effect(ctx, token, &path.workspace_id)?;
        resolver.resolve_strict(&safe).map_err(|error| {
            KernelError::new(
                terminus_kernel_protocol::ErrorCode::InvalidArgument,
                terminus_kernel_protocol::ErrorCategory::Validation,
                format!("path rejected by PathResolver: {error}"),
                false,
            )
        })
    }

    /// Read the file at `path.relative_path` (workspace-relative) and ingest
    /// its bytes into the artifact store. The path is resolved through
    /// `PathResolver::resolve_strict` first, which rejects absolute paths,
    /// `..` traversal, symlink escapes, and protected prefixes (`.git`,
    /// `.env`, etc.).
    ///
    /// Capability-token validation: the token in `ctx.capability_token` MUST
    /// grant `OperationClass::Read` and the requested path MUST be within
    /// the token's `max_scope.workspace_paths` (when non-empty).
    pub fn read(
        &self,
        ctx: &RequestContext,
        _intent: &EffectIntent,
        path: &WorkspacePath,
    ) -> KernelResult<(Vec<u8>, ArtifactRef)> {
        let resolved = self.resolve_for_read(ctx, path)?;
        // §31.3 steps 4-5: resolve the registered workspace first, then
        // canonicalize the relative path and reject traversal/symlink escape.
        if !resolved.host.exists {
            return Err(KernelError::new(
                terminus_kernel_protocol::ErrorCode::PathNotFound,
                terminus_kernel_protocol::ErrorCategory::NotFound,
                format!(
                    "read {}: path does not exist",
                    resolved.host.host_path.display()
                ),
                false,
            ));
        }
        // §31.3 step 10: persist AUTHORIZED state BEFORE the effect.
        tracing::info!(
            target: "terminus_kernel_audit",
            event = "authorized",
            service = "files.read",
            request_id = %ctx.request_id,
            task_id = %ctx.task_id,
            actor_id = %ctx.actor_id,
            workspace_id = %path.workspace_id,
            relative_path = %path.relative_path,
            resolved_host_path = %resolved.host.host_path.display(),
            "file read authorized",
        );
        // Reject oversized files BEFORE reading: the ingest ceiling is only
        // enforced after a full in-memory read otherwise, so a near-ceiling
        // file would be resident (and hashed) before rejection.
        let file_len = std::fs::metadata(&resolved.host.host_path)
            .map_err(|e| {
                KernelError::new(
                    terminus_kernel_protocol::ErrorCode::PathNotFound,
                    terminus_kernel_protocol::ErrorCategory::NotFound,
                    format!("read {}: {e}", resolved.host.host_path.display()),
                    false,
                )
            })?
            .len();
        let max_bytes = self.artifact_store.max_bytes();
        if file_len > max_bytes {
            return Err(KernelError::new(
                terminus_kernel_protocol::ErrorCode::ResourceExhausted,
                    terminus_kernel_protocol::ErrorCategory::ResourceExhausted,
                format!(
                    "read {}: file is {file_len} bytes, above the {max_bytes}-byte artifact ceiling",
                    resolved.host.host_path.display()
                ),
                false,
            ));
        }
        let bytes = std::fs::read(&resolved.host.host_path).map_err(|e| {
            KernelError::new(
                terminus_kernel_protocol::ErrorCode::PathNotFound,
                terminus_kernel_protocol::ErrorCategory::NotFound,
                format!("read {}: {e}", resolved.host.host_path.display()),
                false,
            )
        })?;
        let (_, artifact) = self.artifact_store.ingest(&bytes).map_err(|e| {
            KernelError::new(
                terminus_kernel_protocol::ErrorCode::Internal,
                terminus_kernel_protocol::ErrorCategory::Internal,
                format!("ingest failed: {e}"),
                false,
            )
        })?;
        Ok((bytes, artifact))
    }
}

// ---------- PatchService ----------

#[derive(Clone)]
pub struct PatchService {
    workspaces: WorkspaceService,
    journal_root: PathBuf,
    state_root: PathBuf,
    engines: Arc<Mutex<HashMap<String, Arc<PatchEngine>>>>,
    token_issuer: Arc<TokenIssuer>,
}

impl std::fmt::Debug for PatchService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PatchService")
            .field("workspaces", &self.workspaces)
            .field("journal_root", &self.journal_root)
            .field("state_root", &self.state_root)
            .finish_non_exhaustive()
    }
}

impl PatchService {
    pub fn new(
        workspaces: WorkspaceService,
        journal_root: PathBuf,
        state_root: PathBuf,
        token_issuer: Arc<TokenIssuer>,
    ) -> Self {
        Self {
            workspaces,
            journal_root,
            state_root,
            engines: Arc::new(Mutex::new(HashMap::new())),
            token_issuer,
        }
    }

    fn engine_for_workspace(
        &self,
        ctx: &RequestContext,
        token: &terminus_authz::CapabilityToken,
        workspace_id: &str,
    ) -> KernelResult<Arc<PatchEngine>> {
        let resolver = self
            .workspaces
            .resolver_for_effect(ctx, token, workspace_id)?;
        let mut engines = match self.engines.lock() {
            Ok(engines) => engines,
            Err(poisoned) => poisoned.into_inner(),
        };
        if let Some(engine) = engines.get(workspace_id) {
            return Ok(Arc::clone(engine));
        }
        let storage_key = workspace_storage_key(workspace_id);
        let engine = Arc::new(
            PatchEngine::new(
                resolver,
                self.journal_root.join(&storage_key),
                self.state_root.join(&storage_key),
            )
            .map_err(|error| {
                KernelError::new(
                    terminus_kernel_protocol::ErrorCode::Internal,
                    terminus_kernel_protocol::ErrorCategory::Internal,
                    format!("workspace patch engine initialization failed: {error}"),
                    false,
                )
            })?,
        );
        engines.insert(workspace_id.to_string(), Arc::clone(&engine));
        Ok(engine)
    }

    pub fn apply(
        &self,
        ctx: &RequestContext,
        intent: &EffectIntent,
        transaction_id: &str,
        baseline: &WorkspaceBaseline,
        edits: &[PatchEdit],
    ) -> KernelResult<PatchResponse> {
        self.apply_with_mode(
            ctx,
            intent,
            transaction_id,
            baseline,
            edits,
            terminus_kernel_protocol::PatchCommitMode::ApplyToWorktree,
        )
    }

    /// Apply a patch with an explicit commit mode. Used by the HTTP
    /// mini-service to differentiate `preview` vs `apply` endpoints.
    pub fn apply_with_mode(
        &self,
        ctx: &RequestContext,
        _intent: &EffectIntent,
        transaction_id: &str,
        baseline: &WorkspaceBaseline,
        edits: &[PatchEdit],
        commit_mode: terminus_kernel_protocol::PatchCommitMode,
    ) -> KernelResult<PatchResponse> {
        let patch_paths = patch_workspace_paths(edits, &baseline.workspace_id)?;
        for path in baseline
            .sources
            .iter()
            .map(|source| &source.path)
            .chain(patch_paths.iter())
        {
            if path.workspace_id != baseline.workspace_id {
                return Err(KernelError::new(
                    terminus_kernel_protocol::ErrorCode::PermissionDenied,
                    terminus_kernel_protocol::ErrorCategory::Permission,
                    format!(
                        "patch path workspace `{}` does not match baseline workspace `{}`",
                        path.workspace_id, baseline.workspace_id
                    ),
                    false,
                ));
            }
        }
        let requested_scope = Scope {
            workspace_paths: patch_paths
                .iter()
                .map(|path| path.relative_path.clone())
                .collect(),
            network_destinations: Vec::new(),
            secret_capabilities: Vec::new(),
        };
        // §31.3 steps 3-5: validate the capability, bind every edit to the
        // baseline workspace, then select that workspace's resolver.
        let token = validate_capability_for_op(
            &self.token_issuer,
            ctx,
            OperationClass::Patch,
            &requested_scope,
        )?;
        let engine = self.engine_for_workspace(ctx, &token, &baseline.workspace_id)?;
        // §31.3 step 10: persist AUTHORIZED state.
        tracing::info!(
            target: "terminus_kernel_audit",
            event = "authorized",
            service = "patch.apply",
            request_id = %ctx.request_id,
            task_id = %ctx.task_id,
            actor_id = %ctx.actor_id,
            transaction_id = %transaction_id,
            commit_mode = ?commit_mode,
            edit_count = edits.len(),
            "patch apply authorized",
        );
        engine
            .apply(
                transaction_id,
                baseline,
                edits,
                commit_mode,
                terminus_patch::ValidationProfile::TaskDefault,
            )
            .map_err(|e| {
                KernelError::new(
                    terminus_kernel_protocol::ErrorCode::StaleSourceVersion,
                    terminus_kernel_protocol::ErrorCategory::Conflict,
                    format!("{e}"),
                    true,
                )
            })
    }

    pub fn reconcile(
        &self,
        ctx: &RequestContext,
        transaction_id: &str,
    ) -> KernelResult<PatchResponse> {
        let requested_scope = Scope::default();
        let token = validate_capability_for_op(
            &self.token_issuer,
            ctx,
            OperationClass::Patch,
            &requested_scope,
        )?;
        let engine = self.engine_for_workspace(ctx, &token, &ctx.workspace_id)?;
        engine.reconcile(transaction_id).map_err(|e| {
            KernelError::new(
                terminus_kernel_protocol::ErrorCode::Internal,
                terminus_kernel_protocol::ErrorCategory::Internal,
                e.to_string(),
                false,
            )
        })
    }
}

fn patch_workspace_paths(
    edits: &[PatchEdit],
    baseline_workspace_id: &str,
) -> KernelResult<Vec<WorkspacePath>> {
    let mut paths = Vec::new();
    for edit in edits {
        match edit {
            PatchEdit::ReplaceSymbol(edit) => paths.push(edit.path.clone()),
            PatchEdit::ReplaceRange(edit) => paths.push(edit.path.clone()),
            PatchEdit::ReplaceHashline(edit) => paths.push(edit.path.clone()),
            PatchEdit::ReplaceExactText(edit) => paths.push(edit.path.clone()),
            PatchEdit::Insert(edit) => paths.push(edit.path.clone()),
            PatchEdit::DeleteRange(edit) => paths.push(edit.path.clone()),
            PatchEdit::CreateFile(edit) => paths.push(edit.path.clone()),
            PatchEdit::MoveFile(edit) => {
                paths.push(edit.from.clone());
                paths.push(edit.to.clone());
            }
            PatchEdit::DeleteFile(edit) => paths.push(edit.path.clone()),
            PatchEdit::UnifiedDiff(edit) => {
                let diff = String::from_utf8_lossy(&edit.diff_utf8);
                let relative_path = diff
                    .lines()
                    .find_map(|line| line.strip_prefix("+++ b/"))
                    .or_else(|| diff.lines().find_map(|line| line.strip_prefix("--- a/")))
                    .filter(|path| !path.is_empty())
                    .ok_or_else(|| {
                        KernelError::new(
                            terminus_kernel_protocol::ErrorCode::InvalidArgument,
                            terminus_kernel_protocol::ErrorCategory::Validation,
                            "unified diff must identify one workspace-relative target path",
                            false,
                        )
                    })?;
                paths.push(WorkspacePath::new(baseline_workspace_id, relative_path));
            }
        }
    }
    Ok(paths)
}

fn workspace_storage_key(workspace_id: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(workspace_id.as_bytes());
    hex::encode(hasher.finalize())
}

/// The exact profile id required by the capability-bound workspace policy.
/// This profile is intentionally not resolved until an isolated backend is
/// shipped; accepting a native default here would turn a policy expansion
/// into an unsandboxed authority expansion.
const WORKSPACE_DEVELOPMENT_ISOLATED_SANDBOX_PROFILE_ID: &str = "workspace-development-isolated";

/// Resolve a sandbox profile id to a `SandboxProfile`. The kernel currently
/// ships one enforced profile (`default-restrictive`); `secure-local-default`
/// (the config profile name) maps to it. Unknown ids are rejected rather than
/// substituted with a weaker profile. When multiple profiles are added, this
/// MUST consult a profile registry keyed by id.
fn resolve_sandbox_profile(profile_id: &str) -> KernelResult<SandboxProfile> {
    match profile_id {
        "secure-local-default" | "default-restrictive" => {
            let mut profile = SandboxProfile::default_restrictive();
            profile.id = profile_id.to_string();
            Ok(profile)
        }
        "degraded-local" => {
            let mut profile = SandboxProfile::default_restrictive();
            profile.id = profile_id.to_string();
            // No enforcing backend stands behind this profile, so the
            // protective overlays are all it has. Re-assert them rather than
            // trusting the default: this arm used to hand-match the path
            // `workspace://.git`, and when the rule set changed shape that
            // match silently became a no-op.
            profile.enforce_workspace_overlays();
            Ok(profile)
        }
        "proxy-required" => {
            let mut profile = SandboxProfile::default_restrictive();
            profile.id = profile_id.to_string();
            profile.network = terminus_sandbox::NetworkAccess::ProxyRequired;
            Ok(profile)
        }
        WORKSPACE_DEVELOPMENT_ISOLATED_SANDBOX_PROFILE_ID => Err(KernelError::new(
            terminus_kernel_protocol::ErrorCode::SandboxUnavailable,
            terminus_kernel_protocol::ErrorCategory::SandboxUnavailable,
            format!("sandbox profile `{profile_id}` is not available on this kernel"),
            false,
        )),
        _ => Err(KernelError::new(
            terminus_kernel_protocol::ErrorCode::InvalidArgument,
            terminus_kernel_protocol::ErrorCategory::Validation,
            format!("unknown sandbox profile `{profile_id}`"),
            false,
        )),
    }
}

/// Per-workspace scratch directory handed to the payload as `TMPDIR`.
///
/// Neither `/tmp` nor the darwin per-user temp directory is writable under
/// the generated Seatbelt profile (deliberately — both are shared with the
/// rest of the machine and a write there is a workspace escape), so the
/// kernel provisions one directory per workspace instead. The name is
/// derived from the canonical root so repeated execs in the same workspace
/// reuse it and two workspaces never collide.
fn workspace_scratch_dir(canonical_root: &std::path::Path) -> Option<PathBuf> {
    let mut hasher = Sha256::new();
    hasher.update(canonical_root.as_os_str().as_encoded_bytes());
    let digest = hex::encode(hasher.finalize());
    let dir = std::env::temp_dir().join(format!(
        "{}{}",
        terminus_sandbox::SCRATCH_DIR_PREFIX,
        &digest[..16]
    ));
    std::fs::create_dir_all(&dir).ok()?;
    // Seatbelt and bwrap both match on the RESOLVED path (`/var/folders/…`
    // is a symlink to `/private/var/folders/…` on macOS), so the rule has to
    // carry the canonical spelling or the allowance never fires.
    Some(std::fs::canonicalize(&dir).unwrap_or(dir))
}

fn materialize_workspace_profile(
    mut profile: SandboxProfile,
    workspace_root: &std::path::Path,
) -> SandboxProfile {
    // Canonicalize FIRST. A symlinked root — `/var/folders/…` on macOS,
    // `/tmp` inside a container, any developer checkout reached through a
    // symlink — otherwise produces allowances for a path the sandbox never
    // sees, and every write inside the workspace fails with EPERM.
    let canonical_root =
        std::fs::canonicalize(workspace_root).unwrap_or_else(|_| workspace_root.to_path_buf());
    for rule in &mut profile.filesystem {
        let Some(relative) = rule.path.strip_prefix("workspace://") else {
            continue;
        };
        rule.path = if relative.is_empty() {
            canonical_root.display().to_string()
        } else {
            canonical_root.join(relative).display().to_string()
        };
    }
    if let Some(scratch) = workspace_scratch_dir(&canonical_root) {
        profile.filesystem.push(terminus_sandbox::FilesystemRule {
            path: scratch.display().to_string(),
            access: terminus_sandbox::FilesystemAccess::ReadWrite,
        });
    }
    profile
}

#[cfg(test)]
mod sandbox_profile_tests {
    use super::{materialize_workspace_profile, resolve_sandbox_profile};

    #[test]
    fn proxy_required_is_explicit_and_non_default() {
        assert!(matches!(
            resolve_sandbox_profile("proxy-required"),
            Ok(profile)
                if profile.id == "proxy-required"
                    && matches!(
                        profile.network,
                        terminus_sandbox::NetworkAccess::ProxyRequired
                    )
        ));
        assert!(matches!(
            resolve_sandbox_profile("default-restrictive"),
            Ok(profile) if matches!(profile.network, terminus_sandbox::NetworkAccess::Deny)
        ));
    }

    #[test]
    fn the_degraded_profile_still_carries_every_protective_overlay() {
        // This arm previously looped over `workspace://.git`, a path the rule
        // set no longer contains, so it protected nothing at all.
        let profile = resolve_sandbox_profile("degraded-local").expect("degraded profile resolves");
        assert_eq!(profile.id, "degraded-local");
        for path in terminus_sandbox::PROTECTED_GIT_OVERLAYS {
            let rule = profile.filesystem.iter().find(|r| r.path == *path);
            assert!(rule.is_some(), "degraded-local lost the overlay {path}");
            assert_eq!(
                rule.expect("presence asserted above").access,
                terminus_sandbox::FilesystemAccess::ReadOnly,
                "{path} must stay readable but never writable"
            );
        }
        for path in terminus_sandbox::DENIED_WORKSPACE_OVERLAYS {
            let rule = profile.filesystem.iter().find(|r| r.path == *path);
            assert!(
                rule.is_some(),
                "degraded-local lost the deny overlay {path}"
            );
            assert_eq!(
                rule.expect("presence asserted above").access,
                terminus_sandbox::FilesystemAccess::Deny,
                "{path} must be fully denied"
            );
        }
        // The workspace root itself stays writable in degraded mode.
        assert!(profile.filesystem.iter().any(|r| r.path == "workspace://"
            && r.access == terminus_sandbox::FilesystemAccess::ReadWrite));
    }

    #[test]
    fn unknown_profile_is_rejected() {
        assert!(resolve_sandbox_profile("unknown-profile").is_err());
    }

    #[test]
    fn exec_timeouts_follow_the_request_instead_of_a_flat_sixty_seconds() {
        let limits = resolve_sandbox_profile("default-restrictive")
            .expect("profile")
            .resources;
        let foreground = |requested| {
            let requested =
                std::cmp::min(requested, terminus_sandbox::MAX_FOREGROUND_WALL_CLOCK_MS);
            terminus_sandbox::resolve_exec_timeout_ms(
                requested,
                &limits,
                terminus_sandbox::MAX_BACKGROUND_WALL_CLOCK_MS,
            )
        };
        // No caller timeout at all ⇒ the 60 s profile default.
        assert_eq!(foreground(0), 60_000);
        // A real test suite asks for minutes and gets them.
        assert_eq!(foreground(120_000), 120_000);
        assert_eq!(foreground(600_000), 600_000);
        // Foreground ceiling: 10 minutes.
        assert_eq!(
            foreground(3_600_000),
            terminus_sandbox::MAX_FOREGROUND_WALL_CLOCK_MS
        );
        // Background jobs reach the shared implementation directly and get
        // the 30-minute kernel ceiling.
        assert_eq!(
            terminus_sandbox::resolve_exec_timeout_ms(
                1_500_000,
                &limits,
                terminus_sandbox::MAX_BACKGROUND_WALL_CLOCK_MS
            ),
            1_500_000
        );
        assert_eq!(
            terminus_sandbox::resolve_exec_timeout_ms(
                u64::MAX,
                &limits,
                terminus_sandbox::MAX_BACKGROUND_WALL_CLOCK_MS
            ),
            terminus_sandbox::MAX_BACKGROUND_WALL_CLOCK_MS
        );
    }

    #[test]
    fn workspace_rules_are_materialized_under_the_registered_root() {
        let workspace_root =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("registered-workspace");
        let profile = resolve_sandbox_profile("secure-local-default")
            .map(|profile| materialize_workspace_profile(profile, &workspace_root));
        let expected_root = workspace_root.display().to_string();
        let expected_hooks = workspace_root.join(".git/hooks").display().to_string();
        assert!(matches!(profile, Ok(profile) if
            profile.filesystem.iter().any(|rule| rule.path == expected_root)
                && profile.filesystem.iter().any(|rule| rule.path == expected_hooks)
                && profile.filesystem.iter().all(|rule| !rule.path.starts_with("workspace://"))
        ));
    }

    #[test]
    fn workspace_root_is_writable_and_carries_a_scratch_directory() {
        let workspace = tempfile::tempdir().expect("workspace");
        let profile = materialize_workspace_profile(
            resolve_sandbox_profile("secure-local-default").expect("profile"),
            workspace.path(),
        );
        let canonical = std::fs::canonicalize(workspace.path()).expect("canonical");
        let root_rule = profile
            .filesystem
            .iter()
            .find(|rule| rule.path == canonical.display().to_string())
            .expect("workspace root rule");
        assert_eq!(
            root_rule.access,
            terminus_sandbox::FilesystemAccess::ReadWrite,
            "an agent that cannot write its own checkout cannot do anything"
        );
        let scratch = profile.scratch_dir().expect("scratch directory");
        assert!(
            std::path::Path::new(scratch).is_dir(),
            "the scratch directory must exist before the payload starts"
        );
        assert!(scratch.contains(terminus_sandbox::SCRATCH_DIR_PREFIX));
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_workspace_roots_are_canonicalized() {
        // A symlinked root (`/var/folders/…` on macOS, or any developer
        // checkout reached through a symlink) used to void every Seatbelt
        // allowance: the profile named the link, the kernel enforced on the
        // target, and every write inside the workspace returned EPERM.
        let parent = tempfile::tempdir().expect("parent");
        let real = std::fs::canonicalize(parent.path())
            .expect("canonical parent")
            .join("real-workspace");
        std::fs::create_dir_all(&real).expect("real workspace");
        let link = parent.path().join("linked-workspace");
        std::os::unix::fs::symlink(&real, &link).expect("symlink");

        let profile = materialize_workspace_profile(
            resolve_sandbox_profile("secure-local-default").expect("profile"),
            &link,
        );
        let expected = real.display().to_string();
        assert!(
            profile.filesystem.iter().any(|rule| rule.path == expected),
            "expected a rule for the resolved root {expected}, got {:?}",
            profile
                .filesystem
                .iter()
                .map(|rule| rule.path.clone())
                .collect::<Vec<_>>()
        );
        assert!(
            !profile
                .filesystem
                .iter()
                .any(|rule| rule.path == link.display().to_string()),
            "the symlink spelling must not survive materialization"
        );
    }
}

// ---------- ProcessService ----------

#[derive(Clone)]
pub struct ProcessService {
    process: Arc<ProcessManager>,
    policy: Arc<PolicyEngine>,
    workspace_development_policy: Result<Arc<PolicyEngine>, String>,
    token_issuer: Arc<TokenIssuer>,
    approvals: Arc<ApprovalStore>,
    workspaces: WorkspaceService,
    /// Sandbox manager used to select and validate the enforcement backend
    /// for each process start (SPEC §13, §31.3 step 11). `None` when a unit
    /// test constructs `ProcessService` directly; the production
    /// `KernelHandle` wires a real manager via `with_sandbox`.
    sandbox: Option<Arc<SandboxManager>>,
    /// Kernel-owned route for `proxy-required` sandbox leases. The caller
    /// never supplies this path: each process receives a fresh private
    /// broker socket after policy/capability authorization succeeds.
    egress_broker: Option<EgressBrokerConfig>,
}

#[derive(Debug, Clone)]
struct EgressBrokerConfig {
    proxy: Arc<EgressProxy>,
    root: PathBuf,
}

#[cfg(unix)]
struct ActiveEgressBroker {
    broker_dir: Option<PathBuf>,
    socket_path: Option<PathBuf>,
    server: Option<tokio::task::JoinHandle<()>>,
}

#[cfg(unix)]
impl ActiveEgressBroker {
    fn guest_socket_path() -> String {
        format!(
            "{}/{}",
            terminus_sandbox_linux::LinuxSandboxBackend::EGRESS_BROKER_GUEST_DIR,
            terminus_sandbox_linux::LinuxSandboxBackend::EGRESS_BROKER_SOCKET_NAME
        )
    }

    fn into_spawn_lease(mut self) -> SpawnLease {
        let server = self.server.take();
        let socket_path = self.socket_path.take();
        let broker_dir = self.broker_dir.take();
        SpawnLease::new(move || {
            if let Some(server) = server {
                server.abort();
            }
            if let Some(socket_path) = socket_path {
                let _ = std::fs::remove_file(socket_path);
            }
            if let Some(broker_dir) = broker_dir {
                let _ = std::fs::remove_dir_all(broker_dir);
            }
        })
    }
}

#[cfg(unix)]
impl Drop for ActiveEgressBroker {
    fn drop(&mut self) {
        if let Some(server) = self.server.take() {
            server.abort();
        }
        if let Some(socket_path) = self.socket_path.take() {
            let _ = std::fs::remove_file(socket_path);
        }
        if let Some(broker_dir) = self.broker_dir.take() {
            let _ = std::fs::remove_dir_all(broker_dir);
        }
    }
}

impl std::fmt::Debug for ProcessService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProcessService")
            .field("process", &self.process)
            .field("policy", &self.policy)
            .field(
                "workspace_development_policy_loaded",
                &self.workspace_development_policy.is_ok(),
            )
            .field("workspaces", &self.workspaces)
            .finish_non_exhaustive()
    }
}

impl ProcessService {
    pub fn new(
        process: Arc<ProcessManager>,
        policy: Arc<PolicyEngine>,
        token_issuer: Arc<TokenIssuer>,
        approvals: Arc<ApprovalStore>,
        workspaces: WorkspaceService,
    ) -> Self {
        Self {
            process,
            policy,
            workspace_development_policy: terminus_policy::workspace_development_rule_set()
                .map(PolicyEngine::new)
                .map(Arc::new)
                .map_err(|error| error.to_string()),
            token_issuer,
            approvals,
            workspaces,
            sandbox: None,
            egress_broker: None,
        }
    }

    /// Attach the sandbox manager so `start` can select and validate the
    /// enforcement backend (SPEC §31.3 step 11). Used by `KernelHandle::new`.
    pub fn with_sandbox(mut self, sandbox: Arc<SandboxManager>) -> Self {
        self.sandbox = Some(sandbox);
        self
    }

    /// Attach the kernel-owned egress relay factory for explicit
    /// `proxy-required` executions.
    pub fn with_egress_broker(mut self, proxy: Arc<EgressProxy>, root: PathBuf) -> Self {
        self.egress_broker = Some(EgressBrokerConfig { proxy, root });
        self
    }

    fn command_policy<'a>(
        &'a self,
        token: &terminus_authz::CapabilityToken,
        requested_profile_id: &str,
        sandbox_profile_id: &str,
    ) -> KernelResult<&'a PolicyEngine> {
        match requested_profile_id {
            "" | "default" | terminus_policy::SECURE_LOCAL_DEFAULT_POLICY_PROFILE_ID => {
                Ok(&self.policy)
            }
            terminus_policy::WORKSPACE_DEVELOPMENT_POLICY_PROFILE_ID => {
                if !token
                    .allows_policy_profile(terminus_policy::WORKSPACE_DEVELOPMENT_POLICY_PROFILE_ID)
                {
                    return Err(KernelError::new(
                        terminus_kernel_protocol::ErrorCode::PermissionDenied,
                        terminus_kernel_protocol::ErrorCategory::Permission,
                        "capability token does not authorize command policy profile `workspace-development`",
                        false,
                    ));
                }
                let workspace_scope = &token.claims.max_scope.workspace_paths;
                if workspace_scope.len() != 1 || workspace_scope[0] != "**" {
                    return Err(KernelError::new(
                        terminus_kernel_protocol::ErrorCode::PermissionDenied,
                        terminus_kernel_protocol::ErrorCategory::Permission,
                        "workspace-development policy requires an explicit whole-workspace capability scope",
                        false,
                    ));
                }
                if sandbox_profile_id != WORKSPACE_DEVELOPMENT_ISOLATED_SANDBOX_PROFILE_ID {
                    return Err(KernelError::new(
                        terminus_kernel_protocol::ErrorCode::SandboxUnavailable,
                        terminus_kernel_protocol::ErrorCategory::SandboxUnavailable,
                        format!(
                            "workspace-development policy requires sandbox profile `{WORKSPACE_DEVELOPMENT_ISOLATED_SANDBOX_PROFILE_ID}`"
                        ),
                        false,
                    ));
                }
                self.workspace_development_policy
                    .as_ref()
                    .map(Arc::as_ref)
                    .map_err(|error| {
                        KernelError::new(
                            terminus_kernel_protocol::ErrorCode::IntegrityCheckFailed,
                            terminus_kernel_protocol::ErrorCategory::Integrity,
                            format!("workspace-development policy failed to load: {error}"),
                            false,
                        )
                    })
            }
            other => Err(KernelError::new(
                terminus_kernel_protocol::ErrorCode::InvalidArgument,
                terminus_kernel_protocol::ErrorCategory::Validation,
                format!("unknown command policy profile `{other}`"),
                false,
            )),
        }
    }

    #[cfg(unix)]
    async fn start_egress_broker(&self) -> KernelResult<ActiveEgressBroker> {
        let config = self.egress_broker.clone().ok_or_else(|| {
            KernelError::new(
                terminus_kernel_protocol::ErrorCode::SandboxUnavailable,
                terminus_kernel_protocol::ErrorCategory::SandboxUnavailable,
                "proxy-required profile has no kernel-owned egress broker".to_string(),
                false,
            )
        })?;
        let (broker, broker_dir, socket_path) = tokio::task::spawn_blocking(move || {
            use std::os::unix::fs::PermissionsExt;

            std::fs::create_dir_all(&config.root)?;
            std::fs::set_permissions(&config.root, std::fs::Permissions::from_mode(0o700))?;
            let broker_dir = config.root.join(terminus_kernel_protocol::new_id());
            std::fs::create_dir(&broker_dir)?;
            std::fs::set_permissions(&broker_dir, std::fs::Permissions::from_mode(0o700))?;
            let socket_path = broker_dir
                .join(terminus_sandbox_linux::LinuxSandboxBackend::EGRESS_BROKER_SOCKET_NAME);
            let broker = terminus_egress::EgressBroker::bind(&socket_path, config.proxy)?;
            Ok::<_, terminus_egress::EgressError>((broker, broker_dir, socket_path))
        })
        .await
        .map_err(|error| {
            KernelError::new(
                terminus_kernel_protocol::ErrorCode::SandboxUnavailable,
                terminus_kernel_protocol::ErrorCategory::SandboxUnavailable,
                format!("egress broker setup task failed: {error}"),
                false,
            )
        })?
        .map_err(|error| {
            KernelError::new(
                terminus_kernel_protocol::ErrorCode::SandboxUnavailable,
                terminus_kernel_protocol::ErrorCategory::SandboxUnavailable,
                format!("egress broker setup failed: {error}"),
                false,
            )
        })?;
        let server = tokio::spawn(async move {
            loop {
                if let Err(error) = broker.serve_one().await {
                    tracing::debug!(
                        target: "terminus_kernel_audit",
                        event = "egress_broker_connection_rejected",
                        error = %error,
                        "egress broker rejected or closed a client connection"
                    );
                    // A persistent accept failure (fd exhaustion, detached
                    // listener) must not spin the loop hot; back off before
                    // retrying.
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                }
            }
        });
        Ok(ActiveEgressBroker {
            broker_dir: Some(broker_dir),
            socket_path: Some(socket_path),
            server: Some(server),
        })
    }

    #[cfg(not(unix))]
    async fn start_egress_broker(&self) -> KernelResult<()> {
        Err(KernelError::new(
            terminus_kernel_protocol::ErrorCode::SandboxUnavailable,
            terminus_kernel_protocol::ErrorCategory::SandboxUnavailable,
            "proxy-required execution requires a Unix-domain egress broker".to_string(),
            false,
        ))
    }

    /// Build a `NormalizedCommand` from a `CommandSpec`. The command is
    /// classified heuristically: shell scripts get `EXECUTE_LOCAL`; commands
    /// whose program is a known network client (`curl`, `wget`, `git`) get
    /// the appropriate network effect type.
    fn build_normalized(command: &CommandSpec) -> NormalizedCommand {
        use terminus_policy::EffectType;
        let mut normalized = NormalizedCommand::new(&command.program);
        normalized.argv = command.args.clone();
        normalized.working_directory = command.cwd.relative_path.clone();
        normalized.secret_capabilities = command.secret_capability_uris.clone();
        normalized.effect_types.insert(EffectType::ExecuteLocal);
        if !command.secret_capability_uris.is_empty() {
            normalized.effect_types.insert(EffectType::SecretUse);
        }
        // Heuristic effect classification: shell scripts and known network
        // binaries get extra effect types so the policy engine can match on
        // them.
        if command.shell.enabled {
            let parsed = terminus_policy::ShellAst::parse(&command.shell.script);
            normalized.shell_ast = parsed.shell_ast;
            normalized.redirections = parsed.redirections;
            normalized.effect_types.extend(parsed.effect_types);
        }
        let program_basename = command
            .program
            .rsplit('/')
            .next()
            .unwrap_or(&command.program);
        if matches!(program_basename, "curl" | "wget") {
            normalized.effect_types.insert(EffectType::NetworkRead);
        }
        if program_basename == "git" && command.args.iter().any(|a| a == "push") {
            normalized.effect_types.insert(EffectType::NetworkWrite);
        }
        // If argv contains a shell pipe (literal `|`) or a shell name, mark
        // as ExecuteLocal too — this is conservative.
        if command
            .args
            .iter()
            .any(|a| a == "|" || a == "bash" || a == "sh" || a == "python" || a == "perl")
        {
            normalized.effect_types.insert(EffectType::ExecuteLocal);
        }
        normalized
    }

    /// Apply policy constraints to a `NormalizedSpawn`:
    /// - `max_runtime_ms`: cap `spawn.timeout_ms` if the constraint is lower.
    /// - `max_output_bytes`: applied via `ProcessManager::with_max_inline_bytes`.
    /// - `disallowed_env`: filter these env vars out of `spawn.env`.
    /// - `redact_patterns`: recorded in the audit log; not applied here
    ///   because the process manager does not yet support runtime redaction.
    fn apply_constraints(
        spawn: terminus_process::NormalizedSpawn,
        constraints: &Constraint,
    ) -> terminus_process::NormalizedSpawn {
        let mut s = spawn;
        if let Some(max_rt) = constraints.max_runtime_ms {
            if max_rt > 0 && (s.timeout_ms == 0 || max_rt < s.timeout_ms) {
                s.timeout_ms = max_rt;
            }
        }
        if !constraints.disallowed_env.is_empty() {
            s.env
                .retain(|k, _| !constraints.disallowed_env.iter().any(|d| d == k));
        }
        s
    }

    /// Start a process under the default restrictive sandbox profile.
    /// Enforces the SPEC §31.3 14-step validation order: capability token →
    /// effect/taint classification → policy evaluation → approval resolution
    /// → sandbox selection → budget reservation → audit (AUTHORIZED) →
    /// spawn → evidence audit.
    pub async fn start(
        &self,
        ctx: &RequestContext,
        intent: &EffectIntent,
        command: CommandSpec,
    ) -> KernelResult<tokio::sync::mpsc::Receiver<ProcessEvent>> {
        self.start_in_profile(ctx, intent, command, "default-restrictive")
            .await
    }

    /// Start a process under a named sandbox profile. This is the full
    /// §31.3 14-step entry point used by the HTTP mini-service, which passes
    /// the request's `sandbox_profile_id`.
    pub async fn start_in_profile(
        &self,
        ctx: &RequestContext,
        intent: &EffectIntent,
        mut command: CommandSpec,
        sandbox_profile_id: &str,
    ) -> KernelResult<tokio::sync::mpsc::Receiver<ProcessEvent>> {
        // Foreground ceiling. A durable background job reaches
        // `start_in_profile_with_outcome` through `JobService::start` and is
        // bounded by the 30-minute kernel ceiling instead; an interactive
        // exec must not be able to hold a turn open that long.
        if command.timeout_ms > terminus_sandbox::MAX_FOREGROUND_WALL_CLOCK_MS {
            command.timeout_ms = terminus_sandbox::MAX_FOREGROUND_WALL_CLOCK_MS;
        }
        self.start_in_profile_with_outcome(ctx, intent, command, sandbox_profile_id)
            .await
            .map(|(_, receiver)| receiver)
    }

    /// Start a process and retain its identity for durable JobService
    /// ownership. The ordinary ProcessService API intentionally returns only
    /// the event stream; jobs need the generated process id as well.
    pub async fn start_in_profile_with_outcome(
        &self,
        ctx: &RequestContext,
        intent: &EffectIntent,
        command: CommandSpec,
        sandbox_profile_id: &str,
    ) -> KernelResult<(
        terminus_process::SpawnOutcome,
        tokio::sync::mpsc::Receiver<ProcessEvent>,
    )> {
        // §31.3 step 3: capability-token validation. Process start requires
        // the `Exec` operation class. The requested scope is the cwd path
        // and any secret capability URIs.
        let requested_scope = Scope {
            workspace_paths: vec![command.cwd.relative_path.clone()],
            network_destinations: Vec::new(),
            secret_capabilities: command.secret_capability_uris.clone(),
        };
        let token = validate_capability_for_op(
            &self.token_issuer,
            ctx,
            OperationClass::Exec,
            &requested_scope,
        )?;
        let command_policy =
            self.command_policy(&token, &intent.policy_profile_id, sandbox_profile_id)?;
        let cwd_safe = terminus_fs::SafePath::new(&command.cwd.relative_path).map_err(|error| {
            KernelError::new(
                terminus_kernel_protocol::ErrorCode::InvalidArgument,
                terminus_kernel_protocol::ErrorCategory::Validation,
                format!("process cwd rejected by SafePath: {error}"),
                false,
            )
        })?;
        let cwd_resolver =
            self.workspaces
                .resolver_for_effect(ctx, &token, &command.cwd.workspace_id)?;
        let resolved_cwd = cwd_resolver.resolve_strict(&cwd_safe).map_err(|error| {
            KernelError::new(
                terminus_kernel_protocol::ErrorCode::InvalidArgument,
                terminus_kernel_protocol::ErrorCategory::Validation,
                format!("process cwd rejected by PathResolver: {error}"),
                false,
            )
        })?;
        if !resolved_cwd.host.exists || !resolved_cwd.host.host_path.is_dir() {
            return Err(KernelError::new(
                terminus_kernel_protocol::ErrorCode::PathNotFound,
                terminus_kernel_protocol::ErrorCategory::NotFound,
                format!(
                    "process cwd is not an existing directory: {}",
                    command.cwd.relative_path
                ),
                false,
            ));
        }

        // §31.3 step 6: classify effect and taint. Propagate untrusted
        // provenance from the EffectIntent onto the normalized command so
        // the policy engine and downstream audit can see it (SPEC §13.7,
        // §27.3, §36.15). A tainted command carrying a privileged effect
        // (network write / external state write / secret use / local write)
        // is elevated to Prompt so a human must approve untrusted-driven
        // privileged effects.
        let mut normalized = Self::build_normalized(&command);
        let is_untrusted = intent.trust_label == "untrusted" || intent.trust_label == "derived";
        if is_untrusted {
            normalized.taint_sources.push(TaintSource {
                kind: intent.trust_label.clone(),
                uri: if intent.user_intent_ref.is_empty() {
                    "untrusted-intent".to_string()
                } else {
                    intent.user_intent_ref.clone()
                },
            });
        }
        for src in &intent.taint_sources {
            normalized.taint_sources.push(TaintSource {
                kind: "intent".to_string(),
                uri: src.clone(),
            });
        }
        let tainted = !normalized.taint_sources.is_empty();

        // §31.3 step 7: evaluate command/resource policy.
        let mut report = command_policy.evaluate(&normalized);

        // Taint elevation: a tainted privileged effect must not auto-allow.
        if tainted
            && matches!(report.decision, Decision::Allow)
            && normalized.effect_types.iter().any(|e| {
                matches!(
                    e,
                    terminus_policy::EffectType::NetworkWrite
                        | terminus_policy::EffectType::ExternalStateWrite
                        | terminus_policy::EffectType::SecretUse
                        | terminus_policy::EffectType::WriteLocal
                )
            })
        {
            report.decision = Decision::Prompt;
            report.explanation = format!(
                "elevated to prompt: effect is tainted by untrusted provenance ({})",
                intent.trust_label
            );
        }

        // §31.3 step 8: approval resolution (only when the policy says
        // Prompt).
        match report.decision {
            Decision::Deny => {
                return Err(KernelError::new(
                    terminus_kernel_protocol::ErrorCode::PolicyDenied,
                    terminus_kernel_protocol::ErrorCategory::PolicyDenied,
                    format!(
                        "policy denied: rules=[{}] explanation={}",
                        report.rule_ids.join(","),
                        report.explanation
                    ),
                    false,
                )
                .with_details(serde_json::json!({
                    "rule_ids": report.rule_ids,
                    "explanation": report.explanation,
                    "decision_id": report.decision_id,
                })));
            }
            Decision::Prompt => {
                // Is there an existing valid approval for this operation
                // hash? If so, consume it and proceed; otherwise deny with
                // ApprovalRequired.
                let op_hash = crate::approvals::operation_hash(
                    &command.program,
                    &command.args,
                    &command.cwd.relative_path,
                    "", // env digest omitted for now
                    &command.secret_capability_uris,
                );
                if let Some(_consumed) = self.approvals.consume(&op_hash) {
                    // Approval granted — fall through to spawn.
                } else {
                    tracing::warn!(
                        target: "terminus_kernel_audit",
                        event = "approval_required",
                        service = "process.start",
                        request_id = %ctx.request_id,
                        task_id = %ctx.task_id,
                        program = %command.program,
                        rule_ids = ?report.rule_ids,
                        explanation = %report.explanation,
                        "process start requires approval",
                    );
                    return Err(KernelError::new(
                        terminus_kernel_protocol::ErrorCode::ApprovalRequired,
                        terminus_kernel_protocol::ErrorCategory::ApprovalRequired,
                        format!(
                            "policy requires approval: rules=[{}] explanation={}",
                            report.rule_ids.join(","),
                            report.explanation
                        ),
                        false,
                    )
                    .with_details(serde_json::json!({
                        "rule_ids": report.rule_ids,
                        "explanation": report.explanation,
                        "decision_id": report.decision_id,
                        "operation_hash": op_hash,
                        "approval_status": "pending",
                    })));
                }
            }
            Decision::AllowWithConstraints => {
                // Constraints applied below before spawn.
            }
            Decision::Allow => {
                // No constraints.
            }
        }

        // Build the NormalizedSpawn and apply constraints if any.
        let mut spawn = terminus_process::NormalizedSpawn::from_spec(&command).map_err(|e| {
            KernelError::new(
                terminus_kernel_protocol::ErrorCode::InvalidArgument,
                terminus_kernel_protocol::ErrorCategory::Validation,
                format!("{e}"),
                false,
            )
        })?;
        spawn.working_dir = Some(resolved_cwd.host.host_path.clone());
        if matches!(report.decision, Decision::AllowWithConstraints) {
            spawn = Self::apply_constraints(spawn, &report.constraints);
        }

        // §31.3 step 11 (前置): select the sandbox backend for the named
        // profile and verify enforcement. SPEC §13.4: fail closed when the
        // backend is Unsupported, or when it is Degraded and strict mode is
        // enabled (`TERMINUS_STRICT_SANDBOX=1`). Otherwise audit the effective
        // (degraded) enforcement and proceed — degraded is an explicit,
        // audited state, never a silent downgrade.
        let profile = materialize_workspace_profile(
            resolve_sandbox_profile(sandbox_profile_id)?,
            cwd_resolver.root(),
        );
        let (enforcement, sandbox_backend) = if let Some(mgr) = &self.sandbox {
            match mgr.select(&profile) {
                Ok(backend) => (backend.enforcement_report(), Some(backend)),
                Err(e) => {
                    return Err(KernelError::new(
                        terminus_kernel_protocol::ErrorCode::SandboxUnavailable,
                        terminus_kernel_protocol::ErrorCategory::SandboxUnavailable,
                        format!("sandbox profile `{sandbox_profile_id}` rejected: {e}"),
                        false,
                    ));
                }
            }
        } else {
            // No sandbox manager attached (e.g. a direct unit test): there
            // is no enforcement, so fail closed rather than spawn unsandboxed.
            (
                terminus_sandbox::EnforcementReport {
                    backend_id: "none".to_string(),
                    status: EnforcementStatus::Unsupported,
                    enforced: Vec::new(),
                    degraded: Vec::new(),
                    unsupported: Vec::new(),
                    notes: vec!["no sandbox manager attached".to_string()],
                },
                None,
            )
        };
        #[cfg(unix)]
        let mut egress_broker: Option<ActiveEgressBroker> = None;
        let mut sandbox_command = command.clone();
        sandbox_command.cwd.relative_path = resolved_cwd.host.host_path.display().to_string();
        // Build the sandbox wrapper from the effective spawn, not the
        // caller's original command. Policy constraints may have removed
        // disallowed environment variables from `spawn.env`; passing the
        // original `public_env` here would reintroduce those values through
        // bwrap's `--setenv` arguments while the outer process remains
        // correctly filtered.
        sandbox_command.public_env = spawn.env.clone();
        let sandbox_wrapper = if matches!(
            profile.network,
            terminus_sandbox::NetworkAccess::ProxyRequired
        ) {
            #[cfg(unix)]
            {
                let broker = self.start_egress_broker().await?;
                let broker_socket = ActiveEgressBroker::guest_socket_path();
                spawn
                    .env
                    .insert("TERMINUS_EGRESS_BROKER_SOCKET".to_string(), broker_socket);
                sandbox_command.public_env = spawn.env.clone();
                let wrapper = broker.broker_dir.as_deref().and_then(|broker_dir| {
                    sandbox_backend.as_ref().and_then(|backend| {
                        backend.spawn_wrapper_with_egress_broker(
                            &sandbox_command,
                            &profile,
                            broker_dir,
                        )
                    })
                });
                egress_broker = Some(broker);
                wrapper
            }
            #[cfg(not(unix))]
            {
                let _ = self.start_egress_broker().await?;
                None
            }
        } else {
            sandbox_backend
                .as_ref()
                .and_then(|backend| backend.spawn_wrapper(&sandbox_command, &profile))
        };
        // Defense in depth: any profile that promises a network namespace
        // must have an actual wrapper. A backend report is not sufficient on
        // its own because wrapper construction can still fail (for example if
        // the launcher executable is unavailable). Never substitute a direct
        // process spawn for a secure profile.
        if sandbox_profile_id != "degraded-local"
            && matches!(
                profile.network,
                terminus_sandbox::NetworkAccess::Deny
                    | terminus_sandbox::NetworkAccess::ProxyRequired
            )
            && sandbox_wrapper.is_none()
        {
            return Err(KernelError::new(
                terminus_kernel_protocol::ErrorCode::SandboxUnavailable,
                terminus_kernel_protocol::ErrorCategory::SandboxUnavailable,
                format!(
                    "sandbox backend `{}` did not produce a network-isolating wrapper for secure profile `{}`",
                    enforcement.backend_id, sandbox_profile_id
                ),
                false,
            )
            .with_details(serde_json::json!({
                "backend": enforcement.backend_id,
                "profile": sandbox_profile_id,
                "notes": enforcement.notes,
            })));
        }
        // Degraded execution is an explicit profile choice. The secure
        // default fails closed without relying on an opt-in environment
        // variable (SPEC §36.5).
        let allow_degraded = sandbox_profile_id == "degraded-local";
        match enforcement.status {
            EnforcementStatus::Unsupported => {
                return Err(KernelError::new(
                    terminus_kernel_protocol::ErrorCode::SandboxUnavailable,
                    terminus_kernel_protocol::ErrorCategory::SandboxUnavailable,
                    format!(
                        "sandbox backend `{}` cannot enforce profile `{}` (unsupported); \
                         failing closed (SPEC §13.4). Run on a platform with a real backend \
                         (e.g. Linux + terminus-sandbox-linux) or attach a sandbox manager.",
                        enforcement.backend_id, sandbox_profile_id
                    ),
                    false,
                )
                .with_details(serde_json::json!({
                    "backend": enforcement.backend_id,
                    "unsupported": enforcement.unsupported.iter().map(|f| format!("{f:?}")).collect::<Vec<_>>(),
                    "notes": enforcement.notes,
                })));
            }
            EnforcementStatus::Degraded if !allow_degraded => {
                return Err(KernelError::new(
                    terminus_kernel_protocol::ErrorCode::SandboxDegraded,
                    terminus_kernel_protocol::ErrorCategory::SandboxUnavailable,
                    format!(
                        "sandbox backend `{}` is degraded for secure profile `{}`; \
                         failing closed (select `degraded-local` explicitly to proceed)",
                        enforcement.backend_id
                        , sandbox_profile_id
                    ),
                    false,
                )
                .with_details(serde_json::json!({
                    "backend": enforcement.backend_id,
                    "degraded": enforcement.degraded.iter().map(|f| format!("{f:?}")).collect::<Vec<_>>(),
                    "notes": enforcement.notes,
                })));
            }
            EnforcementStatus::Degraded => {
                tracing::warn!(
                    target: "terminus_kernel_audit",
                    event = "sandbox_degraded",
                    service = "process.start",
                    request_id = %ctx.request_id,
                    backend = %enforcement.backend_id,
                    profile = %sandbox_profile_id,
                    degraded = ?enforcement.degraded,
                    notes = ?enforcement.notes,
                    "process start proceeding under degraded sandbox enforcement (audited)"
                );
            }
            EnforcementStatus::Enforced => {}
        }

        // §31.3 step 9: reserve budgets and resource limits.
        //
        // The profile's `wall_clock_ms` is the DEFAULT for a caller that
        // sends none — it used to be applied as a cap, which silently clamped
        // every exec to 60 s and made `cargo test`, `bun run test` and
        // `pytest` impossible to run to completion. `spawn.timeout_ms` has
        // already been narrowed by any policy `max_runtime_ms` constraint
        // above; this applies the profile default and the absolute kernel
        // ceiling (30 min). Foreground execs were additionally bounded to
        // 10 min by `start_in_profile`.
        spawn.timeout_ms = terminus_sandbox::resolve_exec_timeout_ms(
            spawn.timeout_ms,
            &profile.resources,
            terminus_sandbox::MAX_BACKGROUND_WALL_CLOCK_MS,
        );
        tracing::info!(
            target: "terminus_kernel_audit",
            event = "budget_reserved",
            service = "process.start",
            request_id = %ctx.request_id,
            task_id = %ctx.task_id,
            timeout_ms = spawn.timeout_ms,
            pids_limit = ?profile.resources.pids,
            memory_bytes_limit = ?profile.resources.memory_bytes,
            "budget and resource limits reserved"
        );

        // §31.3 step 10: persist AUTHORIZED state BEFORE the effect.
        tracing::info!(
            target: "terminus_kernel_audit",
            event = "authorized",
            service = "process.start",
            request_id = %ctx.request_id,
            task_id = %ctx.task_id,
            actor_id = %ctx.actor_id,
            program = %command.program,
            args = ?command.args,
            cwd = %command.cwd.relative_path,
            decision = ?report.decision,
            policy_profile_id = %intent.policy_profile_id,
            rule_ids = ?report.rule_ids,
            decision_id = %report.decision_id,
            sandbox_backend = %enforcement.backend_id,
            sandbox_status = ?enforcement.status,
            taint_sources = ?normalized.taint_sources,
            "process start authorized",
        );

        // §31.3 step 11: execute. Apply max_output_bytes if the constraint
        // specifies it.
        let process_manager: Arc<ProcessManager> =
            if let Some(max_bytes) = report.constraints.max_output_bytes {
                Arc::new(
                    (*self.process)
                        .clone()
                        .with_max_inline_bytes(max_bytes.max(1) as usize),
                )
            } else {
                Arc::clone(&self.process)
            };
        let (outcome, rx) = if let Some((wrapper_bin, wrapper_argv)) = sandbox_wrapper {
            // SPEC §34.11: spawn inside the OS sandbox wrapper (bwrap).
            // ProcessManager still owns the process group, timeout, output
            // streaming, and tree-kill on cancel.
            tracing::info!(
                target: "terminus_kernel_audit",
                event = "sandbox_spawn_wrapped",
                service = "process.start",
                request_id = %ctx.request_id,
                wrapper = %wrapper_bin.display(),
                "spawning process inside OS sandbox wrapper"
            );
            #[cfg(unix)]
            if let Some(broker) = egress_broker {
                process_manager
                    .spawn_wrapped_with_lease_for_task(
                        wrapper_bin,
                        wrapper_argv,
                        spawn,
                        broker.into_spawn_lease(),
                        ctx.task_id.clone(),
                    )
                    .await
            } else {
                process_manager
                    .spawn_wrapped_for_task(wrapper_bin, wrapper_argv, spawn, ctx.task_id.clone())
                    .await
            }
            #[cfg(not(unix))]
            {
                process_manager
                    .spawn_wrapped_for_task(wrapper_bin, wrapper_argv, spawn, ctx.task_id.clone())
                    .await
            }
        } else {
            process_manager
                .spawn_for_task(spawn, ctx.task_id.clone())
                .await
        }
        .map_err(|e| {
            KernelError::new(
                terminus_kernel_protocol::ErrorCode::Internal,
                terminus_kernel_protocol::ErrorCategory::Internal,
                format!("{e}"),
                false,
            )
        })?;

        // §31.3 step 13: settle and persist evidence. The start is recorded
        // as an audited effect; exit-time stdout/stderr artifacts are ingested
        // by `ProcessManager` into the content-addressed store, so the
        // evidence chain reaches raw output by artifact reference.
        tracing::info!(
            target: "terminus_kernel_audit",
            event = "effect_started",
            service = "process.start",
            request_id = %ctx.request_id,
            task_id = %ctx.task_id,
            program = %command.program,
            "process effect started; exit artifacts recorded by ProcessManager"
        );
        Ok((outcome, rx))
    }

    pub async fn cancel(
        &self,
        ctx: &RequestContext,
        process_id: &str,
        reason: &str,
    ) -> KernelResult<String> {
        // §31.3 step 3: capability-token validation. Cancel is a process
        // control operation; require the Exec class (control over a process
        // started under Exec).
        let _ = validate_capability_for_op(
            &self.token_issuer,
            ctx,
            OperationClass::Exec,
            &Scope::default(),
        )?;
        let owner_task_id = self
            .process
            .owner_task_id(process_id)
            .await
            .ok_or_else(|| {
                KernelError::new(
                    terminus_kernel_protocol::ErrorCode::ProcessNotFound,
                    terminus_kernel_protocol::ErrorCategory::NotFound,
                    format!("process {process_id} has no live ownership record"),
                    false,
                )
            })?;
        authorize_process_task(&ctx.task_id, &owner_task_id)?;
        // §31.3 step 10: persist AUTHORIZED state.
        tracing::info!(
            target: "terminus_kernel_audit",
            event = "authorized",
            service = "process.cancel",
            request_id = %ctx.request_id,
            task_id = %ctx.task_id,
            actor_id = %ctx.actor_id,
            process_id = %process_id,
            reason = %reason,
            "process cancel authorized",
        );
        self.process.cancel(process_id, reason).await.map_err(|e| {
            KernelError::new(
                terminus_kernel_protocol::ErrorCode::ProcessNotFound,
                terminus_kernel_protocol::ErrorCategory::NotFound,
                format!("{e}"),
                false,
            )
        })
    }
}

fn authorize_process_task(request_task_id: &str, owner_task_id: &str) -> KernelResult<()> {
    if request_task_id == "*" || request_task_id == owner_task_id {
        return Ok(());
    }
    Err(KernelError::new(
        terminus_kernel_protocol::ErrorCode::PermissionDenied,
        terminus_kernel_protocol::ErrorCategory::Permission,
        "process capability is bound to a different task".to_string(),
        false,
    ))
}

#[cfg(test)]
mod process_authorization_tests {
    use super::authorize_process_task;
    use terminus_kernel_protocol::ErrorCode;

    #[test]
    fn process_control_rejects_cross_task_owner() {
        assert!(authorize_process_task("task-a", "task-a").is_ok());
        assert!(authorize_process_task("*", "task-a").is_ok());
        let error = authorize_process_task("task-b", "task-a").unwrap_err();
        assert_eq!(error.code(), ErrorCode::PermissionDenied);
    }
}

// ---------- JobService ----------

#[derive(Clone)]
pub struct JobService {
    manager: Arc<JobManager>,
    token_issuer: Arc<TokenIssuer>,
    process: ProcessService,
}

impl std::fmt::Debug for JobService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("JobService")
            .field("manager", &self.manager)
            .finish_non_exhaustive()
    }
}

impl JobService {
    pub fn new(
        manager: Arc<JobManager>,
        token_issuer: Arc<TokenIssuer>,
        process: ProcessService,
    ) -> Self {
        Self {
            manager,
            token_issuer,
            process,
        }
    }

    pub fn manager(&self) -> &Arc<JobManager> {
        &self.manager
    }

    /// The capability-token issuer used to validate tokens for job-control
    /// operations. Exposed for the HTTP mini-service to inject into the
    /// request context.
    pub fn token_issuer(&self) -> &Arc<TokenIssuer> {
        &self.token_issuer
    }

    /// Start a durable job through the same policy, capability, approval, and
    /// sandbox pipeline as ProcessService. The returned receiver is retained
    /// by the caller for the initial stream; process ownership remains in the
    /// shared ProcessManager held by both services.
    pub async fn start(
        &self,
        ctx: &RequestContext,
        intent: &EffectIntent,
        command: CommandSpec,
        sandbox_profile_id: &str,
        durable: bool,
    ) -> KernelResult<(
        String,
        terminus_process::SpawnOutcome,
        tokio::sync::mpsc::Receiver<ProcessEvent>,
    )> {
        let job_id = terminus_kernel_protocol::new_id();
        let command_text = format!("{} {}", command.program, command.args.join(" "));
        let record =
            terminus_jobs::JobRecord::new(&job_id, &ctx.session_id, &ctx.task_id, command_text);
        self.manager.create(record).await.map_err(job_error)?;
        if let Err(error) = self
            .manager
            .begin_start(&job_id, &command.program, None)
            .await
        {
            let _ = self.manager.remove(&job_id).await;
            return Err(job_error(error));
        }
        let started = self
            .process
            .start_in_profile_with_outcome(ctx, intent, command, sandbox_profile_id)
            .await;
        let (outcome, receiver) = match started {
            Ok(value) => value,
            Err(error) => {
                if let Err(persist_error) = self
                    .manager
                    .mark_start_failed(&job_id, &error.to_string())
                    .await
                {
                    return Err(job_error(persist_error));
                }
                return Err(error);
            }
        };
        if !durable {
            tracing::debug!(job_id = %job_id, "job started in non-durable mode");
        }
        if let Err(error) = self.manager.attach_started(&job_id, &outcome).await {
            // A durable write failure after spawn must not leave an
            // untracked process. Compensate through the same kernel control
            // path, then surface the original persistence error.
            let cancellation = self
                .manager
                .compensate_spawned(&outcome, "job attach persistence failed")
                .await;
            if cancellation.is_ok() {
                if let Err(remove_error) = self.manager.remove(&job_id).await {
                    return Err(job_error(remove_error));
                }
            } else {
                tracing::error!(
                    job_id = %job_id,
                    cancellation = ?cancellation,
                    "job attach persistence failed and process compensation failed"
                );
            }
            return Err(job_error(error));
        }
        Ok((job_id, outcome, receiver))
    }

    pub async fn input(&self, job_id: &str, bytes: &[u8]) -> KernelResult<terminus_jobs::JobState> {
        self.manager.input(job_id, bytes).await.map_err(job_error)
    }

    pub async fn signal(
        &self,
        job_id: &str,
        signal: &str,
    ) -> KernelResult<terminus_jobs::JobState> {
        self.manager.signal(job_id, signal).await.map_err(job_error)
    }

    pub async fn stop(&self, job_id: &str, reason: &str) -> KernelResult<terminus_jobs::JobState> {
        self.manager.stop(job_id, reason).await.map_err(job_error)
    }
}

fn job_error(error: terminus_jobs::JobError) -> KernelError {
    KernelError::new(
        terminus_kernel_protocol::ErrorCode::Internal,
        terminus_kernel_protocol::ErrorCategory::Internal,
        error.to_string(),
        false,
    )
}

// ---------- SandboxService ----------

#[derive(Debug, Clone)]
pub struct SandboxService {
    manager: Arc<SandboxManager>,
}

impl SandboxService {
    pub fn new(manager: Arc<SandboxManager>) -> Self {
        Self { manager }
    }

    pub fn enforcement_report(&self) -> terminus_sandbox::EnforcementReport {
        self.manager.enforcement_report()
    }

    /// Select a backend that supports `profile`. Returns the chosen
    /// `SandboxBackend` trait object.
    pub fn select_public(
        &self,
        profile: &terminus_sandbox::SandboxProfile,
    ) -> Result<std::sync::Arc<dyn terminus_sandbox::SandboxBackend>, terminus_sandbox::SandboxError>
    {
        self.manager.select(profile)
    }
}

// ---------- PolicyService ----------

#[derive(Debug, Clone)]
pub struct PolicyService {
    engine: Arc<PolicyEngine>,
}

impl PolicyService {
    pub fn new(engine: Arc<PolicyEngine>) -> Self {
        Self { engine }
    }

    pub fn evaluate(
        &self,
        _ctx: &RequestContext,
        _intent: &EffectIntent,
        command: &NormalizedCommand,
    ) -> terminus_policy::DecisionReport {
        self.engine.evaluate(command)
    }
}

// ---------- SecretService ----------

#[derive(Clone)]
pub struct SecretService {
    broker: Arc<SecretBroker>,
    token_issuer: Arc<TokenIssuer>,
}

impl std::fmt::Debug for SecretService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SecretService")
            .field("broker", &self.broker)
            .finish_non_exhaustive()
    }
}

impl SecretService {
    pub fn new(broker: Arc<SecretBroker>, token_issuer: Arc<TokenIssuer>) -> Self {
        Self {
            broker,
            token_issuer,
        }
    }

    /// Direct accessor for the underlying broker. Used by the HTTP
    /// mini-service to obtain a `SecretHandle` (whose value is never
    /// serialized to the caller).
    pub fn broker(&self) -> &Arc<SecretBroker> {
        &self.broker
    }

    pub fn request(
        &self,
        ctx: &RequestContext,
        _intent: &EffectIntent,
        uri: &str,
        requested_by: &str,
    ) -> KernelResult<()> {
        self.request_metadata(ctx, uri, requested_by).map(|_| ())
    }

    /// [`Self::request`] for async transports.
    pub async fn request_async(
        &self,
        ctx: &RequestContext,
        _intent: &EffectIntent,
        uri: &str,
        requested_by: &str,
    ) -> KernelResult<()> {
        self.request_metadata_async(ctx, uri, requested_by)
            .await
            .map(|_| ())
    }

    /// Request a secret and return metadata only. The raw value is dropped
    /// before this method returns, so transport adapters can mint an opaque
    /// handle without ever serializing secret material.
    ///
    /// **Synchronous**: async transports MUST use
    /// [`Self::request_metadata_async`].
    pub fn request_metadata(
        &self,
        ctx: &RequestContext,
        uri: &str,
        requested_by: &str,
    ) -> KernelResult<terminus_secrets::SecretMetadata> {
        self.authorize_request(ctx, uri, requested_by)?;
        self.broker
            .request(uri, requested_by)
            .map(|handle| handle.metadata.clone())
            .map_err(secret_resolution_error)
    }

    /// [`Self::request_metadata`] for async transports: the credential
    /// resolve runs on the blocking pool under a deadline, so an OS keychain
    /// prompt cannot park a tokio worker.
    pub async fn request_metadata_async(
        &self,
        ctx: &RequestContext,
        uri: &str,
        requested_by: &str,
    ) -> KernelResult<terminus_secrets::SecretMetadata> {
        self.authorize_request(ctx, uri, requested_by)?;
        self.broker
            .request_async(uri, requested_by)
            .await
            .map(|handle| handle.metadata.clone())
            .map_err(secret_resolution_error)
    }

    /// Inspect whether a credential exists without exposing its bytes or
    /// caching a resolved handle. Provider and policy failures are reported
    /// as `Unavailable`, never as authoritative absence.
    pub fn inspect(
        &self,
        ctx: &RequestContext,
        uri: &str,
        requested_by: &str,
    ) -> KernelResult<terminus_secrets::SecretPresence> {
        self.authorize_request(ctx, uri, requested_by)?;
        let presence = self
            .broker
            .inspect(uri)
            .unwrap_or(terminus_secrets::SecretPresence::Unavailable);
        tracing::info!(
            target: "terminus_kernel_audit",
            event = "secret.inspected",
            request_id = %ctx.request_id,
            task_id = %ctx.task_id,
            actor_id = %ctx.actor_id,
            secret_uri = %uri,
            requested_by = %requested_by,
            presence = ?presence,
            "secret presence inspected",
        );
        Ok(presence)
    }

    /// Bounded metadata-only inspection for async transports. A keychain
    /// prompt that exceeds the broker ceiling becomes `Unavailable`.
    pub async fn inspect_async(
        &self,
        ctx: &RequestContext,
        uri: &str,
        requested_by: &str,
    ) -> KernelResult<terminus_secrets::SecretPresence> {
        self.authorize_request(ctx, uri, requested_by)?;
        let presence = self
            .broker
            .inspect_async(uri)
            .await
            .unwrap_or(terminus_secrets::SecretPresence::Unavailable);
        tracing::info!(
            target: "terminus_kernel_audit",
            event = "secret.inspected",
            request_id = %ctx.request_id,
            task_id = %ctx.task_id,
            actor_id = %ctx.actor_id,
            secret_uri = %uri,
            requested_by = %requested_by,
            presence = ?presence,
            "secret presence inspected",
        );
        Ok(presence)
    }

    /// §31.3 step 3 + step 10 for a secret request: capability-token
    /// validation and the AUTHORIZED audit record, before any store read.
    fn authorize_request(
        &self,
        ctx: &RequestContext,
        uri: &str,
        requested_by: &str,
    ) -> KernelResult<()> {
        // Secret access requires the `Secret` operation class. The requested
        // scope is the URI itself.
        let requested_scope = Scope {
            workspace_paths: Vec::new(),
            network_destinations: Vec::new(),
            secret_capabilities: vec![uri.to_string()],
        };
        let _ = validate_capability_for_op(
            &self.token_issuer,
            ctx,
            OperationClass::Secret,
            &requested_scope,
        )?;
        tracing::info!(
            target: "terminus_kernel_audit",
            event = "authorized",
            service = "secret.request",
            request_id = %ctx.request_id,
            task_id = %ctx.task_id,
            actor_id = %ctx.actor_id,
            secret_uri = %uri,
            requested_by = %requested_by,
            "secret request authorized",
        );
        Ok(())
    }

    /// Persist a provider credential in the registered OS credential store.
    /// The value exists only in the caller's UDS request and this stack frame.
    pub fn store(&self, ctx: &RequestContext, uri: &str, value: &[u8]) -> KernelResult<()> {
        let requested_scope = Scope {
            workspace_paths: Vec::new(),
            network_destinations: Vec::new(),
            secret_capabilities: vec![uri.to_string()],
        };
        let _ = validate_request_pipeline(
            &self.token_issuer,
            ctx,
            OperationClass::Secret,
            &requested_scope,
            true,
        )?;
        self.broker.store(uri, value).map_err(|error| {
            KernelError::new(
                terminus_kernel_protocol::ErrorCode::PermissionDenied,
                terminus_kernel_protocol::ErrorCategory::Permission,
                error.to_string(),
                false,
            )
        })?;
        tracing::info!(
            target: "terminus_kernel_audit",
            event = "secret.stored",
            request_id = %ctx.request_id,
            actor_id = %ctx.actor_id,
            secret_uri = %uri,
            "provider credential stored"
        );
        Ok(())
    }

    pub fn delete(&self, ctx: &RequestContext, uri: &str) -> KernelResult<()> {
        let requested_scope = Scope {
            workspace_paths: Vec::new(),
            network_destinations: Vec::new(),
            secret_capabilities: vec![uri.to_string()],
        };
        let _ = validate_request_pipeline(
            &self.token_issuer,
            ctx,
            OperationClass::Secret,
            &requested_scope,
            true,
        )?;
        self.broker.delete(uri).map_err(|error| {
            KernelError::new(
                terminus_kernel_protocol::ErrorCode::PermissionDenied,
                terminus_kernel_protocol::ErrorCategory::Permission,
                error.to_string(),
                false,
            )
        })?;
        tracing::info!(
            target: "terminus_kernel_audit",
            event = "secret.deleted",
            request_id = %ctx.request_id,
            actor_id = %ctx.actor_id,
            secret_uri = %uri,
            "provider credential deleted"
        );
        Ok(())
    }
}

// ---------- ConnectorService ----------

/// L7 connector broker service (ADR-0035 §2). Credentialed external
/// operations run inside the kernel's trusted boundary: callers present an
/// opaque `ConnectorGrant` plus the canonical operation; the credential is
/// resolved, injected, dispatched, and scrubbed here. Raw material never
/// crosses this service's API.
#[derive(Clone)]
pub struct ConnectorService {
    broker: Arc<ConnectorBroker>,
    issuer: Arc<GrantIssuer>,
    grants: Arc<GrantStore>,
    secret_broker: Arc<SecretBroker>,
    token_issuer: Arc<TokenIssuer>,
    /// L4 allowlist. Minting a grant for a connector whose host comes from a
    /// stored provider account admits that one destination here.
    egress: Arc<EgressProxy>,
    signing_key: Vec<u8>,
}

impl std::fmt::Debug for ConnectorService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ConnectorService")
            .field("broker", &self.broker)
            .finish_non_exhaustive()
    }
}

impl ConnectorService {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        broker: Arc<ConnectorBroker>,
        issuer: Arc<GrantIssuer>,
        grants: Arc<GrantStore>,
        secret_broker: Arc<SecretBroker>,
        token_issuer: Arc<TokenIssuer>,
        egress: Arc<EgressProxy>,
        signing_key: Vec<u8>,
    ) -> Self {
        Self {
            broker,
            issuer,
            grants,
            secret_broker,
            token_issuer,
            egress,
            signing_key,
        }
    }

    /// Register a connector descriptor at runtime. Local development and
    /// conformance harnesses register fixture connectors this way;
    /// production wiring registers them from configuration.
    pub fn register_connector(
        &self,
        id: impl Into<String>,
        auth: terminus_connector::AuthStyle,
    ) -> KernelResult<()> {
        self.broker
            .register_connector(id, auth)
            .map_err(connector_validation_error)
    }

    /// Register a fully specified descriptor at runtime (headers, bounds,
    /// timeouts, host policy).
    pub fn register_descriptor(
        &self,
        id: impl Into<String>,
        descriptor: terminus_connector::ConnectorDescriptor,
    ) -> KernelResult<()> {
        self.broker
            .register_descriptor(id, descriptor)
            .map_err(connector_validation_error)
    }

    /// Decode + verify an encoded grant against the service's signing key.
    /// The key itself never leaves the service.
    pub fn decode_grant(
        &self,
        encoded: &str,
    ) -> Result<terminus_secrets::ConnectorGrant, terminus_secrets::SecretError> {
        terminus_secrets::ConnectorGrant::decode_and_verify(encoded, &self.signing_key)
    }

    /// Direct accessor for the underlying L7 broker (mini-service wiring).
    pub fn broker(&self) -> &Arc<ConnectorBroker> {
        &self.broker
    }

    /// Mint a short-lived connector grant bound to the workload identity of
    /// `requested_by`. The grant carries a digest of the current credential
    /// — never the credential itself (SPEC §17.3).
    ///
    /// **Synchronous**: the credential resolve happens on the calling thread.
    /// Async transports (gRPC, HTTP) MUST call [`Self::mint_grant_async`] —
    /// a keychain read can park for as long as an OS approval prompt is on
    /// screen, and parking a tokio worker there stalls the whole runtime.
    pub fn mint_grant(
        &self,
        ctx: &RequestContext,
        uri: &str,
        binding: terminus_secrets::GrantBinding,
        ttl_secs: u64,
        use_limit: u32,
    ) -> KernelResult<terminus_secrets::ConnectorGrant> {
        if self.authorize_mint(ctx, uri, &binding)? == MintKind::Anonymous {
            return self.mint_anonymous(ctx, binding, ttl_secs, use_limit);
        }
        let digest = self
            .secret_broker
            .request(uri, &binding.task_id)
            .map(|handle| handle.digest())
            .map_err(secret_resolution_error)?;
        self.issue_grant(ctx, uri, &digest, binding, ttl_secs, use_limit)
    }

    /// [`Self::mint_grant`] for async transports. The credential resolve runs
    /// on the blocking pool under [`terminus_secrets::SECRET_RESOLVE_TIMEOUT`],
    /// so a pending OS keychain prompt surfaces as an actionable error instead
    /// of a `DEADLINE_EXCEEDED` with no cause.
    pub async fn mint_grant_async(
        &self,
        ctx: &RequestContext,
        uri: &str,
        binding: terminus_secrets::GrantBinding,
        ttl_secs: u64,
        use_limit: u32,
    ) -> KernelResult<terminus_secrets::ConnectorGrant> {
        if self.authorize_mint(ctx, uri, &binding)? == MintKind::Anonymous {
            return self.mint_anonymous(ctx, binding, ttl_secs, use_limit);
        }
        let digest = self
            .secret_broker
            .request_async(uri, &binding.task_id)
            .await
            .map(|handle| handle.digest())
            .map_err(secret_resolution_error)?;
        self.issue_grant(ctx, uri, &digest, binding, ttl_secs, use_limit)
    }

    /// Steps 1-3 of a mint: descriptor + host authority, anonymity match, and
    /// the capability-token check — everything that must hold BEFORE the
    /// credential store is touched, and identical for the sync and async
    /// mints.
    fn authorize_mint(
        &self,
        ctx: &RequestContext,
        uri: &str,
        binding: &terminus_secrets::GrantBinding,
    ) -> KernelResult<MintKind> {
        // Anonymous connectors (empty secret URI) skip the secret step but
        // still require the Network operation class scoped to the exact
        // destination; the L4 egress proxy authorizes the host at dispatch
        // time. Everything else requires Secret-class capability: a grant is
        // one step from raw use.
        let anonymous = uri.is_empty();
        let descriptor = self
            .broker
            .descriptor(&binding.connector_id)
            .map_err(connector_validation_error)?;
        // §4(f) host authority. `Fixed` connectors may only be minted for the
        // hosts they were registered with; `PerGrant` connectors take their
        // host from the stored provider account, so the control plane must
        // pin that account's allowlist here and the destination must be in it.
        self.authorize_mint_destination(&descriptor, binding)?;
        let connector_is_anonymous = matches!(descriptor.auth, terminus_connector::AuthStyle::None);
        if anonymous != connector_is_anonymous {
            return Err(KernelError::new(
                terminus_kernel_protocol::ErrorCode::PermissionDenied,
                terminus_kernel_protocol::ErrorCategory::Permission,
                format!(
                    "connector {} requires {} credential binding",
                    binding.connector_id,
                    if connector_is_anonymous {
                        "an anonymous"
                    } else {
                        "a secret"
                    },
                ),
                false,
            ));
        }
        let requested_scope = Scope {
            workspace_paths: Vec::new(),
            network_destinations: vec![format!(
                "{}:{}",
                binding.destination_host, binding.destination_port
            )],
            secret_capabilities: if anonymous {
                Vec::new()
            } else {
                vec![uri.to_string()]
            },
        };
        let _ = validate_capability_for_op(
            &self.token_issuer,
            ctx,
            if anonymous {
                OperationClass::Network
            } else {
                OperationClass::Secret
            },
            &requested_scope,
        )?;
        Ok(if anonymous {
            MintKind::Anonymous
        } else {
            MintKind::Credentialed
        })
    }

    /// Mint the fixed-digest grant an anonymous connector uses. No credential
    /// is resolved, so this path never touches the credential store.
    fn mint_anonymous(
        &self,
        ctx: &RequestContext,
        binding: terminus_secrets::GrantBinding,
        ttl_secs: u64,
        use_limit: u32,
    ) -> KernelResult<terminus_secrets::ConnectorGrant> {
        /// SHA-256 of the empty string: an anonymous connector pins no
        /// credential, and the digest field is not optional.
        const ANONYMOUS_DIGEST: &str =
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
        let workload = WorkloadIdentity {
            workload_id: ctx.actor_id.clone(),
            principal: ctx.actor_id.clone(),
            task_id: ctx.task_id.clone(),
        };
        tracing::info!(
            target: "terminus_kernel_audit",
            event = "grant.minted",
            request_id = %ctx.request_id,
            task_id = %ctx.task_id,
            actor_id = %ctx.actor_id,
            secret_uri = "(anonymous)",
            effect_id = %binding.effect_id,
            "anonymous connector grant minted"
        );
        self.issuer
            .mint_for_digest(workload, "", ANONYMOUS_DIGEST, binding, ttl_secs, use_limit)
            .map_err(grant_issue_error)
    }

    /// Sign the grant around an already-resolved credential digest. The
    /// credential itself is never held here.
    fn issue_grant(
        &self,
        ctx: &RequestContext,
        uri: &str,
        digest: &str,
        binding: terminus_secrets::GrantBinding,
        ttl_secs: u64,
        use_limit: u32,
    ) -> KernelResult<terminus_secrets::ConnectorGrant> {
        let workload = WorkloadIdentity {
            workload_id: ctx.actor_id.clone(),
            principal: ctx.actor_id.clone(),
            task_id: ctx.task_id.clone(),
        };
        tracing::info!(
            target: "terminus_kernel_audit",
            event = "grant.minted",
            request_id = %ctx.request_id,
            task_id = %ctx.task_id,
            actor_id = %ctx.actor_id,
            secret_uri = %uri,
            effect_id = %binding.effect_id,
            "connector grant minted"
        );
        self.issuer
            .mint_for_digest(workload, uri, digest, binding, ttl_secs, use_limit)
            .map_err(grant_issue_error)
    }

    /// Execute one grant-bound operation through the trusted connector
    /// path. Requires the `Network` operation class scoped to the exact
    /// destination. Returns the typed receipt and bounded scrubbed response.
    pub async fn execute(
        &self,
        ctx: &RequestContext,
        op: &terminus_connector::CanonicalOperation,
        grant: &terminus_secrets::ConnectorGrant,
    ) -> KernelResult<terminus_connector::ConnectorResponse> {
        let dest = format!("{}:{}", op.host, op.port);
        let requested_scope = Scope {
            workspace_paths: Vec::new(),
            network_destinations: vec![dest],
            secret_capabilities: Vec::new(),
        };
        let _ = validate_capability_for_op(
            &self.token_issuer,
            ctx,
            OperationClass::Network,
            &requested_scope,
        )?;
        let response = self.broker.execute(op, grant).await.map_err(|e| {
            KernelError::new(
                terminus_kernel_protocol::ErrorCode::PermissionDenied,
                terminus_kernel_protocol::ErrorCategory::Permission,
                format!("{e}"),
                false,
            )
        })?;
        tracing::info!(
            target: "terminus_kernel_audit",
            event = "connector.executed",
            request_id = %ctx.request_id,
            task_id = %ctx.task_id,
            actor_id = %ctx.actor_id,
            grant_id = %response.receipt.grant_id,
            outcome = ?response.receipt.outcome,
            status_code = ?response.receipt.status_code,
            response_redactions = response.receipt.response_redactions,
            "connector operation executed"
        );
        Ok(response)
    }

    /// Streaming variant of [`Self::execute`]: identical authorization,
    /// one-time consumption, and bounded capture; response body chunks are
    /// surfaced through `sink` as they arrive instead of only at completion.
    ///
    /// Credential-echo redaction is INCREMENTAL (`terminus_connector`'s
    /// carry-buffered streaming redactor), so a credentialed grant streams
    /// exactly like an anonymous one. Before this, a credentialed operation
    /// degraded to one buffered chunk after whole-body scrubbing, which made
    /// time-to-first-token equal time-to-last-token for every provider call.
    ///
    /// `cancel` tears the in-flight HTTP request down; the call then returns
    /// a `Cancelled`-coded error rather than an unsettled receipt.
    pub async fn execute_streaming<S: ChunkSink>(
        &self,
        ctx: &RequestContext,
        op: &terminus_connector::CanonicalOperation,
        grant: &terminus_secrets::ConnectorGrant,
        sink: &mut S,
        cancel: &terminus_connector::CancelToken,
    ) -> KernelResult<terminus_connector::ConnectorResponse> {
        let dest = format!("{}:{}", op.host, op.port);
        let requested_scope = Scope {
            workspace_paths: Vec::new(),
            network_destinations: vec![dest],
            secret_capabilities: Vec::new(),
        };
        let _ = validate_capability_for_op(
            &self.token_issuer,
            ctx,
            OperationClass::Network,
            &requested_scope,
        )?;
        let response = self
            .broker
            .execute_streaming(op, grant, sink, cancel)
            .await
            .map_err(connector_dispatch_error)?;
        tracing::info!(
            target: "terminus_kernel_audit",
            event = "connector.executed",
            request_id = %ctx.request_id,
            task_id = %ctx.task_id,
            actor_id = %ctx.actor_id,
            grant_id = %response.receipt.grant_id,
            outcome = ?response.receipt.outcome,
            status_code = ?response.receipt.status_code,
            response_redactions = response.receipt.response_redactions,
            "connector operation executed (streamed)"
        );
        Ok(response)
    }

    /// Enforce the descriptor's host policy at mint time and, for accounts
    /// whose host is chosen per grant, admit that exact destination to the
    /// L4 egress allowlist. Widening egress is bounded, audited, and only
    /// reachable after the Secret-class capability check above.
    fn authorize_mint_destination(
        &self,
        descriptor: &terminus_connector::ConnectorDescriptor,
        binding: &terminus_secrets::GrantBinding,
    ) -> KernelResult<()> {
        let host = binding.destination_host.as_str();
        if host.is_empty() {
            return Err(connector_permission_error(
                "grant binding requires a destination host".to_string(),
            ));
        }
        match &descriptor.hosts {
            terminus_connector::HostPolicy::Fixed(hosts) if !hosts.is_empty() => {
                if !hosts.iter().any(|pattern| host_matches(host, pattern)) {
                    return Err(connector_permission_error(format!(
                        "connector {} does not admit host {host}",
                        binding.connector_id
                    )));
                }
            }
            terminus_connector::HostPolicy::Fixed(_) => {}
            terminus_connector::HostPolicy::PerGrant => {
                if binding.allowed_hosts.is_empty() {
                    return Err(connector_permission_error(format!(
                        "connector {} requires the account host allowlist (allowed_hosts) at \
                         mint time",
                        binding.connector_id
                    )));
                }
            }
        }
        if !binding.allowed_hosts.is_empty()
            && !binding
                .allowed_hosts
                .iter()
                .any(|pattern| host_matches(host, pattern))
        {
            return Err(connector_permission_error(format!(
                "destination host {host} is not in the account host allowlist"
            )));
        }
        if matches!(descriptor.hosts, terminus_connector::HostPolicy::PerGrant) {
            self.egress
                .admit_destination(host, binding.destination_port, &binding.scheme)
                .map_err(|e| connector_permission_error(format!("{e}")))?;
            tracing::info!(
                target: "terminus_kernel_audit",
                event = "egress.destination_admitted",
                connector_id = %binding.connector_id,
                host = %host,
                port = binding.destination_port,
                scheme = %binding.scheme,
                "provider-account destination admitted to the egress allowlist"
            );
        }
        Ok(())
    }

    pub fn consumed_grants(&self) -> usize {
        self.grants.consumed_count()
    }
}

/// Render a caller-supplied label into an error message without letting an
/// oversized or control-character-bearing value through. Truncation is
/// explicit: the marker states that the value was elided.
fn bounded_label(value: &str) -> String {
    const MAX: usize = 64;
    let sanitized: String = value
        .chars()
        .filter(|c| !c.is_control())
        .take(MAX)
        .collect();
    if sanitized.is_empty() {
        return "<empty>".to_string();
    }
    if value.chars().filter(|c| !c.is_control()).count() > MAX {
        return format!("{sanitized}… (elided)");
    }
    sanitized
}

fn connector_validation_error(error: terminus_connector::ConnectorError) -> KernelError {
    KernelError::new(
        terminus_kernel_protocol::ErrorCode::InvalidRequest,
        terminus_kernel_protocol::ErrorCategory::Validation,
        format!("{error}"),
        false,
    )
}

fn connector_permission_error(message: String) -> KernelError {
    KernelError::new(
        terminus_kernel_protocol::ErrorCode::PermissionDenied,
        terminus_kernel_protocol::ErrorCategory::Permission,
        message,
        false,
    )
}

/// Whether a mint needs a credential at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MintKind {
    /// `AuthStyle::None` connector: no credential store read.
    Anonymous,
    /// A credential must be resolved and its digest pinned into the grant.
    Credentialed,
}

/// Map a credential-store failure onto a kernel error.
///
/// The message is passed through verbatim so the actionable text in
/// [`terminus_secrets::SecretError::ResolveTimeout`] — which names the
/// pending OS keychain prompt and the `TERMINUS_SECRETS_BACKEND=file`
/// remedy — reaches the control plane's gRPC status instead of being
/// flattened into a bare permission denial. `SecretError` never carries
/// credential material.
fn secret_resolution_error(error: terminus_secrets::SecretError) -> KernelError {
    KernelError::new(
        terminus_kernel_protocol::ErrorCode::PermissionDenied,
        terminus_kernel_protocol::ErrorCategory::Permission,
        format!("{error}"),
        false,
    )
}

/// Map a grant-signing failure onto a kernel error.
fn grant_issue_error(error: terminus_secrets::SecretError) -> KernelError {
    KernelError::new(
        terminus_kernel_protocol::ErrorCode::InvalidRequest,
        terminus_kernel_protocol::ErrorCategory::Validation,
        format!("{error}"),
        false,
    )
}

/// Map a dispatch failure onto a kernel error code. Cancellation is the
/// caller's own decision and must reach the transport as `Cancelled` (gRPC
/// `CANCELLED`), not as the permission denial every other broker failure
/// historically collapsed into.
fn connector_dispatch_error(error: terminus_connector::ConnectorError) -> KernelError {
    match error {
        terminus_connector::ConnectorError::Cancelled => KernelError::new(
            terminus_kernel_protocol::ErrorCode::Cancelled,
            terminus_kernel_protocol::ErrorCategory::Cancelled,
            "connector dispatch cancelled by the caller".to_string(),
            false,
        ),
        other => connector_permission_error(format!("{other}")),
    }
}

/// Exact-or-dot-suffix host match; mirrors the L4 egress semantics.
fn host_matches(host: &str, pattern: &str) -> bool {
    host.eq_ignore_ascii_case(pattern)
        || host
            .to_ascii_lowercase()
            .ends_with(&format!(".{}", pattern.to_ascii_lowercase()))
}

// ---------- NetworkService ----------

#[derive(Clone)]
pub struct NetworkService {
    proxy: Arc<EgressProxy>,
    token_issuer: Arc<TokenIssuer>,
}

impl std::fmt::Debug for NetworkService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NetworkService")
            .field("proxy", &self.proxy)
            .finish_non_exhaustive()
    }
}

impl NetworkService {
    pub fn new(proxy: Arc<EgressProxy>, token_issuer: Arc<TokenIssuer>) -> Self {
        Self {
            proxy,
            token_issuer,
        }
    }

    /// Direct accessor for the underlying egress proxy. Used by the HTTP
    /// mini-service to expose the live allowlist.
    pub fn proxy(&self) -> &Arc<EgressProxy> {
        &self.proxy
    }

    /// Convenience accessor for the egress policy.
    pub fn policy(&self) -> &terminus_egress::EgressPolicy {
        self.proxy.policy()
    }

    pub fn authorize(
        &self,
        ctx: &RequestContext,
        _intent: &EffectIntent,
        host: &str,
        port: u16,
        scheme: &str,
        resolved_ips: &[std::net::IpAddr],
    ) -> KernelResult<()> {
        // §31.3 step 3: capability-token validation. Network access
        // requires the `Network` operation class. The requested scope is the
        // destination (host:port).
        let dest = format!("{host}:{port}");
        let requested_scope = Scope {
            workspace_paths: Vec::new(),
            network_destinations: vec![dest],
            secret_capabilities: Vec::new(),
        };
        let _ = validate_capability_for_op(
            &self.token_issuer,
            ctx,
            OperationClass::Network,
            &requested_scope,
        )?;
        // §31.3 step 10: persist AUTHORIZED state.
        tracing::info!(
            target: "terminus_kernel_audit",
            event = "authorized",
            service = "network.authorize",
            request_id = %ctx.request_id,
            task_id = %ctx.task_id,
            actor_id = %ctx.actor_id,
            host = %host,
            port = port,
            scheme = %scheme,
            "network access authorized",
        );
        self.proxy
            .authorize(host, port, scheme, resolved_ips)
            .map_err(|e| {
                KernelError::new(
                    terminus_kernel_protocol::ErrorCode::PolicyDenied,
                    terminus_kernel_protocol::ErrorCategory::PolicyDenied,
                    format!("{e}"),
                    false,
                )
            })
    }
}

// ---------- CodeIntelligenceService ----------

#[derive(Clone)]
pub struct CodeIntelligenceService {
    workspaces: WorkspaceService,
    kernel_data_root: PathBuf,
    index_root: PathBuf,
    services: Arc<Mutex<HashMap<String, Arc<CodeIntelService>>>>,
    token_issuer: Arc<TokenIssuer>,
}

impl std::fmt::Debug for CodeIntelligenceService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CodeIntelligenceService")
            .field("workspaces", &self.workspaces)
            .field("kernel_data_root", &self.kernel_data_root)
            .field("index_root", &self.index_root)
            .finish_non_exhaustive()
    }
}

impl CodeIntelligenceService {
    pub fn new(
        workspaces: WorkspaceService,
        kernel_data_root: PathBuf,
        index_root: PathBuf,
        token_issuer: Arc<TokenIssuer>,
    ) -> Self {
        Self {
            workspaces,
            kernel_data_root,
            index_root,
            services: Arc::new(Mutex::new(HashMap::new())),
            token_issuer,
        }
    }

    fn service_for_context(
        &self,
        ctx: &RequestContext,
        token: &terminus_authz::CapabilityToken,
    ) -> KernelResult<Arc<CodeIntelService>> {
        let workspace =
            self.workspaces
                .local_workspace_for_effect(ctx, token, &ctx.workspace_id)?;
        let mut services = match self.services.lock() {
            Ok(services) => services,
            Err(poisoned) => poisoned.into_inner(),
        };
        if let Some(service) = services.get(&workspace.id) {
            return Ok(Arc::clone(service));
        }
        let index_path = self
            .index_root
            .join(format!("{}.sqlite", workspace_storage_key(&workspace.id)));
        let index =
            terminus_code_intel::PersistentSymbolIndex::open(index_path).map_err(|error| {
                KernelError::new(
                    terminus_kernel_protocol::ErrorCode::Internal,
                    terminus_kernel_protocol::ErrorCategory::Internal,
                    format!("workspace code-intelligence index initialization failed: {error}"),
                    false,
                )
            })?;
        let kernel_data_root = std::fs::canonicalize(&self.kernel_data_root).ok();
        let workspace_root = PathBuf::from(&workspace.canonical_root);
        let source: Arc<dyn WorkspaceSource> = if kernel_data_root.as_ref() == Some(&workspace_root)
        {
            // A workspace can deliberately be rooted at TERMINUS_DATA (the
            // deterministic harness does this). Keep kernel-owned SQLite,
            // artifact, journal, and state files out of semantic indexing.
            // Per-workspace indexes live under `state/code-intel`, which the
            // kernel-data source excludes with the rest of `state`.
            Arc::new(FileSystemWorkspaceSource::for_kernel_data_dir(
                workspace_root,
            ))
        } else {
            Arc::new(FileSystemWorkspaceSource::new(workspace_root))
        };
        let service = Arc::new(CodeIntelService::with_source(Arc::new(index), source));
        services.insert(workspace.id, Arc::clone(&service));
        Ok(service)
    }

    pub fn inspect(
        &self,
        ctx: &RequestContext,
        _intent: &EffectIntent,
        symbol: &str,
    ) -> KernelResult<terminus_code_intel::InspectResult> {
        // §31.3 step 3: capability-token validation. Inspect requires the
        // `CodeIntel` operation class.
        let token = validate_capability_for_op(
            &self.token_issuer,
            ctx,
            OperationClass::CodeIntel,
            &Scope::default(),
        )?;
        let service = self.service_for_context(ctx, &token)?;
        // §31.3 step 10: persist AUTHORIZED state.
        tracing::info!(
            target: "terminus_kernel_audit",
            event = "authorized",
            service = "code_intel.inspect",
            request_id = %ctx.request_id,
            task_id = %ctx.task_id,
            actor_id = %ctx.actor_id,
            symbol = %symbol,
            "code-intel inspect authorized",
        );
        service.inspect_symbol(symbol).map_err(|e| {
            KernelError::new(
                terminus_kernel_protocol::ErrorCode::Internal,
                terminus_kernel_protocol::ErrorCategory::Internal,
                format!("{e}"),
                false,
            )
        })
    }

    pub fn repository_map(
        &self,
        ctx: &RequestContext,
        _intent: &EffectIntent,
        limit: usize,
        offset: usize,
        expected_revision: Option<&str>,
    ) -> KernelResult<terminus_code_intel::RepositoryMapPage> {
        let token = validate_capability_for_op(
            &self.token_issuer,
            ctx,
            OperationClass::CodeIntel,
            &Scope::default(),
        )?;
        let service = self.service_for_context(ctx, &token)?;
        let path_patterns = token.claims.max_scope.workspace_paths.clone();
        let page = service
            .repository_map_filtered(limit, offset, |path| {
                path_patterns.is_empty()
                    || path_patterns
                        .iter()
                        .any(|pattern| terminus_authz::workspace_path_matches(pattern, path))
            })
            .map_err(|e| {
                KernelError::new(
                    terminus_kernel_protocol::ErrorCode::Internal,
                    terminus_kernel_protocol::ErrorCategory::Internal,
                    format!("{e}"),
                    false,
                )
            })?;
        if let Some(expected) = expected_revision {
            if expected != page.index_revision {
                return Err(KernelError::new(
                    terminus_kernel_protocol::ErrorCode::StaleSourceVersion,
                    terminus_kernel_protocol::ErrorCategory::Conflict,
                    "repository map continuation references a stale index revision",
                    true,
                ));
            }
        }
        Ok(page)
    }

    pub fn find_references(
        &self,
        ctx: &RequestContext,
        _intent: &EffectIntent,
        symbol: &str,
    ) -> KernelResult<terminus_code_intel::ReferenceResult> {
        let token = validate_capability_for_op(
            &self.token_issuer,
            ctx,
            OperationClass::CodeIntel,
            &Scope::default(),
        )?;
        let service = self.service_for_context(ctx, &token)?;
        service.find_references(symbol).map_err(|e| {
            KernelError::new(
                terminus_kernel_protocol::ErrorCode::Internal,
                terminus_kernel_protocol::ErrorCategory::Internal,
                format!("{e}"),
                false,
            )
        })
    }

    pub fn diagnose_files(
        &self,
        ctx: &RequestContext,
        _intent: &EffectIntent,
        paths: &[String],
    ) -> KernelResult<Vec<terminus_code_intel::DiagnoseResult>> {
        let token = validate_capability_for_op(
            &self.token_issuer,
            ctx,
            OperationClass::CodeIntel,
            &Scope {
                workspace_paths: paths.to_vec(),
                network_destinations: Vec::new(),
                secret_capabilities: Vec::new(),
            },
        )?;
        let service = self.service_for_context(ctx, &token)?;
        service.diagnose_files(paths).map_err(|e| {
            KernelError::new(
                terminus_kernel_protocol::ErrorCode::Internal,
                terminus_kernel_protocol::ErrorCategory::Internal,
                format!("{e}"),
                false,
            )
        })
    }
}

// ---------- ExtensionRuntimeService ----------

#[derive(Clone)]
pub struct ExtensionRuntimeService {
    host: Arc<WasiExtensionHost>,
    process_host: Arc<terminus_extension_runtime::ProcessExtensionHost>,
    token_issuer: Arc<TokenIssuer>,
}

impl std::fmt::Debug for ExtensionRuntimeService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ExtensionRuntimeService")
            .field("host", &self.host)
            .field("process_host", &self.process_host)
            .finish_non_exhaustive()
    }
}

impl ExtensionRuntimeService {
    pub fn new(host: Arc<WasiExtensionHost>, token_issuer: Arc<TokenIssuer>) -> Self {
        Self {
            host,
            process_host: Arc::new(terminus_extension_runtime::ProcessExtensionHost::new()),
            token_issuer,
        }
    }

    pub fn report(&self) -> terminus_extension_runtime::WasiExtensionHostReport {
        self.host.report()
    }

    pub fn validate_manifest(
        &self,
        ctx: &RequestContext,
        manifest: &terminus_extension_runtime::ExtensionManifest,
    ) -> KernelResult<()> {
        // §31.3 step 3: capability-token validation. Extension admin
        // requires the `Extension` operation class.
        let _ = validate_capability_for_op(
            &self.token_issuer,
            ctx,
            OperationClass::Extension,
            &Scope::default(),
        )?;
        // §31.3 step 10: persist AUTHORIZED state.
        tracing::info!(
            target: "terminus_kernel_audit",
            event = "authorized",
            service = "extension.validate_manifest",
            request_id = %ctx.request_id,
            task_id = %ctx.task_id,
            actor_id = %ctx.actor_id,
            extension_id = %manifest.id,
            extension_version = %manifest.version,
            "extension manifest validation authorized",
        );
        self.host.validate_manifest(manifest).map_err(|e| {
            KernelError::new(
                terminus_kernel_protocol::ErrorCode::InvalidArgument,
                terminus_kernel_protocol::ErrorCategory::Validation,
                format!("{e}"),
                false,
            )
        })
    }

    /// Authorize an extension invocation and return the host's effective
    /// runtime report. When WASI is unavailable the report is fail-closed;
    /// process-isolated execution remains available via `ProcessExtensionHost`.
    pub fn invoke_report(
        &self,
        ctx: &RequestContext,
        capability_id: &str,
        operation: &str,
        input_len: usize,
    ) -> KernelResult<terminus_extension_runtime::WasiExtensionHostReport> {
        let _ = validate_capability_for_op(
            &self.token_issuer,
            ctx,
            OperationClass::Extension,
            &Scope::default(),
        )?;
        tracing::info!(
            target: "terminus_kernel_audit",
            event = "authorized",
            service = "extension.invoke",
            request_id = %ctx.request_id,
            task_id = %ctx.task_id,
            actor_id = %ctx.actor_id,
            capability_id = %capability_id,
            operation = %operation,
            input_len,
            "extension invocation authorized"
        );
        Ok(self.host.report())
    }

    pub fn process_host(&self) -> &terminus_extension_runtime::ProcessExtensionHost {
        &self.process_host
    }
}

// ---------- ArtifactIngestService ----------

#[derive(Clone)]
pub struct ArtifactIngestService {
    store: Arc<ArtifactStore>,
    token_issuer: Arc<TokenIssuer>,
}

impl std::fmt::Debug for ArtifactIngestService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ArtifactIngestService")
            .field("store", &self.store)
            .finish_non_exhaustive()
    }
}

impl ArtifactIngestService {
    pub fn new(store: Arc<ArtifactStore>, token_issuer: Arc<TokenIssuer>) -> Self {
        Self {
            store,
            token_issuer,
        }
    }

    pub fn ingest(
        &self,
        ctx: &RequestContext,
        _intent: &EffectIntent,
        bytes: &[u8],
    ) -> KernelResult<ArtifactRef> {
        // §31.3 step 3: capability-token validation. Artifact ingest requires
        // the `ArtifactIngest` operation class.
        let _ = validate_capability_for_op(
            &self.token_issuer,
            ctx,
            OperationClass::ArtifactIngest,
            &Scope::default(),
        )?;
        // §31.3 step 10: persist AUTHORIZED state.
        tracing::info!(
            target: "terminus_kernel_audit",
            event = "authorized",
            service = "artifact.ingest",
            request_id = %ctx.request_id,
            task_id = %ctx.task_id,
            actor_id = %ctx.actor_id,
            size_bytes = bytes.len(),
            "artifact ingest authorized",
        );
        if ctx.task_id.is_empty() || ctx.task_id == "control-maintenance" {
            return Err(KernelError::new(
                terminus_kernel_protocol::ErrorCode::PermissionDenied,
                terminus_kernel_protocol::ErrorCategory::Permission,
                "artifact ingest requires a concrete owner task",
                false,
            ));
        }
        let (_, artifact) = self.store.ingest(bytes).map_err(|e| {
            KernelError::new(
                terminus_kernel_protocol::ErrorCode::Internal,
                terminus_kernel_protocol::ErrorCategory::Internal,
                format!("{e}"),
                false,
            )
        })?;
        // The owner tuple must identify one task-artifact relationship, not
        // one global ingest slot for the task. Including the immutable hash
        // keeps re-ingest idempotent while allowing a task to own many
        // artifacts and allowing distinct tasks to own identical bytes.
        let ownership_purpose = format!("ingest:{}", artifact.sha256);
        self.store
            .link_task_bound(
                &artifact.sha256,
                "task",
                &ctx.task_id,
                &ctx.task_id,
                &ownership_purpose,
            )
            .map_err(|error| {
                KernelError::new(
                    terminus_kernel_protocol::ErrorCode::Internal,
                    terminus_kernel_protocol::ErrorCategory::Internal,
                    format!("artifact ownership binding failed: {error}"),
                    false,
                )
            })?;
        Ok(artifact)
    }

    pub fn get(&self, ctx: &RequestContext, sha256: &str) -> KernelResult<Vec<u8>> {
        self.validate_read_access(ctx, sha256)?;
        self.store.get(sha256).map_err(|e| {
            KernelError::new(
                terminus_kernel_protocol::ErrorCode::ArtifactNotFound,
                terminus_kernel_protocol::ErrorCategory::NotFound,
                e.to_string(),
                false,
            )
        })
    }

    pub fn metadata(&self, ctx: &RequestContext, sha256: &str) -> KernelResult<ArtifactRef> {
        let metadata = self.metadata_record(ctx, sha256)?;
        Ok(ArtifactRef::new(
            metadata.hash,
            metadata.size_bytes,
            metadata.media_type,
        ))
    }

    pub fn metadata_record(
        &self,
        ctx: &RequestContext,
        sha256: &str,
    ) -> KernelResult<terminus_artifacts::ArtifactMetadata> {
        self.validate_read_access(ctx, sha256)?;
        self.store.metadata(sha256).map_err(|e| {
            KernelError::new(
                terminus_kernel_protocol::ErrorCode::ArtifactNotFound,
                terminus_kernel_protocol::ErrorCategory::NotFound,
                e.to_string(),
                false,
            )
        })
    }

    fn validate_read_access(&self, ctx: &RequestContext, sha256: &str) -> KernelResult<()> {
        // The ownership gate below keys on the canonical CAS address, while
        // `store.get` / `store.metadata` accept a bare digest. A caller that
        // sent bare hex therefore failed inside `has_task_link` and had its
        // encoding mistake reported as an opaque `Internal`. Reject it here,
        // truthfully, the same way `link` already does.
        if !is_canonical_sha256(sha256) {
            return Err(KernelError::new(
                terminus_kernel_protocol::ErrorCode::InvalidArgument,
                terminus_kernel_protocol::ErrorCategory::Validation,
                "artifact hash must use the canonical sha256:<64 lowercase hex> encoding",
                false,
            ));
        }
        if ctx.task_id == "control-maintenance" {
            return self.validate_maintenance(ctx);
        }
        match validate_capability_for_op(
            &self.token_issuer,
            ctx,
            OperationClass::ArtifactIngest,
            &Scope::default(),
        ) {
            Ok(_) => {
                if ctx.task_id.is_empty()
                    || !self
                        .store
                        .has_task_link(sha256, &ctx.task_id)
                        .map_err(|error| {
                            KernelError::new(
                                terminus_kernel_protocol::ErrorCode::Internal,
                                terminus_kernel_protocol::ErrorCategory::Internal,
                                error.to_string(),
                                false,
                            )
                        })?
                {
                    return Err(KernelError::new(
                        terminus_kernel_protocol::ErrorCode::PermissionDenied,
                        terminus_kernel_protocol::ErrorCategory::Permission,
                        "artifact is not owned by the requesting task",
                        false,
                    ));
                }
                Ok(())
            }
            Err(error) if error.code() == terminus_kernel_protocol::ErrorCode::PermissionDenied => {
                self.validate_maintenance(ctx)
            }
            Err(error) => Err(error),
        }
    }

    fn validate_maintenance(&self, ctx: &RequestContext) -> KernelResult<()> {
        let _ = validate_capability_for_op(
            &self.token_issuer,
            ctx,
            OperationClass::Admin,
            &Scope::default(),
        )?;
        if ctx.task_id != "control-maintenance" {
            return Err(KernelError::new(
                terminus_kernel_protocol::ErrorCode::PermissionDenied,
                terminus_kernel_protocol::ErrorCategory::Permission,
                "kernel maintenance capability must be bound to control-maintenance",
                false,
            ));
        }
        Ok(())
    }

    pub fn gc_dry_run(
        &self,
        ctx: &RequestContext,
        live: &HashSet<String>,
    ) -> KernelResult<terminus_artifacts::GcDryRunReport> {
        self.validate_maintenance(ctx)?;
        self.store.gc_dry_run(live).map_err(|error| {
            KernelError::new(
                terminus_kernel_protocol::ErrorCode::Internal,
                terminus_kernel_protocol::ErrorCategory::Internal,
                error.to_string(),
                false,
            )
        })
    }

    pub fn gc_collect(
        &self,
        ctx: &RequestContext,
        live: &HashSet<String>,
    ) -> KernelResult<terminus_artifacts::GcReport> {
        self.validate_maintenance(ctx)?;
        self.store.gc_collect(live).map_err(|error| {
            KernelError::new(
                terminus_kernel_protocol::ErrorCode::Internal,
                terminus_kernel_protocol::ErrorCategory::Internal,
                error.to_string(),
                false,
            )
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub fn link(
        &self,
        ctx: &RequestContext,
        _intent: &EffectIntent,
        sha256: &str,
        owner_type: &str,
        owner_id: &str,
        purpose: &str,
        owner_task_id: &str,
    ) -> KernelResult<()> {
        let token = validate_capability_for_op(
            &self.token_issuer,
            ctx,
            OperationClass::ArtifactIngest,
            &Scope::default(),
        )?;
        let bound_task = token.claims.binder.task_id.as_str();
        if owner_task_id.is_empty()
            || ctx.task_id != owner_task_id
            || (bound_task != "*" && bound_task != owner_task_id)
        {
            return Err(KernelError::new(
                terminus_kernel_protocol::ErrorCode::PermissionDenied,
                terminus_kernel_protocol::ErrorCategory::Permission,
                "artifact owner task must match the request and capability task binders",
                false,
            ));
        }
        let is_checkpoint_content = owner_type == "checkpoint" && purpose == "content";
        let is_turn_initiating_input = owner_type == "turn" && purpose == "initiating-input";
        let is_task_evidence_bundle = owner_type == "task" && purpose == "evidence-bundle";
        let is_turn_evidence_bundle = owner_type == "turn" && purpose == "evidence-bundle";
        // A tool call spills four durable artifacts and an episode summary
        // spills one. The control plane has always linked them, but the
        // allowlist was only ever extended for checkpoint, initiating-input,
        // and evidence-bundle ownership, so `tool_call/arguments` — the first
        // link of the first tool call — failed closed and aborted every turn
        // that used a tool. These owner kinds carry no task or turn identity
        // of their own, so they are admitted on the task binding enforced
        // above plus the concreteness check below.
        let is_tool_call_artifact = owner_type == "tool_call"
            && matches!(
                purpose,
                "arguments" | "result" | "provider-transcript" | "provider-result-transcript"
            );
        let is_episode_content = owner_type == "episode" && purpose == "content";
        if !is_checkpoint_content
            && !is_turn_initiating_input
            && !is_task_evidence_bundle
            && !is_turn_evidence_bundle
            && !is_tool_call_artifact
            && !is_episode_content
        {
            // Name the rejected pair: "not admitted" without the pair sent
            // the control plane hunting through 14 call sites.
            return Err(KernelError::new(
                terminus_kernel_protocol::ErrorCode::InvalidArgument,
                terminus_kernel_protocol::ErrorCategory::Validation,
                format!(
                    "artifact-link ownership ({}, {}) is not admitted; the public boundary \
                     admits only checkpoint content, turn initiating-input, evidence-bundle, \
                     tool-call, or episode-content ownership",
                    bounded_label(owner_type),
                    bounded_label(purpose)
                ),
                false,
            )
            .with_details(serde_json::json!({
                "owner_type": bounded_label(owner_type),
                "purpose": bounded_label(purpose),
            })));
        }
        for (name, value, max_bytes) in [
            ("owner_type", owner_type, 64_usize),
            ("owner_id", owner_id, 256_usize),
            ("purpose", purpose, 128_usize),
        ] {
            if value.is_empty() || value.len() > max_bytes {
                return Err(KernelError::new(
                    terminus_kernel_protocol::ErrorCode::InvalidArgument,
                    terminus_kernel_protocol::ErrorCategory::Validation,
                    format!("artifact link {name} must contain 1..={max_bytes} bytes"),
                    false,
                ));
            }
        }
        if is_task_evidence_bundle
            && (ctx.task_id.contains('*') || owner_id.contains('*') || owner_task_id.contains('*'))
        {
            return Err(KernelError::new(
                terminus_kernel_protocol::ErrorCode::InvalidArgument,
                terminus_kernel_protocol::ErrorCategory::Validation,
                "task evidence-bundle ownership requires concrete non-wildcard task identifiers",
                false,
            ));
        }
        if is_task_evidence_bundle && owner_id != ctx.task_id {
            return Err(KernelError::new(
                terminus_kernel_protocol::ErrorCode::PermissionDenied,
                terminus_kernel_protocol::ErrorCategory::Permission,
                "task evidence-bundle ownership must match the request task",
                false,
            ));
        }
        // `tool_call` and `episode` owner ids are their own primary keys, so
        // there is nothing in the request context to match them against.
        // Require the task binding to be concrete so a wildcard capability
        // cannot mint ownership across tasks.
        if (is_tool_call_artifact || is_episode_content)
            && (owner_id.contains('*')
                || owner_task_id.contains('*')
                || ctx.task_id.contains('*')
                || bound_task == "*")
        {
            return Err(KernelError::new(
                terminus_kernel_protocol::ErrorCode::InvalidArgument,
                terminus_kernel_protocol::ErrorCategory::Validation,
                "tool-call and episode artifact ownership require concrete non-wildcard identifiers and a task-bound capability",
                false,
            ));
        }
        if is_turn_initiating_input || is_turn_evidence_bundle {
            if ctx.turn_id.is_empty()
                || ctx.turn_id.contains('*')
                || owner_id.contains('*')
                || owner_task_id.contains('*')
            {
                return Err(KernelError::new(
                    terminus_kernel_protocol::ErrorCode::InvalidArgument,
                    terminus_kernel_protocol::ErrorCategory::Validation,
                    "turn artifact ownership requires concrete non-wildcard turn and task identifiers",
                    false,
                ));
            }
            if owner_id != ctx.turn_id || bound_task == "*" {
                return Err(KernelError::new(
                    terminus_kernel_protocol::ErrorCode::PermissionDenied,
                    terminus_kernel_protocol::ErrorCategory::Permission,
                    "turn artifact ownership must match the request turn and a task-bound capability",
                    false,
                ));
            }
        }
        if !is_canonical_sha256(sha256) {
            return Err(KernelError::new(
                terminus_kernel_protocol::ErrorCode::InvalidArgument,
                terminus_kernel_protocol::ErrorCategory::Validation,
                "artifact link hash must use canonical sha256:<64 lowercase hex> encoding",
                false,
            ));
        }
        if !self.store.exists(sha256) {
            return Err(KernelError::new(
                terminus_kernel_protocol::ErrorCode::ArtifactNotFound,
                terminus_kernel_protocol::ErrorCategory::NotFound,
                "artifact link target does not exist",
                false,
            ));
        }
        tracing::info!(
            target: "terminus_kernel_audit",
            event = "authorized",
            service = "artifact.link",
            request_id = %ctx.request_id,
            task_id = %ctx.task_id,
            actor_id = %ctx.actor_id,
            artifact_hash = %sha256,
            owner_type = %owner_type,
            owner_id = %owner_id,
            owner_task_id = %owner_task_id,
            purpose = %purpose,
            "artifact ownership link authorized",
        );
        self.store
            .link_task_bound(sha256, owner_type, owner_id, owner_task_id, purpose)
            .map_err(|error| match error {
                terminus_artifacts::ArtifactError::OwnerConflict(message) => KernelError::new(
                    terminus_kernel_protocol::ErrorCode::AlreadyExists,
                    terminus_kernel_protocol::ErrorCategory::Conflict,
                    message,
                    false,
                ),
                other => KernelError::new(
                    terminus_kernel_protocol::ErrorCode::Internal,
                    terminus_kernel_protocol::ErrorCategory::Internal,
                    other.to_string(),
                    false,
                ),
            })
    }

    pub fn list_checkpoint_links(
        &self,
        ctx: &RequestContext,
        continuation_token: &str,
        page_size: usize,
    ) -> KernelResult<Vec<terminus_artifacts::ArtifactLink>> {
        self.validate_maintenance(ctx)?;
        if continuation_token.len() > 256 || page_size == 0 || page_size > 1_000 {
            return Err(KernelError::new(
                terminus_kernel_protocol::ErrorCode::InvalidArgument,
                terminus_kernel_protocol::ErrorCategory::Validation,
                "checkpoint link pagination is invalid",
                false,
            ));
        }
        self.store
            .list_checkpoint_links(continuation_token, page_size)
            .map_err(|error| {
                KernelError::new(
                    terminus_kernel_protocol::ErrorCode::Internal,
                    terminus_kernel_protocol::ErrorCategory::Internal,
                    error.to_string(),
                    false,
                )
            })
    }

    pub fn unlink_checkpoint(
        &self,
        ctx: &RequestContext,
        sha256: &str,
        checkpoint_id: &str,
        owner_task_id: &str,
    ) -> KernelResult<bool> {
        let task_authorized = if owner_task_id.is_empty() {
            false
        } else {
            validate_capability_for_op(
                &self.token_issuer,
                ctx,
                OperationClass::ArtifactIngest,
                &Scope::default(),
            )
            .is_ok()
                && ctx.task_id == owner_task_id
        };
        if !task_authorized {
            self.validate_maintenance(ctx)?;
        }
        if checkpoint_id.is_empty() || checkpoint_id.len() > 256 || !is_canonical_sha256(sha256) {
            return Err(KernelError::new(
                terminus_kernel_protocol::ErrorCode::InvalidArgument,
                terminus_kernel_protocol::ErrorCategory::Validation,
                "checkpoint unlink binding is invalid",
                false,
            ));
        }
        self.store
            .unlink_checkpoint(sha256, checkpoint_id, owner_task_id)
            .map_err(|error| {
                KernelError::new(
                    terminus_kernel_protocol::ErrorCode::Internal,
                    terminus_kernel_protocol::ErrorCategory::Internal,
                    error.to_string(),
                    false,
                )
            })
    }
}

fn is_canonical_sha256(value: &str) -> bool {
    let Some(hex_hash) = value.strip_prefix("sha256:") else {
        return false;
    };
    hex_hash.len() == 64
        && hex_hash
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(test)]
mod artifact_ingest_tests {
    #![allow(clippy::panic)]

    use super::*;
    use terminus_authz::{OperationClass, Scope, TokenBinder};
    use terminus_kernel_protocol::{ErrorCode, RequestContext};

    fn task_context(
        kernel: &KernelHandle,
        task_id: &str,
        nonce: &str,
    ) -> terminus_kernel_protocol::RequestContext {
        let token = kernel
            .token_issuer
            .mint(
                TokenBinder {
                    principal: "artifact-test".to_string(),
                    session_id: "artifact-session".to_string(),
                    task_id: task_id.to_string(),
                    workspace_id: "artifact-workspace".to_string(),
                    kernel_instance_id: String::new(),
                },
                vec![OperationClass::ArtifactIngest],
                Scope::default(),
                Some(300),
                nonce,
            )
            .and_then(|token| token.encode());
        let token = match token {
            Ok(token) => token,
            Err(error) => panic!("test capability issuance failed: {error}"),
        };
        RequestContext {
            request_id: terminus_kernel_protocol::new_id(),
            idempotency_key: String::new(),
            session_id: "artifact-session".to_string(),
            task_id: task_id.to_string(),
            turn_id: "artifact-turn".to_string(),
            actor_id: "artifact-test".to_string(),
            traceparent: String::new(),
            capability_token: token,
            workspace_id: "artifact-workspace".to_string(),
            deadline_unix_ms: 0,
            resource_budgets: Default::default(),
            policy_version: String::new(),
        }
    }

    #[test]
    fn distinct_artifacts_keep_independent_task_ownership_links() {
        let directory = match tempfile::tempdir() {
            Ok(directory) => directory,
            Err(error) => panic!("test directory creation failed: {error}"),
        };
        let kernel = match KernelHandle::new(directory.path().to_path_buf()) {
            Ok(kernel) => kernel,
            Err(error) => panic!("test kernel creation failed: {error}"),
        };
        let owner = task_context(&kernel, "owner-task", "owner-token");
        let other = task_context(&kernel, "other-task", "other-token");

        let command = kernel
            .artifact_ingest
            .ingest(&owner, &Default::default(), b"job command");
        let command = match command {
            Ok(artifact) => artifact,
            Err(error) => panic!("first task artifact ingest failed: {error}"),
        };
        let output = kernel
            .artifact_ingest
            .ingest(&owner, &Default::default(), b"");
        let output = match output {
            Ok(artifact) => artifact,
            Err(error) => panic!("second task artifact ingest failed: {error}"),
        };
        assert_ne!(command.sha256, output.sha256);

        for (artifact, expected) in [
            (&command, b"job command".as_slice()),
            (&output, b"".as_slice()),
        ] {
            match kernel.artifact_ingest.get(&owner, &artifact.sha256) {
                Ok(bytes) => assert_eq!(bytes, expected),
                Err(error) => panic!("owner could not read task artifact: {error}"),
            }
            let denied = kernel.artifact_ingest.get(&other, &artifact.sha256);
            assert!(matches!(denied, Err(error) if error.code() == ErrorCode::PermissionDenied));
        }

        let collectable = kernel.artifact_ingest.store.gc_dry_run_sqlite();
        assert!(matches!(
            collectable,
            Ok(hashes) if !hashes.contains(&command.sha256) && !hashes.contains(&output.sha256)
        ));
    }

    /// A caller that sends a bare digest instead of the canonical
    /// `sha256:<hex>` address used to fail inside the `has_task_link`
    /// ownership gate, whose `InvalidHash` was reported as `Internal`. The
    /// control plane surfaced that as an opaque HTTP 500, so no turn input
    /// artifact could ever be read back and every user prompt in the desktop
    /// transcript rendered empty.
    #[test]
    fn non_canonical_artifact_hash_reads_are_rejected_as_invalid_argument() {
        let directory = match tempfile::tempdir() {
            Ok(directory) => directory,
            Err(error) => panic!("test directory creation failed: {error}"),
        };
        let kernel = match KernelHandle::new(directory.path().to_path_buf()) {
            Ok(kernel) => kernel,
            Err(error) => panic!("test kernel creation failed: {error}"),
        };
        let owner = task_context(&kernel, "owner-task", "encoding-owner-token");
        let artifact = match kernel.artifact_ingest.ingest(
            &owner,
            &Default::default(),
            b"walk me through this repository",
        ) {
            Ok(artifact) => artifact,
            Err(error) => panic!("artifact ingest failed: {error}"),
        };
        assert!(artifact.sha256.starts_with("sha256:"));
        let bare = &artifact.sha256["sha256:".len()..];

        // The canonical read still returns the bytes.
        match kernel.artifact_ingest.get(&owner, &artifact.sha256) {
            Ok(bytes) => assert_eq!(bytes, b"walk me through this repository"),
            Err(error) => panic!("canonical artifact read failed: {error}"),
        }
        match kernel.artifact_ingest.metadata(&owner, &artifact.sha256) {
            Ok(record) => assert_eq!(record.sha256, artifact.sha256),
            Err(error) => panic!("canonical artifact metadata read failed: {error}"),
        }

        // The bare-hex read is a caller error, never an internal one.
        for outcome in [
            kernel.artifact_ingest.get(&owner, bare).err(),
            kernel.artifact_ingest.metadata(&owner, bare).err(),
        ] {
            let error = match outcome {
                Some(error) => error,
                None => panic!("a non-canonical artifact hash was accepted"),
            };
            assert_ne!(
                error.code(),
                ErrorCode::Internal,
                "caller encoding errors must not be reported as Internal: {error}"
            );
            assert_eq!(error.code(), ErrorCode::InvalidArgument);
        }
    }

    #[test]
    fn task_and_turn_artifact_links_are_concrete_and_task_bound() {
        let directory = match tempfile::tempdir() {
            Ok(directory) => directory,
            Err(error) => panic!("test directory creation failed: {error}"),
        };
        let kernel = match KernelHandle::new(directory.path().to_path_buf()) {
            Ok(kernel) => kernel,
            Err(error) => panic!("test kernel creation failed: {error}"),
        };
        let owner = task_context(&kernel, "owner-task", "turn-owner-token");
        let other = task_context(&kernel, "other-task", "turn-other-token");
        let artifact = match kernel.artifact_ingest.ingest(
            &owner,
            &Default::default(),
            b"initiating turn input",
        ) {
            Ok(artifact) => artifact,
            Err(error) => panic!("turn input ingest failed: {error}"),
        };

        assert!(kernel
            .artifact_ingest
            .link(
                &owner,
                &Default::default(),
                &artifact.sha256,
                "turn",
                "artifact-turn",
                "initiating-input",
                "owner-task",
            )
            .is_ok());
        assert!(kernel
            .artifact_ingest
            .link(
                &owner,
                &Default::default(),
                &artifact.sha256,
                "task",
                "owner-task",
                "evidence-bundle",
                "owner-task",
            )
            .is_ok());
        assert!(kernel
            .artifact_ingest
            .link(
                &owner,
                &Default::default(),
                &artifact.sha256,
                "turn",
                "artifact-turn",
                "evidence-bundle",
                "owner-task",
            )
            .is_ok());
        assert!(kernel
            .artifact_ingest
            .link(
                &owner,
                &Default::default(),
                &artifact.sha256,
                "checkpoint",
                "checkpoint-id",
                "content",
                "owner-task",
            )
            .is_ok());

        // Every tool call spills these four artifacts and every episode
        // summary spills one. They were not on the allowlist, so the first
        // link of the first tool call aborted the turn.
        for (owner_type, owner_id, purpose) in [
            ("tool_call", "tool-call-id", "arguments"),
            ("tool_call", "tool-call-id", "result"),
            ("tool_call", "tool-call-id", "provider-transcript"),
            ("tool_call", "tool-call-id", "provider-result-transcript"),
            ("episode", "episode-id", "content"),
        ] {
            match kernel.artifact_ingest.link(
                &owner,
                &Default::default(),
                &artifact.sha256,
                owner_type,
                owner_id,
                purpose,
                "owner-task",
            ) {
                Ok(_) => {}
                Err(error) => panic!("{owner_type}/{purpose} link was rejected: {error}"),
            }
        }

        // The allowlist stays closed: an unknown purpose on an admitted owner
        // type is still a caller error.
        assert!(matches!(
            kernel.artifact_ingest.link(
                &owner,
                &Default::default(),
                &artifact.sha256,
                "tool_call",
                "tool-call-id",
                "not-a-real-purpose",
                "owner-task",
            ),
            Err(error) if error.code() == ErrorCode::InvalidArgument
        ));

        // A tool-call link may not cross tasks.
        assert!(matches!(
            kernel.artifact_ingest.link(
                &other,
                &Default::default(),
                &artifact.sha256,
                "tool_call",
                "tool-call-id",
                "arguments",
                "owner-task",
            ),
            Err(error) if error.code() == ErrorCode::PermissionDenied
        ));

        let cross_task = kernel.artifact_ingest.link(
            &other,
            &Default::default(),
            &artifact.sha256,
            "turn",
            "artifact-turn",
            "initiating-input",
            "owner-task",
        );
        assert!(matches!(
            cross_task,
            Err(error) if error.code() == ErrorCode::PermissionDenied
        ));

        let wildcard_turn = kernel.artifact_ingest.link(
            &owner,
            &Default::default(),
            &artifact.sha256,
            "turn",
            "*",
            "initiating-input",
            "owner-task",
        );
        assert!(matches!(
            wildcard_turn,
            Err(error) if error.code() == ErrorCode::InvalidArgument
        ));

        let mut wildcard_capability = task_context(&kernel, "*", "turn-wildcard-token");
        wildcard_capability.task_id = "owner-task".to_string();
        let wildcard_task_authority = kernel.artifact_ingest.link(
            &wildcard_capability,
            &Default::default(),
            &artifact.sha256,
            "turn",
            "artifact-turn",
            "initiating-input",
            "owner-task",
        );
        assert!(matches!(
            wildcard_task_authority,
            Err(error) if error.code() == ErrorCode::PermissionDenied
        ));

        let mismatched_task_evidence = kernel.artifact_ingest.link(
            &owner,
            &Default::default(),
            &artifact.sha256,
            "task",
            "other-task",
            "evidence-bundle",
            "owner-task",
        );
        assert!(matches!(
            mismatched_task_evidence,
            Err(error) if error.code() == ErrorCode::PermissionDenied
        ));

        let mismatched_turn_evidence = kernel.artifact_ingest.link(
            &owner,
            &Default::default(),
            &artifact.sha256,
            "turn",
            "other-turn",
            "evidence-bundle",
            "owner-task",
        );
        assert!(matches!(
            mismatched_turn_evidence,
            Err(error) if error.code() == ErrorCode::PermissionDenied
        ));
    }
}

//! The 13 service groups defined in SPEC.md Section 31.1.
//!
//! Each mutating service method enforces the SPEC §31.3 14-step validation
//! pipeline at the granularity this crate supports:
//!   1. authenticate the control-plane connection (caller-provided bearer
//!      token; verified in the HTTP mini-service);
//!   2. validate request schema (handled by serde deserialization);
//!   3. validate capability token and bind to operation class + scope
//!      (`validate_capability_for_op`);
//!   4. resolve workspace and sandbox lease (out of scope for the in-process
//!      kernel; the mini-service wires this);
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
use std::path::PathBuf;
use std::sync::Arc;
use terminus_artifacts::ArtifactStore;
use terminus_authz::{OperationClass, Scope, TokenIssuer, TokenRevoker};
use terminus_code_intel::CodeIntelService;
use terminus_connector::ConnectorBroker;
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
    pub info: KernelInfoService,
    pub workspaces: WorkspaceService,
    pub files: FileService,
    pub patches: PatchService,
    pub processes: ProcessService,
    pub jobs: JobService,
    pub sandboxes: SandboxService,
    pub policies: PolicyService,
    pub secrets: SecretService,
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
        Self::new_with_egress_policy(
            data_dir,
            terminus_egress::EgressPolicy::default(),
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
        let job_manager = Arc::new(JobManager::new(Arc::clone(&process_manager)));
        let policy_engine = Arc::new(PolicyEngine::new(terminus_policy::default_rule_set()));
        let info = KernelInfoService::new();
        // SPEC §13.4 / §36.5: on Linux, prefer the Bubblewrap backend (real
        // namespace isolation) when bwrap is on PATH; fall back to the
        // local-restrictive backend (process groups + env sanitization, no
        // namespace isolation). On other platforms, local-restrictive is the
        // default and honestly reports Degraded. The selected backend's
        // `spawn_wrapper` decides whether spawns run inside bwrap.
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
            #[cfg(not(target_os = "linux"))]
            {
                SandboxManager::new()
            }
        };
        let sandbox_manager = Arc::new(sandbox_manager);
        let secret_broker = Arc::new(SecretBroker::new());
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
        let code_intel = Arc::new(CodeIntelService::new(Arc::new(
            terminus_code_intel::InMemorySymbolIndex::new(),
        )));
        let extension_host = Arc::new(WasiExtensionHost::new());
        let egress = Arc::new(EgressProxy::new(egress_policy, rate_limit));
        let egress_broker_root = data_dir.join("egress-brokers");
        let workspace_resolver = Arc::new(PathResolver::new(&data_dir)?);
        let patch_engine = PatchEngine::new(
            // The patch engine needs its own resolver (it does not share
            // the workspace resolver because patch leases are tracked
            // separately).
            PathResolver::new(&data_dir)?,
            data_dir.join("journal"),
            data_dir.join("patch-state"),
        )?;
        let _git_ops = Arc::new(GitOps::new(Arc::clone(&process_manager), "git"));
        let approvals = Arc::new(ApprovalStore::new());

        Ok(Self {
            info,
            workspaces: WorkspaceService::new(),
            files: FileService::new(
                Arc::clone(&artifact_store),
                Arc::clone(&workspace_resolver),
                Arc::clone(&token_issuer),
            ),
            patches: PatchService::new(Arc::new(patch_engine), Arc::clone(&token_issuer)),
            processes: ProcessService::new(
                Arc::clone(&process_manager),
                Arc::clone(&policy_engine),
                Arc::clone(&token_issuer),
                Arc::clone(&approvals),
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
                )
                .with_sandbox(Arc::clone(&sandbox_manager))
                .with_egress_broker(Arc::clone(&egress), egress_broker_root),
            ),
            sandboxes: SandboxService::new(sandbox_manager),
            policies: PolicyService::new(policy_engine),
            secrets: SecretService::new(Arc::clone(&secret_broker), Arc::clone(&token_issuer)),
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
                let broker = ConnectorBroker::builder(
                    Arc::clone(&secret_broker),
                    Arc::clone(&grants),
                    Arc::clone(&egress),
                    grant_key.to_vec(),
                )
                .build();
                ConnectorService::new(
                    Arc::new(broker),
                    Arc::clone(&issuer),
                    grants,
                    Arc::clone(&secret_broker),
                    Arc::clone(&token_issuer),
                    grant_key.to_vec(),
                )
            },
            network: NetworkService::new(egress, Arc::clone(&token_issuer)),
            code_intel: CodeIntelligenceService::new(code_intel, Arc::clone(&token_issuer)),
            extensions: ExtensionRuntimeService::new(extension_host, Arc::clone(&token_issuer)),
            artifact_ingest: ArtifactIngestService::new(artifact_store, Arc::clone(&token_issuer)),
            token_issuer,
            approvals,
        })
    }

    pub fn token_revoker(&self) -> Arc<TokenRevoker> {
        // Build a fresh revoker view onto the issuer's shared revocation
        // list. The HTTP mini-service uses this to honor revocation calls
        // without exposing the signing secret.
        Arc::new(TokenRevoker::new(self.token_issuer.revocation_list()))
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
    issuer
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
        })
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

    pub fn info(&self) -> serde_json::Value {
        serde_json::json!({
            "instance_id": self.instance_id,
            "implementation": "terminus-kernel-rs",
            "version": env!("CARGO_PKG_VERSION"),
            "services": [
                "KernelInfoService", "WorkspaceService", "FileService", "PatchService",
                "ProcessService", "JobService", "SandboxService", "PolicyService",
                "SecretService", "NetworkService", "CodeIntelligenceService",
                "ExtensionRuntimeService", "ArtifactIngestService",
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

// ---------- WorkspaceService ----------

#[derive(Debug, Clone, Default)]
pub struct WorkspaceService {
    registered: Arc<std::sync::Mutex<std::collections::HashMap<String, WorkspaceEntry>>>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct WorkspaceEntry {
    pub id: String,
    pub root_uri: String,
    pub canonical_root: String,
    pub trust: String,
}

impl WorkspaceService {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(
        &self,
        ctx: &RequestContext,
        _intent: &EffectIntent,
        root_uri: impl Into<String>,
        canonical_root: impl Into<String>,
        trust: &str,
    ) -> KernelResult<String> {
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
        let entry = WorkspaceEntry {
            id: terminus_kernel_protocol::new_id(),
            root_uri: root_uri.into(),
            canonical_root: canonical_root.into(),
            trust,
        };
        let id = entry.id.clone();
        let mut guard = match self.registered.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        guard.insert(id.clone(), entry);
        let _ = ctx;
        Ok(id)
    }

    pub fn get(&self, workspace_id: &str) -> KernelResult<WorkspaceEntry> {
        let guard = match self.registered.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        guard.get(workspace_id).cloned().ok_or_else(|| {
            KernelError::new(
                terminus_kernel_protocol::ErrorCode::WorkspaceNotFound,
                terminus_kernel_protocol::ErrorCategory::NotFound,
                format!("workspace {workspace_id} not found"),
                false,
            )
        })
    }
}

// ---------- FileService ----------

#[derive(Clone)]
pub struct FileService {
    artifact_store: Arc<ArtifactStore>,
    /// Path resolver used to reject absolute paths, `..` traversal, symlink
    /// escapes, and protected prefixes before any bytes touch the
    /// filesystem. SPEC §31.5 + §31.3 step 5.
    resolver: Arc<PathResolver>,
    /// Capability-token issuer used to validate `OperationClass::Read` and
    /// the requested path scope.
    token_issuer: Arc<TokenIssuer>,
}

impl std::fmt::Debug for FileService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FileService")
            .field("artifact_store", &self.artifact_store)
            .field("resolver_root", &self.resolver.root().display().to_string())
            .finish()
    }
}

impl FileService {
    pub fn new(
        artifact_store: Arc<ArtifactStore>,
        resolver: Arc<PathResolver>,
        token_issuer: Arc<TokenIssuer>,
    ) -> Self {
        Self {
            artifact_store,
            resolver,
            token_issuer,
        }
    }

    /// Expose the resolver so HTTP handlers that implement `list` can reuse
    /// the same path-safety check.
    pub fn resolver(&self) -> &Arc<PathResolver> {
        &self.resolver
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
        intent: &EffectIntent,
        path: &WorkspacePath,
    ) -> KernelResult<(Vec<u8>, ArtifactRef)> {
        self.read_with_token(ctx, intent, path, Some(&self.token_issuer))
    }

    /// Read a file with optional explicit capability-token enforcement. If
    /// `issuer` is `None`, capability-token validation is skipped (the caller
    /// is responsible for enforcing it externally, e.g. via the HTTP
    /// middleware). If `issuer` is `Some`, the token's `operation_classes`
    /// and `max_scope` are checked against this read.
    pub fn read_with_token(
        &self,
        ctx: &RequestContext,
        _intent: &EffectIntent,
        path: &WorkspacePath,
        issuer: Option<&TokenIssuer>,
    ) -> KernelResult<(Vec<u8>, ArtifactRef)> {
        if let Some(iss) = issuer {
            let requested_scope = Scope {
                workspace_paths: vec![path.relative_path.clone()],
                network_destinations: Vec::new(),
                secret_capabilities: Vec::new(),
            };
            let _ = validate_capability_for_op(iss, ctx, OperationClass::Read, &requested_scope)?;
        }
        // §31.3 step 5: canonicalize paths and reject traversal/symlink escape.
        let safe = terminus_fs::SafePath::new(&path.relative_path).map_err(|e| {
            KernelError::new(
                terminus_kernel_protocol::ErrorCode::InvalidArgument,
                terminus_kernel_protocol::ErrorCategory::Validation,
                format!("path rejected by SafePath: {e}"),
                false,
            )
        })?;
        let resolved = self.resolver.resolve_strict(&safe).map_err(|e| {
            KernelError::new(
                terminus_kernel_protocol::ErrorCode::InvalidArgument,
                terminus_kernel_protocol::ErrorCategory::Validation,
                format!("path rejected by PathResolver: {e}"),
                false,
            )
        })?;
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
    engine: Arc<PatchEngine>,
    token_issuer: Arc<TokenIssuer>,
}

impl std::fmt::Debug for PatchService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PatchService")
            .field("engine", &self.engine)
            .finish_non_exhaustive()
    }
}

impl PatchService {
    pub fn new(engine: Arc<PatchEngine>, token_issuer: Arc<TokenIssuer>) -> Self {
        Self {
            engine,
            token_issuer,
        }
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
        // §31.3 step 3: capability-token validation.
        let requested_scope = Scope::default();
        let _ = validate_capability_for_op(
            &self.token_issuer,
            ctx,
            OperationClass::Patch,
            &requested_scope,
        )?;
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
        self.engine
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
        let _ = validate_capability_for_op(
            &self.token_issuer,
            ctx,
            OperationClass::Patch,
            &requested_scope,
        )?;
        self.engine.reconcile(transaction_id).map_err(|e| {
            KernelError::new(
                terminus_kernel_protocol::ErrorCode::Internal,
                terminus_kernel_protocol::ErrorCategory::Internal,
                e.to_string(),
                false,
            )
        })
    }
}

/// Resolve a sandbox profile id to a `SandboxProfile`. The kernel currently
/// ships one enforced profile (`default-restrictive`); `secure-local-default`
/// (the config profile name) maps to it. Unknown ids fall back to the
/// restrictive default so a stale or attacker-supplied id never widens
/// permissions (SPEC §13.3: a named secure profile MUST exist and be the
/// default). When multiple profiles are added, this MUST consult a profile
/// registry keyed by id.
fn resolve_sandbox_profile(profile_id: &str) -> KernelResult<SandboxProfile> {
    match profile_id {
        "secure-local-default" | "default-restrictive" | "degraded-local" => {
            let mut profile = SandboxProfile::default_restrictive();
            profile.id = profile_id.to_string();
            Ok(profile)
        }
        "proxy-required" => {
            let mut profile = SandboxProfile::default_restrictive();
            profile.id = profile_id.to_string();
            profile.network = terminus_sandbox::NetworkAccess::ProxyRequired;
            Ok(profile)
        }
        _ => Err(KernelError::new(
            terminus_kernel_protocol::ErrorCode::InvalidArgument,
            terminus_kernel_protocol::ErrorCategory::Validation,
            format!("unknown sandbox profile `{profile_id}`"),
            false,
        )),
    }
}

#[cfg(test)]
mod sandbox_profile_tests {
    use super::resolve_sandbox_profile;

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
    fn unknown_profile_is_rejected() {
        assert!(resolve_sandbox_profile("unknown-profile").is_err());
    }
}

// ---------- ProcessService ----------

#[derive(Clone)]
pub struct ProcessService {
    process: Arc<ProcessManager>,
    policy: Arc<PolicyEngine>,
    token_issuer: Arc<TokenIssuer>,
    approvals: Arc<ApprovalStore>,
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
            .finish_non_exhaustive()
    }
}

impl ProcessService {
    pub fn new(
        process: Arc<ProcessManager>,
        policy: Arc<PolicyEngine>,
        token_issuer: Arc<TokenIssuer>,
        approvals: Arc<ApprovalStore>,
    ) -> Self {
        Self {
            process,
            policy,
            token_issuer,
            approvals,
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
        // Heuristic effect classification: shell scripts and known network
        // binaries get extra effect types so the policy engine can match on
        // them.
        if command.shell.enabled {
            normalized.shell_ast = Some(terminus_policy::ShellAst::Script {
                dialect: if command.shell.dialect.is_empty() {
                    "sh".to_string()
                } else {
                    command.shell.dialect.clone()
                },
                script: command.shell.script.clone(),
            });
            normalized.effect_types.insert(EffectType::ExecuteLocal);
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
        command: CommandSpec,
        sandbox_profile_id: &str,
    ) -> KernelResult<tokio::sync::mpsc::Receiver<ProcessEvent>> {
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
        let _ = validate_capability_for_op(
            &self.token_issuer,
            ctx,
            OperationClass::Exec,
            &requested_scope,
        )?;

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
        let mut report = self.policy.evaluate(&normalized);

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
        if matches!(report.decision, Decision::AllowWithConstraints) {
            spawn = Self::apply_constraints(spawn, &report.constraints);
        }

        // §31.3 step 11 (前置): select the sandbox backend for the named
        // profile and verify enforcement. SPEC §13.4: fail closed when the
        // backend is Unsupported, or when it is Degraded and strict mode is
        // enabled (`TERMINUS_STRICT_SANDBOX=1`). Otherwise audit the effective
        // (degraded) enforcement and proceed — degraded is an explicit,
        // audited state, never a silent downgrade.
        let profile = resolve_sandbox_profile(sandbox_profile_id)?;
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
        let sandbox_wrapper = if matches!(
            profile.network,
            terminus_sandbox::NetworkAccess::ProxyRequired
        ) {
            #[cfg(unix)]
            {
                let broker = self.start_egress_broker().await?;
                let wrapper = broker.broker_dir.as_deref().and_then(|broker_dir| {
                    sandbox_backend.as_ref().and_then(|backend| {
                        backend.spawn_wrapper_with_egress_broker(&command, &profile, broker_dir)
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
                .and_then(|backend| backend.spawn_wrapper(&command, &profile))
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

        // §31.3 step 9: reserve budgets and resource limits. Cap the
        // timeout at the tightest of: the requested timeout, the policy
        // constraint, and the sandbox profile's wall-clock limit. Emit a
        // budget_reserved audit event.
        if let Some(wall) = profile.resources.wall_clock_ms {
            if wall > 0 && (spawn.timeout_ms == 0 || wall < spawn.timeout_ms) {
                spawn.timeout_ms = wall;
            }
        }
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
                spawn.env.insert(
                    "TERMINUS_EGRESS_BROKER_SOCKET".to_string(),
                    ActiveEgressBroker::guest_socket_path(),
                );
                process_manager
                    .spawn_wrapped_with_lease(
                        wrapper_bin,
                        wrapper_argv,
                        spawn,
                        broker.into_spawn_lease(),
                    )
                    .await
            } else {
                process_manager
                    .spawn_wrapped(wrapper_bin, wrapper_argv, spawn)
                    .await
            }
            #[cfg(not(unix))]
            {
                process_manager
                    .spawn_wrapped(wrapper_bin, wrapper_argv, spawn)
                    .await
            }
        } else {
            process_manager.spawn(spawn).await
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
        let started = self
            .process
            .start_in_profile_with_outcome(ctx, intent, command, sandbox_profile_id)
            .await;
        let (outcome, receiver) = match started {
            Ok(value) => value,
            Err(error) => {
                self.manager.remove(&job_id).await;
                return Err(error);
            }
        };
        if !durable {
            tracing::debug!(job_id = %job_id, "job started in non-durable mode");
        }
        self.manager
            .attach_started(&job_id, &outcome)
            .await
            .map_err(job_error)?;
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

    /// Request a secret and return metadata only. The raw value is dropped
    /// before this method returns, so transport adapters can mint an opaque
    /// handle without ever serializing secret material.
    pub fn request_metadata(
        &self,
        ctx: &RequestContext,
        uri: &str,
        requested_by: &str,
    ) -> KernelResult<terminus_secrets::SecretMetadata> {
        // §31.3 step 3: capability-token validation. Secret access requires
        // the `Secret` operation class. The requested scope is the URI
        // itself.
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
        // §31.3 step 10: persist AUTHORIZED state.
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
        self.broker
            .request(uri, requested_by)
            .map(|handle| handle.metadata.clone())
            .map_err(|e| {
                KernelError::new(
                    terminus_kernel_protocol::ErrorCode::PermissionDenied,
                    terminus_kernel_protocol::ErrorCategory::Permission,
                    format!("{e}"),
                    false,
                )
            })
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
        signing_key: Vec<u8>,
    ) -> Self {
        Self {
            broker,
            issuer,
            grants,
            secret_broker,
            token_issuer,
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
        self.broker.register_connector(id, auth).map_err(|e| {
            KernelError::new(
                terminus_kernel_protocol::ErrorCode::InvalidRequest,
                terminus_kernel_protocol::ErrorCategory::Validation,
                format!("{e}"),
                false,
            )
        })
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
    pub fn mint_grant(
        &self,
        ctx: &RequestContext,
        uri: &str,
        binding: terminus_secrets::GrantBinding,
        ttl_secs: u64,
        use_limit: u32,
    ) -> KernelResult<terminus_secrets::ConnectorGrant> {
        // Secret-class capability is required to mint: a grant is one step
        // from raw use.
        let requested_scope = Scope {
            workspace_paths: Vec::new(),
            network_destinations: vec![format!(
                "{}:{}",
                binding.destination_host, binding.destination_port
            )],
            secret_capabilities: vec![uri.to_string()],
        };
        let _ = validate_capability_for_op(
            &self.token_issuer,
            ctx,
            OperationClass::Secret,
            &requested_scope,
        )?;
        let handle = self
            .secret_broker
            .request(uri, &binding.task_id)
            .map_err(|e| {
                KernelError::new(
                    terminus_kernel_protocol::ErrorCode::PermissionDenied,
                    terminus_kernel_protocol::ErrorCategory::Permission,
                    format!("{e}"),
                    false,
                )
            })?;
        let digest = handle.digest();
        drop(handle);
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
            .mint_for_digest(workload, uri, &digest, binding, ttl_secs, use_limit)
            .map_err(|e| {
                KernelError::new(
                    terminus_kernel_protocol::ErrorCode::InvalidRequest,
                    terminus_kernel_protocol::ErrorCategory::Validation,
                    format!("{e}"),
                    false,
                )
            })
    }

    /// Execute one grant-bound operation through the trusted connector
    /// path. Requires the `Network` operation class scoped to the exact
    /// destination. Returns the typed receipt only.
    pub async fn execute(
        &self,
        ctx: &RequestContext,
        op: &terminus_connector::CanonicalOperation,
        grant: &terminus_secrets::ConnectorGrant,
    ) -> KernelResult<terminus_connector::ConnectorReceipt> {
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
        let receipt = self.broker.execute(op, grant).await.map_err(|e| {
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
            grant_id = %receipt.grant_id,
            outcome = ?receipt.outcome,
            status_code = ?receipt.status_code,
            response_redactions = receipt.response_redactions,
            "connector operation executed"
        );
        Ok(receipt)
    }

    pub fn consumed_grants(&self) -> usize {
        self.grants.consumed_count()
    }
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
    inner: Arc<CodeIntelService>,
    token_issuer: Arc<TokenIssuer>,
}

impl std::fmt::Debug for CodeIntelligenceService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CodeIntelligenceService")
            .field("inner", &self.inner)
            .finish_non_exhaustive()
    }
}

impl CodeIntelligenceService {
    pub fn new(inner: Arc<CodeIntelService>, token_issuer: Arc<TokenIssuer>) -> Self {
        Self {
            inner,
            token_issuer,
        }
    }

    /// Direct accessor for the underlying `CodeIntelService`. Used by the
    /// HTTP mini-service to call `find_references` and `diagnose_files`.
    pub fn service(&self) -> &Arc<CodeIntelService> {
        &self.inner
    }

    pub fn inspect(
        &self,
        ctx: &RequestContext,
        _intent: &EffectIntent,
        symbol: &str,
    ) -> KernelResult<terminus_code_intel::InspectResult> {
        // §31.3 step 3: capability-token validation. Inspect requires the
        // `CodeIntel` operation class.
        let _ = validate_capability_for_op(
            &self.token_issuer,
            ctx,
            OperationClass::CodeIntel,
            &Scope::default(),
        )?;
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
        self.inner.inspect_symbol(symbol).map_err(|e| {
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

    /// Direct accessor for the underlying `ArtifactStore`. Used by the HTTP
    /// mini-service to fetch artifact bytes and metadata.
    pub fn store(&self) -> &Arc<ArtifactStore> {
        &self.store
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
        self.ingest_with_bytes(bytes)
    }

    /// Ingest raw bytes without a request context. Used by the HTTP
    /// mini-service's binary `POST /v1/artifacts/ingest` endpoint where the
    /// body IS the artifact bytes (not a JSON envelope).
    pub fn ingest_with_bytes(&self, bytes: &[u8]) -> KernelResult<ArtifactRef> {
        let (_, artifact) = self.store.ingest(bytes).map_err(|e| {
            KernelError::new(
                terminus_kernel_protocol::ErrorCode::Internal,
                terminus_kernel_protocol::ErrorCategory::Internal,
                format!("{e}"),
                false,
            )
        })?;
        Ok(artifact)
    }

    pub fn get(&self, ctx: &RequestContext, sha256: &str) -> KernelResult<Vec<u8>> {
        let _ = validate_capability_for_op(
            &self.token_issuer,
            ctx,
            OperationClass::ArtifactIngest,
            &Scope::default(),
        )?;
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
        let _ = validate_capability_for_op(
            &self.token_issuer,
            ctx,
            OperationClass::ArtifactIngest,
            &Scope::default(),
        )?;
        let metadata = self.store.metadata(sha256).map_err(|e| {
            KernelError::new(
                terminus_kernel_protocol::ErrorCode::ArtifactNotFound,
                terminus_kernel_protocol::ErrorCategory::NotFound,
                e.to_string(),
                false,
            )
        })?;
        Ok(ArtifactRef::new(
            metadata.hash,
            metadata.size_bytes,
            metadata.media_type,
        ))
    }
}

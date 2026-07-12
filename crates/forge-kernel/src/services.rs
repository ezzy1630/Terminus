//! The 13 service groups defined in SPEC.md Section 31.1.

use crate::error::KernelAssemblyError;
use forge_artifacts::ArtifactStore;
use forge_authz::{TokenIssuer, TokenRevoker};
use forge_code_intel::CodeIntelService;
use forge_egress::EgressProxy;
use forge_extension_runtime::WasiExtensionHost;
use forge_fs::PathResolver;
use forge_git::GitOps;
use forge_jobs::JobManager;
use forge_kernel_protocol::{
    ArtifactRef, CommandSpec, Diagnostic, EffectIntent, KernelError, KernelResult, PatchEdit,
    PatchResponse, ProcessEvent, RequestContext, ToolResultEnvelope, ToolResultStatus,
    WorkspaceBaseline, WorkspacePath,
};
use forge_patch::PatchEngine;
use forge_policy::{Decision, PolicyEngine};
use forge_process::ProcessManager;
use forge_sandbox::SandboxManager;
use forge_secrets::SecretBroker;
use std::path::PathBuf;
use std::sync::Arc;

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
    pub network: NetworkService,
    pub code_intel: CodeIntelligenceService,
    pub extensions: ExtensionRuntimeService,
    pub artifact_ingest: ArtifactIngestService,
}

impl std::fmt::Debug for KernelHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("KernelHandle").finish_non_exhaustive()
    }
}

impl KernelHandle {
    /// Build a kernel with all defaults. `data_dir` is the on-disk root for
    /// artifacts, journals, state.
    pub fn new(data_dir: PathBuf) -> Result<Self, KernelAssemblyError> {
        let artifact_store = Arc::new(ArtifactStore::open(data_dir.join("artifacts"))?);
        let process_manager = Arc::new(ProcessManager::new(Arc::clone(&artifact_store)));
        let job_manager = Arc::new(JobManager::new(Arc::clone(&process_manager)));
        let policy_engine = Arc::new(PolicyEngine::new(forge_policy::default_rule_set()));
        let sandbox_manager = Arc::new(SandboxManager::new());
        let secret_broker = Arc::new(SecretBroker::new());
        let token_issuer = Arc::new(TokenIssuer::new(
            b"kernel-default-secret-please-rotate".to_vec(),
            "kernel-instance-1".to_string(),
            3600,
        ));
        let revocation = token_issuer.revocation_list();
        let revoker = Arc::new(TokenRevoker::new(revocation));
        let code_intel = Arc::new(CodeIntelService::new(Arc::new(
            forge_code_intel::InMemorySymbolIndex::new(),
        )));
        let extension_host = Arc::new(WasiExtensionHost::new());
        let egress = Arc::new(EgressProxy::new(
            forge_egress::EgressPolicy::default(),
            forge_egress::RateLimit::default(),
        ));
        let patch_engine = PatchEngine::new(
            // Use the data_dir as the workspace root by default; production
            // kernels pass a per-workspace resolver.
            PathResolver::new(&data_dir)?,
            data_dir.join("journal"),
            data_dir.join("patch-state"),
        )?;
        let git_ops = Arc::new(GitOps::new(Arc::clone(&process_manager), "git"));

        Ok(Self {
            info: KernelInfoService::new(),
            workspaces: WorkspaceService::new(),
            files: FileService::new(Arc::clone(&artifact_store)),
            patches: PatchService::new(Arc::new(patch_engine)),
            processes: ProcessService::new(Arc::clone(&process_manager), Arc::clone(&policy_engine)),
            jobs: JobService::new(job_manager),
            sandboxes: SandboxService::new(sandbox_manager),
            policies: PolicyService::new(policy_engine),
            secrets: SecretService::new(secret_broker),
            network: NetworkService::new(egress),
            code_intel: CodeIntelligenceService::new(code_intel),
            extensions: ExtensionRuntimeService::new(extension_host),
            artifact_ingest: ArtifactIngestService::new(artifact_store),
        })
    }

    pub fn token_revoker(&self) -> Option<Arc<TokenRevoker>> {
        // Revoker is held by the issuer; production code wires this through
        // the kernel's HTTP layer. We expose it for testkit use.
        None
    }
}

// ---------- KernelInfoService ----------

#[derive(Debug, Clone, Default)]
pub struct KernelInfoService {
    instance_id: String,
}

impl KernelInfoService {
    pub fn new() -> Self {
        Self {
            instance_id: forge_kernel_protocol::new_id(),
        }
    }

    pub fn instance_id(&self) -> &str {
        &self.instance_id
    }

    pub fn info(&self) -> serde_json::Value {
        serde_json::json!({
            "instance_id": self.instance_id,
            "implementation": "forge-kernel-rs",
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
    ) -> KernelResult<String> {
        let entry = WorkspaceEntry {
            id: forge_kernel_protocol::new_id(),
            root_uri: root_uri.into(),
            canonical_root: canonical_root.into(),
            trust: "trusted".to_string(),
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
        guard
            .get(workspace_id)
            .cloned()
            .ok_or_else(|| KernelError::new(
                forge_kernel_protocol::ErrorCode::WorkspaceNotFound,
                forge_kernel_protocol::ErrorCategory::NotFound,
                format!("workspace {workspace_id} not found"),
                false,
            ))
    }
}

// ---------- FileService ----------

#[derive(Debug, Clone)]
pub struct FileService {
    artifact_store: Arc<ArtifactStore>,
}

impl FileService {
    pub fn new(artifact_store: Arc<ArtifactStore>) -> Self {
        Self { artifact_store }
    }

    pub fn read(
        &self,
        _ctx: &RequestContext,
        _intent: &EffectIntent,
        path: &WorkspacePath,
    ) -> KernelResult<(Vec<u8>, ArtifactRef)> {
        let bytes = std::fs::read(&path.relative_path).map_err(|e| {
            KernelError::new(
                forge_kernel_protocol::ErrorCode::PathNotFound,
                forge_kernel_protocol::ErrorCategory::NotFound,
                format!("read {}: {e}", path.relative_path),
                false,
            )
        })?;
        let (_, artifact) = self
            .artifact_store
            .ingest(&bytes)
            .map_err(|e| KernelError::new(
                forge_kernel_protocol::ErrorCode::Internal,
                forge_kernel_protocol::ErrorCategory::Internal,
                format!("ingest failed: {e}"),
                false,
            ))?;
        Ok((bytes, artifact))
    }
}

// ---------- PatchService ----------

#[derive(Debug, Clone)]
pub struct PatchService {
    engine: Arc<PatchEngine>,
}

impl PatchService {
    pub fn new(engine: Arc<PatchEngine>) -> Self {
        Self { engine }
    }

    pub fn apply(
        &self,
        _ctx: &RequestContext,
        _intent: &EffectIntent,
        transaction_id: &str,
        baseline: &WorkspaceBaseline,
        edits: &[PatchEdit],
    ) -> KernelResult<PatchResponse> {
        self.apply_with_mode(
            _ctx,
            _intent,
            transaction_id,
            baseline,
            edits,
            forge_kernel_protocol::PatchCommitMode::ApplyToWorktree,
        )
    }

    /// Apply a patch with an explicit commit mode. Used by the HTTP
    /// mini-service to differentiate `preview` vs `apply` endpoints.
    pub fn apply_with_mode(
        &self,
        _ctx: &RequestContext,
        _intent: &EffectIntent,
        transaction_id: &str,
        baseline: &WorkspaceBaseline,
        edits: &[PatchEdit],
        commit_mode: forge_kernel_protocol::PatchCommitMode,
    ) -> KernelResult<PatchResponse> {
        self.engine
            .apply(
                transaction_id,
                baseline,
                edits,
                commit_mode,
                forge_patch::ValidationProfile::TaskDefault,
            )
            .map_err(|e| KernelError::new(
                forge_kernel_protocol::ErrorCode::StaleSourceVersion,
                forge_kernel_protocol::ErrorCategory::Conflict,
                format!("{e}"),
                true,
            ))
    }
}

// ---------- ProcessService ----------

#[derive(Debug, Clone)]
pub struct ProcessService {
    process: Arc<ProcessManager>,
    policy: Arc<PolicyEngine>,
}

impl ProcessService {
    pub fn new(process: Arc<ProcessManager>, policy: Arc<PolicyEngine>) -> Self {
        Self { process, policy }
    }

    pub async fn start(
        &self,
        _ctx: &RequestContext,
        _intent: &EffectIntent,
        command: CommandSpec,
    ) -> KernelResult<tokio::sync::mpsc::Receiver<ProcessEvent>> {
        let spawn = forge_process::NormalizedSpawn::from_spec(&command).map_err(|e| {
            KernelError::new(
                forge_kernel_protocol::ErrorCode::InvalidArgument,
                forge_kernel_protocol::ErrorCategory::Validation,
                format!("{e}"),
                false,
            )
        })?;
        let (_outcome, rx) = self.process.spawn(spawn).await.map_err(|e| {
            KernelError::new(
                forge_kernel_protocol::ErrorCode::Internal,
                forge_kernel_protocol::ErrorCategory::Internal,
                format!("{e}"),
                false,
            )
        })?;
        Ok(rx)
    }

    pub async fn cancel(
        &self,
        _ctx: &RequestContext,
        process_id: &str,
        reason: &str,
    ) -> KernelResult<String> {
        self.process.cancel(process_id, reason).await.map_err(|e| {
            KernelError::new(
                forge_kernel_protocol::ErrorCode::ProcessNotFound,
                forge_kernel_protocol::ErrorCategory::NotFound,
                format!("{e}"),
                false,
            )
        })
    }
}

// ---------- JobService ----------

#[derive(Debug, Clone)]
pub struct JobService {
    manager: Arc<JobManager>,
}

impl JobService {
    pub fn new(manager: Arc<JobManager>) -> Self {
        Self { manager }
    }

    pub fn manager(&self) -> &Arc<JobManager> {
        &self.manager
    }
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

    pub fn enforcement_report(&self) -> forge_sandbox::EnforcementReport {
        self.manager.enforcement_report()
    }

    /// Select a backend that supports `profile`. Returns the chosen
    /// `SandboxBackend` trait object.
    pub fn select_public(
        &self,
        profile: &forge_sandbox::SandboxProfile,
    ) -> Result<std::sync::Arc<dyn forge_sandbox::SandboxBackend>, forge_sandbox::SandboxError> {
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
        command: &forge_policy::NormalizedCommand,
    ) -> forge_policy::DecisionReport {
        self.engine.evaluate(command)
    }
}

// ---------- SecretService ----------

#[derive(Debug, Clone)]
pub struct SecretService {
    broker: Arc<SecretBroker>,
}

impl SecretService {
    pub fn new(broker: Arc<SecretBroker>) -> Self {
        Self { broker }
    }

    /// Direct accessor for the underlying broker. Used by the HTTP
    /// mini-service to obtain a `SecretHandle` (whose value is never
    /// serialized to the caller).
    pub fn broker(&self) -> &Arc<SecretBroker> {
        &self.broker
    }

    pub fn request(
        &self,
        _ctx: &RequestContext,
        _intent: &EffectIntent,
        uri: &str,
        requested_by: &str,
    ) -> KernelResult<()> {
        self.broker
            .request(uri, requested_by)
            .map(|_| ())
            .map_err(|e| KernelError::new(
                forge_kernel_protocol::ErrorCode::PermissionDenied,
                forge_kernel_protocol::ErrorCategory::Permission,
                format!("{e}"),
                false,
            ))
    }
}

// ---------- NetworkService ----------

#[derive(Debug, Clone)]
pub struct NetworkService {
    proxy: Arc<EgressProxy>,
}

impl NetworkService {
    pub fn new(proxy: Arc<EgressProxy>) -> Self {
        Self { proxy }
    }

    /// Direct accessor for the underlying egress proxy. Used by the HTTP
    /// mini-service to expose the live allowlist.
    pub fn proxy(&self) -> &Arc<EgressProxy> {
        &self.proxy
    }

    /// Convenience accessor for the egress policy.
    pub fn policy(&self) -> &forge_egress::EgressPolicy {
        self.proxy.policy()
    }

    pub fn authorize(
        &self,
        _ctx: &RequestContext,
        _intent: &EffectIntent,
        host: &str,
        port: u16,
        scheme: &str,
        resolved_ips: &[std::net::IpAddr],
    ) -> KernelResult<()> {
        self.proxy
            .authorize(host, port, scheme, resolved_ips)
            .map_err(|e| KernelError::new(
                forge_kernel_protocol::ErrorCode::PolicyDenied,
                forge_kernel_protocol::ErrorCategory::PolicyDenied,
                format!("{e}"),
                false,
            ))
    }
}

// ---------- CodeIntelligenceService ----------

#[derive(Debug, Clone)]
pub struct CodeIntelligenceService {
    inner: Arc<CodeIntelService>,
}

impl CodeIntelligenceService {
    pub fn new(inner: Arc<CodeIntelService>) -> Self {
        Self { inner }
    }

    /// Direct accessor for the underlying `CodeIntelService`. Used by the
    /// HTTP mini-service to call `find_references` and `diagnose_files`.
    pub fn service(&self) -> &Arc<CodeIntelService> {
        &self.inner
    }

    pub fn inspect(
        &self,
        _ctx: &RequestContext,
        _intent: &EffectIntent,
        symbol: &str,
    ) -> KernelResult<forge_code_intel::InspectResult> {
        self.inner
            .inspect_symbol(symbol)
            .map_err(|e| KernelError::new(
                forge_kernel_protocol::ErrorCode::Internal,
                forge_kernel_protocol::ErrorCategory::Internal,
                format!("{e}"),
                false,
            ))
    }
}

// ---------- ExtensionRuntimeService ----------

#[derive(Debug, Clone)]
pub struct ExtensionRuntimeService {
    host: Arc<WasiExtensionHost>,
}

impl ExtensionRuntimeService {
    pub fn new(host: Arc<WasiExtensionHost>) -> Self {
        Self { host }
    }

    pub fn report(&self) -> forge_extension_runtime::WasiExtensionHostReport {
        self.host.report()
    }

    pub fn validate_manifest(
        &self,
        _ctx: &RequestContext,
        manifest: &forge_extension_runtime::ExtensionManifest,
    ) -> KernelResult<()> {
        self.host
            .validate_manifest(manifest)
            .map_err(|e| KernelError::new(
                forge_kernel_protocol::ErrorCode::InvalidArgument,
                forge_kernel_protocol::ErrorCategory::Validation,
                format!("{e}"),
                false,
            ))
    }
}

// ---------- ArtifactIngestService ----------

#[derive(Debug, Clone)]
pub struct ArtifactIngestService {
    store: Arc<ArtifactStore>,
}

impl ArtifactIngestService {
    pub fn new(store: Arc<ArtifactStore>) -> Self {
        Self { store }
    }

    /// Direct accessor for the underlying `ArtifactStore`. Used by the HTTP
    /// mini-service to fetch artifact bytes and metadata.
    pub fn store(&self) -> &Arc<ArtifactStore> {
        &self.store
    }

    pub fn ingest(
        &self,
        _ctx: &RequestContext,
        _intent: &EffectIntent,
        bytes: &[u8],
    ) -> KernelResult<ArtifactRef> {
        self.ingest_with_bytes(bytes)
    }

    /// Ingest raw bytes without a request context. Used by the HTTP
    /// mini-service's binary `POST /v1/artifacts/ingest` endpoint where the
    /// body IS the artifact bytes (not a JSON envelope).
    pub fn ingest_with_bytes(&self, bytes: &[u8]) -> KernelResult<ArtifactRef> {
        let (_, artifact) = self
            .store
            .ingest(bytes)
            .map_err(|e| KernelError::new(
                forge_kernel_protocol::ErrorCode::Internal,
                forge_kernel_protocol::ErrorCategory::Internal,
                format!("{e}"),
                false,
            ))?;
        Ok(artifact)
    }
}

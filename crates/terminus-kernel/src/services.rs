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
//!      (`forge_fs::PathResolver::resolve_strict`);
//!   6. classify effect and taint (TODO — for now we delegate to policy);
//!   7. evaluate command/resource policy (`PolicyEngine::evaluate`);
//!   8. resolve approval record if required (`ApprovalStore::consume`);
//!   9. reserve budgets and resource limits (TODO);
//!   10. persist `AUTHORIZED` state (`tracing::info!` structured event
//!       BEFORE the effect is taken);
//!   11. execute inside the selected backend;
//!   12. stream bounded observations (`mpsc::channel(64)`);
//!   13. settle and persist evidence (TODO — artifact store records output);
//!   14. release leases and resources (Drop).

use crate::approvals::ApprovalStore;
use crate::error::KernelAssemblyError;
use forge_artifacts::ArtifactStore;
use forge_authz::{OperationClass, Scope, TokenIssuer, TokenRevoker};
use forge_code_intel::CodeIntelService;
use forge_egress::EgressProxy;
use forge_extension_runtime::WasiExtensionHost;
use forge_fs::PathResolver;
use forge_git::GitOps;
use forge_jobs::JobManager;
use forge_kernel_protocol::{
    ArtifactRef, CommandSpec, EffectIntent, KernelError, KernelResult, PatchEdit, PatchResponse,
    ProcessEvent, RequestContext, WorkspaceBaseline, WorkspacePath,
};
use forge_patch::PatchEngine;
use forge_policy::{Constraint, Decision, NormalizedCommand, PolicyEngine};
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
    /// The capability-token issuer shared by every service. Made public so
    /// testkit and the HTTP mini-service can mint dev tokens and validate
    /// tokens presented by callers.
    pub token_issuer: Arc<TokenIssuer>,
    /// In-memory approval store (SPEC §36.11). Backed by SQLite in
    /// production.
    pub approvals: Arc<ApprovalStore>,
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
        let _revoker = Arc::new(TokenRevoker::new(revocation));
        let code_intel = Arc::new(CodeIntelService::new(Arc::new(
            forge_code_intel::InMemorySymbolIndex::new(),
        )));
        let extension_host = Arc::new(WasiExtensionHost::new());
        let egress = Arc::new(EgressProxy::new(
            forge_egress::EgressPolicy::default(),
            forge_egress::RateLimit::default(),
        ));
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
            info: KernelInfoService::new(),
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
            ),
            jobs: JobService::new(job_manager, Arc::clone(&token_issuer)),
            sandboxes: SandboxService::new(sandbox_manager),
            policies: PolicyService::new(policy_engine),
            secrets: SecretService::new(secret_broker, Arc::clone(&token_issuer)),
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
) -> KernelResult<forge_authz::CapabilityToken> {
    if ctx.capability_token.is_empty() {
        return Err(KernelError::new(
            forge_kernel_protocol::ErrorCode::CapabilityTokenInvalid,
            forge_kernel_protocol::ErrorCategory::Permission,
            "capability token required for this operation but none was supplied",
            false,
        ));
    }
    issuer
        .validate_capability(&ctx.capability_token, op_class, requested_scope)
        .map_err(|e| {
            let (code, msg) = match e {
                forge_authz::AuthzError::Expired => (
                    forge_kernel_protocol::ErrorCode::CapabilityTokenExpired,
                    "capability token expired".to_string(),
                ),
                forge_authz::AuthzError::Revoked => (
                    forge_kernel_protocol::ErrorCode::CapabilityTokenRevoked,
                    "capability token revoked".to_string(),
                ),
                forge_authz::AuthzError::InvalidAudience
                | forge_authz::AuthzError::WrongAudience => (
                    forge_kernel_protocol::ErrorCode::CapabilityTokenInvalid,
                    "capability token audience mismatch".to_string(),
                ),
                forge_authz::AuthzError::InvalidSignature => (
                    forge_kernel_protocol::ErrorCode::CapabilityTokenInvalid,
                    "capability token signature invalid".to_string(),
                ),
                forge_authz::AuthzError::OperationNotPermitted => (
                    forge_kernel_protocol::ErrorCode::PermissionDenied,
                    format!(
                        "capability token does not grant operation class `{:?}`",
                        op_class
                    ),
                ),
                forge_authz::AuthzError::ScopeExceeded => (
                    forge_kernel_protocol::ErrorCode::PermissionDenied,
                    "capability token scope exceeded".to_string(),
                ),
                other => (
                    forge_kernel_protocol::ErrorCode::CapabilityTokenInvalid,
                    format!("capability token rejected: {other}"),
                ),
            };
            KernelError::new(code, forge_kernel_protocol::ErrorCategory::Permission, msg, false)
        })
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
            .ok_or_else(|| {
                KernelError::new(
                    forge_kernel_protocol::ErrorCode::WorkspaceNotFound,
                    forge_kernel_protocol::ErrorCategory::NotFound,
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
        let safe = forge_fs::SafePath::new(&path.relative_path).map_err(|e| {
            KernelError::new(
                forge_kernel_protocol::ErrorCode::InvalidArgument,
                forge_kernel_protocol::ErrorCategory::Validation,
                format!("path rejected by SafePath: {e}"),
                false,
            )
        })?;
        let resolved = self.resolver.resolve_strict(&safe).map_err(|e| {
            KernelError::new(
                forge_kernel_protocol::ErrorCode::InvalidArgument,
                forge_kernel_protocol::ErrorCategory::Validation,
                format!("path rejected by PathResolver: {e}"),
                false,
            )
        })?;
        if !resolved.host.exists {
            return Err(KernelError::new(
                forge_kernel_protocol::ErrorCode::PathNotFound,
                forge_kernel_protocol::ErrorCategory::NotFound,
                format!(
                    "read {}: path does not exist",
                    resolved.host.host_path.display()
                ),
                false,
            ));
        }
        // §31.3 step 10: persist AUTHORIZED state BEFORE the effect.
        tracing::info!(
            target: "forge_kernel_audit",
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
                forge_kernel_protocol::ErrorCode::PathNotFound,
                forge_kernel_protocol::ErrorCategory::NotFound,
                format!("read {}: {e}", resolved.host.host_path.display()),
                false,
            )
        })?;
        let (_, artifact) = self
            .artifact_store
            .ingest(&bytes)
            .map_err(|e| {
                KernelError::new(
                    forge_kernel_protocol::ErrorCode::Internal,
                    forge_kernel_protocol::ErrorCategory::Internal,
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
            forge_kernel_protocol::PatchCommitMode::ApplyToWorktree,
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
        commit_mode: forge_kernel_protocol::PatchCommitMode,
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
            target: "forge_kernel_audit",
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
                forge_patch::ValidationProfile::TaskDefault,
            )
            .map_err(|e| {
                KernelError::new(
                    forge_kernel_protocol::ErrorCode::StaleSourceVersion,
                    forge_kernel_protocol::ErrorCategory::Conflict,
                    format!("{e}"),
                    true,
                )
            })
    }
}

// ---------- ProcessService ----------

#[derive(Clone)]
pub struct ProcessService {
    process: Arc<ProcessManager>,
    policy: Arc<PolicyEngine>,
    token_issuer: Arc<TokenIssuer>,
    approvals: Arc<ApprovalStore>,
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
        }
    }

    /// Build a `NormalizedCommand` from a `CommandSpec`. The command is
    /// classified heuristically: shell scripts get `EXECUTE_LOCAL`; commands
    /// whose program is a known network client (`curl`, `wget`, `git`) get
    /// the appropriate network effect type.
    fn build_normalized(command: &CommandSpec) -> NormalizedCommand {
        use forge_policy::EffectType;
        let mut normalized = NormalizedCommand::new(&command.program);
        normalized.argv = command.args.clone();
        normalized.working_directory = command.cwd.relative_path.clone();
        normalized.secret_capabilities = command.secret_capability_uris.clone();
        normalized.effect_types.insert(EffectType::ExecuteLocal);
        // Heuristic effect classification: shell scripts and known network
        // binaries get extra effect types so the policy engine can match on
        // them.
        if command.shell.enabled {
            normalized.shell_ast = Some(forge_policy::ShellAst::Script {
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
        spawn: forge_process::NormalizedSpawn,
        constraints: &Constraint,
    ) -> forge_process::NormalizedSpawn {
        let mut s = spawn;
        if let Some(max_rt) = constraints.max_runtime_ms {
            if max_rt > 0 && (s.timeout_ms == 0 || max_rt < s.timeout_ms) {
                s.timeout_ms = max_rt;
            }
        }
        if !constraints.disallowed_env.is_empty() {
            s.env.retain(|k, _| !constraints.disallowed_env.iter().any(|d| d == k));
        }
        s
    }

    /// Start a process. Enforces the SPEC §31.3 14-step validation order:
    /// capability token → policy evaluation → approval resolution →
    /// audit (AUTHORIZED) → spawn.
    pub async fn start(
        &self,
        ctx: &RequestContext,
        _intent: &EffectIntent,
        command: CommandSpec,
    ) -> KernelResult<tokio::sync::mpsc::Receiver<ProcessEvent>> {
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

        // §31.3 step 6 + 7: classify effect and evaluate policy.
        let normalized = Self::build_normalized(&command);
        let report = self.policy.evaluate(&normalized);

        // §31.3 step 8: approval resolution (only when the policy says
        // Prompt).
        match report.decision {
            Decision::Deny => {
                return Err(KernelError::new(
                    forge_kernel_protocol::ErrorCode::PolicyDenied,
                    forge_kernel_protocol::ErrorCategory::PolicyDenied,
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
                        forge_kernel_protocol::ErrorCode::ApprovalRequired,
                        forge_kernel_protocol::ErrorCategory::ApprovalRequired,
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
        let spawn = forge_process::NormalizedSpawn::from_spec(&command).map_err(|e| {
            KernelError::new(
                forge_kernel_protocol::ErrorCode::InvalidArgument,
                forge_kernel_protocol::ErrorCategory::Validation,
                format!("{e}"),
                false,
            )
        })?;
        let spawn = if matches!(report.decision, Decision::AllowWithConstraints) {
            Self::apply_constraints(spawn, &report.constraints)
        } else {
            spawn
        };

        // §31.3 step 10: persist AUTHORIZED state BEFORE the effect.
        tracing::info!(
            target: "forge_kernel_audit",
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
            "process start authorized",
        );

        // §31.3 step 11: execute inside the selected backend.
        // Apply max_output_bytes if the constraint specifies it.
        let process_manager: Arc<ProcessManager> =
            if let Some(max_bytes) = report.constraints.max_output_bytes {
                Arc::new((*self.process).clone().with_max_inline_bytes(max_bytes.max(1) as usize))
            } else {
                Arc::clone(&self.process)
            };
        let (_outcome, rx) = process_manager.spawn(spawn).await.map_err(|e| {
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
            target: "forge_kernel_audit",
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
                forge_kernel_protocol::ErrorCode::ProcessNotFound,
                forge_kernel_protocol::ErrorCategory::NotFound,
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
}

impl std::fmt::Debug for JobService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("JobService")
            .field("manager", &self.manager)
            .finish_non_exhaustive()
    }
}

impl JobService {
    pub fn new(manager: Arc<JobManager>, token_issuer: Arc<TokenIssuer>) -> Self {
        Self {
            manager,
            token_issuer,
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
    ) -> Result<std::sync::Arc<dyn forge_sandbox::SandboxBackend>, forge_sandbox::SandboxError>
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
    ) -> forge_policy::DecisionReport {
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
            target: "forge_kernel_audit",
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
            .map(|_| ())
            .map_err(|e| {
                KernelError::new(
                    forge_kernel_protocol::ErrorCode::PermissionDenied,
                    forge_kernel_protocol::ErrorCategory::Permission,
                    format!("{e}"),
                    false,
                )
            })
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
    pub fn policy(&self) -> &forge_egress::EgressPolicy {
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
            target: "forge_kernel_audit",
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
                    forge_kernel_protocol::ErrorCode::PolicyDenied,
                    forge_kernel_protocol::ErrorCategory::PolicyDenied,
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
    ) -> KernelResult<forge_code_intel::InspectResult> {
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
            target: "forge_kernel_audit",
            event = "authorized",
            service = "code_intel.inspect",
            request_id = %ctx.request_id,
            task_id = %ctx.task_id,
            actor_id = %ctx.actor_id,
            symbol = %symbol,
            "code-intel inspect authorized",
        );
        self.inner
            .inspect_symbol(symbol)
            .map_err(|e| {
                KernelError::new(
                    forge_kernel_protocol::ErrorCode::Internal,
                    forge_kernel_protocol::ErrorCategory::Internal,
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
    token_issuer: Arc<TokenIssuer>,
}

impl std::fmt::Debug for ExtensionRuntimeService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ExtensionRuntimeService")
            .field("host", &self.host)
            .finish_non_exhaustive()
    }
}

impl ExtensionRuntimeService {
    pub fn new(host: Arc<WasiExtensionHost>, token_issuer: Arc<TokenIssuer>) -> Self {
        Self {
            host,
            token_issuer,
        }
    }

    pub fn report(&self) -> forge_extension_runtime::WasiExtensionHostReport {
        self.host.report()
    }

    pub fn validate_manifest(
        &self,
        ctx: &RequestContext,
        manifest: &forge_extension_runtime::ExtensionManifest,
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
            target: "forge_kernel_audit",
            event = "authorized",
            service = "extension.validate_manifest",
            request_id = %ctx.request_id,
            task_id = %ctx.task_id,
            actor_id = %ctx.actor_id,
            extension_id = %manifest.id,
            extension_version = %manifest.version,
            "extension manifest validation authorized",
        );
        self.host
            .validate_manifest(manifest)
            .map_err(|e| {
                KernelError::new(
                    forge_kernel_protocol::ErrorCode::InvalidArgument,
                    forge_kernel_protocol::ErrorCategory::Validation,
                    format!("{e}"),
                    false,
                )
            })
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
            target: "forge_kernel_audit",
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
        let (_, artifact) = self
            .store
            .ingest(bytes)
            .map_err(|e| {
                KernelError::new(
                    forge_kernel_protocol::ErrorCode::Internal,
                    forge_kernel_protocol::ErrorCategory::Internal,
                    format!("{e}"),
                    false,
                )
            })?;
        Ok(artifact)
    }
}

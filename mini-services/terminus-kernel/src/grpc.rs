//! Generated gRPC-over-UDS transport for the privileged kernel boundary.

#![cfg_attr(test, allow(clippy::expect_used, clippy::unwrap_used))]
// Tonic's public streaming traits return `Result<_, Status>` by contract;
// these targeted allowances keep the transport adapter lintable without
// boxing every generated status. The generated prost module is excluded
// separately because it is not repository-authored code.
#![allow(clippy::result_large_err)]
#![allow(clippy::cast_possible_truncation)]
#![allow(clippy::default_trait_access)]
#![allow(clippy::map_flatten)]

use std::collections::HashMap;
use std::path::PathBuf;
use tokio_stream::{Stream, StreamExt};
use tonic::{transport::Server, Request, Response, Status};

#[allow(clippy::all)]
pub mod protocol {
    tonic::include_proto!("terminus.kernel.v1");
}

use crate::auth::constant_time_eq;
use protocol::artifact_ingest_service_server::{
    ArtifactIngestService as ArtifactIngestRpc, ArtifactIngestServiceServer,
};
use protocol::code_intelligence_service_server::{
    CodeIntelligenceService as CodeIntelligenceRpc, CodeIntelligenceServiceServer,
};
use protocol::computer_use_service_server::{
    ComputerUseService as ComputerUseRpc, ComputerUseServiceServer,
};
use protocol::connector_service_server::{
    ConnectorService as ConnectorServiceRpc, ConnectorServiceServer,
};
use protocol::extension_runtime_service_server::{
    ExtensionRuntimeService as ExtensionRuntimeRpc, ExtensionRuntimeServiceServer,
};
use protocol::file_service_server::{FileService as FileServiceRpc, FileServiceServer};
use protocol::job_service_server::{JobService as JobServiceRpc, JobServiceServer};
use protocol::kernel_info_service_server::{
    KernelInfoService as KernelInfoServiceRpc, KernelInfoServiceServer,
};
use protocol::network_service_server::{NetworkService as NetworkServiceRpc, NetworkServiceServer};
use protocol::patch_service_server::{PatchService as PatchServiceRpc, PatchServiceServer};
use protocol::policy_service_server::{PolicyService as PolicyServiceRpc, PolicyServiceServer};
use protocol::process_service_server::{ProcessService as ProcessServiceRpc, ProcessServiceServer};
use protocol::provider_account_service_server::{
    ProviderAccountService as ProviderAccountServiceRpc, ProviderAccountServiceServer,
};
use protocol::sandbox_service_server::{SandboxService as SandboxServiceRpc, SandboxServiceServer};
use protocol::secret_service_server::{SecretService as SecretServiceRpc, SecretServiceServer};
use protocol::workspace_service_server::{
    WorkspaceService as WorkspaceServiceRpc, WorkspaceServiceServer,
};
use protocol::{
    ArtifactRef, EnforcementReportMessage, EnforcementStatusProto, KernelHealth, KernelInfo,
    ReadFileResponse, RequestContext as ProtoContext, SourceVersion, WorkspaceEntryMessage,
};

#[derive(Clone)]
pub struct GrpcKernel {
    kernel: terminus_kernel::KernelHandle,
    control_bootstrap: ControlBootstrapConfig,
    job_stream_tasks: std::sync::Arc<tokio::sync::Mutex<tokio::task::JoinSet<()>>>,
    job_streams:
        std::sync::Arc<tokio::sync::Mutex<HashMap<String, std::sync::Arc<JobStreamBuffer>>>>,
}

const MAX_REPLAYED_JOB_EVENTS: usize = 4_096;
const MAX_REPLAYED_JOB_BYTES: usize = 8 * 1_024 * 1_024;
const DEFAULT_REPOSITORY_MAP_PAGE_SIZE: usize = 200;
const MAX_REPOSITORY_MAP_PAGE_SIZE: usize = 1_000;

#[derive(Default)]
struct JobStreamState {
    events: Vec<protocol::JobEvent>,
    bytes: usize,
    closed: bool,
    failure: Option<String>,
}

#[derive(Default)]
struct JobStreamBuffer {
    state: tokio::sync::Mutex<JobStreamState>,
    changed: tokio::sync::Notify,
}

impl GrpcKernel {
    fn new(
        kernel: terminus_kernel::KernelHandle,
        control_bootstrap: ControlBootstrapConfig,
    ) -> Self {
        Self {
            kernel,
            control_bootstrap,
            job_stream_tasks: std::sync::Arc::new(tokio::sync::Mutex::new(
                tokio::task::JoinSet::new(),
            )),
            job_streams: std::sync::Arc::new(tokio::sync::Mutex::new(HashMap::new())),
        }
    }

    async fn retain_job_stream(
        &self,
        job_id: String,
        mut receiver: tokio::sync::mpsc::Receiver<terminus_kernel_protocol::ProcessEvent>,
    ) {
        let stream = std::sync::Arc::new(JobStreamBuffer::default());
        self.job_streams
            .lock()
            .await
            .insert(job_id.clone(), std::sync::Arc::clone(&stream));
        let manager = std::sync::Arc::clone(self.kernel.jobs.manager());
        let mut tasks = self.job_stream_tasks.lock().await;
        while let Some(result) = tasks.try_join_next() {
            if let Err(error) = result {
                tracing::warn!(
                    target: "terminus_kernel_audit",
                    event = "job_stream_task_failed",
                    cancelled = error.is_cancelled(),
                    panicked = error.is_panic(),
                    "job stream retention task did not complete normally"
                );
            }
        }
        let lease_token = manager.get(&job_id).await.map(|record| record.lease_token);
        let job_streams = std::sync::Arc::clone(&self.job_streams);
        tasks.spawn(async move {
            let mut sequence = 0_u64;
            let mut saw_exit = false;
            while let Some(event) = receiver.recv().await {
                let Some(lease_token) = lease_token.as_deref() else {
                    let mut state = stream.state.lock().await;
                    state.failure = Some(
                        "job stream cannot be persisted because the durable job record is missing"
                            .to_string(),
                    );
                    state.closed = true;
                    drop(state);
                    stream.changed.notify_waiters();
                    break;
                };
                if let Err(error) = persist_job_event(&manager, &job_id, lease_token, &event).await
                {
                    let mut state = stream.state.lock().await;
                    state.failure = Some(error);
                    state.closed = true;
                    drop(state);
                    stream.changed.notify_waiters();
                    break;
                }
                sequence = sequence.saturating_add(1);
                let exited = matches!(event, terminus_kernel_protocol::ProcessEvent::Exited(_));
                let event = job_event(&job_id, sequence, event);
                let event_bytes = job_event_size(&event);
                {
                    let mut state = stream.state.lock().await;
                    if state.failure.is_none()
                        && (state.events.len() >= MAX_REPLAYED_JOB_EVENTS
                            || state.bytes.saturating_add(event_bytes) > MAX_REPLAYED_JOB_BYTES)
                    {
                        state.failure = Some(format!(
                            "job output exceeded the replay buffer ({} events or {} bytes); output was not silently truncated",
                            MAX_REPLAYED_JOB_EVENTS, MAX_REPLAYED_JOB_BYTES
                        ));
                    }
                    if state.failure.is_none() {
                        state.bytes = state.bytes.saturating_add(event_bytes);
                        state.events.push(event);
                    }
                    if exited {
                        state.closed = true;
                        saw_exit = true;
                    }
                }
                stream.changed.notify_waiters();
                if saw_exit {
                    break;
                }
            }
            if !saw_exit {
                if let Some(record) = manager.get(&job_id).await {
                    if !record.state.is_terminal() {
                        let _ = manager.mark_orphaned(&job_id).await;
                    }
                }
                let mut state = stream.state.lock().await;
                state.closed = true;
                if state.failure.is_none() {
                    state.failure = Some(
                        "job process event stream ended before an exit event; settlement is unknown"
                            .to_string(),
                    );
                }
                drop(state);
                stream.changed.notify_waiters();
            }
            remove_completed_job_stream(&job_streams, &job_id, &stream).await;
        });
    }
}

/// Release the registry's strong reference once the live receiver settles.
/// Existing stream consumers retain their own `Arc`; later consumers replay
/// the same events from the durable job record instead of retaining an 8 MiB
/// in-memory buffer for every completed job.
async fn remove_completed_job_stream(
    job_streams: &std::sync::Arc<
        tokio::sync::Mutex<HashMap<String, std::sync::Arc<JobStreamBuffer>>>,
    >,
    job_id: &str,
    completed: &std::sync::Arc<JobStreamBuffer>,
) {
    let mut streams = job_streams.lock().await;
    let is_current = streams
        .get(job_id)
        .map(|current| std::sync::Arc::ptr_eq(current, completed))
        .unwrap_or(false);
    if is_current {
        streams.remove(job_id);
    }
}

/// Persist each process event before making it visible through the replay
/// buffer. A bounded retry keeps a transient `SQLite` lock from losing output,
/// while a persistent failure is surfaced to stream consumers instead of
/// being mistaken for a clean process exit.
async fn persist_job_event(
    manager: &terminus_jobs::JobManager,
    job_id: &str,
    lease_token: &str,
    event: &terminus_kernel_protocol::ProcessEvent,
) -> Result<(), String> {
    const MAX_DATABASE_RETRIES: usize = 5;
    for attempt in 0..=MAX_DATABASE_RETRIES {
        match manager
            .record_event_with_lease(job_id, lease_token, event)
            .await
        {
            Ok(()) => return Ok(()),
            Err(terminus_jobs::JobError::Database(error)) if attempt < MAX_DATABASE_RETRIES => {
                tracing::warn!(
                    target: "terminus_kernel_audit",
                    event = "job_event_persistence_retry",
                    %job_id,
                    attempt = attempt + 1,
                    %error,
                    "retrying durable job event persistence"
                );
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
            Err(error) => {
                return Err(format!(
                    "durable job event persistence failed for {job_id}: {error}"
                ));
            }
        }
    }
    Err(format!(
        "durable job event persistence exhausted retries for {job_id}"
    ))
}

const DEFAULT_CONTROL_PRINCIPAL: &str = "terminus-control-bearer";
const DEFAULT_BOOTSTRAP_TTL_SECONDS: u64 = 900;
const MIN_BOOTSTRAP_TTL_SECONDS: u64 = 60;
const MAX_BOOTSTRAP_TTL_SECONDS: u64 = 3_600;
const MAX_BINDER_BYTES: usize = 200;
const MAX_SCOPE_ENTRIES_PER_KIND: usize = 64;
const MAX_TOTAL_SCOPE_ENTRIES: usize = 128;
const MAX_SCOPE_VALUE_BYTES: usize = 2_048;
const MAX_TOTAL_SCOPE_BYTES: usize = 64 * 1_024;
const MAX_TASK_CAPABILITY_TTL_SECONDS: u64 = 300;
const CONTROL_BOOTSTRAP_METADATA: &str = "x-terminus-control-bootstrap";

#[derive(Clone)]
struct ControlBootstrapConfig {
    enabled: bool,
    principal: String,
    ttl_seconds: u64,
    token: String,
}

impl ControlBootstrapConfig {
    fn from_uds_environment() -> Result<Self, String> {
        let enabled = match std::env::var("TERMINUS_KERNEL_CONTROL_BOOTSTRAP") {
            Ok(value) => value == "1",
            Err(std::env::VarError::NotPresent) => false,
            Err(std::env::VarError::NotUnicode(_)) => {
                return Err("TERMINUS_KERNEL_CONTROL_BOOTSTRAP must contain valid UTF-8".to_string())
            }
        };
        let principal = Self::configured_principal()?;
        if !enabled {
            return Ok(Self {
                enabled: false,
                principal,
                ttl_seconds: DEFAULT_BOOTSTRAP_TTL_SECONDS,
                token: String::new(),
            });
        }

        let token = match std::env::var("TERMINUS_KERNEL_CONTROL_BOOTSTRAP_TOKEN") {
            Ok(value) if valid_bootstrap_token(&value) => value,
            Ok(_) => {
                return Err(
                    "TERMINUS_KERNEL_CONTROL_BOOTSTRAP_TOKEN must contain 32..128 base64url characters"
                        .to_string(),
                )
            }
            Err(std::env::VarError::NotPresent) => {
                return Err(
                    "TERMINUS_KERNEL_CONTROL_BOOTSTRAP_TOKEN is required when control bootstrap is enabled"
                        .to_string(),
                )
            }
            Err(std::env::VarError::NotUnicode(_)) => {
                return Err(
                    "TERMINUS_KERNEL_CONTROL_BOOTSTRAP_TOKEN must contain valid UTF-8".to_string(),
                )
            }
        };

        let ttl_seconds = match std::env::var("TERMINUS_KERNEL_CONTROL_BOOTSTRAP_TTL_SECONDS") {
            Ok(value) => value.parse::<u64>().map_err(|_| {
                "TERMINUS_KERNEL_CONTROL_BOOTSTRAP_TTL_SECONDS must be an integer".to_string()
            })?,
            Err(std::env::VarError::NotPresent) => DEFAULT_BOOTSTRAP_TTL_SECONDS,
            Err(std::env::VarError::NotUnicode(_)) => {
                return Err(
                    "TERMINUS_KERNEL_CONTROL_BOOTSTRAP_TTL_SECONDS must contain valid UTF-8"
                        .to_string(),
                )
            }
        };
        if !(MIN_BOOTSTRAP_TTL_SECONDS..=MAX_BOOTSTRAP_TTL_SECONDS).contains(&ttl_seconds) {
            return Err(format!(
                "TERMINUS_KERNEL_CONTROL_BOOTSTRAP_TTL_SECONDS must be between {MIN_BOOTSTRAP_TTL_SECONDS} and {MAX_BOOTSTRAP_TTL_SECONDS}"
            ));
        }

        Ok(Self {
            enabled: true,
            principal,
            ttl_seconds,
            token,
        })
    }

    fn disabled_from_environment() -> Result<Self, String> {
        Ok(Self {
            enabled: false,
            principal: Self::configured_principal()?,
            ttl_seconds: DEFAULT_BOOTSTRAP_TTL_SECONDS,
            token: String::new(),
        })
    }

    fn configured_principal() -> Result<String, String> {
        let principal = match std::env::var("TERMINUS_KERNEL_CONTROL_PRINCIPAL") {
            Ok(value) => value,
            Err(std::env::VarError::NotPresent) => DEFAULT_CONTROL_PRINCIPAL.to_string(),
            Err(std::env::VarError::NotUnicode(_)) => {
                return Err("TERMINUS_KERNEL_CONTROL_PRINCIPAL must contain valid UTF-8".to_string())
            }
        };
        validate_concrete_binder("configured control principal", &principal)
            .map_err(|status| status.message().to_string())?;
        Ok(principal)
    }
}

fn valid_bootstrap_token(value: &str) -> bool {
    (32..=128).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

struct IssuedCapability {
    encoded: String,
    expires_at_unix: u64,
}

fn mint_bootstrap_capability(
    kernel: &terminus_kernel::KernelHandle,
    principal: &str,
    task_id: &str,
    ttl_seconds: u64,
) -> Result<IssuedCapability, Status> {
    let token = kernel
        .token_issuer
        .mint(
            terminus_authz::TokenBinder {
                principal: principal.to_string(),
                session_id: "control".to_string(),
                task_id: task_id.to_string(),
                workspace_id: "*".to_string(),
                kernel_instance_id: String::new(),
            },
            vec![terminus_authz::OperationClass::Admin],
            terminus_authz::Scope::default(),
            Some(ttl_seconds),
            format!(
                "control-bootstrap-{task_id}-{}",
                terminus_kernel_protocol::new_id()
            ),
        )
        .map_err(|_| Status::internal("control bootstrap capability issuance failed"))?;
    let expires_at_unix = token.claims.expires_at_unix;
    let encoded = token
        .encode()
        .map_err(|_| Status::internal("control bootstrap capability encoding failed"))?;
    Ok(IssuedCapability {
        encoded,
        expires_at_unix,
    })
}

fn validate_broker_capability(
    context: &terminus_kernel_protocol::RequestContext,
    claims: &terminus_authz::TokenClaims,
    configured_principal: &str,
) -> Result<(), Status> {
    let binder = &claims.binder;
    let is_broker = binder.principal == configured_principal
        && binder.session_id == "control"
        && binder.task_id == "control-broker"
        && binder.workspace_id == "*"
        && context.actor_id == configured_principal
        && context.session_id == "control"
        && context.task_id == "control-broker"
        && context.workspace_id == "*"
        && claims.operation_classes.as_slice() == [terminus_authz::OperationClass::Admin];
    if !is_broker {
        tracing::warn!(
            target: "terminus_kernel_audit",
            security_event = "task_capability_mint_denied",
            reason = "not_control_broker",
            "denied task capability mint"
        );
        return Err(Status::permission_denied(
            "task capabilities require the control broker capability",
        ));
    }
    Ok(())
}

fn audit_task_capability_denial(reason: &'static str, error: Status) -> Status {
    tracing::warn!(
        target: "terminus_kernel_audit",
        security_event = "task_capability_mint_denied",
        reason,
        grpc_code = ?error.code(),
        "denied task capability mint"
    );
    error
}

fn validate_task_capability_request(
    request: &protocol::MintTaskCapabilityRequest,
    configured_principal: &str,
) -> Result<(), Status> {
    if request.principal != configured_principal {
        return Err(Status::permission_denied(
            "task capability principal must equal the configured control principal",
        ));
    }
    validate_concrete_binder("principal", &request.principal)?;
    validate_concrete_binder("session_id", &request.session_id)?;
    validate_concrete_binder("task_id", &request.task_id)?;
    validate_concrete_binder("workspace_id", &request.workspace_id)?;
    if matches!(
        request.task_id.as_str(),
        "control-broker" | "control-maintenance"
    ) {
        return Err(Status::invalid_argument(
            "task_id uses a reserved control capability binder",
        ));
    }
    if !(1..=MAX_TASK_CAPABILITY_TTL_SECONDS).contains(&request.ttl_seconds) {
        return Err(Status::invalid_argument(format!(
            "ttl_seconds must be between 1 and {MAX_TASK_CAPABILITY_TTL_SECONDS}"
        )));
    }
    Ok(())
}

fn validate_concrete_binder(label: &str, value: &str) -> Result<(), Status> {
    if value.is_empty() {
        return Err(Status::invalid_argument(format!(
            "{label} must not be empty"
        )));
    }
    if value.len() > MAX_BINDER_BYTES {
        return Err(Status::invalid_argument(format!(
            "{label} exceeds {MAX_BINDER_BYTES} bytes"
        )));
    }
    if value.trim() != value {
        return Err(Status::invalid_argument(format!(
            "{label} must not contain leading or trailing whitespace"
        )));
    }
    if value.contains('*') {
        return Err(Status::invalid_argument(format!(
            "{label} must be a concrete non-wildcard value"
        )));
    }
    if value.chars().any(char::is_control) {
        return Err(Status::invalid_argument(format!(
            "{label} must not contain control characters"
        )));
    }
    Ok(())
}

fn decode_task_operation_classes(
    raw_operations: &[i32],
) -> Result<Vec<terminus_authz::OperationClass>, Status> {
    if raw_operations.is_empty() {
        return Err(Status::invalid_argument(
            "at least one operation class is required",
        ));
    }
    if raw_operations.len() > 12 {
        return Err(Status::invalid_argument(
            "too many operation classes requested",
        ));
    }

    let mut operations = Vec::with_capacity(raw_operations.len());
    for raw in raw_operations {
        let proto = protocol::CapabilityOperationProto::try_from(*raw)
            .map_err(|_| Status::invalid_argument("unknown operation class"))?;
        let operation = match proto {
            protocol::CapabilityOperationProto::CapabilityOperationUnspecified => {
                return Err(Status::invalid_argument(
                    "operation class must not be unspecified",
                ))
            }
            protocol::CapabilityOperationProto::CapabilityOperationRead => {
                terminus_authz::OperationClass::Read
            }
            protocol::CapabilityOperationProto::CapabilityOperationPatch => {
                terminus_authz::OperationClass::Patch
            }
            protocol::CapabilityOperationProto::CapabilityOperationExec => {
                terminus_authz::OperationClass::Exec
            }
            protocol::CapabilityOperationProto::CapabilityOperationJob => {
                terminus_authz::OperationClass::Job
            }
            protocol::CapabilityOperationProto::CapabilityOperationSandbox => {
                terminus_authz::OperationClass::Sandbox
            }
            protocol::CapabilityOperationProto::CapabilityOperationSecret => {
                terminus_authz::OperationClass::Secret
            }
            protocol::CapabilityOperationProto::CapabilityOperationNetwork => {
                terminus_authz::OperationClass::Network
            }
            protocol::CapabilityOperationProto::CapabilityOperationCodeIntel => {
                terminus_authz::OperationClass::CodeIntel
            }
            protocol::CapabilityOperationProto::CapabilityOperationExtension => {
                terminus_authz::OperationClass::Extension
            }
            protocol::CapabilityOperationProto::CapabilityOperationGit => {
                terminus_authz::OperationClass::Git
            }
            protocol::CapabilityOperationProto::CapabilityOperationArtifactIngest => {
                terminus_authz::OperationClass::ArtifactIngest
            }
            protocol::CapabilityOperationProto::CapabilityOperationComputerUse => {
                terminus_authz::OperationClass::ComputerUse
            }
        };
        if operations.contains(&operation) {
            return Err(Status::invalid_argument(
                "operation classes must not contain duplicates",
            ));
        }
        operations.push(operation);
    }
    validate_task_operation_classes(&operations)?;
    Ok(operations)
}

fn validate_task_operation_classes(
    operations: &[terminus_authz::OperationClass],
) -> Result<(), Status> {
    if operations.is_empty() {
        return Err(Status::invalid_argument(
            "at least one operation class is required",
        ));
    }
    if operations.iter().any(|operation| {
        matches!(
            operation,
            terminus_authz::OperationClass::Admin | terminus_authz::OperationClass::Policy
        )
    }) {
        return Err(Status::permission_denied(
            "Admin and Policy operation classes cannot be delegated",
        ));
    }
    Ok(())
}

fn validate_task_scope(
    workspace_paths: Vec<String>,
    network_destinations: Vec<String>,
    secret_capabilities: Vec<String>,
) -> Result<terminus_authz::Scope, Status> {
    for (label, values) in [
        ("workspace_paths", workspace_paths.as_slice()),
        ("network_destinations", network_destinations.as_slice()),
        ("secret_capabilities", secret_capabilities.as_slice()),
    ] {
        if values.len() > MAX_SCOPE_ENTRIES_PER_KIND {
            return Err(Status::invalid_argument(format!(
                "{label} exceeds {MAX_SCOPE_ENTRIES_PER_KIND} entries"
            )));
        }
        for value in values {
            if value.is_empty() {
                return Err(Status::invalid_argument(format!(
                    "{label} entries must not be empty"
                )));
            }
            if value.len() > MAX_SCOPE_VALUE_BYTES {
                return Err(Status::invalid_argument(format!(
                    "{label} entry exceeds {MAX_SCOPE_VALUE_BYTES} bytes"
                )));
            }
            if value.chars().any(char::is_control) {
                return Err(Status::invalid_argument(format!(
                    "{label} entries must not contain control characters"
                )));
            }
        }
    }
    let total_entries =
        workspace_paths.len() + network_destinations.len() + secret_capabilities.len();
    if total_entries > MAX_TOTAL_SCOPE_ENTRIES {
        return Err(Status::invalid_argument(format!(
            "capability scope exceeds {MAX_TOTAL_SCOPE_ENTRIES} total entries"
        )));
    }
    let total_bytes = workspace_paths
        .iter()
        .chain(&network_destinations)
        .chain(&secret_capabilities)
        .map(String::len)
        .sum::<usize>();
    if total_bytes > MAX_TOTAL_SCOPE_BYTES {
        return Err(Status::invalid_argument(format!(
            "capability scope exceeds {MAX_TOTAL_SCOPE_BYTES} total bytes"
        )));
    }
    Ok(terminus_authz::Scope::deny_unspecified(
        workspace_paths,
        network_destinations,
        secret_capabilities,
    ))
}

#[tonic::async_trait]
impl KernelInfoServiceRpc for GrpcKernel {
    async fn get_info(&self, _request: Request<()>) -> Result<Response<KernelInfo>, Status> {
        let value = self.kernel.info.info();
        let supported_backends = strings(&value, "supported_backends");
        let supported_services = strings(&value, "services");
        Ok(Response::new(KernelInfo {
            version: string(&value, "version", ""),
            protocol_version: "terminus.kernel.v1".to_string(),
            // Read straight off the service rather than round-tripping
            // through the JSON with a `"dev"` default: the placeholder that
            // used to identify every build can no longer be reached.
            build_revision: self.kernel.info.build_revision().to_string(),
            supported_backends,
            supported_services,
            instance_id: self.kernel.info.instance_id().to_string(),
        }))
    }

    async fn health(&self, _request: Request<()>) -> Result<Response<KernelHealth>, Status> {
        let value = self.kernel.info.health();
        Ok(Response::new(KernelHealth {
            state: string(&value, "status", "ok"),
            degradations: Vec::new(),
            checked_at: Some(prost_types::Timestamp::from(std::time::SystemTime::now())),
        }))
    }

    async fn bootstrap_control(
        &self,
        request: Request<protocol::BootstrapControlRequest>,
    ) -> Result<Response<protocol::BootstrapControlCapabilities>, Status> {
        if !self.control_bootstrap.enabled {
            tracing::warn!(
                target: "terminus_kernel_audit",
                security_event = "control_capability_bootstrap_denied",
                reason = "disabled_or_non_uds_transport",
                "denied control capability bootstrap"
            );
            return Err(Status::permission_denied("control bootstrap is disabled"));
        }

        let presented_token = request
            .metadata()
            .get(CONTROL_BOOTSTRAP_METADATA)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default();
        if !constant_time_eq(presented_token, &self.control_bootstrap.token) {
            tracing::warn!(
                target: "terminus_kernel_audit",
                security_event = "control_capability_bootstrap_denied",
                reason = "invalid_bootstrap_credential",
                "denied control capability bootstrap"
            );
            return Err(Status::permission_denied(
                "control bootstrap credential is not authorized",
            ));
        }

        let request = request.into_inner();
        if request.principal != self.control_bootstrap.principal {
            tracing::warn!(
                target: "terminus_kernel_audit",
                security_event = "control_capability_bootstrap_denied",
                reason = "principal_mismatch",
                "denied control capability bootstrap"
            );
            return Err(Status::permission_denied(
                "control bootstrap principal is not authorized",
            ));
        }

        let broker = mint_bootstrap_capability(
            &self.kernel,
            &self.control_bootstrap.principal,
            "control-broker",
            self.control_bootstrap.ttl_seconds,
        )?;
        let maintenance = mint_bootstrap_capability(
            &self.kernel,
            &self.control_bootstrap.principal,
            "control-maintenance",
            self.control_bootstrap.ttl_seconds,
        )?;
        let expires_at_unix = broker.expires_at_unix.min(maintenance.expires_at_unix);
        tracing::info!(
            target: "terminus_kernel_audit",
            security_event = "control_capability_bootstrap",
            principal = %self.control_bootstrap.principal,
            broker_task = "control-broker",
            maintenance_task = "control-maintenance",
            expires_at_unix,
            "issued bounded control capabilities"
        );
        Ok(Response::new(protocol::BootstrapControlCapabilities {
            broker_capability_token: broker.encoded,
            maintenance_capability_token: maintenance.encoded,
            expires_at_unix,
        }))
    }
}

#[tonic::async_trait]
impl WorkspaceServiceRpc for GrpcKernel {
    async fn resolve_root(
        &self,
        request: Request<protocol::ResolveWorkspaceRootRequest>,
    ) -> Result<Response<protocol::ResolvedWorkspaceRootMessage>, Status> {
        let request = request.into_inner();
        let ctx = authorize_context(
            &self.kernel,
            request
                .context
                .ok_or_else(|| Status::invalid_argument("context is required"))?,
            terminus_authz::OperationClass::Admin,
        )?;
        let resolved = self
            .kernel
            .workspaces
            .resolve_root(&ctx, request.root_uri, request.candidate_root)
            .map_err(status)?;
        Ok(Response::new(protocol::ResolvedWorkspaceRootMessage {
            root_uri: resolved.root_uri,
            canonical_root: resolved.canonical_root,
        }))
    }

    async fn register(
        &self,
        request: Request<protocol::RegisterWorkspaceRequest>,
    ) -> Result<Response<WorkspaceEntryMessage>, Status> {
        let request = request.into_inner();
        let ctx = authorize_context(
            &self.kernel,
            request
                .context
                .ok_or_else(|| Status::invalid_argument("context is required"))?,
            terminus_authz::OperationClass::Admin,
        )?;
        let id = self
            .kernel
            .workspaces
            .register_with_id(
                &ctx,
                &Default::default(),
                request.root_uri.clone(),
                request.canonical_root.clone(),
                &request.trust,
                (!request.requested_workspace_id.is_empty())
                    .then_some(request.requested_workspace_id.as_str()),
            )
            .map_err(status)?;
        let entry = self
            .kernel
            .workspaces
            .get_for_admin(&ctx, &id)
            .map_err(status)?;
        Ok(Response::new(WorkspaceEntryMessage {
            id: entry.id,
            root_uri: entry.root_uri,
            canonical_root: entry.canonical_root,
            trust: entry.trust,
        }))
    }

    async fn get(
        &self,
        request: Request<protocol::GetWorkspaceRequest>,
    ) -> Result<Response<WorkspaceEntryMessage>, Status> {
        let request = request.into_inner();
        let mut ctx = context(
            request
                .context
                .ok_or_else(|| Status::invalid_argument("context is required"))?,
        );
        ctx.workspace_id = request.workspace_id.clone();
        terminus_kernel::validate_request_pipeline(
            &self.kernel.token_issuer,
            &ctx,
            terminus_authz::OperationClass::Read,
            &terminus_authz::Scope::default(),
            false,
        )
        .map_err(status)?;
        let entry = self
            .kernel
            .workspaces
            .get(&ctx, &request.workspace_id)
            .map_err(status)?;
        Ok(Response::new(WorkspaceEntryMessage {
            id: entry.id,
            root_uri: entry.root_uri,
            canonical_root: entry.canonical_root,
            trust: entry.trust,
        }))
    }
}

#[tonic::async_trait]
impl FileServiceRpc for GrpcKernel {
    async fn read(
        &self,
        request: Request<protocol::ReadFileRequest>,
    ) -> Result<Response<ReadFileResponse>, Status> {
        let request = request.into_inner();
        let ctx = request
            .context
            .map(context)
            .ok_or_else(|| Status::invalid_argument("context is required"))?;
        let intent = request.intent.map(intent).unwrap_or_default();
        let path = request
            .path
            .map(path)
            .ok_or_else(|| Status::invalid_argument("path is required"))?;
        let (bytes, artifact) = self
            .kernel
            .files
            .read(&ctx, &intent, &path)
            .map_err(status)?;
        let projection = if request.max_bytes == 0 {
            bytes.clone()
        } else {
            bytes
                .iter()
                .copied()
                .take(request.max_bytes as usize)
                .collect()
        };
        let truncated = projection.len() < bytes.len();
        if !request.expected_sha256.is_empty() && request.expected_sha256 != artifact.sha256 {
            return Err(Status::failed_precondition(
                "expected_sha256 does not match source",
            ));
        }
        Ok(Response::new(ReadFileResponse {
            source_version: Some(SourceVersion {
                path: Some(protocol::WorkspacePath {
                    workspace_id: path.workspace_id,
                    relative_path: path.relative_path,
                }),
                sha256: artifact.sha256.clone(),
                repository_revision: "no-vcs".to_string(),
            }),
            rendered_mode: if request.mode.is_empty() {
                "full".to_string()
            } else {
                request.mode
            },
            full_content: Some(artifact_ref(artifact)),
            model_projection_utf8: projection,
            elisions: Vec::new(),
            diagnostics: Vec::new(),
            truncated,
            continuation_token: if truncated {
                "artifact:full".to_string()
            } else {
                String::new()
            },
        }))
    }
}

#[tonic::async_trait]
impl SandboxServiceRpc for GrpcKernel {
    async fn report(
        &self,
        request: Request<protocol::SandboxReportRequest>,
    ) -> Result<Response<EnforcementReportMessage>, Status> {
        let request = request.into_inner();
        authorize_context(
            &self.kernel,
            request
                .context
                .ok_or_else(|| Status::invalid_argument("context is required"))?,
            terminus_authz::OperationClass::Sandbox,
        )?;
        let report = self.kernel.sandboxes.enforcement_report();
        Ok(Response::new(EnforcementReportMessage {
            backend_id: report.backend_id,
            status: match report.status {
                terminus_sandbox::EnforcementStatus::Enforced => {
                    EnforcementStatusProto::EnforcedStatus as i32
                }
                terminus_sandbox::EnforcementStatus::Degraded => {
                    EnforcementStatusProto::DegradedStatus as i32
                }
                terminus_sandbox::EnforcementStatus::Unsupported => {
                    EnforcementStatusProto::UnsupportedStatus as i32
                }
            },
            enforced: report
                .enforced
                .into_iter()
                .map(|v| format!("{v:?}"))
                .collect(),
            degraded: report
                .degraded
                .into_iter()
                .map(|v| format!("{v:?}"))
                .collect(),
            unsupported: report
                .unsupported
                .into_iter()
                .map(|v| format!("{v:?}"))
                .collect(),
            notes: report.notes,
        }))
    }
}

#[tonic::async_trait]
impl ArtifactIngestRpc for GrpcKernel {
    async fn ingest(
        &self,
        request: Request<protocol::IngestArtifactRequest>,
    ) -> Result<Response<protocol::IngestArtifactResponse>, Status> {
        let request = request.into_inner();
        let ctx = request
            .context
            .map(context_long_running)
            .ok_or_else(|| Status::invalid_argument("context is required"))?;
        let request_id = ctx.request_id.clone();
        let artifact = self
            .kernel
            .artifact_ingest
            .ingest(&ctx, &Default::default(), &request.content)
            .map_err(|error| log_kernel_rpc_error("artifact.ingest", &request_id, error))?;
        Ok(Response::new(protocol::IngestArtifactResponse {
            artifact: Some(artifact_ref(artifact)),
            already_present: false,
        }))
    }

    async fn get(
        &self,
        request: Request<protocol::GetArtifactRequest>,
    ) -> Result<Response<protocol::GetArtifactResponse>, Status> {
        let request = request.into_inner();
        let ctx = request
            .context
            .map(context_long_running)
            .ok_or_else(|| Status::invalid_argument("context is required"))?;
        if request.sha256.is_empty() {
            return Err(Status::invalid_argument("sha256 is required"));
        }
        let content = self
            .kernel
            .artifact_ingest
            .get(&ctx, &request.sha256)
            .map_err(status)?;
        let artifact = self
            .kernel
            .artifact_ingest
            .metadata(&ctx, &request.sha256)
            .map_err(status)?;
        Ok(Response::new(protocol::GetArtifactResponse {
            artifact: Some(artifact_ref(artifact)),
            content,
        }))
    }

    async fn get_metadata(
        &self,
        request: Request<protocol::GetArtifactMetadataRequest>,
    ) -> Result<Response<protocol::GetArtifactMetadataResponse>, Status> {
        let request = request.into_inner();
        let ctx = request
            .context
            .map(context_long_running)
            .ok_or_else(|| Status::invalid_argument("context is required"))?;
        if request.sha256.is_empty() {
            return Err(Status::invalid_argument("sha256 is required"));
        }
        let artifact = self
            .kernel
            .artifact_ingest
            .metadata(&ctx, &request.sha256)
            .map_err(status)?;
        Ok(Response::new(protocol::GetArtifactMetadataResponse {
            artifact: Some(artifact_ref(artifact)),
        }))
    }

    async fn link(
        &self,
        request: Request<protocol::LinkArtifactRequest>,
    ) -> Result<Response<protocol::LinkArtifactResponse>, Status> {
        let request = request.into_inner();
        let ctx = request
            .context
            .map(context_long_running)
            .ok_or_else(|| Status::invalid_argument("context is required"))?;
        self.kernel
            .artifact_ingest
            .link(
                &ctx,
                &Default::default(),
                &request.sha256,
                &request.owner_type,
                &request.owner_id,
                &request.purpose,
                &request.owner_task_id,
            )
            .map_err(status)?;
        Ok(Response::new(protocol::LinkArtifactResponse {
            linked: true,
        }))
    }

    async fn list_checkpoint_links(
        &self,
        request: Request<protocol::ListCheckpointArtifactLinksRequest>,
    ) -> Result<Response<protocol::ListCheckpointArtifactLinksResponse>, Status> {
        let request = request.into_inner();
        let ctx = request
            .context
            .map(context_long_running)
            .ok_or_else(|| Status::invalid_argument("context is required"))?;
        let page_size = if request.page_size == 0 {
            100_usize
        } else {
            request.page_size as usize
        };
        if page_size > 999 {
            return Err(Status::invalid_argument("page_size must be at most 999"));
        }
        let mut links = self
            .kernel
            .artifact_ingest
            .list_checkpoint_links(&ctx, &request.continuation_token, page_size + 1)
            .map_err(status)?;
        let has_more = links.len() > page_size;
        if has_more {
            links.pop();
        }
        let continuation_token = if has_more {
            links.last().map(|link| link.id.clone()).unwrap_or_default()
        } else {
            String::new()
        };
        Ok(Response::new(
            protocol::ListCheckpointArtifactLinksResponse {
                links: links
                    .into_iter()
                    .map(|link| protocol::CheckpointArtifactLinkMessage {
                        link_id: link.id,
                        sha256: link.artifact_hash,
                        checkpoint_id: link.owner_id,
                        owner_task_id: link.owner_task_id,
                        created_at: link.created_at,
                    })
                    .collect(),
                continuation_token,
            },
        ))
    }

    async fn unlink_checkpoint(
        &self,
        request: Request<protocol::UnlinkCheckpointArtifactRequest>,
    ) -> Result<Response<protocol::UnlinkCheckpointArtifactResponse>, Status> {
        let request = request.into_inner();
        let ctx = request
            .context
            .map(context_long_running)
            .ok_or_else(|| Status::invalid_argument("context is required"))?;
        let unlinked = self
            .kernel
            .artifact_ingest
            .unlink_checkpoint(
                &ctx,
                &request.sha256,
                &request.checkpoint_id,
                &request.owner_task_id,
            )
            .map_err(status)?;
        Ok(Response::new(protocol::UnlinkCheckpointArtifactResponse {
            unlinked,
        }))
    }
}

#[tonic::async_trait]
impl ExtensionRuntimeRpc for GrpcKernel {
    async fn invoke(
        &self,
        request: Request<protocol::ExtensionInvokeRequest>,
    ) -> Result<Response<protocol::ExtensionInvokeResponse>, Status> {
        let request = request.into_inner();
        let ctx = request
            .context
            .map(context_long_running)
            .ok_or_else(|| Status::invalid_argument("context is required"))?;
        let report = self
            .kernel
            .extensions
            .invoke_report(
                &ctx,
                &request.capability_id,
                &request.operation,
                request.input.len(),
            )
            .map_err(status)?;
        Ok(Response::new(protocol::ExtensionInvokeResponse {
            output: Vec::new(),
            ok: false,
            error: if report.available {
                "extension runtime returned no executable result".to_string()
            } else {
                report.reason
            },
        }))
    }
}

#[tonic::async_trait]
impl ComputerUseRpc for GrpcKernel {
    async fn observe(
        &self,
        request: Request<protocol::ComputerObserveRequest>,
    ) -> Result<Response<protocol::ComputerObserveResponse>, Status> {
        let request = request.into_inner();
        let context = request
            .context
            .map(context)
            .ok_or_else(|| Status::invalid_argument("context is required"))?;
        terminus_kernel::validate_capability_for_op(
            &self.kernel.token_issuer,
            &context,
            terminus_authz::OperationClass::ComputerUse,
            &terminus_authz::Scope::default(),
        )
        .map_err(status)?;
        terminus_kernel::computer_use::validate_observe_request(
            &request.browser_session_id,
            request.viewport_width,
            request.viewport_height,
            request.max_screenshot_bytes,
        )
        .map_err(|error| Status::invalid_argument(error.to_string()))?;
        Err(Status::unavailable(
            "no authenticated isolated-browser adapter is configured; no browser effect was attempted",
        ))
    }

    async fn act(
        &self,
        request: Request<protocol::ComputerActRequest>,
    ) -> Result<Response<protocol::ComputerActResponse>, Status> {
        let request = request.into_inner();
        let context = request
            .context
            .map(context)
            .ok_or_else(|| Status::invalid_argument("context is required"))?;
        terminus_kernel::validate_capability_for_op(
            &self.kernel.token_issuer,
            &context,
            terminus_authz::OperationClass::ComputerUse,
            &terminus_authz::Scope::default(),
        )
        .map_err(status)?;
        let action = match protocol::ComputerActionKind::try_from(request.action) {
            Ok(protocol::ComputerActionKind::ComputerActionNavigate) => {
                terminus_kernel::computer_use::BrowserActionKind::Navigate
            }
            Ok(protocol::ComputerActionKind::ComputerActionClick) => {
                terminus_kernel::computer_use::BrowserActionKind::Click
            }
            Ok(protocol::ComputerActionKind::ComputerActionTypeText) => {
                terminus_kernel::computer_use::BrowserActionKind::TypeText
            }
            Ok(protocol::ComputerActionKind::ComputerActionScroll) => {
                terminus_kernel::computer_use::BrowserActionKind::Scroll
            }
            Ok(protocol::ComputerActionKind::ComputerActionWait) => {
                terminus_kernel::computer_use::BrowserActionKind::Wait
            }
            Ok(protocol::ComputerActionKind::ComputerActionUnspecified) | Err(_) => {
                return Err(Status::invalid_argument(
                    "action is not in the governed browser allowlist",
                ));
            }
        };
        terminus_kernel::computer_use::validate_action_request(
            &request.browser_session_id,
            &request.observation_id,
            request.observation_version,
            action,
            &request.target_id,
            &request.navigation_url,
            &request.text,
            request.scroll_x,
            request.scroll_y,
            request.wait_ms,
        )
        .map_err(|error| Status::invalid_argument(error.to_string()))?;
        Err(Status::unavailable(
            "no authenticated isolated-browser adapter is configured; no browser effect was attempted",
        ))
    }
}

#[tonic::async_trait]
impl PolicyServiceRpc for GrpcKernel {
    async fn evaluate(
        &self,
        request: Request<protocol::EvaluatePolicyRequest>,
    ) -> Result<Response<protocol::DecisionReportMessage>, Status> {
        let request = request.into_inner();
        let ctx = request
            .context
            .map(context)
            .ok_or_else(|| Status::invalid_argument("context is required"))?;
        terminus_kernel::validate_capability_for_op(
            &self.kernel.token_issuer,
            &ctx,
            terminus_authz::OperationClass::Policy,
            &terminus_authz::Scope::default(),
        )
        .map_err(status)?;
        let command = request
            .command
            .ok_or_else(|| Status::invalid_argument("command is required"))?;
        let mut normalized = terminus_policy::NormalizedCommand::new(command.resolved_executable);
        normalized.argv = command.argv;
        normalized.working_directory = command.working_directory;
        let report = self
            .kernel
            .policies
            .evaluate(&ctx, &Default::default(), &normalized);
        let decision = match report.decision {
            terminus_policy::Decision::Allow => protocol::DecisionProto::DecisionAllow,
            terminus_policy::Decision::AllowWithConstraints => {
                protocol::DecisionProto::DecisionAllowWithConstraints
            }
            terminus_policy::Decision::Prompt => protocol::DecisionProto::DecisionPrompt,
            terminus_policy::Decision::Deny => protocol::DecisionProto::DecisionDeny,
        };
        Ok(Response::new(protocol::DecisionReportMessage {
            decision: decision as i32,
            rule_ids: report.rule_ids,
            explanation: report.explanation,
            decision_id: report.decision_id,
            constraints: Some(protocol::ConstraintMessage {
                max_runtime_ms: report.constraints.max_runtime_ms,
                max_output_bytes: report.constraints.max_output_bytes,
                disallowed_env: report.constraints.disallowed_env,
            }),
        }))
    }

    async fn mint_task_capability(
        &self,
        request: Request<protocol::MintTaskCapabilityRequest>,
    ) -> Result<Response<protocol::MintTaskCapabilityResponse>, Status> {
        let request = request.into_inner();
        let broker_context = request
            .context
            .clone()
            .map(context)
            .ok_or_else(|| Status::invalid_argument("context is required"))?;
        let broker = terminus_kernel::validate_request_pipeline(
            &self.kernel.token_issuer,
            &broker_context,
            terminus_authz::OperationClass::Admin,
            &terminus_authz::Scope::default(),
            false,
        )
        .map_err(status)
        .map_err(|error| audit_task_capability_denial("broker_authorization", error))?;
        validate_broker_capability(
            &broker_context,
            &broker.claims,
            &self.control_bootstrap.principal,
        )?;
        validate_task_capability_request(&request, &self.control_bootstrap.principal)
            .map_err(|error| audit_task_capability_denial("invalid_binder_or_ttl", error))?;
        let operation_classes = decode_task_operation_classes(&request.operation_classes)
            .map_err(|error| audit_task_capability_denial("invalid_operations", error))?;
        let scope = validate_task_scope(
            request.workspace_paths,
            request.network_destinations,
            request.secret_capabilities,
        )
        .map_err(|error| audit_task_capability_denial("invalid_scope", error))?;

        let token = self
            .kernel
            .token_issuer
            .mint(
                terminus_authz::TokenBinder {
                    principal: request.principal.clone(),
                    session_id: request.session_id.clone(),
                    task_id: request.task_id.clone(),
                    workspace_id: request.workspace_id.clone(),
                    kernel_instance_id: String::new(),
                },
                operation_classes.clone(),
                scope,
                Some(request.ttl_seconds),
                format!(
                    "task-capability-{}-{}",
                    request.task_id,
                    terminus_kernel_protocol::new_id()
                ),
            )
            .map_err(|_| Status::internal("task capability issuance failed"))?;
        let expires_at_unix = token.claims.expires_at_unix;
        let capability_token = token
            .encode()
            .map_err(|_| Status::internal("task capability encoding failed"))?;
        let operation_names = operation_classes
            .iter()
            .map(|operation| operation.as_str())
            .collect::<Vec<_>>();
        tracing::info!(
            target: "terminus_kernel_audit",
            security_event = "task_capability_minted",
            principal = %request.principal,
            session_id = %request.session_id,
            task_id = %request.task_id,
            workspace_id = %request.workspace_id,
            operations = ?operation_names,
            expires_at_unix,
            "issued task-scoped capability"
        );
        Ok(Response::new(protocol::MintTaskCapabilityResponse {
            capability_token,
            expires_at_unix,
        }))
    }
}

#[tonic::async_trait]
impl NetworkServiceRpc for GrpcKernel {
    async fn decide(
        &self,
        request: Request<protocol::EgressRequest>,
    ) -> Result<Response<protocol::EgressDecisionMessage>, Status> {
        let request = request.into_inner();
        let ctx = request
            .context
            .map(context)
            .ok_or_else(|| Status::invalid_argument("context is required"))?;
        let (host, port) = request
            .destination
            .rsplit_once(':')
            .ok_or_else(|| Status::invalid_argument("destination must be host:port"))?;
        let port = port
            .parse::<u16>()
            .map_err(|_| Status::invalid_argument("destination port is invalid"))?;
        let scheme = if request.method.is_empty() {
            "https"
        } else {
            request.method.as_str()
        };
        let resolved_ips = match tokio::net::lookup_host((host, port)).await {
            Ok(addresses) => addresses.map(|address| address.ip()).collect::<Vec<_>>(),
            Err(error) => {
                return Ok(Response::new(protocol::EgressDecisionMessage {
                    allowed: false,
                    reason: format!("DNS resolution failed for {host}:{port}: {error}"),
                }));
            }
        };
        match self.kernel.network.authorize(
            &ctx,
            &Default::default(),
            host,
            port,
            scheme,
            &resolved_ips,
        ) {
            Ok(()) => Ok(Response::new(protocol::EgressDecisionMessage {
                allowed: true,
                reason: "allowlisted by kernel egress policy".to_string(),
            })),
            Err(error) => Ok(Response::new(protocol::EgressDecisionMessage {
                allowed: false,
                reason: error.to_string(),
            })),
        }
    }
}

#[tonic::async_trait]
impl SecretServiceRpc for GrpcKernel {
    async fn mint(
        &self,
        request: Request<protocol::MintSecretRequest>,
    ) -> Result<Response<protocol::SecretCapabilityMessage>, Status> {
        let request = request.into_inner();
        let ctx = request
            .context
            .map(context)
            .ok_or_else(|| Status::invalid_argument("context is required"))?;
        if request.capability_uri.is_empty() {
            return Err(Status::invalid_argument("capability_uri is required"));
        }
        let metadata = self
            .kernel
            .secrets
            .request_metadata_async(&ctx, &request.capability_uri, &ctx.actor_id)
            .await
            .map_err(status)?;
        let requested_expiry = if request.ttl_seconds == 0 {
            metadata.expires_at_unix
        } else {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|_| Status::internal("system clock before unix epoch"))?
                .as_secs();
            metadata
                .expires_at_unix
                .min(now.saturating_add(request.ttl_seconds))
        };
        Ok(Response::new(protocol::SecretCapabilityMessage {
            capability_uri: metadata.uri,
            handle: format!("secret-handle:{}", terminus_kernel_protocol::new_id()),
            expires_at_unix: requested_expiry,
        }))
    }

    async fn store(
        &self,
        request: Request<protocol::StoreSecretRequest>,
    ) -> Result<Response<protocol::SecretMutationResponse>, Status> {
        let request = request.into_inner();
        let ctx = request
            .context
            .map(context)
            .ok_or_else(|| Status::invalid_argument("context is required"))?;
        if request.capability_uri.is_empty() {
            return Err(Status::invalid_argument("capability_uri is required"));
        }
        if request.value.is_empty() || request.value.len() > 16 * 1_024 {
            return Err(Status::invalid_argument(
                "secret value must contain 1..=16384 bytes",
            ));
        }
        self.kernel
            .secrets
            .store(&ctx, &request.capability_uri, &request.value)
            .map_err(status)?;
        Ok(Response::new(protocol::SecretMutationResponse {
            capability_uri: request.capability_uri,
            stored: true,
        }))
    }

    async fn delete(
        &self,
        request: Request<protocol::DeleteSecretRequest>,
    ) -> Result<Response<protocol::SecretMutationResponse>, Status> {
        let request = request.into_inner();
        let ctx = request
            .context
            .map(context)
            .ok_or_else(|| Status::invalid_argument("context is required"))?;
        if request.capability_uri.is_empty() {
            return Err(Status::invalid_argument("capability_uri is required"));
        }
        self.kernel
            .secrets
            .delete(&ctx, &request.capability_uri)
            .map_err(status)?;
        Ok(Response::new(protocol::SecretMutationResponse {
            capability_uri: request.capability_uri,
            stored: false,
        }))
    }
}

/// Wire form of a discovered credential. Identity and a non-reversible
/// fingerprint only: secret bytes never cross this boundary.
fn local_provider_credential(
    credential: terminus_kernel::LocalProviderCredential,
) -> protocol::LocalProviderCredentialMessage {
    protocol::LocalProviderCredentialMessage {
        source: credential.source,
        auth_kind: credential.auth_kind.as_str().to_string(),
        fingerprint: credential.fingerprint,
        metadata_json: credential.metadata.to_json(),
        expires_at_unix: credential.expires_at_unix,
        store: credential.store.as_str().to_string(),
    }
}

#[tonic::async_trait]
impl ProviderAccountServiceRpc for GrpcKernel {
    /// Read the local credential stores. Requires a `Secret`-class capability
    /// scoped to `secret://provider-account/discover`; a capability failure is
    /// `PERMISSION_DENIED`, a missing context is `INVALID_ARGUMENT`.
    async fn discover_local(
        &self,
        request: Request<protocol::DiscoverLocalProviderCredentialsRequest>,
    ) -> Result<Response<protocol::DiscoverLocalProviderCredentialsResponse>, Status> {
        let request = request.into_inner();
        let ctx = request
            .context
            .map(context)
            .ok_or_else(|| Status::invalid_argument("context is required"))?;
        let discovery = self
            .kernel
            .provider_accounts
            .discover_local(&ctx)
            .map_err(status)?;
        Ok(Response::new(
            protocol::DiscoverLocalProviderCredentialsResponse {
                credentials: discovery
                    .credentials
                    .into_iter()
                    .map(local_provider_credential)
                    .collect(),
                warnings: discovery.warnings,
                codex_installed: discovery.codex_installed,
                opencode_installed: discovery.opencode_installed,
                opencode_store_status: discovery.opencode_store_status.as_str().to_string(),
            },
        ))
    }

    /// Move one discovered credential into the OS keyring. Requires a
    /// `Secret`-class capability scoped to exactly `capability_uri` plus an
    /// idempotency key, as `SecretService::store` does. A destination outside
    /// `secret://provider-account/<uuid-v7>` and a missing idempotency key are
    /// `INVALID_ARGUMENT`; an unknown source is `NOT_FOUND`; a capability or
    /// keyring refusal is `PERMISSION_DENIED`.
    async fn import_local(
        &self,
        request: Request<protocol::ImportLocalProviderCredentialRequest>,
    ) -> Result<Response<protocol::ImportLocalProviderCredentialResponse>, Status> {
        let request = request.into_inner();
        let ctx = request
            .context
            .map(context)
            .ok_or_else(|| Status::invalid_argument("context is required"))?;
        if request.source.is_empty() {
            return Err(Status::invalid_argument("source is required"));
        }
        if request.capability_uri.is_empty() {
            return Err(Status::invalid_argument("capability_uri is required"));
        }
        if request.expected_fingerprint.is_empty() {
            return Err(Status::invalid_argument("expected_fingerprint is required"));
        }
        let imported = self
            .kernel
            .provider_accounts
            .import_local(
                &ctx,
                &request.source,
                &request.capability_uri,
                &request.expected_fingerprint,
            )
            .map_err(status)?;
        Ok(Response::new(
            protocol::ImportLocalProviderCredentialResponse {
                capability_uri: imported.capability_uri,
                stored: imported.stored,
                credential: Some(local_provider_credential(imported.credential)),
            },
        ))
    }
}

#[tonic::async_trait]
impl ConnectorServiceRpc for GrpcKernel {
    async fn mint_grant(
        &self,
        request: Request<protocol::MintConnectorGrantRequest>,
    ) -> Result<Response<protocol::ConnectorGrantMessage>, Status> {
        let request = request.into_inner();
        let ctx = request
            .context
            .map(context_long_running)
            .ok_or_else(|| Status::invalid_argument("context is required"))?;
        let binding = request
            .binding
            .ok_or_else(|| Status::invalid_argument("binding is required"))?;
        let destination_port = u16::try_from(binding.destination_port)
            .map_err(|_| Status::invalid_argument("destination_port exceeds 65535"))?;
        let grant = self
            .kernel
            .connectors
            // Async variant: the credential resolve runs on the blocking pool
            // under a deadline, so a pending OS keychain prompt cannot park a
            // tokio worker until the control plane's unary deadline fires.
            .mint_grant_async(
                &ctx,
                &request.capability_uri,
                terminus_secrets::GrantBinding {
                    connector_id: binding.connector_id,
                    destination_host: binding.destination_host,
                    destination_port,
                    scheme: binding.scheme,
                    method: binding.method,
                    path_class: binding.path_class,
                    task_id: ctx.task_id.clone(),
                    effect_id: binding.effect_id,
                    // Per-account host allowlist. Signed into the grant, so a
                    // consumer cannot widen it after minting.
                    allowed_hosts: binding.allowed_hosts,
                },
                request.ttl_seconds,
                1,
            )
            .await
            .map_err(status)?;
        let encoded_grant = grant
            .encode()
            .map_err(|_| Status::internal("connector grant encoding failed"))?;
        Ok(Response::new(protocol::ConnectorGrantMessage {
            encoded_grant,
            grant_id: grant.claims.grant_id,
            expires_at_unix: grant.claims.expires_at_unix,
        }))
    }

    type ExecuteStreamStream = std::pin::Pin<
        Box<
            dyn tokio_stream::Stream<Item = Result<protocol::ConnectorChunk, Status>>
                + Send
                + 'static,
        >,
    >;

    async fn execute_stream(
        &self,
        request: Request<protocol::ExecuteConnectorRequest>,
    ) -> Result<Response<Self::ExecuteStreamStream>, Status> {
        let request = request.into_inner();
        let ctx = request
            .context
            .map(context_long_running)
            .ok_or_else(|| Status::invalid_argument("context is required"))?;
        let operation = request
            .operation
            .ok_or_else(|| Status::invalid_argument("operation is required"))?;
        let port = u16::try_from(operation.port)
            .map_err(|_| Status::invalid_argument("operation port exceeds 65535"))?;
        let grant = self
            .kernel
            .connectors
            .decode_grant(&request.encoded_grant)
            .map_err(|_| Status::permission_denied("connector grant is invalid"))?;
        let canonical = terminus_connector::CanonicalOperation {
            method: operation.method,
            scheme: operation.scheme,
            host: operation.host,
            port,
            path: operation.path,
            query: operation.query,
            headers: operation
                .headers
                .into_iter()
                .map(|header| (header.name, header.value))
                .collect(),
            body: operation.body,
        };

        // The dispatch runs in a supervised task whose JoinHandle is held by
        // the returned stream: it is joined when the channel closes and
        // ABORTED when the consumer drops the stream, so a cancelled RPC
        // never leaves a detached provider request running to completion.
        //
        // The sink emits a metadata frame first (a receipt frame carrying
        // `outcome = "head"`, the HTTP status, and the allowlisted response
        // headers), then body frames, then the terminal accounting receipt.
        struct ReceiptSink {
            tx: tokio::sync::mpsc::Sender<Result<protocol::ConnectorChunk, Status>>,
            identity: ConnectorStreamIdentity,
        }
        impl terminus_connector::ChunkSink for ReceiptSink {
            fn on_head(
                &mut self,
                head: terminus_connector::ResponseHead,
            ) -> std::pin::Pin<
                Box<
                    dyn std::future::Future<Output = Result<(), terminus_connector::ConnectorError>>
                        + Send
                        + '_,
                >,
            > {
                let frame = self.identity.head_frame(&head);
                let tx = self.tx.clone();
                Box::pin(async move {
                    tx.send(Ok(protocol::ConnectorChunk {
                        payload: Some(protocol::connector_chunk::Payload::Receipt(frame)),
                    }))
                    .await
                    .map_err(|_| {
                        terminus_connector::ConnectorError::Protocol(
                            "stream consumer dropped".into(),
                        )
                    })
                })
            }

            fn on_chunk(
                &mut self,
                bytes: &[u8],
            ) -> std::pin::Pin<
                Box<
                    dyn std::future::Future<Output = Result<(), terminus_connector::ConnectorError>>
                        + Send
                        + '_,
                >,
            > {
                let payload = bytes.to_vec();
                let tx = self.tx.clone();
                Box::pin(async move {
                    tx.send(Ok(protocol::ConnectorChunk {
                        payload: Some(protocol::connector_chunk::Payload::Bytes(payload)),
                    }))
                    .await
                    .map_err(|_| {
                        terminus_connector::ConnectorError::Protocol(
                            "stream consumer dropped".into(),
                        )
                    })
                })
            }
        }

        let identity = ConnectorStreamIdentity {
            grant_id: grant.claims.grant_id.clone(),
            task_id: grant.claims.workload.task_id.clone(),
            effect_id: grant.claims.binding.effect_id.clone(),
            connector_id: grant.claims.binding.connector_id.clone(),
            method: canonical.method.clone(),
            path: canonical.path.clone(),
            destination: format!(
                "{}://{}:{}",
                canonical.scheme, canonical.host, canonical.port
            ),
        };
        // Bounded in-flight window: a slow consumer parks the sink send,
        // which parks the dispatch loop, which stops reading the socket —
        // backpressure reaches the provider instead of growing kernel heap.
        // Each item is one aligned SSE flush, so this is bytes-bounded too.
        let (tx, rx) = tokio::sync::mpsc::channel::<Result<protocol::ConnectorChunk, Status>>(
            CONNECTOR_STREAM_CHANNEL_DEPTH,
        );
        let connectors = self.kernel.connectors.clone();
        let cancel = terminus_connector::CancelToken::new();
        let dispatch_cancel = cancel.clone();
        let pump = tokio::spawn(async move {
            let mut sink = ReceiptSink {
                tx: tx.clone(),
                identity,
            };
            let result = connectors
                .execute_streaming(&ctx, &canonical, &grant, &mut sink, &dispatch_cancel)
                .await;
            match result {
                Ok(response) => {
                    let receipt = response.receipt;
                    let _ = tx
                        .send(Ok(protocol::ConnectorChunk {
                            payload: Some(protocol::connector_chunk::Payload::Receipt(
                                protocol::ConnectorReceiptMessage {
                                    grant_id: receipt.grant_id,
                                    task_id: receipt.task_id,
                                    effect_id: receipt.effect_id,
                                    connector_id: receipt.connector_id,
                                    method: receipt.method,
                                    path: receipt.path,
                                    destination: receipt.destination,
                                    request_sha256: receipt.request_sha256,
                                    status_code: receipt.status_code.map(u32::from),
                                    response_sha256: receipt.response_sha256,
                                    response_redactions: u64::try_from(receipt.response_redactions)
                                        .unwrap_or(u64::MAX),
                                    outcome: connector_outcome(receipt.outcome).to_string(),
                                    response_headers: connector_response_headers(
                                        receipt.response_headers,
                                    ),
                                },
                            )),
                        }))
                        .await;
                }
                Err(error) => {
                    let _ = tx
                        .send(Err(connector_stream_status(&dispatch_cancel, error)))
                        .await;
                }
            }
        });

        let stream = PumpStream { rx, pump, cancel };
        Ok(Response::new(Box::pin(stream) as Self::ExecuteStreamStream))
    }

    async fn execute(
        &self,
        request: Request<protocol::ExecuteConnectorRequest>,
    ) -> Result<Response<protocol::ConnectorResponseMessage>, Status> {
        let request = request.into_inner();
        let ctx = request
            .context
            .map(context_long_running)
            .ok_or_else(|| Status::invalid_argument("context is required"))?;
        let operation = request
            .operation
            .ok_or_else(|| Status::invalid_argument("operation is required"))?;
        let port = u16::try_from(operation.port)
            .map_err(|_| Status::invalid_argument("operation port exceeds 65535"))?;
        let grant = self
            .kernel
            .connectors
            .decode_grant(&request.encoded_grant)
            .map_err(|_| Status::permission_denied("connector grant is invalid"))?;
        let response = self
            .kernel
            .connectors
            .execute(
                &ctx,
                &terminus_connector::CanonicalOperation {
                    method: operation.method,
                    scheme: operation.scheme,
                    host: operation.host,
                    port,
                    path: operation.path,
                    query: operation.query,
                    headers: operation
                        .headers
                        .into_iter()
                        .map(|header| (header.name, header.value))
                        .collect(),
                    body: operation.body,
                },
                &grant,
            )
            .await
            .map_err(status)?;
        let receipt = response.receipt;
        Ok(Response::new(protocol::ConnectorResponseMessage {
            receipt: Some(protocol::ConnectorReceiptMessage {
                grant_id: receipt.grant_id,
                task_id: receipt.task_id,
                effect_id: receipt.effect_id,
                connector_id: receipt.connector_id,
                method: receipt.method,
                path: receipt.path,
                destination: receipt.destination,
                request_sha256: receipt.request_sha256,
                status_code: receipt.status_code.map(u32::from),
                response_sha256: receipt.response_sha256,
                response_redactions: u64::try_from(receipt.response_redactions)
                    .map_err(|_| Status::internal("response redaction count exceeds u64"))?,
                outcome: connector_outcome(receipt.outcome).to_string(),
                response_headers: connector_response_headers(receipt.response_headers),
            }),
            body: response.body,
            content_type: response.content_type,
        }))
    }
}

/// Project the broker's allowlisted response headers onto the wire message.
/// The broker already filtered names and bounded values; this is a pure
/// shape conversion.
fn connector_response_headers(
    headers: Vec<(String, String)>,
) -> Vec<protocol::ConnectorHeaderMessage> {
    headers
        .into_iter()
        .map(|(name, value)| protocol::ConnectorHeaderMessage { name, value })
        .collect()
}

/// In-flight frames a stream consumer may lag behind by. Each frame is one
/// event-boundary-aligned flush (bounded by the connector's pending-event
/// cap), so the window bounds kernel memory as well as frame count.
const CONNECTOR_STREAM_CHANNEL_DEPTH: usize = 16;

/// Identity fields repeated on every receipt frame of one connector stream.
/// The leading metadata frame reuses `ConnectorReceiptMessage` — no proto
/// change — and is distinguished by `outcome == "head"`.
#[derive(Clone, Debug)]
struct ConnectorStreamIdentity {
    grant_id: String,
    task_id: String,
    effect_id: String,
    connector_id: String,
    method: String,
    path: String,
    destination: String,
}

/// Marks the leading metadata frame. Body/accounting frames always carry one
/// of the four `Outcome` names, so this value is unambiguous.
pub const CONNECTOR_STREAM_HEAD_OUTCOME: &str = "head";

impl ConnectorStreamIdentity {
    /// The metadata frame: HTTP status and the connector's allowlisted
    /// response headers (`retry-after`, `x-ratelimit-*`, `x-codex-*`, …),
    /// delivered before the first body byte. Hash and redaction accounting
    /// are only known at settlement and stay on the terminal frame.
    fn head_frame(
        &self,
        head: &terminus_connector::ResponseHead,
    ) -> protocol::ConnectorReceiptMessage {
        protocol::ConnectorReceiptMessage {
            grant_id: self.grant_id.clone(),
            task_id: self.task_id.clone(),
            effect_id: self.effect_id.clone(),
            connector_id: self.connector_id.clone(),
            method: self.method.clone(),
            path: self.path.clone(),
            destination: self.destination.clone(),
            request_sha256: String::new(),
            status_code: Some(u32::from(head.status_code)),
            response_sha256: None,
            response_redactions: 0,
            outcome: CONNECTOR_STREAM_HEAD_OUTCOME.to_string(),
            response_headers: connector_response_headers(head.headers.clone()),
        }
    }
}

/// Terminal status for a failed connector stream. A dispatch the caller tore
/// down answers `CANCELLED` so a consumer can tell "we stopped this" from
/// "the provider or the policy refused it".
fn connector_stream_status(
    cancel: &terminus_connector::CancelToken,
    error: terminus_kernel_protocol::KernelError,
) -> Status {
    if cancel.is_cancelled() {
        return Status::cancelled("connector stream cancelled by the caller");
    }
    status(error)
}

fn connector_outcome(outcome: terminus_connector::Outcome) -> &'static str {
    match outcome {
        terminus_connector::Outcome::Accepted => "accepted",
        terminus_connector::Outcome::RejectedNonRetryable => "rejected_non_retryable",
        terminus_connector::Outcome::DispatchUncertain => "dispatch_uncertain",
        terminus_connector::Outcome::NotDispatched => "not_dispatched",
    }
}

#[tonic::async_trait]
impl CodeIntelligenceRpc for GrpcKernel {
    async fn search(
        &self,
        request: Request<protocol::CodeSearchRequest>,
    ) -> Result<Response<protocol::CodeSearchResponse>, Status> {
        let request = request.into_inner();
        let mut ctx = request
            .context
            .map(context_long_running)
            .ok_or_else(|| Status::invalid_argument("context is required"))?;
        if request.query.is_empty() {
            return Err(Status::invalid_argument("query is required"));
        }
        let requested_workspace = request.workspace_id.trim();
        if requested_workspace.is_empty() {
            if ctx.workspace_id.is_empty() || ctx.workspace_id == "*" {
                return Err(Status::invalid_argument(
                    "workspace_id is required when the request context has no concrete workspace",
                ));
            }
        } else {
            if requested_workspace == "*" {
                return Err(Status::invalid_argument(
                    "workspace_id must identify one concrete workspace",
                ));
            }
            if ctx.workspace_id != "*"
                && !ctx.workspace_id.is_empty()
                && ctx.workspace_id != requested_workspace
            {
                return Err(Status::permission_denied(
                    "search workspace_id does not match the request context workspace binder",
                ));
            }
            ctx.workspace_id = requested_workspace.to_string();
        }
        let result = self
            .kernel
            .code_intel
            .inspect(&ctx, &Default::default(), &request.query)
            .map_err(status)?;
        let limit = if request.limit == 0 {
            100
        } else {
            request.limit as usize
        };
        let mut results = Vec::new();
        if let Some(symbol) = result.symbol {
            results.push(protocol::CodeSearchResult {
                path: symbol.path,
                line: symbol.start_line,
                symbol: symbol.name,
                method: "symbol-index".to_string(),
            });
        }
        let truncated = results.len() > limit;
        results.truncate(limit);
        Ok(Response::new(protocol::CodeSearchResponse {
            results,
            truncated,
            continuation: None,
        }))
    }

    async fn map(
        &self,
        request: Request<protocol::RepositoryMapRequest>,
    ) -> Result<Response<protocol::RepositoryMapResponse>, Status> {
        let request = request.into_inner();
        let mut ctx = request
            .context
            .map(context_long_running)
            .ok_or_else(|| Status::invalid_argument("context is required"))?;
        let requested_workspace = request.workspace_id.trim();
        if requested_workspace.is_empty() {
            if ctx.workspace_id.is_empty() || ctx.workspace_id == "*" {
                return Err(Status::invalid_argument(
                    "workspace_id is required when the request context has no concrete workspace",
                ));
            }
        } else {
            if requested_workspace == "*" {
                return Err(Status::invalid_argument(
                    "workspace_id must identify one concrete workspace",
                ));
            }
            if ctx.workspace_id != "*"
                && !ctx.workspace_id.is_empty()
                && ctx.workspace_id != requested_workspace
            {
                return Err(Status::permission_denied(
                    "map workspace_id does not match the request context workspace binder",
                ));
            }
            ctx.workspace_id = requested_workspace.to_string();
        }

        let limit = if request.limit == 0 {
            DEFAULT_REPOSITORY_MAP_PAGE_SIZE
        } else {
            usize::try_from(request.limit)
                .map_err(|_| Status::invalid_argument("repository map limit is invalid"))?
        };
        if limit > MAX_REPOSITORY_MAP_PAGE_SIZE {
            return Err(Status::invalid_argument(format!(
                "repository map limit exceeds {MAX_REPOSITORY_MAP_PAGE_SIZE}"
            )));
        }
        let (expected_revision, offset) = parse_repository_map_continuation(&request.continuation)?;
        let page = self
            .kernel
            .code_intel
            .repository_map(
                &ctx,
                &Default::default(),
                limit,
                offset,
                expected_revision.as_deref(),
            )
            .map_err(status)?;
        let continuation = page
            .next_offset
            .map(|next_offset| format!("v1|{}|{next_offset}", page.index_revision));
        let total_entries = u32::try_from(page.total_entries)
            .map_err(|_| Status::internal("repository map entry count exceeds protocol range"))?;
        Ok(Response::new(protocol::RepositoryMapResponse {
            entries: page
                .entries
                .into_iter()
                .map(|entry| protocol::RepositoryMapEntry {
                    path: entry.path,
                    symbols: entry.symbols,
                    source_sha256: entry.source_sha256,
                })
                .collect(),
            index_revision: page.index_revision,
            truncated: continuation.is_some(),
            continuation,
            total_entries,
        }))
    }
}

fn parse_repository_map_continuation(
    continuation: &str,
) -> Result<(Option<String>, usize), Status> {
    if continuation.trim().is_empty() {
        return Ok((None, 0));
    }
    let parts = continuation.split('|').collect::<Vec<_>>();
    if parts.len() != 3 || parts[0] != "v1" {
        return Err(Status::invalid_argument(
            "repository map continuation has an invalid format",
        ));
    }
    let revision = parts[1];
    let digest = revision.strip_prefix("sha256:").ok_or_else(|| {
        Status::invalid_argument("repository map continuation has an invalid revision")
    })?;
    if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(Status::invalid_argument(
            "repository map continuation has an invalid revision",
        ));
    }
    let offset = parts[2].parse::<usize>().map_err(|_| {
        Status::invalid_argument("repository map continuation has an invalid offset")
    })?;
    Ok((Some(revision.to_string()), offset))
}

#[tonic::async_trait]
impl PatchServiceRpc for GrpcKernel {
    async fn apply(
        &self,
        request: Request<protocol::PatchRequest>,
    ) -> Result<Response<protocol::PatchResponse>, Status> {
        let request = request.into_inner();
        let ctx = request
            .context
            .map(context_long_running)
            .ok_or_else(|| Status::invalid_argument("context is required"))?;
        let intent = request.intent.map(intent).unwrap_or_default();
        let baseline = request
            .baseline
            .ok_or_else(|| Status::invalid_argument("baseline is required"))?;
        let baseline = terminus_kernel_protocol::WorkspaceBaseline {
            workspace_id: baseline.workspace_id,
            repository_revision: baseline.repository_revision,
            dirty_digest: baseline.dirty_digest,
            sources: baseline
                .sources
                .into_iter()
                .map(source_version)
                .collect::<Result<_, _>>()?,
        };
        let edits = request
            .edits
            .into_iter()
            .map(patch_edit)
            .collect::<Result<Vec<_>, _>>()?;
        let mode = match request.commit_mode {
            1 => terminus_kernel_protocol::PatchCommitMode::PreviewOnly,
            2 => terminus_kernel_protocol::PatchCommitMode::StageOnly,
            _ => terminus_kernel_protocol::PatchCommitMode::ApplyToWorktree,
        };
        let result = self
            .kernel
            .patches
            .apply_with_mode(
                &ctx,
                &intent,
                &request.transaction_id,
                &baseline,
                &edits,
                mode,
            )
            .map_err(status)?;
        Ok(Response::new(patch_response(result)))
    }
    async fn reconcile(
        &self,
        request: Request<protocol::PatchReconcileRequest>,
    ) -> Result<Response<protocol::PatchResponse>, Status> {
        let request = request.into_inner();
        let ctx = request
            .context
            .map(context_long_running)
            .ok_or_else(|| Status::invalid_argument("context is required"))?;
        if request.transaction_id.is_empty() {
            return Err(Status::invalid_argument("transaction_id is required"));
        }
        let result = self
            .kernel
            .patches
            .reconcile(&ctx, &request.transaction_id)
            .map_err(status)?;
        Ok(Response::new(patch_response(result)))
    }
}

#[tonic::async_trait]
impl ProcessServiceRpc for GrpcKernel {
    type StartStream = std::pin::Pin<
        Box<dyn tokio_stream::Stream<Item = Result<protocol::ProcessEvent, Status>> + Send>,
    >;
    async fn start(
        &self,
        request: Request<protocol::StartProcessRequest>,
    ) -> Result<Response<Self::StartStream>, Status> {
        let request = request.into_inner();
        let ctx = request
            .context
            .map(context_long_running)
            .ok_or_else(|| Status::invalid_argument("context is required"))?;
        let intent = request.intent.map(intent).unwrap_or_default();
        let command = request
            .command
            .map(|spec| command(spec, DEFAULT_EXEC_TIMEOUT_MS))
            .transpose()?
            .ok_or_else(|| Status::invalid_argument("command is required"))?;
        let profile = if request.sandbox_profile_id.is_empty() {
            "secure-local-default"
        } else {
            request.sandbox_profile_id.as_str()
        };
        let receiver = self
            .kernel
            .processes
            .start_in_profile(&ctx, &intent, command, profile)
            .await
            .map_err(status)?;
        let stream = Box::pin(
            tokio_stream::wrappers::ReceiverStream::new(receiver)
                .map(|event| Ok(process_event(event))),
        );
        Ok(Response::new(stream))
    }
    async fn cancel(
        &self,
        request: Request<protocol::CancelProcessRequest>,
    ) -> Result<Response<protocol::CancelProcessResponse>, Status> {
        let request = request.into_inner();
        let ctx = request
            .context
            .map(context_long_running)
            .ok_or_else(|| Status::invalid_argument("context is required"))?;
        let state = self
            .kernel
            .processes
            .cancel(&ctx, &request.process_id, &request.reason)
            .await
            .map_err(status)?;
        Ok(Response::new(protocol::CancelProcessResponse { state }))
    }
}

#[tonic::async_trait]
impl JobServiceRpc for GrpcKernel {
    type StreamStream =
        std::pin::Pin<Box<dyn Stream<Item = Result<protocol::JobEvent, Status>> + Send>>;
    async fn start(
        &self,
        request: Request<protocol::StartJobRequest>,
    ) -> Result<Response<protocol::StartJobResponse>, Status> {
        let request = request.into_inner();
        let ctx = request
            .context
            .map(context_long_running)
            .ok_or_else(|| Status::invalid_argument("context is required"))?;
        let intent = request.intent.map(intent).unwrap_or_default();
        let command = request
            .command
            .map(|spec| command(spec, DEFAULT_JOB_TIMEOUT_MS))
            .transpose()?
            .ok_or_else(|| Status::invalid_argument("command is required"))?;
        let profile = if request.sandbox_profile_id.is_empty() {
            "secure-local-default"
        } else {
            request.sandbox_profile_id.as_str()
        };
        let request_id = ctx.request_id.clone();
        let (job_id, outcome, receiver) = self
            .kernel
            .jobs
            .start(&ctx, &intent, command, profile, request.durable)
            .await
            .map_err(|error| log_kernel_rpc_error("job.start", &request_id, error))?;
        // Retain the one real process stream in a bounded, replayable buffer.
        // Job.Stream reads this buffer; it must never poll a synthetic state
        // while another task discards stdout/stderr/exit events.
        self.retain_job_stream(job_id.clone(), receiver).await;
        Ok(Response::new(protocol::StartJobResponse {
            job_id,
            process_id: outcome.process_id,
            started_at: Some(prost_types::Timestamp::from(std::time::SystemTime::now())),
        }))
    }
    async fn stream(
        &self,
        request: Request<protocol::JobStreamRequest>,
    ) -> Result<Response<Self::StreamStream>, Status> {
        let request = request.into_inner();
        let ctx = request
            .context
            .map(context_long_running)
            .ok_or_else(|| Status::invalid_argument("context is required"))?;
        let record = authorize_job_control(&self.kernel, &ctx, &request.job_id).await?;
        let job_id = request.job_id;
        let retained = self.job_streams.lock().await.get(&job_id).cloned();
        let from_sequence = request.from_sequence;
        if let Some(retained) = retained {
            let stream = async_stream::try_stream! {
                let mut cursor = from_sequence;
                loop {
                    let notified = retained.changed.notified();
                    let (events, closed, failure) = {
                        let state = retained.state.lock().await;
                        (
                            state
                                .events
                                .iter()
                                .filter(|event| event.sequence > cursor)
                                .cloned()
                                .collect::<Vec<_>>(),
                            state.closed,
                            state.failure.clone(),
                        )
                    };
                    for event in events {
                        cursor = event.sequence;
                        yield event;
                    }
                    if let Some(message) = failure {
                        Err(Status::resource_exhausted(message))?;
                    }
                    if closed {
                        break;
                    }
                    notified.await;
                }
            };
            return Ok(Response::new(Box::pin(stream)));
        }

        // The process receiver is intentionally process-local, but the job
        // record and output chunks survive a kernel restart. Reconstruct a
        // terminal stream from those durable records instead of reporting a
        // false "no stream" failure after every restart.
        let events =
            replay_durable_job_stream(self.kernel.jobs.manager(), &record, from_sequence).await?;
        let stream = tokio_stream::iter(events.into_iter().map(Ok));
        Ok(Response::new(Box::pin(stream)))
    }
    async fn input(
        &self,
        request: Request<protocol::JobInputRequest>,
    ) -> Result<Response<protocol::JobState>, Status> {
        let request = request.into_inner();
        let ctx = request
            .context
            .map(context_long_running)
            .ok_or_else(|| Status::invalid_argument("context is required"))?;
        let _record = authorize_job_control(&self.kernel, &ctx, &request.job_id).await?;
        let state = self
            .kernel
            .jobs
            .input(&request.job_id, &request.stdin)
            .await
            .map_err(status)?;
        Ok(Response::new(job_state(&request.job_id, state)))
    }
    async fn signal(
        &self,
        request: Request<protocol::JobSignalRequest>,
    ) -> Result<Response<protocol::JobState>, Status> {
        let request = request.into_inner();
        let ctx = request
            .context
            .map(context_long_running)
            .ok_or_else(|| Status::invalid_argument("context is required"))?;
        let _record = authorize_job_control(&self.kernel, &ctx, &request.job_id).await?;
        let state = self
            .kernel
            .jobs
            .signal(&request.job_id, &request.signal)
            .await
            .map_err(status)?;
        Ok(Response::new(job_state(&request.job_id, state)))
    }
    async fn stop(
        &self,
        request: Request<protocol::JobStopRequest>,
    ) -> Result<Response<protocol::JobState>, Status> {
        let request = request.into_inner();
        let ctx = request
            .context
            .map(context_long_running)
            .ok_or_else(|| Status::invalid_argument("context is required"))?;
        let _record = authorize_job_control(&self.kernel, &ctx, &request.job_id).await?;
        let state = self
            .kernel
            .jobs
            .stop(&request.job_id, &request.reason)
            .await
            .map_err(status)?;
        Ok(Response::new(job_state(&request.job_id, state)))
    }
    async fn get(
        &self,
        request: Request<protocol::JobGetRequest>,
    ) -> Result<Response<protocol::JobState>, Status> {
        let request = request.into_inner();
        let ctx = request
            .context
            .map(context_long_running)
            .ok_or_else(|| Status::invalid_argument("context is required"))?;
        let record = authorize_job_control(&self.kernel, &ctx, &request.job_id).await?;
        Ok(Response::new(job_state_from_record(&record)))
    }
}

async fn authorize_job_control(
    kernel: &terminus_kernel::KernelHandle,
    ctx: &terminus_kernel_protocol::RequestContext,
    job_id: &str,
) -> Result<terminus_jobs::JobRecord, Status> {
    let token = terminus_kernel::validate_capability_for_op(
        &kernel.token_issuer,
        ctx,
        terminus_authz::OperationClass::Job,
        &terminus_authz::Scope::default(),
    )
    .map_err(status)?;
    let record = kernel
        .jobs
        .manager()
        .get(job_id)
        .await
        .ok_or_else(|| Status::not_found("job not found"))?;
    if ctx.task_id != "*" && record.owner_task_id != ctx.task_id {
        return Err(Status::permission_denied(
            "job is owned by a different task",
        ));
    }
    if token.claims.binder.task_id != "*" && record.owner_task_id != token.claims.binder.task_id {
        return Err(Status::permission_denied(
            "job capability is owned by a different task",
        ));
    }
    Ok(record)
}

fn job_state(job_id: &str, state: terminus_jobs::JobState) -> protocol::JobState {
    protocol::JobState {
        job_id: job_id.to_string(),
        state: state.as_str().to_ascii_lowercase(),
        exit_code: 0,
        started_at: None,
        exited_at: None,
        stdout_artifact: None,
        stderr_artifact: None,
    }
}

fn artifact_ref_opt(sha256: &Option<String>) -> Option<protocol::ArtifactRef> {
    let sha = sha256.as_deref()?;
    Some(protocol::ArtifactRef {
        sha256: sha.to_string(),
        size_bytes: 0,
        media_type: String::new(),
    })
}

/// Full projection of a durable job record (Cubic exec_poll finding): the
/// settled exit code parsed from the termination receipt plus the CAS
/// artifact refs the poll tool tails.
fn job_state_from_record(record: &terminus_jobs::JobRecord) -> protocol::JobState {
    let exit_code = record
        .termination_receipt
        .as_deref()
        .and_then(|receipt| receipt.strip_prefix("exit:"))
        .and_then(|code| code.parse::<i32>().ok())
        .unwrap_or(-1);
    protocol::JobState {
        job_id: record.id.clone(),
        state: record.state.as_str().to_ascii_lowercase(),
        exit_code,
        started_at: record.started_at.as_ref().and_then(|raw| {
            chrono::DateTime::parse_from_rfc3339(raw)
                .ok()
                .map(|ts| prost_types::Timestamp {
                    seconds: ts.timestamp(),
                    nanos: ts.timestamp_subsec_nanos() as i32,
                })
        }),
        exited_at: record.settled_at.as_ref().and_then(|raw| {
            chrono::DateTime::parse_from_rfc3339(raw)
                .ok()
                .map(|ts| prost_types::Timestamp {
                    seconds: ts.timestamp(),
                    nanos: ts.timestamp_subsec_nanos() as i32,
                })
        }),
        stdout_artifact: artifact_ref_opt(&record.stdout_artifact),
        stderr_artifact: artifact_ref_opt(&record.stderr_artifact),
    }
}

fn log_kernel_rpc_error(
    service: &'static str,
    request_id: &str,
    error: terminus_kernel_protocol::KernelError,
) -> Status {
    tracing::error!(
        target: "terminus_kernel_audit",
        event = "rpc_failed",
        service,
        request_id,
        error_code = error.code_name(),
        error_category = error.category().as_str(),
        retryable = error.retryable(),
        kernel_error = %error,
        "kernel RPC failed"
    );
    status(error)
}

/// Convert a proto `RequestContext`. When the caller omitted a deadline the
/// kernel substitutes its own (SPEC §31.3 step 9), so the pipeline check in
/// `terminus_kernel::validate_request_pipeline` is live rather than dead
/// code; the transport-level [`crate::deadline::DeadlineLayer`] enforces the
/// same budget on the response and its body.
fn context(value: ProtoContext) -> terminus_kernel_protocol::RequestContext {
    context_for(value, terminus_kernel::RpcDeadlineClass::Unary)
}

/// Context conversion for RPCs whose work legitimately runs long: streams,
/// model dispatch, process/job supervision, extensions, indexing, patches,
/// and artifact ingest. Mirrors `crate::deadline::LONG_RUNNING_SERVICES`.
fn context_long_running(value: ProtoContext) -> terminus_kernel_protocol::RequestContext {
    context_for(value, terminus_kernel::RpcDeadlineClass::LongRunning)
}

fn context_for(
    value: ProtoContext,
    class: terminus_kernel::RpcDeadlineClass,
) -> terminus_kernel_protocol::RequestContext {
    let deadline_unix_ms = value
        .deadline
        .map(|t| {
            u64::try_from(t.seconds).unwrap_or(0).saturating_mul(1_000)
                + u64::try_from(t.nanos.max(0)).unwrap_or(0) / 1_000_000
        })
        .unwrap_or(0);
    let resource_budgets = value
        .resource_budgets
        .map(|b| terminus_kernel_protocol::ResourceBudgets {
            max_cpu_milliseconds: b.max_cpu_milliseconds,
            max_memory_bytes: b.max_memory_bytes,
            max_output_bytes: b.max_output_bytes,
            max_wallclock_seconds: b.max_wallclock_seconds,
        })
        .unwrap_or_default();
    let mut ctx = terminus_kernel_protocol::RequestContext {
        request_id: value.request_id,
        idempotency_key: value.idempotency_key,
        session_id: value.session_id,
        task_id: value.task_id,
        turn_id: value.turn_id,
        actor_id: value.actor_id,
        traceparent: value.traceparent,
        capability_token: value.capability_token,
        workspace_id: value.workspace_id,
        deadline_unix_ms,
        resource_budgets,
        policy_version: value.policy_version,
    };
    terminus_kernel::apply_default_deadline(&mut ctx, class);
    ctx
}

fn authorize_context(
    kernel: &terminus_kernel::KernelHandle,
    value: ProtoContext,
    operation: terminus_authz::OperationClass,
) -> Result<terminus_kernel_protocol::RequestContext, Status> {
    let ctx = context(value);
    terminus_kernel::validate_request_pipeline(
        &kernel.token_issuer,
        &ctx,
        operation,
        &terminus_authz::Scope::default(),
        false,
    )
    .map(|_| ctx)
    .map_err(status)
}
fn intent(value: protocol::EffectIntent) -> terminus_kernel_protocol::EffectIntent {
    terminus_kernel_protocol::EffectIntent {
        user_intent_ref: value.user_intent_ref,
        task_contract_hash: value.task_contract_hash,
        trust_label: value.trust_label,
        confidentiality_label: value.confidentiality_label,
        taint_sources: value.taint_sources,
        policy_profile_id: value.policy_profile_id,
        expected_effect_class: value.expected_effect_class,
    }
}
fn path(value: protocol::WorkspacePath) -> terminus_kernel_protocol::WorkspacePath {
    terminus_kernel_protocol::WorkspacePath {
        workspace_id: value.workspace_id,
        relative_path: value.relative_path,
    }
}
/// Default wall-clock bound for a synchronous `Process.Start` when the
/// caller sent no timeout. Interactive exec is expected to be short.
const DEFAULT_EXEC_TIMEOUT_MS: u64 = 120_000;
/// Default wall-clock bound for `Job.Start` when the caller sent no timeout.
/// Jobs run builds and test suites, so the budget is much larger — but still
/// finite.
const DEFAULT_JOB_TIMEOUT_MS: u64 = 30 * 60 * 1_000;

/// Convert a proto `CommandSpec`. `default_timeout_ms` is applied when the
/// caller sent no timeout; unbounded runtime requires the explicit
/// `allow_unbounded_timeout` opt-in and is never inferred from an absent or
/// zero duration.
fn command(
    value: protocol::CommandSpec,
    default_timeout_ms: u64,
) -> Result<terminus_kernel_protocol::CommandSpec, Status> {
    let requested_ms = value
        .timeout
        .as_ref()
        .and_then(|duration| {
            let seconds = u64::try_from(duration.seconds).ok()?;
            let millis = u64::from(u32::try_from(duration.nanos.max(0)).unwrap_or(0)) / 1_000_000;
            Some(seconds.saturating_mul(1_000).saturating_add(millis))
        })
        .unwrap_or(0);
    let timeout_ms = resolve_command_timeout_ms(
        requested_ms,
        value.allow_unbounded_timeout,
        default_timeout_ms,
    );
    let shell = value.shell.unwrap_or_default();
    Ok(terminus_kernel_protocol::CommandSpec {
        program: value.program,
        args: value.args,
        cwd: value
            .cwd
            .map(path)
            .ok_or_else(|| Status::invalid_argument("command.cwd is required"))?,
        public_env: value.public_env.into_iter().collect(),
        secret_capability_uris: value.secret_capability_uris,
        timeout_ms,
        allocate_pty: value.allocate_pty,
        shell: terminus_kernel_protocol::ShellSpec {
            enabled: shell.enabled,
            script: shell.script,
            dialect: shell.dialect,
        },
    })
}
/// Timeout resolution for one command (SPEC §31.3 step 9 budget reservation).
///
/// - an explicit positive duration wins;
/// - `allow_unbounded_timeout` maps to the process-manager sentinel, and is
///   the ONLY way to run without a wall clock;
/// - anything else falls back to the RPC class default.
///
/// Policy `max_runtime_ms` and the sandbox profile's wall clock clamp the
/// result downstream exactly as before, including the unbounded case.
fn resolve_command_timeout_ms(
    requested_ms: u64,
    allow_unbounded: bool,
    default_timeout_ms: u64,
) -> u64 {
    if requested_ms > 0 {
        return requested_ms;
    }
    if allow_unbounded {
        return terminus_process::UNBOUNDED_TIMEOUT_MS;
    }
    default_timeout_ms
}

fn timestamp(value: &str) -> Option<prost_types::Timestamp> {
    let parsed = chrono::DateTime::parse_from_rfc3339(value).ok()?;
    Some(prost_types::Timestamp {
        seconds: parsed.timestamp(),
        nanos: parsed.timestamp_subsec_nanos() as i32,
    })
}

async fn replay_durable_job_stream(
    manager: &terminus_jobs::JobManager,
    record: &terminus_jobs::JobRecord,
    from_sequence: u64,
) -> Result<Vec<protocol::JobEvent>, Status> {
    use protocol::job_event::Event;

    let mut events = Vec::new();
    let mut sequence = 0_u64;
    if let Some(process_id) = record.process_identity.as_deref() {
        sequence = 1;
        events.push(protocol::JobEvent {
            sequence,
            occurred_at: record.started_at.as_deref().and_then(timestamp),
            event: Some(Event::Started(protocol::ProcessStarted {
                process_id: process_id.to_string(),
                job_id: record.id.clone(),
                resolved_executable: record.resolved_executable.clone(),
                started_at: record.started_at.as_deref().and_then(timestamp),
            })),
        });
    }

    let mut output = Vec::new();
    for stream in ["stdout", "stderr"] {
        let chunks = manager
            .output_since(&record.id, stream, 0)
            .await
            .map_err(|error| durable_output_status(record, stream, error))?;
        output.extend(chunks);
    }
    output.sort_by(|left, right| {
        left.start_cursor
            .cmp(&right.start_cursor)
            .then_with(|| left.stream.cmp(&right.stream))
            .then_with(|| left.end_cursor.cmp(&right.end_cursor))
    });
    for chunk in output {
        sequence = sequence.saturating_add(1);
        let event = if chunk.stream == "stdout" {
            Event::Stdout(protocol::OutputChunk {
                cursor: chunk.end_cursor,
                bytes: chunk.bytes,
                redacted: chunk.redacted,
            })
        } else {
            Event::Stderr(protocol::OutputChunk {
                cursor: chunk.end_cursor,
                bytes: chunk.bytes,
                redacted: chunk.redacted,
            })
        };
        events.push(protocol::JobEvent {
            sequence,
            occurred_at: None,
            event: Some(event),
        });
    }

    match record.state {
        terminus_jobs::JobState::Exited => {
            sequence = sequence.saturating_add(1);
            let (exit_code, signal) = termination_projection(record);
            events.push(protocol::JobEvent {
                sequence,
                occurred_at: record.settled_at.as_deref().and_then(timestamp),
                event: Some(Event::Exited(protocol::ProcessExited {
                    exit_code,
                    signal,
                    exited_at: record.settled_at.as_deref().and_then(timestamp),
                    stdout_artifact: artifact_ref_opt(&record.stdout_artifact),
                    stderr_artifact: artifact_ref_opt(&record.stderr_artifact),
                })),
            });
        }
        state => {
            sequence = sequence.saturating_add(1);
            let (state, explanation) = if state == terminus_jobs::JobState::Running {
                (
                    "running",
                    "kernel restarted after the process event channel was created; durable output is replayable, but live events cannot be reattached",
                )
            } else {
                (
                    "unknown-settlement",
                    "kernel restarted before a durable process exit event was recorded",
                )
            };
            events.push(protocol::JobEvent {
                sequence,
                occurred_at: None,
                event: Some(Event::Reconciled(protocol::JobReconciled {
                    state: state.to_string(),
                    explanation: explanation.to_string(),
                })),
            });
        }
    }

    Ok(events
        .into_iter()
        .filter(|event| event.sequence > from_sequence)
        .collect())
}

fn durable_output_status(
    record: &terminus_jobs::JobRecord,
    stream: &str,
    error: terminus_jobs::JobError,
) -> Status {
    match error {
        terminus_jobs::JobError::OutputTruncated { available_from, .. } => {
            let artifact = if stream == "stdout" {
                record.stdout_artifact.as_deref()
            } else {
                record.stderr_artifact.as_deref()
            };
            let artifact_hint = artifact
                .map(|value| format!("; retrieve artifact {value}"))
                .unwrap_or_default();
            Status::resource_exhausted(format!(
                "durable {stream} output was compacted; continue from byte cursor {available_from}{artifact_hint}"
            ))
        }
        other => Status::internal(format!("durable job output replay failed: {other}")),
    }
}

fn termination_projection(record: &terminus_jobs::JobRecord) -> (i32, String) {
    let Some(receipt) = record.termination_receipt.as_deref() else {
        return (-1, String::new());
    };
    if let Some(code) = receipt.strip_prefix("exit:") {
        return (code.parse::<i32>().unwrap_or(-1), String::new());
    }
    if let Some(signal) = receipt.strip_prefix("signal:") {
        return (-1, signal.to_string());
    }
    (-1, receipt.to_string())
}

fn job_event(
    job_id: &str,
    sequence: u64,
    value: terminus_kernel_protocol::ProcessEvent,
) -> protocol::JobEvent {
    use protocol::job_event::Event;
    match value {
        terminus_kernel_protocol::ProcessEvent::Started(event) => protocol::JobEvent {
            sequence,
            occurred_at: timestamp(&event.started_at),
            event: Some(Event::Started(protocol::ProcessStarted {
                process_id: event.process_id,
                job_id: job_id.to_string(),
                resolved_executable: event.resolved_executable,
                started_at: timestamp(&event.started_at),
            })),
        },
        terminus_kernel_protocol::ProcessEvent::Stdout(event) => protocol::JobEvent {
            sequence,
            occurred_at: None,
            event: Some(Event::Stdout(protocol::OutputChunk {
                cursor: event.cursor,
                bytes: event.bytes,
                redacted: event.redacted,
            })),
        },
        terminus_kernel_protocol::ProcessEvent::Stderr(event) => protocol::JobEvent {
            sequence,
            occurred_at: None,
            event: Some(Event::Stderr(protocol::OutputChunk {
                cursor: event.cursor,
                bytes: event.bytes,
                redacted: event.redacted,
            })),
        },
        terminus_kernel_protocol::ProcessEvent::Exited(event) => protocol::JobEvent {
            sequence,
            occurred_at: timestamp(&event.exited_at),
            event: Some(Event::Exited(protocol::ProcessExited {
                exit_code: event.exit_code,
                signal: event.signal,
                exited_at: timestamp(&event.exited_at),
                stdout_artifact: event.stdout_artifact.map(artifact_ref),
                stderr_artifact: event.stderr_artifact.map(artifact_ref),
            })),
        },
        terminus_kernel_protocol::ProcessEvent::Policy(event) => protocol::JobEvent {
            sequence,
            occurred_at: None,
            event: Some(Event::Policy(protocol::PolicyDecision {
                decision_id: event.decision_id,
                decision: event.decision,
                rule_ids: event.rule_ids,
                explanation: event.explanation,
            })),
        },
    }
}

fn job_event_size(event: &protocol::JobEvent) -> usize {
    use protocol::job_event::Event;
    let payload = match event.event.as_ref() {
        Some(Event::Stdout(chunk) | Event::Stderr(chunk)) => chunk.bytes.len(),
        Some(Event::Started(started)) => {
            started.process_id.len() + started.job_id.len() + started.resolved_executable.len()
        }
        Some(Event::Exited(exited)) => exited.signal.len() + 128,
        Some(Event::Policy(policy)) => {
            policy.decision_id.len()
                + policy.decision.len()
                + policy.explanation.len()
                + policy.rule_ids.iter().map(String::len).sum::<usize>()
        }
        Some(Event::Reconciled(reconciled)) => {
            reconciled.state.len() + reconciled.explanation.len()
        }
        None => 0,
    };
    payload.saturating_add(128)
}

fn process_event(value: terminus_kernel_protocol::ProcessEvent) -> protocol::ProcessEvent {
    use protocol::process_event::Event;
    match value {
        terminus_kernel_protocol::ProcessEvent::Started(event) => protocol::ProcessEvent {
            sequence: 0,
            occurred_at: timestamp(&event.started_at),
            event: Some(Event::Started(protocol::ProcessStarted {
                process_id: event.process_id,
                job_id: event.job_id,
                resolved_executable: event.resolved_executable,
                started_at: timestamp(&event.started_at),
            })),
        },
        terminus_kernel_protocol::ProcessEvent::Stdout(event) => protocol::ProcessEvent {
            sequence: event.cursor,
            occurred_at: None,
            event: Some(Event::Stdout(protocol::OutputChunk {
                cursor: event.cursor,
                bytes: event.bytes,
                redacted: event.redacted,
            })),
        },
        terminus_kernel_protocol::ProcessEvent::Stderr(event) => protocol::ProcessEvent {
            sequence: event.cursor,
            occurred_at: None,
            event: Some(Event::Stderr(protocol::OutputChunk {
                cursor: event.cursor,
                bytes: event.bytes,
                redacted: event.redacted,
            })),
        },
        terminus_kernel_protocol::ProcessEvent::Exited(event) => protocol::ProcessEvent {
            sequence: 0,
            occurred_at: timestamp(&event.exited_at),
            event: Some(Event::Exited(protocol::ProcessExited {
                exit_code: event.exit_code,
                signal: event.signal,
                exited_at: timestamp(&event.exited_at),
                stdout_artifact: event.stdout_artifact.map(artifact_ref),
                stderr_artifact: event.stderr_artifact.map(artifact_ref),
            })),
        },
        terminus_kernel_protocol::ProcessEvent::Policy(event) => protocol::ProcessEvent {
            sequence: 0,
            occurred_at: None,
            event: Some(Event::Policy(protocol::PolicyDecision {
                decision_id: event.decision_id,
                decision: event.decision,
                rule_ids: event.rule_ids,
                explanation: event.explanation,
            })),
        },
    }
}
fn artifact_ref(value: terminus_kernel_protocol::ArtifactRef) -> ArtifactRef {
    ArtifactRef {
        sha256: value.sha256,
        size_bytes: value.size_bytes,
        media_type: value.media_type,
    }
}
fn source_version(
    value: protocol::SourceVersion,
) -> Result<terminus_kernel_protocol::SourceVersion, Status> {
    Ok(terminus_kernel_protocol::SourceVersion {
        path: value
            .path
            .map(path)
            .ok_or_else(|| Status::invalid_argument("source path is required"))?,
        sha256: value.sha256,
        repository_revision: value.repository_revision,
    })
}
fn line_range(
    value: Option<protocol::LineRange>,
) -> Result<terminus_kernel_protocol::LineRange, Status> {
    let value = value.ok_or_else(|| Status::invalid_argument("line range is required"))?;
    Ok(terminus_kernel_protocol::LineRange {
        start_line: value.start_line,
        end_line: value.end_line,
    })
}
fn patch_edit(value: protocol::PatchEdit) -> Result<terminus_kernel_protocol::PatchEdit, Status> {
    use protocol::patch_edit::Edit;
    match value
        .edit
        .ok_or_else(|| Status::invalid_argument("patch edit is required"))?
    {
        Edit::ReplaceSymbol(value) => Ok(terminus_kernel_protocol::PatchEdit::ReplaceSymbol(
            terminus_kernel_protocol::ReplaceSymbol {
                path: value
                    .path
                    .map(path)
                    .ok_or_else(|| Status::invalid_argument("replace symbol path is required"))?,
                expected_sha256: value.expected_sha256,
                symbol: value.symbol,
                structural_fingerprint: value.structural_fingerprint,
                replacement_utf8: value.replacement_utf8,
            },
        )),
        Edit::ReplaceRange(value) => Ok(terminus_kernel_protocol::PatchEdit::ReplaceRange(
            terminus_kernel_protocol::ReplaceRange {
                path: value
                    .path
                    .map(path)
                    .ok_or_else(|| Status::invalid_argument("replace range path is required"))?,
                expected_sha256: value.expected_sha256,
                range: line_range(value.range)?,
                replacement_utf8: value.replacement_utf8,
            },
        )),
        Edit::ReplaceHashline(value) => Ok(terminus_kernel_protocol::PatchEdit::ReplaceHashline(
            terminus_kernel_protocol::ReplaceHashline {
                path: value
                    .path
                    .map(path)
                    .ok_or_else(|| Status::invalid_argument("replace hashline path is required"))?,
                expected_sha256: value.expected_sha256,
                line_hashes: value.line_hashes,
                start_line: value.start_line,
                end_line: value.end_line,
                replacement_utf8: value.replacement_utf8,
            },
        )),
        Edit::ReplaceExactText(value) => Ok(terminus_kernel_protocol::PatchEdit::ReplaceExactText(
            terminus_kernel_protocol::ReplaceExactText {
                path: value
                    .path
                    .map(path)
                    .ok_or_else(|| Status::invalid_argument("replace exact path is required"))?,
                expected_sha256: value.expected_sha256,
                expected_utf8: value.expected_utf8,
                replacement_utf8: value.replacement_utf8,
                require_unique: value.require_unique,
            },
        )),
        Edit::Insert(value) => Ok(terminus_kernel_protocol::PatchEdit::Insert(
            terminus_kernel_protocol::InsertContent {
                path: value
                    .path
                    .map(path)
                    .ok_or_else(|| Status::invalid_argument("insert path is required"))?,
                expected_sha256: value.expected_sha256,
                anchor_kind: value.anchor_kind,
                anchor: value.anchor,
                position: value.position,
                content_utf8: value.content_utf8,
            },
        )),
        Edit::DeleteRange(value) => Ok(terminus_kernel_protocol::PatchEdit::DeleteRange(
            terminus_kernel_protocol::DeleteRange {
                path: value
                    .path
                    .map(path)
                    .ok_or_else(|| Status::invalid_argument("delete range path is required"))?,
                expected_sha256: value.expected_sha256,
                range: line_range(value.range)?,
            },
        )),
        Edit::CreateFile(value) => Ok(terminus_kernel_protocol::PatchEdit::CreateFile(
            terminus_kernel_protocol::CreateFile {
                path: value
                    .path
                    .map(path)
                    .ok_or_else(|| Status::invalid_argument("create path is required"))?,
                must_not_exist: value.must_not_exist,
                content: value.content,
                media_type: value.media_type,
            },
        )),
        Edit::MoveFile(value) => Ok(terminus_kernel_protocol::PatchEdit::MoveFile(
            terminus_kernel_protocol::MoveFile {
                from: value
                    .from
                    .map(path)
                    .ok_or_else(|| Status::invalid_argument("move source is required"))?,
                to: value
                    .to
                    .map(path)
                    .ok_or_else(|| Status::invalid_argument("move target is required"))?,
                expected_sha256: value.expected_sha256,
                target_must_not_exist: value.target_must_not_exist,
            },
        )),
        Edit::DeleteFile(value) => Ok(terminus_kernel_protocol::PatchEdit::DeleteFile(
            terminus_kernel_protocol::DeleteFile {
                path: value
                    .path
                    .map(path)
                    .ok_or_else(|| Status::invalid_argument("delete path is required"))?,
                expected_sha256: value.expected_sha256,
            },
        )),
        Edit::UnifiedDiff(value) => Ok(terminus_kernel_protocol::PatchEdit::UnifiedDiff(
            terminus_kernel_protocol::UnifiedDiff {
                repository_revision: value.repository_revision,
                diff_utf8: value.diff_utf8,
            },
        )),
    }
}
fn patch_response(value: terminus_kernel_protocol::PatchResponse) -> protocol::PatchResponse {
    protocol::PatchResponse {
        transaction_id: value.transaction_id,
        state: value.state,
        final_repository_revision: value.final_repository_revision,
        final_dirty_digest: value.final_dirty_digest,
        changed_files: value
            .changed_files
            .into_iter()
            .map(|file| protocol::ChangedFile {
                path: Some(protocol::WorkspacePath {
                    workspace_id: file.path.workspace_id,
                    relative_path: file.path.relative_path,
                }),
                old_sha256: file.old_sha256,
                new_sha256: file.new_sha256,
                operation: file.operation,
            })
            .collect(),
        validations: value
            .validations
            .into_iter()
            .map(|validation| protocol::ValidationResult {
                check_id: validation.check_id,
                status: validation.status,
                summary: validation.summary,
                evidence: validation.evidence.map(artifact_ref),
            })
            .collect(),
        complete_diff: value.complete_diff.map(artifact_ref),
    }
}
fn status(error: terminus_kernel_protocol::KernelError) -> Status {
    use terminus_kernel_protocol::ErrorCode;
    let code = match error.code() {
        ErrorCode::InvalidRequest
        | ErrorCode::InvalidArgument
        | ErrorCode::MissingField
        | ErrorCode::SchemaMismatch => tonic::Code::InvalidArgument,
        ErrorCode::NotFound
        | ErrorCode::WorkspaceNotFound
        | ErrorCode::JobNotFound
        | ErrorCode::ProcessNotFound
        | ErrorCode::ArtifactNotFound
        | ErrorCode::PathNotFound => tonic::Code::NotFound,
        ErrorCode::StaleSourceVersion
        | ErrorCode::AlreadyExists
        | ErrorCode::TransactionConflict
        | ErrorCode::LeaseHeld => tonic::Code::Aborted,
        ErrorCode::PermissionDenied
        | ErrorCode::CapabilityTokenInvalid
        | ErrorCode::CapabilityTokenExpired
        | ErrorCode::CapabilityTokenRevoked => tonic::Code::PermissionDenied,
        ErrorCode::PolicyDenied | ErrorCode::ApprovalRejected => tonic::Code::PermissionDenied,
        ErrorCode::ApprovalRequired
        | ErrorCode::SandboxUnavailable
        | ErrorCode::SandboxDegraded
        | ErrorCode::UnsupportedPlatform
        | ErrorCode::IntegrityCheckFailed
        | ErrorCode::HashMismatch => tonic::Code::FailedPrecondition,
        ErrorCode::ResourceExhausted | ErrorCode::BudgetExhausted => tonic::Code::ResourceExhausted,
        ErrorCode::Timeout => tonic::Code::DeadlineExceeded,
        ErrorCode::Cancelled => tonic::Code::Cancelled,
        ErrorCode::ExternalDependencyFailed | ErrorCode::ProviderError => tonic::Code::Unavailable,
        ErrorCode::UnknownSettlement => tonic::Code::Unknown,
        ErrorCode::Internal => tonic::Code::Internal,
        ErrorCode::TaintedByUntrustedSource => tonic::Code::PermissionDenied,
        ErrorCode::NotImplemented => tonic::Code::Unimplemented,
    };
    let terminus_kernel_protocol::KernelError::Structured {
        message,
        details,
        suggested_action,
        trace_id,
        ..
    } = &error;

    // The message is the primary diagnostic: the HTTP path has always
    // preserved it (`error.rs::ApiError::from_kernel`) while gRPC callers got
    // the constant "kernel request failed" and had to guess. Both transports
    // now carry the same text, scrubbed and bounded.
    let mut status = Status::new(code, scrub_error_text(message, MAX_STATUS_MESSAGE_BYTES));
    let metadata = status.metadata_mut();
    if let Ok(value) = tonic::metadata::MetadataValue::try_from(error.code_name()) {
        metadata.insert("terminus-error-code", value);
    }
    if let Ok(value) = tonic::metadata::MetadataValue::try_from(error.category().as_str()) {
        metadata.insert("terminus-error-category", value);
    }
    if let Ok(value) =
        tonic::metadata::MetadataValue::try_from(if error.retryable() { "true" } else { "false" })
    {
        metadata.insert("terminus-error-retryable", value);
    }
    // Structured payload mirroring the SPEC §30.4 HTTP envelope. Binary
    // metadata so the JSON survives transport unmodified, and bounded so a
    // large `details` object can never exceed the peer's header limit.
    let envelope = error_envelope(
        &error,
        details,
        suggested_action.as_deref(),
        trace_id.as_deref(),
    );
    metadata.insert_bin(
        TERMINUS_ERROR_METADATA_KEY,
        tonic::metadata::BinaryMetadataValue::from_bytes(envelope.as_bytes()),
    );
    status
}

/// Frame ceilings for `ConnectorService` only. They mirror the per-descriptor
/// connector bounds plus protobuf framing overhead, so the byte limits the
/// broker enforces are actually reachable over the wire instead of failing at
/// the encoder. Every other service keeps the 8 MiB default.
const MAX_CONNECTOR_REQUEST_MESSAGE_BYTES: usize = 12 * 1024 * 1024;
const MAX_CONNECTOR_RESPONSE_MESSAGE_BYTES: usize = 40 * 1024 * 1024;

/// Binary metadata key carrying the SPEC §30.4 error envelope as JSON.
pub const TERMINUS_ERROR_METADATA_KEY: &str = "terminus-error-bin";
/// gRPC implementations commonly cap total header bytes at 8 KiB; keep both
/// the message and the envelope well inside that.
const MAX_STATUS_MESSAGE_BYTES: usize = 2 * 1024;
const MAX_ERROR_ENVELOPE_BYTES: usize = 4 * 1024;

/// Build the bounded JSON envelope. When `details` would push the payload
/// past the bound it is dropped and the omission is stated explicitly —
/// never silently truncated (AGENTS.md "no silent truncation").
fn error_envelope(
    error: &terminus_kernel_protocol::KernelError,
    details: &serde_json::Value,
    suggested_action: Option<&str>,
    trace_id: Option<&str>,
) -> String {
    let base = |details: serde_json::Value, details_omitted: bool| {
        serde_json::json!({
            "code": error.code_name(),
            "category": error.category().as_str(),
            "retryable": error.retryable(),
            "message": scrub_error_text(&error.to_string(), MAX_STATUS_MESSAGE_BYTES),
            "details": details,
            "details_omitted": details_omitted,
            "suggested_action": suggested_action.map(|a| scrub_error_text(a, 512)),
            "trace_id": trace_id,
        })
    };
    let scrubbed_details = scrub_json(details);
    let full = base(scrubbed_details, false);
    let rendered = serde_json::to_string(&full).unwrap_or_default();
    if rendered.len() <= MAX_ERROR_ENVELOPE_BYTES && !rendered.is_empty() {
        return rendered;
    }
    let reduced = base(serde_json::Value::Null, true);
    serde_json::to_string(&reduced).unwrap_or_else(|_| {
        format!(
            r#"{{"code":"{}","details_omitted":true}}"#,
            error.code_name()
        )
    })
}

/// Known credential shapes that must never reach a client, a log, or an
/// artifact. Kernel error messages carry URIs and identifiers rather than
/// secret values, but this is the last boundary before the wire, so it fails
/// closed on anything token-shaped regardless of which layer produced it.
const CREDENTIAL_PREFIXES: &[&str] = &[
    "sk-",
    "sk_",
    "pk_",
    "ghp_",
    "gho_",
    "ghs_",
    "ghu_",
    "github_pat_",
    "xoxb-",
    "xoxp-",
    "xapp-",
    "AKIA",
    "ASIA",
    "eyJ", // JWT header
];

/// Replace token-shaped runs with a marker and bound the result. Splitting on
/// characters that never occur inside a token keeps identifiers, paths, and
/// host names readable.
fn scrub_error_text(text: &str, max_bytes: usize) -> String {
    fn is_separator(c: char) -> bool {
        c.is_whitespace() || matches!(c, '"' | '\'' | ',' | ';' | '(' | ')' | '<' | '>')
    }
    let mut out = String::with_capacity(text.len().min(max_bytes));
    let mut redact_next = false;
    for token in text.split_inclusive(is_separator) {
        let (word, trailing) = match token.char_indices().next_back() {
            Some((index, last)) if is_separator(last) => token.split_at(index),
            _ => (token, ""),
        };
        let looks_secret = redact_next
            || CREDENTIAL_PREFIXES
                .iter()
                .any(|prefix| word.starts_with(prefix));
        // `Bearer <token>`: the value follows the scheme name.
        redact_next = word.eq_ignore_ascii_case("bearer");
        if looks_secret && !word.is_empty() {
            out.push_str("[redacted]");
        } else {
            out.push_str(word);
        }
        out.push_str(trailing);
    }
    if out.len() > max_bytes {
        const MARKER: &str = " … (truncated)";
        let mut cut = max_bytes.saturating_sub(MARKER.len());
        while cut > 0 && !out.is_char_boundary(cut) {
            cut -= 1;
        }
        out.truncate(cut);
        out.push_str(MARKER);
    }
    out
}

/// Apply [`scrub_error_text`] to every string in a details payload.
fn scrub_json(value: &serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::String(text) => {
            serde_json::Value::String(scrub_error_text(text, MAX_STATUS_MESSAGE_BYTES))
        }
        serde_json::Value::Array(items) => {
            serde_json::Value::Array(items.iter().map(scrub_json).collect())
        }
        serde_json::Value::Object(map) => serde_json::Value::Object(
            map.iter()
                .map(|(key, value)| (key.clone(), scrub_json(value)))
                .collect(),
        ),
        other => other.clone(),
    }
}

fn string(value: &serde_json::Value, key: &str, fallback: &str) -> String {
    value
        .get(key)
        .and_then(serde_json::Value::as_str)
        .unwrap_or(fallback)
        .to_string()
}

fn strings(value: &serde_json::Value, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(serde_json::Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(serde_json::Value::as_str)
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// Serve the canonical Protobuf API over a filesystem-restricted Unix socket.
#[cfg(unix)]
pub async fn serve_grpc(
    socket_path: PathBuf,
    kernel: terminus_kernel::KernelHandle,
    desktop_parent_pid: Option<u32>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let control_bootstrap = ControlBootstrapConfig::from_uds_environment()
        .map_err(|error| -> Box<dyn std::error::Error + Send + Sync> { error.into() })?;
    if let Some(parent) = socket_path.parent() {
        tokio::fs::create_dir_all(parent).await?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::{MetadataExt, PermissionsExt};
            let metadata = tokio::fs::symlink_metadata(parent).await?;
            if !metadata.is_dir() || metadata.mode() & 0o077 != 0 {
                return Err(format!(
                    "gRPC socket parent {} must be a private directory",
                    parent.display()
                )
                .into());
            }
            let parent_uid = metadata.uid();
            tokio::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700)).await?;
            if tokio::fs::symlink_metadata(parent).await?.uid() != parent_uid {
                return Err(format!(
                    "gRPC socket parent {} changed owner during setup",
                    parent.display()
                )
                .into());
            }
        }
    }
    #[cfg(unix)]
    let expected_owner = match socket_path.parent() {
        Some(parent) => {
            let metadata = tokio::fs::symlink_metadata(parent).await?;
            use std::os::unix::fs::MetadataExt;
            Some(metadata.uid())
        }
        None => None,
    };
    match tokio::fs::symlink_metadata(&socket_path).await {
        Ok(metadata) => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::{FileTypeExt, MetadataExt};
                if !metadata.file_type().is_socket() {
                    return Err(format!(
                        "refusing to replace non-socket path {}",
                        socket_path.display()
                    )
                    .into());
                }
                if metadata.mode() & 0o077 != 0 {
                    return Err(format!(
                        "refusing to replace a group/world-accessible socket {}",
                        socket_path.display()
                    )
                    .into());
                }
                if expected_owner != Some(metadata.uid()) {
                    return Err(format!(
                        "refusing to replace a socket not owned by the private parent owner {}",
                        socket_path.display()
                    )
                    .into());
                }
            }
            tokio::fs::remove_file(&socket_path).await?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }

    let listener = tokio::net::UnixListener::bind(&socket_path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(&socket_path, std::fs::Permissions::from_mode(0o600)).await?;
        use std::os::unix::fs::{FileTypeExt, MetadataExt};
        let metadata = tokio::fs::symlink_metadata(&socket_path).await?;
        if !metadata.file_type().is_socket()
            || metadata.mode() & 0o077 != 0
            || expected_owner != Some(metadata.uid())
        {
            let _ = tokio::fs::remove_file(&socket_path).await;
            return Err(format!(
                "gRPC socket {} failed ownership or mode verification",
                socket_path.display()
            )
            .into());
        }
    }

    tracing::info!(socket = %socket_path.display(), "kernel gRPC listening on UDS");
    const MAX_GRPC_MESSAGE_BYTES: usize = 8 * 1024 * 1024;
    let signal_shutdown_kernel = kernel.clone();
    let fallback_shutdown_kernel = kernel.clone();
    let (shutdown_result_sender, shutdown_result_receiver) = tokio::sync::oneshot::channel();
    let shutdown = async move {
        crate::shutdown_signal(desktop_parent_pid).await;
        let result = signal_shutdown_kernel
            .shutdown()
            .await
            .map_err(|error| error.to_string());
        let _ = shutdown_result_sender.send(result);
    };
    let service = GrpcKernel::new(kernel, control_bootstrap);
    // SPEC §31.3 step 9: every RPC gets a server-side budget even when the
    // caller sends no deadline, bounding both the response future and the
    // response body so a wedged handler or stream cannot pin a worker.
    let result = Server::builder()
        .layer(crate::deadline::DeadlineLayer)
        .add_service(
            KernelInfoServiceServer::new(service.clone())
                .max_decoding_message_size(MAX_GRPC_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_GRPC_MESSAGE_BYTES),
        )
        .add_service(
            FileServiceServer::new(service.clone())
                .max_decoding_message_size(MAX_GRPC_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_GRPC_MESSAGE_BYTES),
        )
        .add_service(
            PatchServiceServer::new(service.clone())
                .max_decoding_message_size(MAX_GRPC_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_GRPC_MESSAGE_BYTES),
        )
        .add_service(
            ProcessServiceServer::new(service.clone())
                .max_decoding_message_size(MAX_GRPC_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_GRPC_MESSAGE_BYTES),
        )
        .add_service(
            JobServiceServer::new(service.clone())
                .max_decoding_message_size(MAX_GRPC_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_GRPC_MESSAGE_BYTES),
        )
        .add_service(
            ComputerUseServiceServer::new(service.clone())
                .max_decoding_message_size(MAX_GRPC_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_GRPC_MESSAGE_BYTES),
        )
        .add_service(
            WorkspaceServiceServer::new(service.clone())
                .max_decoding_message_size(MAX_GRPC_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_GRPC_MESSAGE_BYTES),
        )
        .add_service(
            SandboxServiceServer::new(service.clone())
                .max_decoding_message_size(MAX_GRPC_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_GRPC_MESSAGE_BYTES),
        )
        .add_service(
            PolicyServiceServer::new(service.clone())
                .max_decoding_message_size(MAX_GRPC_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_GRPC_MESSAGE_BYTES),
        )
        .add_service(
            SecretServiceServer::new(service.clone())
                .max_decoding_message_size(MAX_GRPC_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_GRPC_MESSAGE_BYTES),
        )
        .add_service(
            ProviderAccountServiceServer::new(service.clone())
                .max_decoding_message_size(MAX_GRPC_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_GRPC_MESSAGE_BYTES),
        )
        .add_service(
            NetworkServiceServer::new(service.clone())
                .max_decoding_message_size(MAX_GRPC_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_GRPC_MESSAGE_BYTES),
        )
        .add_service(
            // Model connectors carry compiled context in and a full streamed
            // completion out (§4(f) bounds: 8 MiB request / 32 MiB response).
            // Only THIS service gets the wider frame, and only the amounts
            // the connector descriptors already enforce.
            ConnectorServiceServer::new(service.clone())
                .max_decoding_message_size(MAX_CONNECTOR_REQUEST_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_CONNECTOR_RESPONSE_MESSAGE_BYTES),
        )
        .add_service(
            CodeIntelligenceServiceServer::new(service.clone())
                .max_decoding_message_size(MAX_GRPC_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_GRPC_MESSAGE_BYTES),
        )
        .add_service(
            ExtensionRuntimeServiceServer::new(service.clone())
                .max_decoding_message_size(MAX_GRPC_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_GRPC_MESSAGE_BYTES),
        )
        .add_service(
            ArtifactIngestServiceServer::new(service)
                .max_decoding_message_size(MAX_GRPC_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_GRPC_MESSAGE_BYTES),
        )
        .serve_with_incoming_shutdown(
            tokio_stream::wrappers::UnixListenerStream::new(listener),
            shutdown,
        )
        .await;
    // If the server failed before a shutdown signal, its shutdown future was
    // dropped. Reap every owned process before returning the transport error.
    let shutdown_result = match shutdown_result_receiver.await {
        Ok(result) => result,
        Err(_) => fallback_shutdown_kernel
            .shutdown()
            .await
            .map_err(|error| error.to_string()),
    };
    let _ = tokio::fs::remove_file(&socket_path).await;
    result?;
    shutdown_result
        .map_err(|error| -> Box<dyn std::error::Error + Send + Sync> { error.into() })?;
    Ok(())
}

/// Serve the kernel gRPC API over TCP with mandatory mutual TLS (remote mode).
pub async fn serve_grpc_mtls(
    bind_addr: std::net::SocketAddr,
    kernel: terminus_kernel::KernelHandle,
    material: &terminus_remote::MtlsMaterial,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let control_bootstrap = ControlBootstrapConfig::disabled_from_environment()
        .map_err(|error| -> Box<dyn std::error::Error + Send + Sync> { error.into() })?;
    material
        .validate()
        .map_err(|error| -> Box<dyn std::error::Error + Send + Sync> {
            error.to_string().into()
        })?;
    let cert = tokio::fs::read(&material.cert_pem_path).await?;
    let key = tokio::fs::read(&material.key_pem_path).await?;
    let ca = tokio::fs::read(&material.client_ca_pem_path).await?;
    let identity = tonic::transport::Identity::from_pem(cert, key);
    let client_ca = tonic::transport::Certificate::from_pem(ca);
    let tls = tonic::transport::ServerTlsConfig::new()
        .identity(identity)
        .client_ca_root(client_ca);
    tracing::info!(
        %bind_addr,
        peer = %material.expected_peer.as_str(),
        "kernel gRPC listening on mTLS"
    );
    const MAX_GRPC_MESSAGE_BYTES: usize = 8 * 1024 * 1024;
    // Bootstrap is a local owner-only UDS trust boundary. The remote mTLS
    // listener can use an externally provisioned broker but can never mint
    // that broker through KernelInfoService.
    let signal_shutdown_kernel = kernel.clone();
    let fallback_shutdown_kernel = kernel.clone();
    let (shutdown_result_sender, shutdown_result_receiver) = tokio::sync::oneshot::channel();
    let shutdown = async move {
        crate::shutdown_signal(None).await;
        let result = signal_shutdown_kernel
            .shutdown()
            .await
            .map_err(|error| error.to_string());
        let _ = shutdown_result_sender.send(result);
    };
    let service = GrpcKernel::new(kernel, control_bootstrap);
    // SPEC §31.3 step 9: every RPC gets a server-side budget even when the
    // caller sends no deadline, bounding both the response future and the
    // response body so a wedged handler or stream cannot pin a worker.
    let result = Server::builder()
        .layer(crate::deadline::DeadlineLayer)
        .tls_config(tls)?
        .add_service(
            KernelInfoServiceServer::new(service.clone())
                .max_decoding_message_size(MAX_GRPC_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_GRPC_MESSAGE_BYTES),
        )
        .add_service(
            FileServiceServer::new(service.clone())
                .max_decoding_message_size(MAX_GRPC_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_GRPC_MESSAGE_BYTES),
        )
        .add_service(
            PatchServiceServer::new(service.clone())
                .max_decoding_message_size(MAX_GRPC_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_GRPC_MESSAGE_BYTES),
        )
        .add_service(
            ProcessServiceServer::new(service.clone())
                .max_decoding_message_size(MAX_GRPC_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_GRPC_MESSAGE_BYTES),
        )
        .add_service(
            JobServiceServer::new(service.clone())
                .max_decoding_message_size(MAX_GRPC_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_GRPC_MESSAGE_BYTES),
        )
        .add_service(
            ComputerUseServiceServer::new(service.clone())
                .max_decoding_message_size(MAX_GRPC_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_GRPC_MESSAGE_BYTES),
        )
        .add_service(
            WorkspaceServiceServer::new(service.clone())
                .max_decoding_message_size(MAX_GRPC_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_GRPC_MESSAGE_BYTES),
        )
        .add_service(
            SandboxServiceServer::new(service.clone())
                .max_decoding_message_size(MAX_GRPC_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_GRPC_MESSAGE_BYTES),
        )
        .add_service(
            PolicyServiceServer::new(service.clone())
                .max_decoding_message_size(MAX_GRPC_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_GRPC_MESSAGE_BYTES),
        )
        .add_service(
            SecretServiceServer::new(service.clone())
                .max_decoding_message_size(MAX_GRPC_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_GRPC_MESSAGE_BYTES),
        )
        .add_service(
            ProviderAccountServiceServer::new(service.clone())
                .max_decoding_message_size(MAX_GRPC_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_GRPC_MESSAGE_BYTES),
        )
        .add_service(
            NetworkServiceServer::new(service.clone())
                .max_decoding_message_size(MAX_GRPC_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_GRPC_MESSAGE_BYTES),
        )
        .add_service(
            // Model connectors carry compiled context in and a full streamed
            // completion out (§4(f) bounds: 8 MiB request / 32 MiB response).
            // Only THIS service gets the wider frame, and only the amounts
            // the connector descriptors already enforce.
            ConnectorServiceServer::new(service.clone())
                .max_decoding_message_size(MAX_CONNECTOR_REQUEST_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_CONNECTOR_RESPONSE_MESSAGE_BYTES),
        )
        .add_service(
            CodeIntelligenceServiceServer::new(service.clone())
                .max_decoding_message_size(MAX_GRPC_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_GRPC_MESSAGE_BYTES),
        )
        .add_service(
            ExtensionRuntimeServiceServer::new(service.clone())
                .max_decoding_message_size(MAX_GRPC_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_GRPC_MESSAGE_BYTES),
        )
        .add_service(
            ArtifactIngestServiceServer::new(service)
                .max_decoding_message_size(MAX_GRPC_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_GRPC_MESSAGE_BYTES),
        )
        .serve_with_shutdown(bind_addr, shutdown)
        .await;
    let shutdown_result = match shutdown_result_receiver.await {
        Ok(result) => result,
        Err(_) => fallback_shutdown_kernel
            .shutdown()
            .await
            .map_err(|error| error.to_string()),
    };
    result?;
    shutdown_result
        .map_err(|error| -> Box<dyn std::error::Error + Send + Sync> { error.into() })?;
    Ok(())
}

/// Windows has no Unix-domain socket transport. Refuse startup explicitly
/// rather than silently replacing the authenticated local transport with TCP.
#[cfg(not(unix))]
pub async fn serve_grpc(
    _socket_path: PathBuf,
    _kernel: terminus_kernel::KernelHandle,
    _desktop_parent_pid: Option<u32>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    Err("the kernel gRPC UDS transport is unsupported on this platform".into())
}

/// Server-stream adapter that keeps the pumping task observed: the join
/// handle is polled to completion once the channel closes, so no spawned
/// work escapes supervision.
impl PumpStream {
    fn poll_pump(
        pump: &mut tokio::task::JoinHandle<()>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<<Self as tokio_stream::Stream>::Item>> {
        use std::future::Future;
        match std::pin::Pin::new(pump).poll(cx) {
            std::task::Poll::Ready(Ok(())) => std::task::Poll::Ready(None),
            std::task::Poll::Ready(Err(join_error)) => std::task::Poll::Ready(Some(Err(
                Status::internal(format!("connector stream pump failed: {join_error}")),
            ))),
            std::task::Poll::Pending => std::task::Poll::Pending,
        }
    }
}

struct PumpStream {
    rx: tokio::sync::mpsc::Receiver<Result<protocol::ConnectorChunk, Status>>,
    pump: tokio::task::JoinHandle<()>,
    cancel: terminus_connector::CancelToken,
}

/// A gRPC client that goes away — cancelled RPC, dropped stream, closed
/// connection — drops the response stream. Before, the JoinHandle went with
/// it and the dispatch task ran on detached: the provider kept generating
/// (and billing) a completion nobody would read, for up to the connector's
/// 300 s total bound. Now the drop cancels the dispatch (which tears the
/// HTTPS connection down at the next await point) and aborts the task.
impl Drop for PumpStream {
    fn drop(&mut self) {
        self.cancel.cancel();
        self.pump.abort();
    }
}

impl tokio_stream::Stream for PumpStream {
    type Item = Result<protocol::ConnectorChunk, Status>;

    fn poll_next(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Self::Item>> {
        match self.rx.poll_recv(cx) {
            std::task::Poll::Ready(Some(item)) => std::task::Poll::Ready(Some(item)),
            std::task::Poll::Ready(None) => {
                // Channel closed: observe the pump's completion.
                Self::poll_pump(&mut self.pump, cx)
            }
            std::task::Poll::Pending => std::task::Poll::Pending,
        }
    }
}

#[cfg(test)]
#[cfg(unix)]
mod tests {
    use super::*;
    use hyper_util::rt::TokioIo;
    use protocol::artifact_ingest_service_client::ArtifactIngestServiceClient;
    use protocol::job_service_client::JobServiceClient;
    use protocol::kernel_info_service_client::KernelInfoServiceClient;
    use protocol::process_service_client::ProcessServiceClient;
    use protocol::sandbox_service_client::SandboxServiceClient;
    use protocol::workspace_service_client::WorkspaceServiceClient;
    use std::os::unix::fs::PermissionsExt;
    use terminus_authz::{OperationClass, Scope, TokenBinder};
    use tokio::net::UnixStream;
    use tonic::transport::{Endpoint, Uri};
    use tower::service_fn;

    const TEST_BOOTSTRAP_TOKEN: &str = "test_bootstrap_token_0123456789abcdef";

    fn test_bootstrap_config(enabled: bool) -> ControlBootstrapConfig {
        ControlBootstrapConfig {
            enabled,
            principal: "terminus-control-test".to_string(),
            ttl_seconds: 120,
            token: if enabled {
                TEST_BOOTSTRAP_TOKEN.to_string()
            } else {
                String::new()
            },
        }
    }

    #[tokio::test]
    async fn completed_job_stream_releases_only_its_registry_entry() {
        let streams = std::sync::Arc::new(tokio::sync::Mutex::new(HashMap::new()));
        let completed = std::sync::Arc::new(JobStreamBuffer::default());
        streams
            .lock()
            .await
            .insert("job-1".to_string(), std::sync::Arc::clone(&completed));

        remove_completed_job_stream(&streams, "job-1", &completed).await;
        assert!(!streams.lock().await.contains_key("job-1"));

        let replacement = std::sync::Arc::new(JobStreamBuffer::default());
        streams
            .lock()
            .await
            .insert("job-1".to_string(), std::sync::Arc::clone(&replacement));
        remove_completed_job_stream(&streams, "job-1", &completed).await;
        let current = streams.lock().await.get("job-1").cloned();
        assert!(current
            .as_ref()
            .map(|stream| std::sync::Arc::ptr_eq(stream, &replacement))
            .unwrap_or(false));
    }

    fn bootstrap_request(principal: &str) -> Request<protocol::BootstrapControlRequest> {
        let mut request = Request::new(protocol::BootstrapControlRequest {
            principal: principal.to_string(),
        });
        request.metadata_mut().insert(
            CONTROL_BOOTSTRAP_METADATA,
            tonic::metadata::MetadataValue::from_static(TEST_BOOTSTRAP_TOKEN),
        );
        request
    }

    fn test_kernel() -> (tempfile::TempDir, terminus_kernel::KernelHandle) {
        let data_dir = tempfile::tempdir().expect("kernel data dir");
        let kernel =
            terminus_kernel::KernelHandle::new(data_dir.path().to_path_buf()).expect("test kernel");
        (data_dir, kernel)
    }

    fn register_test_workspace(
        kernel: &terminus_kernel::KernelHandle,
        workspace_id: &str,
        root: &std::path::Path,
    ) {
        let token = kernel
            .token_issuer
            .mint(
                TokenBinder {
                    principal: "terminus-control-test".to_string(),
                    session_id: "control".to_string(),
                    task_id: "control-maintenance".to_string(),
                    workspace_id: "*".to_string(),
                    kernel_instance_id: String::new(),
                },
                vec![OperationClass::Admin],
                Scope::default(),
                None,
                format!("register-{workspace_id}"),
            )
            .expect("admin capability")
            .encode()
            .expect("encoded admin capability");
        let mut context =
            terminus_kernel_protocol::RequestContext::new(format!("register-{workspace_id}"));
        context.session_id = "control".to_string();
        context.task_id = "control-maintenance".to_string();
        context.actor_id = "terminus-control-test".to_string();
        context.workspace_id = "*".to_string();
        context.capability_token = token;
        kernel
            .workspaces
            .register_with_id(
                &context,
                &Default::default(),
                format!("file://{}", root.display()),
                root.display().to_string(),
                "restricted",
                Some(workspace_id),
            )
            .expect("registered test workspace");
    }

    fn broker_context(token: String, task_id: &str) -> protocol::RequestContext {
        protocol::RequestContext {
            request_id: terminus_kernel_protocol::new_id(),
            idempotency_key: String::new(),
            session_id: "control".to_string(),
            task_id: task_id.to_string(),
            turn_id: "bootstrap-test".to_string(),
            actor_id: "terminus-control-test".to_string(),
            traceparent: String::new(),
            capability_token: token,
            workspace_id: "*".to_string(),
            ..Default::default()
        }
    }

    fn task_capability_request(
        token: String,
        broker_task_id: &str,
    ) -> protocol::MintTaskCapabilityRequest {
        protocol::MintTaskCapabilityRequest {
            context: Some(broker_context(token, broker_task_id)),
            principal: "terminus-control-test".to_string(),
            session_id: "session-1".to_string(),
            task_id: "task-1".to_string(),
            workspace_id: "workspace-1".to_string(),
            operation_classes: vec![
                protocol::CapabilityOperationProto::CapabilityOperationRead as i32,
                protocol::CapabilityOperationProto::CapabilityOperationArtifactIngest as i32,
            ],
            workspace_paths: vec!["src/**".to_string()],
            network_destinations: Vec::new(),
            secret_capabilities: Vec::new(),
            ttl_seconds: 120,
        }
    }

    // ---- K1: structured errors survive the gRPC boundary ---------------

    /// Mint a capability bound to one task for the given operation classes.
    fn task_bound_token(
        kernel: &terminus_kernel::KernelHandle,
        task_id: &str,
        classes: Vec<OperationClass>,
    ) -> String {
        kernel
            .token_issuer
            .mint(
                TokenBinder {
                    principal: "terminus-control-test".to_string(),
                    session_id: "session".to_string(),
                    task_id: task_id.to_string(),
                    workspace_id: "*".to_string(),
                    kernel_instance_id: String::new(),
                },
                classes,
                Scope::default(),
                None,
                format!("token-{task_id}"),
            )
            .and_then(|token| token.encode())
            .unwrap_or_default()
    }

    fn error_envelope_of(status: &Status) -> serde_json::Value {
        let raw = status
            .metadata()
            .get_bin(TERMINUS_ERROR_METADATA_KEY)
            .and_then(|value| value.to_bytes().ok())
            .unwrap_or_default();
        serde_json::from_slice(&raw).unwrap_or(serde_json::Value::Null)
    }

    #[tokio::test]
    async fn rejected_artifact_link_status_names_the_owner_type_and_purpose() {
        let (_data_dir, kernel) = test_kernel();
        let token = task_bound_token(&kernel, "task-1", vec![OperationClass::ArtifactIngest]);
        let service = GrpcKernel::new(kernel, test_bootstrap_config(false));

        let mut context = broker_context(token, "task-1");
        context.request_id = "link-rejection".to_string();
        // The capability binder pins the session; the context must match it
        // or the request fails on permission before reaching the allowlist.
        context.session_id = "session".to_string();
        let status = ArtifactIngestRpc::link(
            &service,
            Request::new(protocol::LinkArtifactRequest {
                context: Some(context),
                sha256: format!("sha256:{}", "0".repeat(64)),
                owner_type: "session".to_string(),
                owner_id: "owner-1".to_string(),
                purpose: "scratch".to_string(),
                owner_task_id: "task-1".to_string(),
            }),
        )
        .await
        .expect_err("an unadmitted ownership pair must be rejected");

        assert_eq!(status.code(), tonic::Code::InvalidArgument);
        // The whole point of K1: the message is the real diagnostic, not the
        // constant "kernel request failed".
        assert_ne!(status.message(), "kernel request failed");
        assert!(
            status.message().contains("session") && status.message().contains("scratch"),
            "status message must name the rejected pair: {}",
            status.message()
        );

        let envelope = error_envelope_of(&status);
        assert_eq!(envelope["code"], "INVALID_ARGUMENT");
        assert_eq!(envelope["category"], "validation");
        assert_eq!(envelope["retryable"], false);
        assert_eq!(envelope["details"]["owner_type"], "session");
        assert_eq!(envelope["details"]["purpose"], "scratch");
        assert_eq!(envelope["details_omitted"], false);

        // Legacy metadata keys stay populated for existing consumers.
        assert_eq!(
            status
                .metadata()
                .get("terminus-error-code")
                .and_then(|v| v.to_str().ok()),
            Some("INVALID_ARGUMENT")
        );
    }

    #[test]
    fn oversized_detail_strings_are_truncated_with_a_marker() {
        let error = terminus_kernel_protocol::KernelError::new(
            terminus_kernel_protocol::ErrorCode::Internal,
            terminus_kernel_protocol::ErrorCategory::Internal,
            "long detail",
            false,
        )
        .with_details(serde_json::json!({ "blob": "x".repeat(8192) }));
        let status = status(error);
        let envelope = error_envelope_of(&status);
        let blob = envelope["details"]["blob"].as_str().unwrap_or_default();
        assert!(blob.len() <= MAX_STATUS_MESSAGE_BYTES, "{}", blob.len());
        assert!(
            blob.ends_with(" … (truncated)"),
            "truncation must be stated"
        );
    }

    #[test]
    fn error_envelope_is_bounded_and_states_omission() {
        // Many keys, each individually within the per-string bound, so only
        // the aggregate exceeds the envelope budget.
        let mut map = serde_json::Map::new();
        for index in 0..64 {
            map.insert(format!("key-{index}"), serde_json::json!("v".repeat(200)));
        }
        let details = serde_json::Value::Object(map);
        let error = terminus_kernel_protocol::KernelError::new(
            terminus_kernel_protocol::ErrorCode::Internal,
            terminus_kernel_protocol::ErrorCategory::Internal,
            "oversized details",
            false,
        )
        .with_details(details);
        let status = status(error);
        let raw = status
            .metadata()
            .get_bin(TERMINUS_ERROR_METADATA_KEY)
            .and_then(|value| value.to_bytes().ok())
            .unwrap_or_default();
        assert!(raw.len() <= MAX_ERROR_ENVELOPE_BYTES, "{}", raw.len());
        let envelope: serde_json::Value =
            serde_json::from_slice(&raw).unwrap_or(serde_json::Value::Null);
        // Dropped, and explicitly reported as dropped — never silently cut.
        assert_eq!(envelope["details_omitted"], true);
        assert_eq!(envelope["details"], serde_json::Value::Null);
    }

    #[test]
    fn error_text_scrubs_credential_shapes() {
        let cases = [
            ("Authorization: Bearer ghp_CANARY", "ghp_"),
            ("token sk-proj-canary failed", "sk-"),
            ("jwt eyJhbGciOiJSUzI1NiJ9.payload.sig rejected", "eyJ"),
            ("aws key AKIA-CANARY denied", "AKIA"),
        ];
        for (input, marker) in cases {
            let scrubbed = scrub_error_text(input, 2048);
            assert!(
                !scrubbed.contains(marker),
                "credential shape survived scrubbing: {scrubbed}"
            );
            assert!(scrubbed.contains("[redacted]"), "{scrubbed}");
        }
        // Ordinary diagnostics survive intact.
        let benign = "workspace ws-1 path src/main.rs not found (host api.openai.com)";
        assert_eq!(scrub_error_text(benign, 2048), benign);
    }

    #[test]
    fn error_text_truncation_is_announced() {
        let long = "a".repeat(4096);
        let scrubbed = scrub_error_text(&long, 128);
        assert!(scrubbed.len() <= 128, "{}", scrubbed.len());
        assert!(scrubbed.ends_with(" … (truncated)"), "{scrubbed}");
    }

    // ---- K2: exec/job timeouts are never unbounded by accident ----------

    #[test]
    fn absent_timeout_resolves_to_the_rpc_class_default() {
        assert_eq!(
            resolve_command_timeout_ms(0, false, DEFAULT_EXEC_TIMEOUT_MS),
            120_000
        );
        assert_eq!(
            resolve_command_timeout_ms(0, false, DEFAULT_JOB_TIMEOUT_MS),
            1_800_000
        );
        // An explicit request always wins over the class default.
        assert_eq!(
            resolve_command_timeout_ms(5_000, false, DEFAULT_JOB_TIMEOUT_MS),
            5_000
        );
    }

    #[test]
    fn unbounded_runtime_requires_the_explicit_opt_in() {
        assert_eq!(
            resolve_command_timeout_ms(0, true, DEFAULT_EXEC_TIMEOUT_MS),
            terminus_process::UNBOUNDED_TIMEOUT_MS
        );
        // The opt-in never overrides a concrete request.
        assert_eq!(
            resolve_command_timeout_ms(2_500, true, DEFAULT_EXEC_TIMEOUT_MS),
            2_500
        );
        // And the sentinel really is unbounded downstream.
        assert_eq!(
            terminus_process::effective_timeout_ms(terminus_process::UNBOUNDED_TIMEOUT_MS),
            None
        );
        assert_eq!(
            terminus_process::effective_timeout_ms(120_000),
            Some(120_000)
        );
    }

    #[test]
    fn command_conversion_applies_the_class_default() {
        let spec = |allow_unbounded: bool| protocol::CommandSpec {
            program: "/bin/ls".to_string(),
            args: Vec::new(),
            cwd: Some(protocol::WorkspacePath {
                workspace_id: "workspace".to_string(),
                relative_path: ".".to_string(),
            }),
            public_env: Default::default(),
            secret_capability_uris: Vec::new(),
            timeout: None,
            allocate_pty: false,
            shell: None,
            allow_unbounded_timeout: allow_unbounded,
        };
        let exec = command(spec(false), DEFAULT_EXEC_TIMEOUT_MS)
            .map(|c| c.timeout_ms)
            .unwrap_or_default();
        assert_eq!(exec, DEFAULT_EXEC_TIMEOUT_MS);
        let job = command(spec(false), DEFAULT_JOB_TIMEOUT_MS)
            .map(|c| c.timeout_ms)
            .unwrap_or_default();
        assert_eq!(job, DEFAULT_JOB_TIMEOUT_MS);
        let unbounded = command(spec(true), DEFAULT_EXEC_TIMEOUT_MS)
            .map(|c| c.timeout_ms)
            .unwrap_or_default();
        assert_eq!(unbounded, terminus_process::UNBOUNDED_TIMEOUT_MS);
    }

    // ---- K7: server-side deadline defaults ------------------------------

    #[test]
    fn an_absent_caller_deadline_is_filled_in_per_rpc_class() {
        let bare = protocol::RequestContext {
            request_id: "no-deadline".to_string(),
            ..Default::default()
        };
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| u64::try_from(d.as_millis()).unwrap_or(0))
            .unwrap_or(0);

        let unary = context(bare.clone());
        assert!(
            unary.deadline_unix_ms > now_ms,
            "unary deadline must be set"
        );
        assert!(
            unary.deadline_unix_ms <= now_ms + 31_000,
            "unary budget should be ~30s, got {}",
            unary.deadline_unix_ms - now_ms
        );

        let long = context_long_running(bare);
        assert!(
            long.deadline_unix_ms > now_ms + 60_000,
            "long-running budget must exceed a minute"
        );
        assert!(long.deadline_unix_ms <= now_ms + 1_801_000);
    }

    #[test]
    fn an_over_long_caller_deadline_is_clamped_to_the_ceiling() {
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| u64::try_from(d.as_millis()).unwrap_or(0))
            .unwrap_or(0);
        let far_future = now_ms + 86_400_000;
        let ctx = protocol::RequestContext {
            request_id: "far-deadline".to_string(),
            deadline: Some(prost_types::Timestamp {
                seconds: i64::try_from(far_future / 1_000).unwrap_or(0),
                nanos: 0,
            }),
            ..Default::default()
        };
        let resolved = context_long_running(ctx);
        assert!(
            resolved.deadline_unix_ms <= now_ms + 1_801_000,
            "a caller deadline beyond the ceiling must be clamped"
        );
    }

    #[tokio::test]
    async fn control_bootstrap_is_disabled_and_principal_bound() {
        let (_data_dir, kernel) = test_kernel();
        let disabled = GrpcKernel::new(kernel.clone(), test_bootstrap_config(false));
        let denied = KernelInfoServiceRpc::bootstrap_control(
            &disabled,
            bootstrap_request("terminus-control-test"),
        )
        .await
        .expect_err("bootstrap must fail closed when disabled");
        assert_eq!(denied.code(), tonic::Code::PermissionDenied);

        let enabled = GrpcKernel::new(kernel, test_bootstrap_config(true));
        let denied = KernelInfoServiceRpc::bootstrap_control(
            &enabled,
            Request::new(protocol::BootstrapControlRequest {
                principal: "terminus-control-test".to_string(),
            }),
        )
        .await
        .expect_err("same-UID callers without the bootstrap credential must be denied");
        assert_eq!(denied.code(), tonic::Code::PermissionDenied);

        let mut wrong_credential = bootstrap_request("terminus-control-test");
        wrong_credential.metadata_mut().insert(
            CONTROL_BOOTSTRAP_METADATA,
            tonic::metadata::MetadataValue::from_static("wrong_bootstrap_token_0123456789abcdef"),
        );
        let denied = KernelInfoServiceRpc::bootstrap_control(&enabled, wrong_credential)
            .await
            .expect_err("an incorrect bootstrap credential must be denied");
        assert_eq!(denied.code(), tonic::Code::PermissionDenied);

        let denied =
            KernelInfoServiceRpc::bootstrap_control(&enabled, bootstrap_request("other-principal"))
                .await
                .expect_err("bootstrap must require the configured principal exactly");
        assert_eq!(denied.code(), tonic::Code::PermissionDenied);
    }

    #[tokio::test]
    async fn control_bootstrap_mints_distinct_bounded_capabilities() {
        let (_data_dir, kernel) = test_kernel();
        let service = GrpcKernel::new(kernel.clone(), test_bootstrap_config(true));
        let response = KernelInfoServiceRpc::bootstrap_control(
            &service,
            bootstrap_request("terminus-control-test"),
        )
        .await
        .expect("enabled bootstrap succeeds")
        .into_inner();
        assert_ne!(
            response.broker_capability_token,
            response.maintenance_capability_token
        );

        let broker = kernel
            .token_issuer
            .validate(&response.broker_capability_token)
            .expect("broker token validates");
        let maintenance = kernel
            .token_issuer
            .validate(&response.maintenance_capability_token)
            .expect("maintenance token validates");
        for (token, task_id) in [
            (&broker, "control-broker"),
            (&maintenance, "control-maintenance"),
        ] {
            assert_eq!(token.claims.binder.principal, "terminus-control-test");
            assert_eq!(token.claims.binder.session_id, "control");
            assert_eq!(token.claims.binder.task_id, task_id);
            assert_eq!(token.claims.binder.workspace_id, "*");
            assert_eq!(token.claims.operation_classes, vec![OperationClass::Admin]);
            assert!(token.claims.expires_at_unix >= response.expires_at_unix);
            assert!(token.claims.expires_at_unix <= response.expires_at_unix + 1);
            assert_eq!(
                token.claims.expires_at_unix - token.claims.issued_at_unix,
                120
            );
        }
        assert_ne!(broker.claims.nonce, maintenance.claims.nonce);
    }

    #[tokio::test]
    async fn broker_mints_only_concrete_non_admin_task_capabilities() {
        let (_data_dir, kernel) = test_kernel();
        let service = GrpcKernel::new(kernel.clone(), test_bootstrap_config(true));
        let bootstrap = KernelInfoServiceRpc::bootstrap_control(
            &service,
            bootstrap_request("terminus-control-test"),
        )
        .await
        .expect("bootstrap succeeds")
        .into_inner();

        let issued = PolicyServiceRpc::mint_task_capability(
            &service,
            Request::new(task_capability_request(
                bootstrap.broker_capability_token.clone(),
                "control-broker",
            )),
        )
        .await
        .expect("broker mints task capability")
        .into_inner();
        let task_token = kernel
            .token_issuer
            .validate(&issued.capability_token)
            .expect("task capability validates");
        assert_eq!(task_token.claims.binder.principal, "terminus-control-test");
        assert_eq!(task_token.claims.binder.session_id, "session-1");
        assert_eq!(task_token.claims.binder.task_id, "task-1");
        assert_eq!(task_token.claims.binder.workspace_id, "workspace-1");
        assert_eq!(
            task_token.claims.operation_classes,
            vec![OperationClass::Read, OperationClass::ArtifactIngest]
        );
        assert_eq!(task_token.claims.max_scope.workspace_paths, ["src/**"]);
        assert_eq!(
            task_token.claims.expires_at_unix - task_token.claims.issued_at_unix,
            120
        );

        let mut wildcard =
            task_capability_request(bootstrap.broker_capability_token.clone(), "control-broker");
        wildcard.task_id = "*".to_string();
        let denied = PolicyServiceRpc::mint_task_capability(&service, Request::new(wildcard))
            .await
            .expect_err("wildcard task binder must be rejected");
        assert_eq!(denied.code(), tonic::Code::InvalidArgument);

        let wrong_broker = task_capability_request(
            bootstrap.maintenance_capability_token,
            "control-maintenance",
        );
        let denied = PolicyServiceRpc::mint_task_capability(&service, Request::new(wrong_broker))
            .await
            .expect_err("maintenance capability is not a broker");
        assert_eq!(denied.code(), tonic::Code::PermissionDenied);

        for forbidden in [OperationClass::Admin, OperationClass::Policy] {
            let denied = validate_task_operation_classes(&[forbidden])
                .expect_err("privileged operation must not be delegated");
            assert_eq!(denied.code(), tonic::Code::PermissionDenied);
        }
    }

    #[tokio::test]
    async fn task_exec_capability_with_no_declared_secrets_denies_arbitrary_secret_uri() {
        let (_data_dir, kernel) = test_kernel();
        let service = GrpcKernel::new(kernel.clone(), test_bootstrap_config(true));
        let bootstrap = KernelInfoServiceRpc::bootstrap_control(
            &service,
            bootstrap_request("terminus-control-test"),
        )
        .await
        .expect("bootstrap succeeds")
        .into_inner();
        let mut request =
            task_capability_request(bootstrap.broker_capability_token, "control-broker");
        request.operation_classes =
            vec![protocol::CapabilityOperationProto::CapabilityOperationExec as i32];
        request.workspace_paths = vec![".".to_string()];
        request.secret_capabilities.clear();
        let issued = PolicyServiceRpc::mint_task_capability(&service, Request::new(request))
            .await
            .expect("broker mints bounded Exec capability")
            .into_inner();
        let context = terminus_kernel_protocol::RequestContext {
            request_id: "exec-secret-denial".to_string(),
            session_id: "session-1".to_string(),
            task_id: "task-1".to_string(),
            actor_id: "terminus-control-test".to_string(),
            workspace_id: "workspace-1".to_string(),
            capability_token: issued.capability_token,
            ..Default::default()
        };
        let denied = kernel
            .processes
            .start_in_profile(
                &context,
                &Default::default(),
                terminus_kernel_protocol::CommandSpec {
                    program: "/bin/cat".to_string(),
                    cwd: terminus_kernel_protocol::WorkspacePath::new("workspace-1", "."),
                    secret_capability_uris: vec!["secret://github/not-declared".to_string()],
                    ..Default::default()
                },
                "degraded-local",
            )
            .await
            .expect_err("omitted task secret scope must deny secret use");
        assert_eq!(
            denied.code(),
            terminus_kernel_protocol::ErrorCode::PermissionDenied
        );
    }

    #[tokio::test]
    async fn task_capability_inputs_have_hard_scope_and_ttl_bounds() {
        let (_data_dir, kernel) = test_kernel();
        let service = GrpcKernel::new(kernel, test_bootstrap_config(true));
        let bootstrap = KernelInfoServiceRpc::bootstrap_control(
            &service,
            bootstrap_request("terminus-control-test"),
        )
        .await
        .expect("bootstrap succeeds")
        .into_inner();

        let mut oversized_scope =
            task_capability_request(bootstrap.broker_capability_token.clone(), "control-broker");
        oversized_scope.workspace_paths = vec!["src/**".to_string(); 65];
        let denied =
            PolicyServiceRpc::mint_task_capability(&service, Request::new(oversized_scope))
                .await
                .expect_err("oversized scope must be rejected");
        assert_eq!(denied.code(), tonic::Code::InvalidArgument);

        let mut excessive_ttl =
            task_capability_request(bootstrap.broker_capability_token, "control-broker");
        excessive_ttl.ttl_seconds = 301;
        let denied = PolicyServiceRpc::mint_task_capability(&service, Request::new(excessive_ttl))
            .await
            .expect_err("excessive TTL must be rejected");
        assert_eq!(denied.code(), tonic::Code::InvalidArgument);
    }

    #[tokio::test]
    async fn code_search_inherits_concrete_context_workspace_and_rejects_cross_root_requests() {
        let (_data_dir, kernel) = test_kernel();
        let first = tempfile::tempdir().expect("first workspace");
        let second = tempfile::tempdir().expect("second workspace");
        std::fs::write(first.path().join("first.rs"), "fn isolated_symbol() {}\n")
            .expect("first source");
        std::fs::write(second.path().join("second.rs"), "fn isolated_symbol() {}\n")
            .expect("second source");
        register_test_workspace(&kernel, "workspace-a", first.path());
        register_test_workspace(&kernel, "workspace-b", second.path());
        let token = kernel
            .token_issuer
            .mint(
                TokenBinder {
                    principal: "terminus-control-test".to_string(),
                    session_id: "session-1".to_string(),
                    task_id: "task-1".to_string(),
                    workspace_id: "workspace-a".to_string(),
                    kernel_instance_id: String::new(),
                },
                vec![OperationClass::CodeIntel],
                Scope::default(),
                None,
                "code-search-workspace-a",
            )
            .expect("code-intel capability")
            .encode()
            .expect("encoded code-intel capability");
        let context = protocol::RequestContext {
            request_id: "code-search".to_string(),
            session_id: "session-1".to_string(),
            task_id: "task-1".to_string(),
            actor_id: "terminus-control-test".to_string(),
            workspace_id: "workspace-a".to_string(),
            capability_token: token,
            ..Default::default()
        };
        let service = GrpcKernel::new(kernel, test_bootstrap_config(false));

        let inherited = CodeIntelligenceRpc::search(
            &service,
            Request::new(protocol::CodeSearchRequest {
                context: Some(context.clone()),
                workspace_id: String::new(),
                query: "isolated_symbol".to_string(),
                limit: 10,
            }),
        )
        .await
        .expect("empty request workspace inherits concrete context")
        .into_inner();
        assert_eq!(inherited.results.len(), 1);
        assert_eq!(inherited.results[0].path, "first.rs");

        let denied = CodeIntelligenceRpc::search(
            &service,
            Request::new(protocol::CodeSearchRequest {
                context: Some(context),
                workspace_id: "workspace-b".to_string(),
                query: "isolated_symbol".to_string(),
                limit: 10,
            }),
        )
        .await
        .expect_err("search request cannot override a concrete context workspace");
        assert_eq!(denied.code(), tonic::Code::PermissionDenied);

        let missing = CodeIntelligenceRpc::search(
            &service,
            Request::new(protocol::CodeSearchRequest {
                context: Some(protocol::RequestContext {
                    request_id: "missing-code-search-workspace".to_string(),
                    ..Default::default()
                }),
                workspace_id: String::new(),
                query: "isolated_symbol".to_string(),
                limit: 10,
            }),
        )
        .await
        .expect_err("search requires a concrete workspace from request or context");
        assert_eq!(missing.code(), tonic::Code::InvalidArgument);
    }

    #[tokio::test]
    async fn repository_map_pages_and_rejects_stale_continuations() {
        let (_data_dir, kernel) = test_kernel();
        let workspace = tempfile::tempdir().expect("workspace");
        std::fs::write(workspace.path().join("a.rs"), "fn alpha() {}\n").expect("first source");
        std::fs::write(workspace.path().join("b.rs"), "fn beta() {}\n").expect("second source");
        register_test_workspace(&kernel, "workspace-map", workspace.path());
        let token = kernel
            .token_issuer
            .mint(
                TokenBinder {
                    principal: "terminus-control-test".to_string(),
                    session_id: "session-1".to_string(),
                    task_id: "task-1".to_string(),
                    workspace_id: "workspace-map".to_string(),
                    kernel_instance_id: String::new(),
                },
                vec![OperationClass::CodeIntel],
                Scope::default(),
                None,
                "repository-map-test",
            )
            .expect("code-intel capability")
            .encode()
            .expect("encoded code-intel capability");
        let scoped_token = kernel
            .token_issuer
            .mint(
                TokenBinder {
                    principal: "terminus-control-test".to_string(),
                    session_id: "session-1".to_string(),
                    task_id: "task-1".to_string(),
                    workspace_id: "workspace-map".to_string(),
                    kernel_instance_id: String::new(),
                },
                vec![OperationClass::CodeIntel],
                Scope {
                    workspace_paths: vec!["a.rs".to_string()],
                    ..Default::default()
                },
                None,
                "repository-map-scoped-test",
            )
            .expect("scoped code-intel capability")
            .encode()
            .expect("encoded scoped code-intel capability");
        let context = protocol::RequestContext {
            request_id: "repository-map".to_string(),
            session_id: "session-1".to_string(),
            task_id: "task-1".to_string(),
            actor_id: "terminus-control-test".to_string(),
            workspace_id: "workspace-map".to_string(),
            capability_token: token,
            ..Default::default()
        };
        let service = GrpcKernel::new(kernel, test_bootstrap_config(false));

        let first = CodeIntelligenceRpc::map(
            &service,
            Request::new(protocol::RepositoryMapRequest {
                context: Some(context.clone()),
                workspace_id: String::new(),
                limit: 1,
                continuation: String::new(),
            }),
        )
        .await
        .expect("first repository map page")
        .into_inner();
        assert_eq!(first.total_entries, 2);
        assert_eq!(first.entries.len(), 1);
        assert!(first.truncated);
        let continuation = first.continuation.clone().expect("continuation token");
        assert!(continuation.starts_with("v1|sha256:"));

        let scoped = CodeIntelligenceRpc::map(
            &service,
            Request::new(protocol::RepositoryMapRequest {
                context: Some(protocol::RequestContext {
                    capability_token: scoped_token,
                    ..context.clone()
                }),
                workspace_id: String::new(),
                limit: 10,
                continuation: String::new(),
            }),
        )
        .await
        .expect("scoped repository map")
        .into_inner();
        assert_eq!(scoped.total_entries, 1);
        assert_eq!(scoped.entries[0].path, "a.rs");
        assert!(!scoped.truncated);

        let second = CodeIntelligenceRpc::map(
            &service,
            Request::new(protocol::RepositoryMapRequest {
                context: Some(context.clone()),
                workspace_id: String::new(),
                limit: 1,
                continuation,
            }),
        )
        .await
        .expect("second repository map page")
        .into_inner();
        assert_eq!(second.entries.len(), 1);
        assert!(!second.truncated);

        std::fs::write(workspace.path().join("b.rs"), "fn beta_changed() {}\n")
            .expect("changed source");
        let stale = CodeIntelligenceRpc::map(
            &service,
            Request::new(protocol::RepositoryMapRequest {
                context: Some(context),
                workspace_id: String::new(),
                limit: 1,
                continuation: first.continuation.expect("continuation token remains"),
            }),
        )
        .await
        .expect_err("stale continuation must fail closed");
        assert_eq!(stale.code(), tonic::Code::Aborted);
    }

    #[tokio::test]
    async fn code_search_excludes_kernel_storage_when_data_root_is_the_workspace() {
        let (data_dir, kernel) = test_kernel();
        std::fs::write(
            data_dir.path().join("workspace-source.rs"),
            "fn fixture_symbol() {}\n",
        )
        .expect("workspace source");
        register_test_workspace(&kernel, "kernel-data-workspace", data_dir.path());
        let token = kernel
            .token_issuer
            .mint(
                TokenBinder {
                    principal: "terminus-control-test".to_string(),
                    session_id: "session-1".to_string(),
                    task_id: "task-1".to_string(),
                    workspace_id: "kernel-data-workspace".to_string(),
                    kernel_instance_id: String::new(),
                },
                vec![OperationClass::CodeIntel],
                Scope::default(),
                None,
                "code-search-kernel-data-workspace",
            )
            .expect("code-intel capability")
            .encode()
            .expect("encoded code-intel capability");
        let service = GrpcKernel::new(kernel, test_bootstrap_config(false));
        let response = CodeIntelligenceRpc::search(
            &service,
            Request::new(protocol::CodeSearchRequest {
                context: Some(protocol::RequestContext {
                    request_id: "code-search-kernel-data".to_string(),
                    session_id: "session-1".to_string(),
                    task_id: "task-1".to_string(),
                    actor_id: "terminus-control-test".to_string(),
                    workspace_id: "kernel-data-workspace".to_string(),
                    capability_token: token,
                    ..Default::default()
                }),
                workspace_id: String::new(),
                query: "free text without an exact symbol".to_string(),
                limit: 10,
            }),
        )
        .await
        .expect("kernel-owned binary state must not fail workspace search")
        .into_inner();

        assert!(response.results.is_empty());
    }

    #[tokio::test]
    async fn durable_job_start_accepts_task_scoped_exec_and_job_capability() {
        let (_data_dir, kernel) = test_kernel();
        let workspace = tempfile::tempdir().expect("job workspace");
        register_test_workspace(&kernel, "workspace-1", workspace.path());
        let token = kernel
            .token_issuer
            .mint(
                TokenBinder {
                    principal: "terminus-control-test".to_string(),
                    session_id: "session-1".to_string(),
                    task_id: "task-1".to_string(),
                    workspace_id: "workspace-1".to_string(),
                    kernel_instance_id: String::new(),
                },
                vec![
                    OperationClass::Exec,
                    OperationClass::Job,
                    OperationClass::ArtifactIngest,
                ],
                Scope {
                    workspace_paths: vec![".".to_string()],
                    network_destinations: Vec::new(),
                    secret_capabilities: Vec::new(),
                },
                Some(300),
                "job-start-task-token",
            )
            .expect("task capability")
            .encode()
            .expect("encoded task capability");
        let context = terminus_kernel_protocol::RequestContext {
            request_id: terminus_kernel_protocol::new_id(),
            idempotency_key: "job-start-test".to_string(),
            session_id: "session-1".to_string(),
            task_id: "task-1".to_string(),
            turn_id: "turn-1".to_string(),
            actor_id: "terminus-control-test".to_string(),
            traceparent: String::new(),
            capability_token: token,
            workspace_id: "workspace-1".to_string(),
            deadline_unix_ms: 0,
            resource_budgets: Default::default(),
            policy_version: String::new(),
        };
        let command = terminus_kernel_protocol::CommandSpec {
            program: "/bin/cat".to_string(),
            args: Vec::new(),
            cwd: terminus_kernel_protocol::WorkspacePath {
                workspace_id: "workspace-1".to_string(),
                relative_path: ".".to_string(),
            },
            public_env: Default::default(),
            secret_capability_uris: Vec::new(),
            timeout_ms: 60_000,
            allocate_pty: false,
            shell: Default::default(),
        };

        let started = kernel
            .jobs
            .start(
                &context,
                &Default::default(),
                command,
                "degraded-local",
                true,
            )
            .await;
        assert!(
            started.is_ok(),
            "durable JobService start failed before gRPC mapping: {:?}",
            started.as_ref().err()
        );
        let Some((job_id, outcome, mut receiver)) = started.ok() else {
            return;
        };
        assert!(!outcome.process_id.is_empty());
        let _ = kernel.jobs.stop(&job_id, "focused test cleanup").await;
        while receiver.try_recv().is_ok() {}
    }

    #[tokio::test]
    async fn generated_client_reaches_generated_server_over_restricted_uds() {
        let dir = tempfile::tempdir().expect("temporary directory");
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700))
            .expect("private test directory");
        let socket = dir.path().join("kernel.sock");
        let server_socket = socket.clone();
        let workspace_dir = dir.path().join("workspace");
        std::fs::create_dir(&workspace_dir).expect("test workspace");
        let workspace_root = std::fs::canonicalize(&workspace_dir).expect("canonical workspace");
        let workspace_root = workspace_root
            .to_str()
            .expect("UTF-8 test workspace")
            .to_string();
        let data_dir = tempfile::tempdir().expect("kernel data dir");
        let kernel =
            terminus_kernel::KernelHandle::new(data_dir.path().to_path_buf()).expect("kernel");
        let token = kernel
            .token_issuer
            .mint(
                TokenBinder {
                    principal: "grpc-test".to_string(),
                    session_id: "session".to_string(),
                    task_id: "task".to_string(),
                    workspace_id: "workspace".to_string(),
                    kernel_instance_id: String::new(),
                },
                vec![OperationClass::Admin, OperationClass::ArtifactIngest],
                Scope::default(),
                None,
                "grpc-test-nonce",
            )
            .expect("test capability")
            .encode()
            .expect("encoded capability");
        let maintenance_token = kernel
            .token_issuer
            .mint(
                TokenBinder {
                    principal: "grpc-test".to_string(),
                    session_id: "control".to_string(),
                    task_id: "control-maintenance".to_string(),
                    workspace_id: "*".to_string(),
                    kernel_instance_id: String::new(),
                },
                vec![OperationClass::Admin],
                Scope::default(),
                None,
                "grpc-maintenance-nonce",
            )
            .expect("maintenance capability")
            .encode()
            .expect("encoded maintenance capability");
        let job_token = kernel
            .token_issuer
            .mint(
                TokenBinder {
                    principal: "grpc-test".to_string(),
                    session_id: "session".to_string(),
                    task_id: "task".to_string(),
                    workspace_id: "workspace".to_string(),
                    kernel_instance_id: String::new(),
                },
                vec![
                    OperationClass::Exec,
                    OperationClass::Job,
                    OperationClass::ArtifactIngest,
                ],
                Scope {
                    workspace_paths: vec![".".to_string()],
                    network_destinations: Vec::new(),
                    secret_capabilities: Vec::new(),
                },
                Some(300),
                "grpc-job-nonce",
            )
            .expect("job capability")
            .encode()
            .expect("encoded job capability");
        let exec_token = kernel
            .token_issuer
            .mint(
                TokenBinder {
                    principal: "grpc-test".to_string(),
                    session_id: "session".to_string(),
                    task_id: "task".to_string(),
                    workspace_id: "workspace".to_string(),
                    kernel_instance_id: String::new(),
                },
                vec![OperationClass::Exec],
                Scope {
                    workspace_paths: vec![".".to_string()],
                    network_destinations: Vec::new(),
                    secret_capabilities: Vec::new(),
                },
                Some(300),
                "grpc-exec-nonce",
            )
            .expect("exec capability")
            .encode()
            .expect("encoded exec capability");
        let server = tokio::spawn(async move { serve_grpc(server_socket, kernel, None).await });

        for _ in 0..100 {
            if socket.exists() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert!(socket.exists(), "server did not create the UDS");
        assert_eq!(
            std::fs::metadata(&socket)
                .expect("socket metadata")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );

        let connector_socket = socket.clone();
        let channel = Endpoint::try_from("http://[::]:50051")
            .expect("valid endpoint")
            .connect_with_connector(service_fn(move |_: Uri| {
                let socket = connector_socket.clone();
                async move { UnixStream::connect(socket).await.map(TokioIo::new) }
            }))
            .await
            .expect("connect over UDS");
        let response = KernelInfoServiceClient::new(channel.clone())
            .get_info(())
            .await
            .expect("GetInfo succeeds")
            .into_inner();
        assert_eq!(response.protocol_version, "terminus.kernel.v1");
        assert!(
            response.instance_id.starts_with("kernel:"),
            "instance_id must be kernel-prefixed for remote identity binding"
        );
        // Build identity survives the wire: the control plane's health
        // endpoint reads this instead of deriving a digest from the version
        // and service list.
        assert!(
            !response.build_revision.is_empty() && response.build_revision != "dev",
            "build_revision must identify a real build, got {:?}",
            response.build_revision
        );
        assert!(!response.version.is_empty(), "version must be reported");

        let workspace = WorkspaceServiceClient::new(channel.clone())
            .register(protocol::RegisterWorkspaceRequest {
                context: Some(protocol::RequestContext {
                    request_id: "grpc-register".to_string(),
                    idempotency_key: "grpc-register".to_string(),
                    session_id: "session".to_string(),
                    task_id: "task".to_string(),
                    turn_id: "turn".to_string(),
                    actor_id: "grpc-test".to_string(),
                    traceparent: String::new(),
                    capability_token: token.clone(),
                    workspace_id: "workspace".to_string(),
                    ..Default::default()
                }),
                root_uri: format!("file://{workspace_root}"),
                canonical_root: workspace_root.clone(),
                trust: "restricted".to_string(),
                remote_environment_json: String::new(),
                kind: "local_directory".to_string(),
                requested_workspace_id: "workspace".to_string(),
            })
            .await
            .expect("Workspace.Register succeeds")
            .into_inner();
        assert_eq!(workspace.trust, "restricted");

        let mut process_events = ProcessServiceClient::new(channel.clone())
            .start(protocol::StartProcessRequest {
                context: Some(protocol::RequestContext {
                    request_id: "grpc-process-start".to_string(),
                    idempotency_key: "grpc-process-start".to_string(),
                    session_id: "session".to_string(),
                    task_id: "task".to_string(),
                    turn_id: "turn".to_string(),
                    actor_id: "grpc-test".to_string(),
                    traceparent: String::new(),
                    capability_token: exec_token,
                    workspace_id: "workspace".to_string(),
                    ..Default::default()
                }),
                intent: Some(protocol::EffectIntent {
                    user_intent_ref: "control-plane".to_string(),
                    task_contract_hash: String::new(),
                    trust_label: "trusted".to_string(),
                    confidentiality_label: "workspace".to_string(),
                    taint_sources: Vec::new(),
                    policy_profile_id: "secure-local-default".to_string(),
                    expected_effect_class: String::new(),
                }),
                command: Some(protocol::CommandSpec {
                    program: "/bin/ls".to_string(),
                    args: vec!["-d".to_string(), ".".to_string()],
                    cwd: Some(protocol::WorkspacePath {
                        workspace_id: "workspace".to_string(),
                        relative_path: ".".to_string(),
                    }),
                    public_env: Default::default(),
                    secret_capability_uris: Vec::new(),
                    timeout: None,
                    allocate_pty: false,
                    shell: None,
                    allow_unbounded_timeout: false,
                }),
                sandbox_profile_id: "degraded-local".to_string(),
                output_policy_id: "default".to_string(),
            })
            .await
            .expect("Process.Start succeeds over UDS")
            .into_inner();
        let first_process_event = process_events
            .message()
            .await
            .expect("first process event is readable")
            .expect("process stream starts with an event");
        assert!(matches!(
            first_process_event.event,
            Some(protocol::process_event::Event::Started(_))
        ));
        drop(process_events);

        let mut artifacts = ArtifactIngestServiceClient::new(channel.clone());
        let ingested = artifacts
            .ingest(protocol::IngestArtifactRequest {
                context: Some(protocol::RequestContext {
                    request_id: "grpc-artifact-ingest".to_string(),
                    idempotency_key: "grpc-artifact-ingest".to_string(),
                    session_id: "session".to_string(),
                    task_id: "task".to_string(),
                    turn_id: "turn".to_string(),
                    actor_id: "grpc-test".to_string(),
                    traceparent: String::new(),
                    capability_token: token.clone(),
                    workspace_id: "workspace".to_string(),
                    ..Default::default()
                }),
                content: b"durable checkpoint artifact".to_vec(),
                media_type: "application/json".to_string(),
            })
            .await
            .expect("ArtifactIngest.Ingest succeeds")
            .into_inner();
        let artifact = ingested.artifact.expect("ingest returns an artifact");
        let initial_output = artifacts
            .ingest(protocol::IngestArtifactRequest {
                context: Some(protocol::RequestContext {
                    request_id: "grpc-artifact-ingest-empty".to_string(),
                    idempotency_key: "grpc-artifact-ingest-empty".to_string(),
                    session_id: "session".to_string(),
                    task_id: "task".to_string(),
                    turn_id: "turn".to_string(),
                    actor_id: "grpc-test".to_string(),
                    traceparent: String::new(),
                    capability_token: token.clone(),
                    workspace_id: "workspace".to_string(),
                    ..Default::default()
                }),
                content: Vec::new(),
                media_type: "application/octet-stream".to_string(),
            })
            .await
            .expect("a task can ingest a second, empty artifact")
            .into_inner()
            .artifact
            .expect("second ingest returns an artifact");
        assert_ne!(artifact.sha256, initial_output.sha256);
        for (request_id, expected_artifact, expected_content) in [
            (
                "grpc-artifact-get-command",
                &artifact,
                b"durable checkpoint artifact".as_slice(),
            ),
            ("grpc-artifact-get-empty", &initial_output, b"".as_slice()),
        ] {
            let owned = artifacts
                .get(protocol::GetArtifactRequest {
                    context: Some(protocol::RequestContext {
                        request_id: request_id.to_string(),
                        idempotency_key: request_id.to_string(),
                        session_id: "session".to_string(),
                        task_id: "task".to_string(),
                        turn_id: "turn".to_string(),
                        actor_id: "grpc-test".to_string(),
                        traceparent: String::new(),
                        capability_token: token.clone(),
                        workspace_id: "workspace".to_string(),
                        ..Default::default()
                    }),
                    sha256: expected_artifact.sha256.clone(),
                })
                .await
                .expect("task reads each independently owned artifact")
                .into_inner();
            assert_eq!(owned.content, expected_content);
        }
        let linked = artifacts
            .link(protocol::LinkArtifactRequest {
                context: Some(protocol::RequestContext {
                    request_id: "grpc-artifact-link".to_string(),
                    idempotency_key: "grpc-artifact-link".to_string(),
                    session_id: "session".to_string(),
                    task_id: "task".to_string(),
                    turn_id: "turn".to_string(),
                    actor_id: "grpc-test".to_string(),
                    traceparent: String::new(),
                    capability_token: token.clone(),
                    workspace_id: "workspace".to_string(),
                    ..Default::default()
                }),
                sha256: artifact.sha256.clone(),
                owner_type: "checkpoint".to_string(),
                owner_id: "checkpoint-id".to_string(),
                purpose: "content".to_string(),
                owner_task_id: "task".to_string(),
            })
            .await
            .expect("ArtifactIngest.Link succeeds")
            .into_inner();
        assert!(linked.linked);
        let turn_linked = artifacts
            .link(protocol::LinkArtifactRequest {
                context: Some(protocol::RequestContext {
                    request_id: "grpc-turn-input-link".to_string(),
                    idempotency_key: "grpc-turn-input-link".to_string(),
                    session_id: "session".to_string(),
                    task_id: "task".to_string(),
                    turn_id: "turn".to_string(),
                    actor_id: "grpc-test".to_string(),
                    traceparent: String::new(),
                    capability_token: token.clone(),
                    workspace_id: "workspace".to_string(),
                    ..Default::default()
                }),
                sha256: artifact.sha256.clone(),
                owner_type: "turn".to_string(),
                owner_id: "turn".to_string(),
                purpose: "initiating-input".to_string(),
                owner_task_id: "task".to_string(),
            })
            .await
            .expect("task-bound turn initiating-input link succeeds")
            .into_inner();
        assert!(turn_linked.linked);

        let cross_task_turn = artifacts
            .link(protocol::LinkArtifactRequest {
                context: Some(protocol::RequestContext {
                    request_id: "grpc-turn-input-link-cross-task".to_string(),
                    idempotency_key: "grpc-turn-input-link-cross-task".to_string(),
                    session_id: "session".to_string(),
                    task_id: "task".to_string(),
                    turn_id: "other-turn".to_string(),
                    actor_id: "grpc-test".to_string(),
                    traceparent: String::new(),
                    capability_token: token.clone(),
                    workspace_id: "workspace".to_string(),
                    ..Default::default()
                }),
                sha256: artifact.sha256.clone(),
                owner_type: "turn".to_string(),
                owner_id: "other-turn".to_string(),
                purpose: "initiating-input".to_string(),
                owner_task_id: "other-task".to_string(),
            })
            .await
            .expect_err("turn initiating-input ownership cannot cross task binders");
        assert_eq!(cross_task_turn.code(), tonic::Code::PermissionDenied);

        let owner_links = artifacts
            .list_checkpoint_links(protocol::ListCheckpointArtifactLinksRequest {
                context: Some(protocol::RequestContext {
                    request_id: "grpc-artifact-inventory".to_string(),
                    idempotency_key: "grpc-artifact-inventory".to_string(),
                    session_id: "control".to_string(),
                    task_id: "control-maintenance".to_string(),
                    turn_id: "reconcile".to_string(),
                    actor_id: "grpc-test".to_string(),
                    traceparent: String::new(),
                    capability_token: maintenance_token,
                    workspace_id: "*".to_string(),
                    ..Default::default()
                }),
                continuation_token: String::new(),
                page_size: 10,
            })
            .await
            .expect("checkpoint owner links are readable")
            .into_inner()
            .links;
        assert_eq!(owner_links.len(), 1);
        assert_eq!(owner_links[0].sha256, artifact.sha256);
        assert_eq!(owner_links[0].owner_task_id, "task");

        let missing = artifacts
            .link(protocol::LinkArtifactRequest {
                context: Some(protocol::RequestContext {
                    request_id: "grpc-artifact-link-missing".to_string(),
                    idempotency_key: "grpc-artifact-link-missing".to_string(),
                    session_id: "session".to_string(),
                    task_id: "task".to_string(),
                    turn_id: "turn".to_string(),
                    actor_id: "grpc-test".to_string(),
                    traceparent: String::new(),
                    capability_token: token.clone(),
                    workspace_id: "workspace".to_string(),
                    ..Default::default()
                }),
                sha256: format!("sha256:{}", "0".repeat(64)),
                owner_type: "checkpoint".to_string(),
                owner_id: "missing-checkpoint".to_string(),
                purpose: "content".to_string(),
                owner_task_id: "task".to_string(),
            })
            .await
            .expect_err("linking an unknown artifact must fail");
        assert_eq!(missing.code(), tonic::Code::NotFound);

        for malformed_hash in ["", "sha256:", "abc", &artifact.sha256[7..]] {
            let malformed = artifacts
                .link(protocol::LinkArtifactRequest {
                    context: Some(protocol::RequestContext {
                        request_id: format!("grpc-artifact-link-invalid-{malformed_hash}"),
                        idempotency_key: format!("grpc-artifact-link-invalid-{malformed_hash}"),
                        session_id: "session".to_string(),
                        task_id: "task".to_string(),
                        turn_id: "turn".to_string(),
                        actor_id: "grpc-test".to_string(),
                        traceparent: String::new(),
                        capability_token: token.clone(),
                        workspace_id: "workspace".to_string(),
                        ..Default::default()
                    }),
                    sha256: malformed_hash.to_string(),
                    owner_type: "checkpoint".to_string(),
                    owner_id: "invalid-checkpoint".to_string(),
                    purpose: "content".to_string(),
                    owner_task_id: "task".to_string(),
                })
                .await
                .expect_err("malformed artifact link hashes must fail");
            assert_eq!(malformed.code(), tonic::Code::InvalidArgument);
        }

        let wrong_owner_task = artifacts
            .link(protocol::LinkArtifactRequest {
                context: Some(protocol::RequestContext {
                    request_id: "grpc-artifact-link-wrong-owner".to_string(),
                    idempotency_key: "grpc-artifact-link-wrong-owner".to_string(),
                    session_id: "session".to_string(),
                    task_id: "task".to_string(),
                    turn_id: "turn".to_string(),
                    actor_id: "grpc-test".to_string(),
                    traceparent: String::new(),
                    capability_token: token.clone(),
                    workspace_id: "workspace".to_string(),
                    ..Default::default()
                }),
                sha256: artifact.sha256.clone(),
                owner_type: "checkpoint".to_string(),
                owner_id: "wrong-owner-checkpoint".to_string(),
                purpose: "content".to_string(),
                owner_task_id: "other-task".to_string(),
            })
            .await
            .expect_err("artifact ownership cannot cross task binders");
        assert_eq!(wrong_owner_task.code(), tonic::Code::PermissionDenied);

        let mut jobs = JobServiceClient::new(channel.clone());
        let started_job = jobs
            .start(protocol::StartJobRequest {
                context: Some(protocol::RequestContext {
                    request_id: "grpc-job-start".to_string(),
                    idempotency_key: "grpc-job-start".to_string(),
                    session_id: "session".to_string(),
                    task_id: "task".to_string(),
                    turn_id: "turn".to_string(),
                    actor_id: "grpc-test".to_string(),
                    traceparent: String::new(),
                    capability_token: job_token.clone(),
                    workspace_id: "workspace".to_string(),
                    ..Default::default()
                }),
                intent: Some(protocol::EffectIntent {
                    user_intent_ref: "control-plane".to_string(),
                    task_contract_hash: String::new(),
                    trust_label: "trusted".to_string(),
                    confidentiality_label: "workspace".to_string(),
                    taint_sources: Vec::new(),
                    policy_profile_id: "secure-local-default".to_string(),
                    expected_effect_class: String::new(),
                }),
                command: Some(protocol::CommandSpec {
                    program: "/bin/cat".to_string(),
                    args: Vec::new(),
                    cwd: Some(protocol::WorkspacePath {
                        workspace_id: "workspace".to_string(),
                        relative_path: ".".to_string(),
                    }),
                    public_env: Default::default(),
                    secret_capability_uris: Vec::new(),
                    timeout: None,
                    allocate_pty: false,
                    shell: None,
                    allow_unbounded_timeout: false,
                }),
                sandbox_profile_id: "degraded-local".to_string(),
                output_policy_id: "default".to_string(),
                durable: true,
            })
            .await
            .expect("Job.Start succeeds over UDS")
            .into_inner();
        assert!(!started_job.job_id.is_empty());
        assert!(!started_job.process_id.is_empty());
        let mut job_events = jobs
            .stream(protocol::JobStreamRequest {
                context: Some(protocol::RequestContext {
                    request_id: "grpc-job-stream".to_string(),
                    idempotency_key: "grpc-job-stream".to_string(),
                    session_id: "session".to_string(),
                    task_id: "task".to_string(),
                    turn_id: "turn".to_string(),
                    actor_id: "grpc-test".to_string(),
                    traceparent: String::new(),
                    capability_token: job_token.clone(),
                    workspace_id: "workspace".to_string(),
                    ..Default::default()
                }),
                job_id: started_job.job_id.clone(),
                from_sequence: 0,
            })
            .await
            .expect("Job.Stream opens over UDS")
            .into_inner();
        let first_job_event = job_events
            .message()
            .await
            .expect("Job.Stream first event is readable")
            .expect("Job.Stream emits a started event");
        assert!(matches!(
            first_job_event.event,
            Some(protocol::job_event::Event::Started(_))
        ));
        jobs.input(protocol::JobInputRequest {
            context: Some(protocol::RequestContext {
                request_id: "grpc-job-input".to_string(),
                idempotency_key: "grpc-job-input".to_string(),
                session_id: "session".to_string(),
                task_id: "task".to_string(),
                turn_id: "turn".to_string(),
                actor_id: "grpc-test".to_string(),
                traceparent: String::new(),
                capability_token: job_token.clone(),
                workspace_id: "workspace".to_string(),
                ..Default::default()
            }),
            job_id: started_job.job_id.clone(),
            stdin: b"kernel job stream\n".to_vec(),
        })
        .await
        .expect("Job.Input succeeds over UDS");
        let stdout_event = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let event = job_events
                    .message()
                    .await
                    .expect("Job.Stream remains readable")
                    .expect("Job.Stream remains open until process exit");
                if let Some(protocol::job_event::Event::Stdout(stdout)) = event.event {
                    break stdout;
                }
            }
        })
        .await
        .expect("Job.Stream forwards stdout without polling synthetic state");
        assert_eq!(stdout_event.bytes, b"kernel job stream\n");
        let stopped_job = jobs
            .stop(protocol::JobStopRequest {
                context: Some(protocol::RequestContext {
                    request_id: "grpc-job-stop".to_string(),
                    idempotency_key: "grpc-job-stop".to_string(),
                    session_id: "session".to_string(),
                    task_id: "task".to_string(),
                    turn_id: "turn".to_string(),
                    actor_id: "grpc-test".to_string(),
                    traceparent: String::new(),
                    capability_token: job_token,
                    workspace_id: "workspace".to_string(),
                    ..Default::default()
                }),
                job_id: started_job.job_id,
                reason: "focused test cleanup".to_string(),
            })
            .await
            .expect("Job.Stop succeeds over UDS")
            .into_inner();
        assert_eq!(stopped_job.state, "exited");
        let exit_event = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let event = job_events
                    .message()
                    .await
                    .expect("Job.Stream remains readable after stop")
                    .expect("Job.Stream emits the process exit");
                if let Some(protocol::job_event::Event::Exited(exited)) = event.event {
                    break exited;
                }
            }
        })
        .await
        .expect("Job.Stream forwards the real exit event");
        assert!(!exit_event.signal.is_empty() || exit_event.exit_code != 0);

        let report = SandboxServiceClient::new(channel)
            .report(protocol::SandboxReportRequest {
                context: Some(protocol::RequestContext {
                    request_id: "grpc-sandbox".to_string(),
                    idempotency_key: "grpc-sandbox".to_string(),
                    session_id: "session".to_string(),
                    task_id: "task".to_string(),
                    turn_id: "turn".to_string(),
                    actor_id: "grpc-test".to_string(),
                    traceparent: String::new(),
                    capability_token: token,
                    workspace_id: "workspace".to_string(),
                    ..Default::default()
                }),

                profile_id: "secure-local-default".to_string(),
            })
            .await
            .expect("Sandbox.Report succeeds")
            .into_inner();
        assert!(!report.backend_id.is_empty());

        server.abort();
        let _ = server.await;
    }

    #[tokio::test]
    async fn durable_job_stream_replays_output_and_exit_after_reload() {
        let dir = tempfile::tempdir().expect("durable stream test directory");
        let artifacts = std::sync::Arc::new(
            terminus_artifacts::ArtifactStore::open(dir.path().join("artifacts"))
                .expect("artifact store"),
        );
        let process = std::sync::Arc::new(terminus_process::ProcessManager::new(artifacts));
        let storage_path = dir.path().join("jobs.sqlite");
        let manager =
            terminus_jobs::JobManager::with_storage(std::sync::Arc::clone(&process), &storage_path);
        let job_id = terminus_kernel_protocol::new_id();
        let process_id = "process-after-restart".to_string();
        let mut record =
            terminus_jobs::JobRecord::new(job_id.clone(), "session", "task", "echo durable");
        record.state = terminus_jobs::JobState::Running;
        record.process_identity = Some(process_id.clone());
        record.resolved_executable = "/bin/echo".to_string();
        record.started_at = Some("2026-08-28T00:00:00.000000Z".to_string());
        manager.create(record).await.expect("create durable job");
        let lease = manager
            .get(&job_id)
            .await
            .expect("durable job record")
            .lease_token;
        manager
            .record_event_with_lease(
                &job_id,
                &lease,
                &terminus_kernel_protocol::ProcessEvent::Started(
                    terminus_kernel_protocol::ProcessStarted {
                        process_id: process_id.clone(),
                        job_id: job_id.clone(),
                        resolved_executable: "/bin/echo".to_string(),
                        started_at: "2026-08-28T00:00:00.000000Z".to_string(),
                    },
                ),
            )
            .await
            .expect("persist started event");
        manager
            .record_event_with_lease(
                &job_id,
                &lease,
                &terminus_kernel_protocol::ProcessEvent::Stdout(
                    terminus_kernel_protocol::OutputChunk {
                        cursor: 7,
                        bytes: b"durable".to_vec(),
                        redacted: false,
                    },
                ),
            )
            .await
            .expect("persist output event");
        manager
            .record_event_with_lease(
                &job_id,
                &lease,
                &terminus_kernel_protocol::ProcessEvent::Exited(
                    terminus_kernel_protocol::ProcessExited {
                        exit_code: 0,
                        signal: String::new(),
                        exited_at: "2026-08-28T00:00:01.000000Z".to_string(),
                        stdout_artifact: None,
                        stderr_artifact: None,
                    },
                ),
            )
            .await
            .expect("persist exit event");

        let reloaded = terminus_jobs::JobManager::with_storage(process, &storage_path);
        assert_eq!(reloaded.load_persisted().await.expect("reload jobs"), 1);
        let record = reloaded.get(&job_id).await.expect("reloaded job record");
        let events = replay_durable_job_stream(&reloaded, &record, 0)
            .await
            .expect("replay durable job stream");
        assert_eq!(events.len(), 3);
        assert_eq!(events[0].sequence, 1);
        assert!(matches!(
            events[0].event,
            Some(protocol::job_event::Event::Started(_))
        ));
        assert!(matches!(
            events[1].event,
            Some(protocol::job_event::Event::Stdout(ref output))
                if output.cursor == 7 && output.bytes == b"durable"
        ));
        assert!(matches!(
            events[2].event,
            Some(protocol::job_event::Event::Exited(ref exit))
                if exit.exit_code == 0
        ));
    }

    // -----------------------------------------------------------------
    // Connector stream cancellation (harness audit Phase 0 item 8).
    // -----------------------------------------------------------------

    /// The defect: the dispatch JoinHandle went out of scope with the
    /// stream and the task ran on detached, so a stopped turn still paid
    /// for a full provider completion. Dropping the stream must cancel the
    /// token AND abort the task.
    #[tokio::test]
    async fn dropping_the_connector_stream_cancels_and_aborts_the_dispatch() {
        let (tx, rx) = tokio::sync::mpsc::channel::<Result<protocol::ConnectorChunk, Status>>(4);
        let cancel = terminus_connector::CancelToken::new();
        let alive = std::sync::Arc::new(());
        let held = alive.clone();
        let pump = tokio::spawn(async move {
            // Stands in for an in-flight provider dispatch: never finishes
            // on its own, and keeps `held` alive while it runs.
            let _held = held;
            let _tx = tx;
            std::future::pending::<()>().await;
        });
        tokio::task::yield_now().await;
        assert_eq!(std::sync::Arc::strong_count(&alive), 2);

        let stream = PumpStream {
            rx,
            pump,
            cancel: cancel.clone(),
        };
        drop(stream);

        assert!(cancel.is_cancelled(), "drop must cancel the dispatch token");
        for _ in 0..200 {
            if std::sync::Arc::strong_count(&alive) == 1 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert_eq!(
            std::sync::Arc::strong_count(&alive),
            1,
            "the dispatch task must be aborted, not left running detached"
        );
    }

    /// A torn-down dispatch answers CANCELLED; everything else keeps its
    /// own mapping so a permission denial is never mistaken for a stop.
    #[test]
    fn a_cancelled_connector_stream_terminates_with_the_cancelled_status() {
        let cancel = terminus_connector::CancelToken::new();
        let denial = terminus_kernel_protocol::KernelError::new(
            terminus_kernel_protocol::ErrorCode::PermissionDenied,
            terminus_kernel_protocol::ErrorCategory::Permission,
            "denied".to_string(),
            false,
        );
        assert_eq!(
            connector_stream_status(&cancel, denial).code(),
            tonic::Code::PermissionDenied
        );

        cancel.cancel();
        let cancelled = terminus_kernel_protocol::KernelError::new(
            terminus_kernel_protocol::ErrorCode::Cancelled,
            terminus_kernel_protocol::ErrorCategory::Cancelled,
            "cancelled".to_string(),
            false,
        );
        assert_eq!(
            connector_stream_status(&cancel, cancelled).code(),
            tonic::Code::Cancelled
        );

        // Even without the token, the kernel error code alone maps through.
        let fresh = terminus_connector::CancelToken::new();
        let coded = terminus_kernel_protocol::KernelError::new(
            terminus_kernel_protocol::ErrorCode::Cancelled,
            terminus_kernel_protocol::ErrorCategory::Cancelled,
            "cancelled".to_string(),
            false,
        );
        assert_eq!(
            connector_stream_status(&fresh, coded).code(),
            tonic::Code::Cancelled
        );
    }

    /// The leading metadata frame is a receipt frame marked `head`, so an
    /// existing consumer that only reads `bytes`/`receipt` keeps working and
    /// a new one can tell it from the terminal accounting frame.
    #[test]
    fn the_leading_metadata_frame_carries_status_and_allowlisted_headers() {
        let identity = ConnectorStreamIdentity {
            grant_id: "grant-1".to_string(),
            task_id: "task-1".to_string(),
            effect_id: "eff-1".to_string(),
            connector_id: "chatgpt-codex".to_string(),
            method: "POST".to_string(),
            path: "/backend-api/codex/responses".to_string(),
            destination: "https://chatgpt.com:443".to_string(),
        };
        let frame = identity.head_frame(&terminus_connector::ResponseHead {
            status_code: 429,
            content_type: Some("text/event-stream".to_string()),
            headers: vec![
                ("x-codex-turn-state".to_string(), "shard-7".to_string()),
                ("retry-after".to_string(), "12".to_string()),
            ],
        });
        assert_eq!(frame.outcome, CONNECTOR_STREAM_HEAD_OUTCOME);
        assert_eq!(frame.status_code, Some(429));
        assert_eq!(frame.response_sha256, None);
        assert_eq!(frame.response_redactions, 0);
        assert_eq!(frame.connector_id, "chatgpt-codex");
        let names = frame
            .response_headers
            .iter()
            .map(|header| header.name.clone())
            .collect::<Vec<_>>();
        assert!(names.contains(&"x-codex-turn-state".to_string()));
        assert!(names.contains(&"retry-after".to_string()));
    }
}

//! Generated gRPC-over-UDS transport for the privileged kernel boundary.

#![cfg_attr(test, allow(clippy::expect_used, clippy::unwrap_used))]

use std::path::PathBuf;
use tokio_stream::StreamExt;
use tonic::{transport::Server, Request, Response, Status};

pub mod protocol {
    tonic::include_proto!("terminus.kernel.v1");
}

use protocol::artifact_ingest_service_server::{
    ArtifactIngestService as ArtifactIngestRpc, ArtifactIngestServiceServer,
};
use protocol::code_intelligence_service_server::{
    CodeIntelligenceService as CodeIntelligenceRpc, CodeIntelligenceServiceServer,
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
}

impl GrpcKernel {
    pub fn new(kernel: terminus_kernel::KernelHandle) -> Self {
        Self { kernel }
    }
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
            build_revision: string(&value, "build_revision", "dev"),
            supported_backends,
            supported_services,
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
}

#[tonic::async_trait]
impl WorkspaceServiceRpc for GrpcKernel {
    async fn register(
        &self,
        request: Request<protocol::RegisterWorkspaceRequest>,
    ) -> Result<Response<WorkspaceEntryMessage>, Status> {
        let request = request.into_inner();
        let ctx = request.context.map(context).unwrap_or_else(|| {
            terminus_kernel_protocol::RequestContext::new(terminus_kernel_protocol::new_id())
        });
        let id = self
            .kernel
            .workspaces
            .register(
                &ctx,
                &Default::default(),
                request.root_uri.clone(),
                request.canonical_root.clone(),
                &request.trust,
            )
            .map_err(status)?;
        let entry = self.kernel.workspaces.get(&id).map_err(status)?;
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
        let entry = self
            .kernel
            .workspaces
            .get(&request.into_inner().workspace_id)
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
        _request: Request<protocol::SandboxReportRequest>,
    ) -> Result<Response<EnforcementReportMessage>, Status> {
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
            .map(context)
            .ok_or_else(|| Status::invalid_argument("context is required"))?;
        let artifact = self
            .kernel
            .artifact_ingest
            .ingest(&ctx, &Default::default(), &request.content)
            .map_err(status)?;
        Ok(Response::new(protocol::IngestArtifactResponse {
            artifact: Some(artifact_ref(artifact)),
            already_present: false,
        }))
    }
}

macro_rules! unavailable_unary {
    ($trait:path, $method:ident, $request:ty, $response:ty, $label:literal) => {
        #[tonic::async_trait]
        impl $trait for GrpcKernel {
            async fn $method(
                &self,
                _request: Request<$request>,
            ) -> Result<Response<$response>, Status> {
                Err(Status::unimplemented($label))
            }
        }
    };
}

unavailable_unary!(
    ExtensionRuntimeRpc,
    invoke,
    protocol::ExtensionInvokeRequest,
    protocol::ExtensionInvokeResponse,
    "Extension.Invoke is not wired"
);

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
        match self
            .kernel
            .network
            .authorize(&ctx, &Default::default(), host, port, scheme, &[])
        {
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
            .request_metadata(&ctx, &request.capability_uri, &ctx.actor_id)
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
}

#[tonic::async_trait]
impl CodeIntelligenceRpc for GrpcKernel {
    async fn search(
        &self,
        request: Request<protocol::CodeSearchRequest>,
    ) -> Result<Response<protocol::CodeSearchResponse>, Status> {
        let request = request.into_inner();
        let ctx = request.context.map(context).ok_or_else(|| Status::invalid_argument("context is required"))?;
        if request.query.is_empty() {
            return Err(Status::invalid_argument("query is required"));
        }
        let result = self.kernel.code_intel.inspect(&ctx, &Default::default(), &request.query).map_err(status)?;
        let limit = if request.limit == 0 { 100 } else { request.limit as usize };
        let mut results = Vec::new();
        if let Some(symbol) = result.symbol {
            if request.workspace_id.is_empty() || symbol.path.starts_with(&request.workspace_id) {
                results.push(protocol::CodeSearchResult { path: symbol.path, line: symbol.start_line, symbol: symbol.name, method: "symbol-index".to_string() });
            }
        }
        let truncated = results.len() > limit;
        results.truncate(limit);
        Ok(Response::new(protocol::CodeSearchResponse { results, truncated, continuation: None }))
    }
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
            .map(context)
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
        _request: Request<protocol::PatchReconcileRequest>,
    ) -> Result<Response<protocol::PatchResponse>, Status> {
        Err(Status::unimplemented(
            "Patch.Reconcile requires the durable journal reconciliation API",
        ))
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
            .map(context)
            .ok_or_else(|| Status::invalid_argument("context is required"))?;
        let intent = request.intent.map(intent).unwrap_or_default();
        let command = request
            .command
            .map(command)
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
            .map(context)
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
    type StreamStream = tokio_stream::wrappers::ReceiverStream<Result<protocol::JobEvent, Status>>;
    async fn start(
        &self,
        _request: Request<protocol::StartJobRequest>,
    ) -> Result<Response<protocol::StartJobResponse>, Status> {
        Err(Status::unimplemented("Job.Start is not wired"))
    }
    async fn stream(
        &self,
        _request: Request<protocol::JobStreamRequest>,
    ) -> Result<Response<Self::StreamStream>, Status> {
        Err(Status::unimplemented("Job.Stream is not wired"))
    }
    async fn input(
        &self,
        _request: Request<protocol::JobInputRequest>,
    ) -> Result<Response<protocol::JobState>, Status> {
        Err(Status::unimplemented("Job.Input is not wired"))
    }
    async fn signal(
        &self,
        _request: Request<protocol::JobSignalRequest>,
    ) -> Result<Response<protocol::JobState>, Status> {
        Err(Status::unimplemented("Job.Signal is not wired"))
    }
    async fn stop(
        &self,
        _request: Request<protocol::JobStopRequest>,
    ) -> Result<Response<protocol::JobState>, Status> {
        Err(Status::unimplemented("Job.Stop is not wired"))
    }
    async fn get(
        &self,
        _request: Request<protocol::JobGetRequest>,
    ) -> Result<Response<protocol::JobState>, Status> {
        Err(Status::unimplemented("Job.Get is not wired"))
    }
}

fn context(value: ProtoContext) -> terminus_kernel_protocol::RequestContext {
    terminus_kernel_protocol::RequestContext {
        request_id: value.request_id,
        idempotency_key: value.idempotency_key,
        session_id: value.session_id,
        task_id: value.task_id,
        turn_id: value.turn_id,
        actor_id: value.actor_id,
        traceparent: value.traceparent,
        capability_token: value.capability_token,
    }
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
fn command(value: protocol::CommandSpec) -> Result<terminus_kernel_protocol::CommandSpec, Status> {
    let timeout_ms = value
        .timeout
        .as_ref()
        .map(|duration| {
            let seconds = u64::try_from(duration.seconds).ok()?;
            let millis = u64::from(duration.nanos.max(0) as u32) / 1_000_000;
            Some(seconds.saturating_mul(1_000).saturating_add(millis))
        })
        .flatten()
        .unwrap_or(0);
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
fn timestamp(value: &str) -> Option<prost_types::Timestamp> {
    let parsed = chrono::DateTime::parse_from_rfc3339(value).ok()?;
    Some(prost_types::Timestamp {
        seconds: parsed.timestamp(),
        nanos: parsed.timestamp_subsec_nanos() as i32,
    })
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
    Status::internal(error.to_string())
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
pub async fn serve_grpc(
    socket_path: PathBuf,
    kernel: terminus_kernel::KernelHandle,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    if let Some(parent) = socket_path.parent() {
        tokio::fs::create_dir_all(parent).await?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            tokio::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700)).await?;
        }
    }
    match tokio::fs::symlink_metadata(&socket_path).await {
        Ok(metadata) => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::FileTypeExt;
                if !metadata.file_type().is_socket() {
                    return Err(format!(
                        "refusing to replace non-socket path {}",
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
    }

    tracing::info!(socket = %socket_path.display(), "kernel gRPC listening on UDS");
    let service = GrpcKernel::new(kernel);
    Server::builder()
        .add_service(KernelInfoServiceServer::new(service.clone()))
        .add_service(FileServiceServer::new(service.clone()))
        .add_service(PatchServiceServer::new(service.clone()))
        .add_service(ProcessServiceServer::new(service.clone()))
        .add_service(JobServiceServer::new(service.clone()))
        .add_service(WorkspaceServiceServer::new(service.clone()))
        .add_service(SandboxServiceServer::new(service.clone()))
        .add_service(PolicyServiceServer::new(service.clone()))
        .add_service(SecretServiceServer::new(service.clone()))
        .add_service(NetworkServiceServer::new(service.clone()))
        .add_service(CodeIntelligenceServiceServer::new(service.clone()))
        .add_service(ExtensionRuntimeServiceServer::new(service.clone()))
        .add_service(ArtifactIngestServiceServer::new(service))
        .serve_with_incoming(tokio_stream::wrappers::UnixListenerStream::new(listener))
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use hyper_util::rt::TokioIo;
    use protocol::kernel_info_service_client::KernelInfoServiceClient;
    use protocol::sandbox_service_client::SandboxServiceClient;
    use protocol::workspace_service_client::WorkspaceServiceClient;
    use std::os::unix::fs::PermissionsExt;
    use tokio::net::UnixStream;
    use tonic::transport::{Endpoint, Uri};
    use tower::service_fn;

    #[tokio::test]
    async fn generated_client_reaches_generated_server_over_restricted_uds() {
        let dir = tempfile::tempdir().expect("temporary directory");
        let socket = dir.path().join("kernel.sock");
        let server_socket = socket.clone();
        let server = tokio::spawn(async move {
            let data_dir = tempfile::tempdir().expect("kernel data dir");
            let kernel =
                terminus_kernel::KernelHandle::new(data_dir.path().to_path_buf()).expect("kernel");
            serve_grpc(server_socket, kernel).await
        });

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

        let workspace = WorkspaceServiceClient::new(channel.clone())
            .register(protocol::RegisterWorkspaceRequest {
                context: None,
                root_uri: "file:///tmp/terminus-grpc".to_string(),
                canonical_root: "/tmp/terminus-grpc".to_string(),
                trust: "restricted".to_string(),
            })
            .await
            .expect("Workspace.Register succeeds")
            .into_inner();
        assert_eq!(workspace.trust, "restricted");

        let report = SandboxServiceClient::new(channel)
            .report(protocol::SandboxReportRequest {
                context: None,
                profile_id: "secure-local-default".to_string(),
            })
            .await
            .expect("Sandbox.Report succeeds")
            .into_inner();
        assert!(!report.backend_id.is_empty());

        server.abort();
        let _ = server.await;
    }
}

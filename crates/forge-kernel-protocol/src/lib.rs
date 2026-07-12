//! Shared protocol types for the Forge effect kernel.
//!
//! This crate contains pure serde-friendly data structures that mirror the
//! kernel RPC contract described in `SPEC.md` Appendix D. It performs no I/O
//! and depends only on serde + uuid + chrono so it can be reused by every
//! other kernel crate and the testkit.

#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};
use thiserror::Error;

pub mod error_codes;
pub use error_codes::{ErrorCategory, ErrorCode};

/// RequestContext mirrors `forge.kernel.v1.RequestContext`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RequestContext {
    pub request_id: String,
    pub idempotency_key: String,
    pub session_id: String,
    pub task_id: String,
    pub turn_id: String,
    pub actor_id: String,
    pub traceparent: String,
    pub capability_token: String,
}

impl RequestContext {
    /// Build a minimal request context with only an id; useful in tests.
    pub fn new(request_id: impl Into<String>) -> Self {
        Self {
            request_id: request_id.into(),
            idempotency_key: String::new(),
            session_id: String::new(),
            task_id: String::new(),
            turn_id: String::new(),
            actor_id: String::new(),
            traceparent: String::new(),
            capability_token: String::new(),
        }
    }
}

/// EffectIntent mirrors `forge.kernel.v1.EffectIntent`.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct EffectIntent {
    pub user_intent_ref: String,
    pub task_contract_hash: String,
    pub trust_label: String,
    pub confidentiality_label: String,
    pub taint_sources: Vec<String>,
    pub policy_profile_id: String,
    pub expected_effect_class: String,
}

/// Logical workspace-relative path.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
pub struct WorkspacePath {
    pub workspace_id: String,
    pub relative_path: String,
}

impl WorkspacePath {
    pub fn new(workspace_id: impl Into<String>, relative_path: impl Into<String>) -> Self {
        Self {
            workspace_id: workspace_id.into(),
            relative_path: relative_path.into(),
        }
    }
}

/// A source version pin for a single path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceVersion {
    pub path: WorkspacePath,
    pub sha256: String,
    pub repository_revision: String,
}

/// Shell configuration for command execution.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct ShellSpec {
    pub enabled: bool,
    pub script: String,
    pub dialect: String,
}

/// Structured command request.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct CommandSpec {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: WorkspacePath,
    pub public_env: std::collections::BTreeMap<String, String>,
    pub secret_capability_uris: Vec<String>,
    /// Timeout in milliseconds (0 means "use backend default").
    pub timeout_ms: u64,
    pub allocate_pty: bool,
    pub shell: ShellSpec,
}

/// Reference to an ingested artifact.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArtifactRef {
    pub sha256: String,
    pub size_bytes: u64,
    pub media_type: String,
}

impl ArtifactRef {
    pub fn new(sha256: impl Into<String>, size_bytes: u64, media_type: impl Into<String>) -> Self {
        Self {
            sha256: sha256.into(),
            size_bytes,
            media_type: media_type.into(),
        }
    }
}

/// A captured policy decision.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PolicyDecision {
    pub decision_id: String,
    pub decision: String,
    pub rule_ids: Vec<String>,
    pub explanation: String,
}

/// A diagnostic emitted by an editor, validator, or compiler.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Diagnostic {
    pub path: WorkspacePath,
    pub start_line: u32,
    pub start_column: u32,
    pub end_line: u32,
    pub end_column: u32,
    pub severity: String,
    pub source: String,
    pub code: String,
    pub message: String,
}

/// Half-open line range `[start_line, end_line]`, 1-indexed inclusive.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct LineRange {
    pub start_line: u32,
    pub end_line: u32,
}

/// A contiguous elision in a projected read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Elision {
    pub range: LineRange,
    pub reason: String,
}

/// A bounded chunk of process output.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OutputChunk {
    pub cursor: u64,
    pub bytes: Vec<u8>,
    pub redacted: bool,
}

/// Emitted when a process starts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProcessStarted {
    pub process_id: String,
    pub job_id: String,
    pub resolved_executable: String,
    /// RFC3339 UTC timestamp.
    pub started_at: String,
}

/// Emitted when a process exits.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProcessExited {
    pub exit_code: i32,
    pub signal: String,
    pub exited_at: String,
    pub stdout_artifact: Option<ArtifactRef>,
    pub stderr_artifact: Option<ArtifactRef>,
}

/// A single event in a process stream.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ProcessEvent {
    Started(ProcessStarted),
    Stdout(OutputChunk),
    Stderr(OutputChunk),
    Exited(ProcessExited),
    Policy(PolicyDecision),
}

impl ProcessEvent {
    pub fn sequence_hint(&self) -> Option<u64> {
        match self {
            ProcessEvent::Stdout(c) | ProcessEvent::Stderr(c) => Some(c.cursor),
            _ => None,
        }
    }
}

/// A snapshot of the workspace used to anchor a patch transaction.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct WorkspaceBaseline {
    pub workspace_id: String,
    pub repository_revision: String,
    pub dirty_digest: String,
    pub sources: Vec<SourceVersion>,
}

/// Patch commit mode mirrors `PatchCommitMode`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PatchCommitMode {
    Unspecified,
    PreviewOnly,
    StageOnly,
    ApplyToWorktree,
}

impl Default for PatchCommitMode {
    fn default() -> Self {
        Self::Unspecified
    }
}

/// A single edit in a patch transaction.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PatchEdit {
    ReplaceSymbol(ReplaceSymbol),
    ReplaceRange(ReplaceRange),
    ReplaceExactText(ReplaceExactText),
    Insert(InsertContent),
    DeleteRange(DeleteRange),
    CreateFile(CreateFile),
    MoveFile(MoveFile),
    DeleteFile(DeleteFile),
    UnifiedDiff(UnifiedDiff),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReplaceSymbol {
    pub path: WorkspacePath,
    pub expected_sha256: String,
    pub symbol: String,
    pub structural_fingerprint: String,
    pub replacement_utf8: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReplaceRange {
    pub path: WorkspacePath,
    pub expected_sha256: String,
    pub range: LineRange,
    pub replacement_utf8: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReplaceExactText {
    pub path: WorkspacePath,
    pub expected_sha256: String,
    pub expected_utf8: Vec<u8>,
    pub replacement_utf8: Vec<u8>,
    pub require_unique: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InsertContent {
    pub path: WorkspacePath,
    pub expected_sha256: String,
    pub anchor_kind: String,
    pub anchor: String,
    pub position: String,
    pub content_utf8: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeleteRange {
    pub path: WorkspacePath,
    pub expected_sha256: String,
    pub range: LineRange,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CreateFile {
    pub path: WorkspacePath,
    pub must_not_exist: bool,
    pub content: Vec<u8>,
    pub media_type: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MoveFile {
    pub from: WorkspacePath,
    pub to: WorkspacePath,
    pub expected_sha256: String,
    pub target_must_not_exist: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeleteFile {
    pub path: WorkspacePath,
    pub expected_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UnifiedDiff {
    pub repository_revision: String,
    pub diff_utf8: Vec<u8>,
}

/// A file affected by a patch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChangedFile {
    pub path: WorkspacePath,
    pub old_sha256: String,
    pub new_sha256: String,
    pub operation: String,
}

/// A single validation result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ValidationResult {
    pub check_id: String,
    pub status: String,
    pub summary: String,
    pub evidence: Option<ArtifactRef>,
}

/// PatchResponse mirrors `forge.kernel.v1.PatchResponse`.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct PatchResponse {
    pub transaction_id: String,
    pub state: String,
    pub final_repository_revision: String,
    pub final_dirty_digest: String,
    pub changed_files: Vec<ChangedFile>,
    pub validations: Vec<ValidationResult>,
    pub complete_diff: Option<ArtifactRef>,
}

/// The universal tool result envelope (Section 34.4).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolResultEnvelope {
    pub status: ToolResultStatus,
    pub summary: String,
    pub data: serde_json::Value,
    pub artifacts: Vec<ArtifactRef>,
    pub source_versions: std::collections::BTreeMap<String, String>,
    pub truncation: TruncationInfo,
    pub diagnostics: Vec<Diagnostic>,
    pub side_effects: Vec<SideEffectDescriptor>,
    pub trust: TrustLabel,
    pub confidentiality: ConfidentialityLabel,
    pub timing: TimingInfo,
    pub resource_usage: ResourceUsage,
    pub tool_call_id: String,
    pub trace_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolResultStatus {
    Success,
    Partial,
    Error,
    Denied,
    Timeout,
    Cancelled,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct TruncationInfo {
    pub occurred: bool,
    pub reason: Option<String>,
    pub continuation: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SideEffectDescriptor {
    pub kind: String,
    pub resource: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TrustLabel {
    Trusted,
    Derived,
    Untrusted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConfidentialityLabel {
    Public,
    Workspace,
    SecretAdjacent,
    Secret,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct TimingInfo {
    pub queued_ms: u64,
    pub execution_ms: u64,
    pub total_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct ResourceUsage {
    pub cpu_ms: Option<u64>,
    pub peak_memory_bytes: Option<u64>,
    pub bytes_read: Option<u64>,
    pub bytes_written: Option<u64>,
    pub network_bytes: Option<u64>,
}

/// Generate a fresh UUIDv7 identifier suitable for public domain entities.
pub fn new_id() -> String {
    uuid::Uuid::now_v7().to_string()
}

/// Top-level typed error returned by kernel services.
#[derive(Debug, Error)]
pub enum KernelError {
    #[error("{code:?}: {message}")]
    Structured {
        code: ErrorCode,
        message: String,
        category: ErrorCategory,
        retryable: bool,
        details: serde_json::Value,
        suggested_action: Option<String>,
        trace_id: Option<String>,
    },
}

impl KernelError {
    pub fn new(
        code: ErrorCode,
        category: ErrorCategory,
        message: impl Into<String>,
        retryable: bool,
    ) -> Self {
        Self::Structured {
            code,
            message: message.into(),
            category,
            retryable,
            details: serde_json::Value::Null,
            suggested_action: None,
            trace_id: None,
        }
    }

    #[must_use]
    pub fn with_details(mut self, details: serde_json::Value) -> Self {
        let KernelError::Structured { details: d, .. } = &mut self;
        *d = details;
        self
    }

    pub fn code(&self) -> ErrorCode {
        match self {
            Self::Structured { code, .. } => *code,
        }
    }

    pub fn category(&self) -> ErrorCategory {
        match self {
            Self::Structured { category, .. } => *category,
        }
    }

    pub fn retryable(&self) -> bool {
        match self {
            Self::Structured { retryable, .. } => *retryable,
        }
    }
}

pub type KernelResult<T> = Result<T, KernelError>;

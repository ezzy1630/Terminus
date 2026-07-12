use crate::state::JobState;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct JobResourceLimits {
    pub max_runtime_ms: u64,
    pub max_output_bytes: u64,
}

impl Default for JobResourceLimits {
    fn default() -> Self {
        Self {
            max_runtime_ms: 3_600_000,
            max_output_bytes: 64 * 1024 * 1024,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JobRecord {
    pub id: String,
    pub owner_session_id: String,
    pub owner_task_id: String,
    pub command: String,
    pub resolved_executable: String,
    pub cwd: String,
    pub public_environment_digest: String,
    pub secret_capability_refs: Vec<String>,
    pub sandbox_id: String,
    pub process_identity: Option<String>,
    pub resource_limits: JobResourceLimits,
    pub output_artifact: Option<String>,
    pub output_cursor: u64,
    pub cleanup_policy: String,
    pub state: JobState,
    pub started_at: Option<String>,
    pub settled_at: Option<String>,
}

impl JobRecord {
    pub fn new(
        id: impl Into<String>,
        session_id: impl Into<String>,
        task_id: impl Into<String>,
        command: impl Into<String>,
    ) -> Self {
        Self {
            id: id.into(),
            owner_session_id: session_id.into(),
            owner_task_id: task_id.into(),
            command: command.into(),
            resolved_executable: String::new(),
            cwd: String::new(),
            public_environment_digest: String::new(),
            secret_capability_refs: Vec::new(),
            sandbox_id: String::new(),
            process_identity: None,
            resource_limits: JobResourceLimits::default(),
            output_artifact: None,
            output_cursor: 0,
            cleanup_policy: "kill_tree".to_string(),
            state: JobState::Created,
            started_at: None,
            settled_at: None,
        }
    }
}

//! Conversion helpers from protocol `CommandSpec` to a normalized spawn.

use crate::error::ProcessError;
use forge_kernel_protocol::CommandSpec;
use std::collections::BTreeMap;

/// A normalized spawn request: an executable path, an argv, an explicit env,
/// a working directory, and a timeout in milliseconds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NormalizedSpawn {
    pub program: String,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub working_dir: Option<std::path::PathBuf>,
    pub timeout_ms: u64,
    pub shell: bool,
}

impl NormalizedSpawn {
    /// Build from a protocol `CommandSpec`. Exactly one of `program` or
    /// `shell.script` must be present.
    pub fn from_spec(cmd: &CommandSpec) -> Result<Self, ProcessError> {
        let shell = cmd.shell.enabled;
        if shell {
            if cmd.shell.script.is_empty() {
                return Err(ProcessError::InvalidSpec(
                    "shell.enabled=true but shell.script is empty".into(),
                ));
            }
            // Use the dialect's binary; default to `sh`.
            let program = match cmd.shell.dialect.as_str() {
                "bash" => "bash",
                "zsh" => "zsh",
                "powershell" => "powershell",
                "cmd" => "cmd",
                "" => "sh",
                other => return Err(ProcessError::InvalidSpec(format!("unsupported shell dialect `{other}`"))),
            };
            return Ok(Self {
                program: program.to_string(),
                args: vec!["-c".to_string(), cmd.shell.script.clone()],
                env: cmd.public_env.clone(),
                working_dir: None,
                timeout_ms: if cmd.timeout_ms == 0 { 60_000 } else { cmd.timeout_ms },
                shell: true,
            });
        }
        if cmd.program.is_empty() {
            return Err(ProcessError::InvalidSpec(
                "program is required when shell is disabled".into(),
            ));
        }
        Ok(Self {
            program: cmd.program.clone(),
            args: cmd.args.clone(),
            env: cmd.public_env.clone(),
            working_dir: None,
            timeout_ms: if cmd.timeout_ms == 0 { 60_000 } else { cmd.timeout_ms },
            shell: false,
        })
    }
}

/// The outcome of a successful spawn: a process id and an event receiver.
#[derive(Debug)]
pub struct SpawnOutcome {
    pub process_id: String,
    pub job_id: String,
    pub resolved_executable: String,
}

impl SpawnOutcome {
    pub fn new(process_id: impl Into<String>, job_id: impl Into<String>) -> Self {
        Self {
            process_id: process_id.into(),
            job_id: job_id.into(),
            resolved_executable: String::new(),
        }
    }
}

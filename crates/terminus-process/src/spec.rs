//! Conversion helpers from protocol `CommandSpec` to a normalized spawn.

use crate::error::ProcessError;
use std::collections::BTreeMap;
use terminus_kernel_protocol::CommandSpec;

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
    pub allocate_pty: bool,
}

impl NormalizedSpawn {
    /// Build from a protocol `CommandSpec`. Exactly one of `program` or
    /// `shell.script` must be present.
    pub fn from_spec(cmd: &CommandSpec) -> Result<Self, ProcessError> {
        validate_public_environment(&cmd.public_env)?;
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
                other => {
                    return Err(ProcessError::InvalidSpec(format!(
                        "unsupported shell dialect `{other}`"
                    )))
                }
            };
            return Ok(Self {
                program: program.to_string(),
                args: vec!["-c".to_string(), cmd.shell.script.clone()],
                env: cmd.public_env.clone(),
                working_dir: None,
                timeout_ms: if cmd.timeout_ms == 0 {
                    60_000
                } else {
                    cmd.timeout_ms
                },
                shell: true,
                allocate_pty: cmd.allocate_pty,
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
            timeout_ms: if cmd.timeout_ms == 0 {
                60_000
            } else {
                cmd.timeout_ms
            },
            shell: false,
            allocate_pty: cmd.allocate_pty,
        })
    }
}

fn validate_public_environment(environment: &BTreeMap<String, String>) -> Result<(), ProcessError> {
    for (name, value) in environment {
        let mut characters = name.chars();
        let valid_first = characters
            .next()
            .is_some_and(|character| character == '_' || character.is_ascii_alphabetic());
        let valid_rest =
            characters.all(|character| character == '_' || character.is_ascii_alphanumeric());
        if !valid_first || !valid_rest {
            return Err(ProcessError::InvalidSpec(format!(
                "public environment key `{name}` is not a portable environment name"
            )));
        }
        if value.contains('\0') {
            return Err(ProcessError::InvalidSpec(format!(
                "public environment value for `{name}` contains NUL"
            )));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::NormalizedSpawn;
    use terminus_kernel_protocol::CommandSpec;

    #[test]
    fn public_environment_requires_portable_names() {
        let mut command = CommandSpec {
            program: "/usr/bin/true".to_string(),
            ..CommandSpec::default()
        };
        command
            .public_env
            .insert("TERMINUS_PROVIDER_PROTOCOL".to_string(), "v1".to_string());
        assert!(NormalizedSpawn::from_spec(&command).is_ok());

        command
            .public_env
            .insert("INVALID=NAME".to_string(), "value".to_string());
        assert!(NormalizedSpawn::from_spec(&command).is_err());
    }

    #[test]
    fn public_environment_rejects_nul_values() {
        let command = CommandSpec {
            program: "/usr/bin/true".to_string(),
            public_env: [("PUBLIC_VALUE".to_string(), "bad\0value".to_string())]
                .into_iter()
                .collect(),
            ..CommandSpec::default()
        };
        assert!(NormalizedSpawn::from_spec(&command).is_err());
    }
}

/// The outcome of a successful spawn: a process id and an event receiver.
#[derive(Debug)]
pub struct SpawnOutcome {
    pub process_id: String,
    pub job_id: String,
    pub resolved_executable: String,
    /// OS process id captured at spawn time for durable-job fencing.
    pub pid: Option<u32>,
    /// Human-readable RFC3339 launch time.
    pub started_at: String,
    /// Platform process-start identity. This is intentionally separate from
    /// `started_at`: on Linux it is the monotonic `/proc` start-time tick
    /// count, while supported BSD-family platforms use the `ps` start value.
    pub process_start_time: Option<String>,
    /// Executable identity used with `process_start_time` for PID fencing.
    pub process_executable: Option<String>,
    /// Host working directory at spawn time.
    pub working_directory: Option<String>,
}

impl SpawnOutcome {
    pub fn new(process_id: impl Into<String>, job_id: impl Into<String>) -> Self {
        Self {
            process_id: process_id.into(),
            job_id: job_id.into(),
            resolved_executable: String::new(),
            pid: None,
            started_at: String::new(),
            process_start_time: None,
            process_executable: None,
            working_directory: None,
        }
    }
}

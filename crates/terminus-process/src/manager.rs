//! `ProcessManager` owns child processes and streams `ProcessEvent`s.

use crate::error::ProcessError;
use crate::spec::{NormalizedSpawn, SpawnOutcome};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use terminus_artifacts::ArtifactStore;
use terminus_kernel_protocol::{
    ArtifactRef, OutputChunk, ProcessEvent, ProcessExited, ProcessStarted,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{mpsc, Mutex};
use tokio::time;

type ManagedProcessRef = Arc<Mutex<ManagedProcess>>;
type ChildRegistry = Arc<Mutex<HashMap<String, ManagedProcessRef>>>;

/// A resource that must remain alive for the full child-process lease.
///
/// The process supervisor drops the lease after the child is reaped, on a
/// timeout, or on a spawn-stream failure. This keeps per-process resources
/// such as an egress broker from becoming detached background state.
pub struct SpawnLease {
    cleanup: Option<Box<dyn FnOnce() + Send + 'static>>,
}

impl SpawnLease {
    pub fn new(cleanup: impl FnOnce() + Send + 'static) -> Self {
        Self {
            cleanup: Some(Box::new(cleanup)),
        }
    }
}

impl std::fmt::Debug for SpawnLease {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SpawnLease").finish_non_exhaustive()
    }
}

impl Drop for SpawnLease {
    fn drop(&mut self) {
        if let Some(cleanup) = self.cleanup.take() {
            cleanup();
        }
    }
}

/// A running or recently-exited managed process.
#[derive(Debug)]
pub struct ManagedProcess {
    pub process_id: String,
    pub job_id: String,
    pub child: Option<Child>,
    pub stdin: Option<ChildStdin>,
    pub pid: Option<u32>,
    pub process_start_time: Option<String>,
    pub process_executable: String,
    pub cancel_requested: bool,
    pub termination_receipt: Option<String>,
    pub allocate_pty: bool,
    lease: Option<SpawnLease>,
    pub supervisor_handle: Option<tokio::task::JoinHandle<()>>,
}

impl Drop for ManagedProcess {
    fn drop(&mut self) {
        if let Some(handle) = self.supervisor_handle.take() {
            handle.abort();
        }
    }
}

/// ProcessManager owns child processes. Construction is cheap; share via
/// `Arc`. The artifact store is used to capture stdout/stderr.
#[derive(Debug, Clone)]
pub struct ProcessManager {
    artifact_store: Arc<ArtifactStore>,
    children: ChildRegistry,
    /// Maximum captured output before spilling to artifact. 1 MiB by default.
    max_inline_bytes: usize,
}

impl ProcessManager {
    pub fn new(artifact_store: Arc<ArtifactStore>) -> Self {
        Self {
            artifact_store,
            children: Arc::new(Mutex::new(HashMap::new())),
            max_inline_bytes: 1024 * 1024,
        }
    }

    pub fn with_max_inline_bytes(mut self, max: usize) -> Self {
        self.max_inline_bytes = max;
        self
    }

    /// Spawn a process and stream its events. Returns the spawn outcome and
    /// a receiver for `ProcessEvent`s. The receiver closes after `Exited`.
    pub async fn spawn(
        &self,
        spawn: NormalizedSpawn,
    ) -> Result<(SpawnOutcome, mpsc::Receiver<ProcessEvent>), ProcessError> {
        let mut command = Command::new(&spawn.program);
        command.args(&spawn.args);
        command.env_clear();
        command.envs(&spawn.env);
        if let Some(cwd) = &spawn.working_dir {
            command.current_dir(cwd);
        }
        let resolved_executable = spawn.program.clone();
        let process_identity = command_identity(&spawn.program, &spawn.args);
        self.spawn_command(
            command,
            resolved_executable,
            process_identity,
            spawn.working_dir,
            spawn.timeout_ms,
            None,
        )
        .await
    }

    /// Spawn a process wrapped in a sandbox binary (e.g. `bwrap`) with a
    /// pre-built argv prefix. `wrapper_argv` MUST already contain the full
    /// sandbox argv INCLUDING the trailing `-- <program> <args...>` (as
    /// produced by `LinuxSandboxBackend::build_bwrap_argv`). The wrapper
    /// binary owns namespace isolation; `ProcessManager` still owns the
    /// process group, timeout, output streaming, and owned-group kill on cancel.
    /// SPEC §13.4 / §34.11.
    pub async fn spawn_wrapped(
        &self,
        wrapper: std::path::PathBuf,
        wrapper_argv: Vec<String>,
        spawn: NormalizedSpawn,
    ) -> Result<(SpawnOutcome, mpsc::Receiver<ProcessEvent>), ProcessError> {
        let mut command = Command::new(&wrapper);
        command.args(&wrapper_argv);
        command.env_clear();
        command.envs(&spawn.env);
        // The wrapper starts from the already-resolved host cwd. Namespace
        // backends may also set an in-sandbox cwd (for example bwrap
        // --chdir); Seatbelt inherits this host cwd directly.
        if let Some(cwd) = &spawn.working_dir {
            command.current_dir(cwd);
        }
        let resolved_executable =
            format!("{} (sandboxed via {})", spawn.program, wrapper.display());
        let process_identity = command_identity(&wrapper.display().to_string(), &wrapper_argv);
        self.spawn_command(
            command,
            resolved_executable,
            process_identity,
            spawn.working_dir,
            spawn.timeout_ms,
            None,
        )
        .await
    }

    /// Spawn a sandboxed process and retain a lease-owned resource until its
    /// process group has terminated and been reaped.
    pub async fn spawn_wrapped_with_lease(
        &self,
        wrapper: std::path::PathBuf,
        wrapper_argv: Vec<String>,
        spawn: NormalizedSpawn,
        lease: SpawnLease,
    ) -> Result<(SpawnOutcome, mpsc::Receiver<ProcessEvent>), ProcessError> {
        let mut command = Command::new(&wrapper);
        command.args(&wrapper_argv);
        command.env_clear();
        command.envs(&spawn.env);
        if let Some(cwd) = &spawn.working_dir {
            command.current_dir(cwd);
        }
        let resolved_executable =
            format!("{} (sandboxed via {})", spawn.program, wrapper.display());
        let process_identity = command_identity(&wrapper.display().to_string(), &wrapper_argv);
        self.spawn_command(
            command,
            resolved_executable,
            process_identity,
            spawn.working_dir,
            spawn.timeout_ms,
            Some(lease),
        )
        .await
    }

    /// Shared spawn core: take a fully-configured `Command`, spawn it, and
    /// run the streaming supervisor. Used by `spawn` (direct) and
    /// `spawn_wrapped` (sandboxed).
    async fn spawn_command(
        &self,
        mut command: Command,
        resolved_executable: String,
        process_executable: String,
        working_directory: Option<std::path::PathBuf>,
        timeout_ms: u64,
        lease: Option<SpawnLease>,
    ) -> Result<(SpawnOutcome, mpsc::Receiver<ProcessEvent>), ProcessError> {
        let process_id = terminus_kernel_protocol::new_id();
        let job_id = terminus_kernel_protocol::new_id();

        command.stdin(Stdio::piped());
        command.stdout(Stdio::piped());
        command.stderr(Stdio::piped());
        // Process group on unix so tree-kill reaches sandbox descendants.
        #[cfg(unix)]
        {
            command.process_group(0);
        }

        let mut child = command
            .spawn()
            .map_err(|e| ProcessError::Spawn(format!("{e}")))?;

        let started_at = now_rfc3339();
        let child_pid = child.id();
        let process_snapshot = match child_pid {
            Some(pid) => match inspect_process(pid) {
                Ok(snapshot) => snapshot,
                Err(error) => {
                    #[cfg(unix)]
                    kill_process_group(pid);
                    let _ = child.kill().await;
                    return Err(error);
                }
            },
            None => None,
        };
        // A shell or sandbox launcher may replace itself with the final
        // executable (`sh -c 'sleep 30'` commonly becomes `sleep`). Preserve
        // the original command identity so the start-time fence accepts only
        // an image named by the launch contract, even across that exec.
        let (tx, rx) = mpsc::channel(64);
        let started = ProcessStarted {
            process_id: process_id.clone(),
            job_id: job_id.clone(),
            resolved_executable: resolved_executable.clone(),
            started_at: started_at.clone(),
        };
        let _ = tx.send(ProcessEvent::Started(started.clone())).await;

        let stdin = child.stdin.take();
        let child_pid = child.id();
        let managed = Arc::new(Mutex::new(ManagedProcess {
            process_id: process_id.clone(),
            job_id: job_id.clone(),
            child: Some(child),
            stdin,
            pid: child_pid,
            process_start_time: process_snapshot
                .as_ref()
                .map(|snapshot| snapshot.start_time.clone()),
            process_executable: process_executable.clone(),
            cancel_requested: false,
            termination_receipt: None,
            allocate_pty: false,
            lease,
            supervisor_handle: None,
        }));
        self.children
            .lock()
            .await
            .insert(process_id.clone(), Arc::clone(&managed));

        let store = Arc::clone(&self.artifact_store);
        let max_inline = self.max_inline_bytes;
        let pid = process_id.clone();
        let tx_clone = tx.clone();
        let children = Arc::clone(&self.children);
        let managed_supervisor = Arc::clone(&managed);
        // `timeout_ms` is a parameter of `spawn_command`.

        // SPEC §44.2 ownership: this supervisor task owns the child's
        // lifetime and is explicitly tracked by ManagedProcess.
        let supervisor = tokio::spawn(async move {
            // Pull child out of the managed wrapper so we can take stdout/stderr.
            let mut child_guard = managed_supervisor.lock().await;
            let mut child = match child_guard.child.take() {
                Some(c) => c,
                None => return,
            };
            let stdout = child.stdout.take();
            let stderr = child.stderr.take();
            drop(child_guard);

            let stdout_task = if let Some(mut stdout) = stdout {
                let tx = tx_clone.clone();
                let store = Arc::clone(&store);
                Some(tokio::spawn(async move {
                    capture_stream(&mut stdout, &tx, &store, max_inline, StreamKind::Stdout).await
                }))
            } else {
                None
            };
            let stderr_task = if let Some(mut stderr) = stderr {
                let tx = tx_clone.clone();
                let store = Arc::clone(&store);
                Some(tokio::spawn(async move {
                    capture_stream(&mut stderr, &tx, &store, max_inline, StreamKind::Stderr).await
                }))
            } else {
                None
            };

            // Wait with timeout. An absent bound (`0`) is NOT unbounded: it
            // resolves to the crate default. Only the explicit
            // `UNBOUNDED_TIMEOUT_MS` sentinel runs without a wall clock.
            let wait_fut = child.wait();
            let effective_timeout_ms = crate::spec::effective_timeout_ms(timeout_ms);
            let exit_result = if let Some(bound_ms) = effective_timeout_ms {
                match time::timeout(std::time::Duration::from_millis(bound_ms), wait_fut).await {
                    Ok(r) => r,
                    Err(_) => {
                        // Timed out; kill the process group.
                        if let Some(pid) = child_pid {
                            let mut child_guard = managed_supervisor.lock().await;
                            child_guard.termination_receipt = Some("TIMEOUT->SIGKILL".to_string());
                            drop(child_guard);
                            kill_process_group(pid);
                            #[cfg(windows)]
                            let _ = child.kill().await;
                            let _ = child.wait().await;
                        }
                        let mut child_guard = managed_supervisor.lock().await;
                        child_guard.pid = None;
                        child_guard.stdin = None;
                        drop(child_guard);
                        // The group is dead and its pipe ends are closed, so
                        // both capture tasks reach EOF promptly; reap them
                        // instead of leaving them running detached and racing
                        // release_managed below.
                        let stdout_artifact = match stdout_task {
                            Some(t) => t.await.unwrap_or(None),
                            None => None,
                        };
                        let stderr_artifact = match stderr_task {
                            Some(t) => t.await.unwrap_or(None),
                            None => None,
                        };
                        let _ = tx_clone
                            .send(ProcessEvent::Exited(ProcessExited {
                                exit_code: -1,
                                signal: "TIMEOUT".to_string(),
                                exited_at: now_rfc3339(),
                                stdout_artifact,
                                stderr_artifact,
                            }))
                            .await;
                        release_managed(&children, &pid, &managed_supervisor).await;
                        return;
                    }
                }
            } else {
                wait_fut.await
            };
            let status = match exit_result {
                Ok(s) => s,
                Err(e) => {
                    let mut child_guard = managed_supervisor.lock().await;
                    child_guard.pid = None;
                    child_guard.stdin = None;
                    drop(child_guard);
                    // wait() failed, so pipe closure is not guaranteed; abort
                    // the capture tasks deterministically and reap them rather
                    // than leaving detached tasks behind.
                    if let Some(t) = stdout_task {
                        t.abort();
                        let _ = t.await;
                    }
                    if let Some(t) = stderr_task {
                        t.abort();
                        let _ = t.await;
                    }
                    let _ = tx_clone
                        .send(ProcessEvent::Exited(ProcessExited {
                            exit_code: -1,
                            signal: format!("io error: {e}"),
                            exited_at: now_rfc3339(),
                            stdout_artifact: None,
                            stderr_artifact: None,
                        }))
                        .await;
                    release_managed(&children, &pid, &managed_supervisor).await;
                    return;
                }
            };
            let mut child_guard = managed_supervisor.lock().await;
            let termination_receipt = child_guard.termination_receipt.clone();
            child_guard.pid = None;
            child_guard.stdin = None;
            drop(child_guard);

            // Drain stdout/stderr tasks.
            let stdout_artifact = match stdout_task {
                Some(t) => t.await.unwrap_or(None),
                None => None,
            };
            let stderr_artifact = match stderr_task {
                Some(t) => t.await.unwrap_or(None),
                None => None,
            };

            let signal = if let Some(receipt) = termination_receipt {
                if receipt.contains("SIGKILL") {
                    "SIGKILL".to_string()
                } else if receipt.contains("SIGTERM") {
                    "SIGTERM".to_string()
                } else {
                    receipt
                }
            } else if let Some(code) = status.code() {
                let _ = code;
                String::new()
            } else {
                #[cfg(unix)]
                {
                    use std::os::unix::process::ExitStatusExt;
                    if let Some(sig) = status.signal() {
                        format!("SIG{}", signal_name(sig))
                    } else {
                        String::new()
                    }
                }
                #[cfg(not(unix))]
                {
                    String::new()
                }
            };
            let exit_code = status.code().unwrap_or(-1);
            let _ = tx_clone
                .send(ProcessEvent::Exited(ProcessExited {
                    exit_code,
                    signal,
                    exited_at: now_rfc3339(),
                    stdout_artifact,
                    stderr_artifact,
                }))
                .await;
            release_managed(&children, &pid, &managed_supervisor).await;
        });
        managed.lock().await.supervisor_handle = Some(supervisor);

        Ok((
            SpawnOutcome {
                process_id,
                job_id,
                resolved_executable,
                pid: child_pid,
                started_at,
                process_start_time: process_snapshot
                    .as_ref()
                    .map(|snapshot| snapshot.start_time.clone()),
                process_executable: Some(process_executable),
                working_directory: working_directory.map(|path| path.display().to_string()),
            },
            rx,
        ))
    }

    /// Gracefully stop a running process, escalating to a process-group kill
    /// when it does not exit within the bounded grace period. The supervisor
    /// remains the sole owner of waiting/reaping the child, and this method
    /// waits until that supervisor removes the registry entry.
    pub async fn cancel(&self, process_id: &str, _reason: &str) -> Result<String, ProcessError> {
        const TERM_GRACE_MS: u64 = 2_000;
        const REAP_TIMEOUT_MS: u64 = 5_000;
        let managed = {
            let children = self.children.lock().await;
            children
                .get(process_id)
                .cloned()
                .ok_or_else(|| ProcessError::NotFound(process_id.to_string()))?
        };
        let (pid, process_start_time, process_executable) = {
            let guard = managed.lock().await;
            (
                guard.pid,
                guard.process_start_time.clone(),
                guard.process_executable.clone(),
            )
        };
        let Some(pid) = pid else {
            wait_for_registry_release(
                &self.children,
                process_id,
                time::Instant::now() + std::time::Duration::from_millis(REAP_TIMEOUT_MS),
            )
            .await;
            return Ok("already-exited".to_string());
        };
        let Some(process_start_time) = process_start_time else {
            return Err(ProcessError::IdentityUnavailable(format!(
                "missing start identity for managed process {process_id}"
            )));
        };
        if !process_identity_matches(pid, &process_start_time, &process_executable)? {
            return Err(ProcessError::IdentityMismatch(pid));
        }

        managed.lock().await.cancel_requested = true;
        let mut escalated = false;
        {
            let mut guard = managed.lock().await;
            guard.termination_receipt = Some("SIGTERM".to_string());
        }
        if send_process_signal_for_cancellation(pid, signal_number("SIGTERM")?).is_err() {
            if !process_identity_matches(pid, &process_start_time, &process_executable)? {
                let _ = wait_for_registry_release(
                    &self.children,
                    process_id,
                    time::Instant::now() + std::time::Duration::from_millis(REAP_TIMEOUT_MS),
                )
                .await;
                return Ok("already-exited".to_string());
            }
            escalated = true;
            {
                let mut guard = managed.lock().await;
                guard.termination_receipt = Some("SIGTERM->SIGKILL".to_string());
            }
            send_process_signal_for_cancellation(pid, signal_number("SIGKILL")?)?;
        } else {
            let deadline = time::Instant::now() + std::time::Duration::from_millis(TERM_GRACE_MS);
            loop {
                if managed.lock().await.pid.is_none() {
                    break;
                }
                if time::Instant::now() >= deadline {
                    escalated = true;
                    if process_identity_matches(pid, &process_start_time, &process_executable)? {
                        let mut guard = managed.lock().await;
                        guard.termination_receipt = Some("SIGTERM->SIGKILL".to_string());
                        drop(guard);
                        send_process_signal_for_cancellation(pid, signal_number("SIGKILL")?)?;
                    }
                    break;
                }
                time::sleep(std::time::Duration::from_millis(25)).await;
            }
        }
        let released = wait_for_registry_release(
            &self.children,
            process_id,
            time::Instant::now() + std::time::Duration::from_millis(REAP_TIMEOUT_MS),
        )
        .await;
        if !released {
            return Err(ProcessError::Timeout(REAP_TIMEOUT_MS));
        }
        if escalated {
            Ok("sigterm->sigkill".to_string())
        } else {
            Ok("cancelled".to_string())
        }
    }

    /// Write bytes to a managed process stdin. The write is bounded by the
    /// caller's request size and fails once the process has exited.
    pub async fn write_stdin(&self, process_id: &str, bytes: &[u8]) -> Result<(), ProcessError> {
        let managed = {
            let children = self.children.lock().await;
            children
                .get(process_id)
                .cloned()
                .ok_or_else(|| ProcessError::NotFound(process_id.to_string()))?
        };
        let mut guard = managed.lock().await;
        let stdin = guard
            .stdin
            .as_mut()
            .ok_or_else(|| ProcessError::NotFound(format!("stdin for {process_id}")))?;
        stdin.write_all(bytes).await.map_err(ProcessError::Io)?;
        stdin.flush().await.map_err(ProcessError::Io)?;
        Ok(())
    }

    /// Deliver a narrowly allow-listed signal to the process group.
    pub async fn signal(&self, process_id: &str, signal: &str) -> Result<String, ProcessError> {
        let managed = {
            let children = self.children.lock().await;
            children
                .get(process_id)
                .cloned()
                .ok_or_else(|| ProcessError::NotFound(process_id.to_string()))?
        };
        let guard = managed.lock().await;
        let pid = guard
            .pid
            .ok_or_else(|| ProcessError::NotFound(process_id.to_string()))?;
        let process_start_time = guard.process_start_time.as_deref().ok_or_else(|| {
            ProcessError::IdentityUnavailable(format!("missing start identity for {process_id}"))
        })?;
        if !process_identity_matches(pid, process_start_time, &guard.process_executable)? {
            return Err(ProcessError::IdentityMismatch(pid));
        }
        let signal_number = signal_number(signal)?;
        send_process_signal(pid, signal_number)?;
        Ok(signal.to_string())
    }

    /// Signal a process discovered from durable state after a manager restart.
    /// The persisted identity is checked immediately before the signal so a
    /// reused PID can never receive a job's control request.
    pub async fn signal_verified(
        &self,
        pid: u32,
        process_start_time: &str,
        process_executable: &str,
        signal: &str,
    ) -> Result<String, ProcessError> {
        if !process_identity_matches(pid, process_start_time, process_executable)? {
            return Err(ProcessError::IdentityMismatch(pid));
        }
        send_process_signal(pid, signal_number(signal)?)?;
        Ok(signal.to_string())
    }

    /// Stop a process discovered from durable state after a manager restart.
    /// There is no child handle to reap in this case, so the method waits for
    /// the verified OS identity to disappear instead.
    pub async fn cancel_verified(
        &self,
        pid: u32,
        process_start_time: &str,
        process_executable: &str,
        _reason: &str,
    ) -> Result<String, ProcessError> {
        const TERM_GRACE_MS: u64 = 2_000;
        const KILL_GRACE_MS: u64 = 5_000;
        if !process_identity_matches(pid, process_start_time, process_executable)? {
            return Ok("already-exited".to_string());
        }
        send_process_signal_for_cancellation(pid, signal_number("SIGTERM")?)?;
        if wait_for_process_identity_to_disappear(
            pid,
            process_start_time,
            process_executable,
            TERM_GRACE_MS,
        )
        .await?
        {
            return Ok("cancelled".to_string());
        }
        if process_identity_matches(pid, process_start_time, process_executable)? {
            send_process_signal_for_cancellation(pid, signal_number("SIGKILL")?)?;
        }
        if wait_for_process_identity_to_disappear(
            pid,
            process_start_time,
            process_executable,
            KILL_GRACE_MS,
        )
        .await?
        {
            Ok("sigterm->sigkill".to_string())
        } else {
            Err(ProcessError::Timeout(KILL_GRACE_MS))
        }
    }

    pub async fn is_running(&self, process_id: &str) -> bool {
        let children = self.children.lock().await;
        if let Some(m) = children.get(process_id) {
            let g = m.lock().await;
            if g.cancel_requested {
                return false;
            }
            match (g.pid, g.process_start_time.as_deref()) {
                (Some(pid), Some(start_time)) => {
                    process_identity_matches(pid, start_time, &g.process_executable)
                        .unwrap_or(false)
                }
                _ => false,
            }
        } else {
            false
        }
    }

    pub async fn is_process_identity_running(
        &self,
        pid: u32,
        process_start_time: &str,
        process_executable: &str,
    ) -> Result<bool, ProcessError> {
        process_identity_matches(pid, process_start_time, process_executable)
    }

    pub fn is_process_identity_running_sync(
        &self,
        pid: u32,
        process_start_time: &str,
        process_executable: &str,
    ) -> Result<bool, ProcessError> {
        process_identity_matches(pid, process_start_time, process_executable)
    }

    /// Kill every owned process group and wait until each child supervisor
    /// has reaped its direct child and released its registry entry. Kernel shutdown
    /// calls this before its transport returns, so provider/tool descendants
    /// cannot outlive the effect authority that created them.
    pub async fn shutdown_all(&self) -> Result<(), ProcessError> {
        const SHUTDOWN_TIMEOUT_MS: u64 = 5_000;
        let deadline = time::Instant::now() + std::time::Duration::from_millis(SHUTDOWN_TIMEOUT_MS);
        loop {
            let managed = {
                let children = self.children.lock().await;
                if children.is_empty() {
                    return Ok(());
                }
                children.values().cloned().collect::<Vec<_>>()
            };
            for process in managed {
                let pid = {
                    let mut guard = process.lock().await;
                    guard.cancel_requested = true;
                    guard.termination_receipt = Some("SIGKILL".to_string());
                    guard.stdin = None;
                    (
                        guard.pid,
                        guard.process_start_time.clone(),
                        guard.process_executable.clone(),
                    )
                };
                if let (Some(pid), Some(start_time), executable) = pid {
                    if process_identity_matches(pid, &start_time, &executable).unwrap_or(false) {
                        kill_process_group(pid);
                    }
                }
            }
            if time::Instant::now() >= deadline {
                return Err(ProcessError::Timeout(SHUTDOWN_TIMEOUT_MS));
            }
            time::sleep(std::time::Duration::from_millis(25)).await;
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ProcessSnapshot {
    start_time: String,
    executable: String,
}

fn command_identity(program: &str, args: &[String]) -> String {
    std::iter::once(program)
        .chain(args.iter().map(String::as_str))
        .collect::<Vec<_>>()
        .join(" ")
}

fn process_identity_matches(
    pid: u32,
    expected_start_time: &str,
    expected_executable: &str,
) -> Result<bool, ProcessError> {
    let Some(snapshot) = inspect_process(pid)? else {
        return Ok(false);
    };
    Ok(snapshot.start_time == expected_start_time
        && executable_matches(expected_executable, &snapshot.executable))
}

fn executable_matches(expected: &str, observed: &str) -> bool {
    let expected_first = expected.split_whitespace().next().unwrap_or(expected);
    let expected_name = executable_name(expected_first);
    let observed_first = observed.split_whitespace().next().unwrap_or_default();
    let observed_name = executable_name(observed_first);
    !expected_name.is_empty()
        && !observed_name.is_empty()
        && (expected == observed_first
            || executable_names_match(expected_name, observed_name)
            // A shell may replace itself with the final command in `-c`
            // mode. The start-time identity remains the primary fence; the
            // observed image must also occur in the original command line.
            || (is_launcher(expected_name)
                && expected.split_whitespace().any(|token| {
                    executable_names_match(executable_name(token), observed_name)
                })))
}

#[cfg(windows)]
fn executable_name(value: &str) -> &str {
    value
        .rsplit(['/', '\\'])
        .next()
        .map_or(value, |name| name.trim_matches(['(', ')']))
}

#[cfg(not(windows))]
fn executable_name(value: &str) -> &str {
    value
        .rsplit('/')
        .next()
        .map_or(value, |name| name.trim_matches(['(', ')']))
}

fn executable_names_match(expected: &str, observed: &str) -> bool {
    #[cfg(windows)]
    {
        let expected = strip_exe_suffix(expected);
        let observed = strip_exe_suffix(observed);
        expected.eq_ignore_ascii_case(observed)
    }
    #[cfg(not(windows))]
    {
        expected == observed
    }
}

#[cfg(windows)]
fn strip_exe_suffix(name: &str) -> &str {
    if name.len() >= 4 && name[name.len() - 4..].eq_ignore_ascii_case(".exe") {
        &name[..name.len() - 4]
    } else {
        name
    }
}

fn is_launcher(name: &str) -> bool {
    is_shell_launcher(name)
        || executable_names_match(name, "sandbox-exec")
        || executable_names_match(name, "bwrap")
}

fn is_shell_launcher(name: &str) -> bool {
    [
        "sh",
        "bash",
        "zsh",
        "fish",
        "dash",
        "ksh",
        "pwsh",
        "powershell",
        "cmd.exe",
    ]
    .iter()
    .any(|candidate| executable_names_match(name, candidate))
}

#[cfg(target_os = "linux")]
fn inspect_process(pid: u32) -> Result<Option<ProcessSnapshot>, ProcessError> {
    let stat_path = format!("/proc/{pid}/stat");
    let stat = match std::fs::read_to_string(stat_path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(ProcessError::Io(error)),
    };
    let Some((prefix, fields)) = stat.rsplit_once(") ") else {
        return Err(ProcessError::IdentityUnavailable(format!(
            "malformed /proc/{pid}/stat"
        )));
    };
    let Some((_, command_name)) = prefix.split_once(" (") else {
        return Err(ProcessError::IdentityUnavailable(format!(
            "missing /proc/{pid} command name"
        )));
    };
    let command_name = command_name.trim_end_matches(')');
    let Some(state) = fields.split_whitespace().next() else {
        return Err(ProcessError::IdentityUnavailable(format!(
            "missing /proc/{pid} state"
        )));
    };
    if state == "Z" {
        return Ok(None);
    }
    let Some(start_time) = fields.split_whitespace().nth(19) else {
        return Err(ProcessError::IdentityUnavailable(format!(
            "missing /proc/{pid} start time"
        )));
    };
    let commandline = match std::fs::read(format!("/proc/{pid}/cmdline")) {
        Ok(commandline) => commandline,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(ProcessError::Io(error)),
    };
    let executable = commandline
        .split(|byte| *byte == 0)
        .next()
        .filter(|value| !value.is_empty())
        .map_or_else(
            || match std::fs::read_link(format!("/proc/{pid}/exe")) {
                Ok(path) => Ok(path.display().to_string()),
                // A live process can temporarily expose an empty cmdline and
                // no exe link while its image is being replaced. The stat
                // command name is still tied to this PID/start-time fence.
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    Ok(command_name.to_string())
                }
                Err(error) => Err(ProcessError::Io(error)),
            },
            |value| Ok(String::from_utf8_lossy(value).into_owned()),
        )?;
    Ok(Some(ProcessSnapshot {
        start_time: start_time.to_string(),
        executable,
    }))
}

#[cfg(target_os = "macos")]
fn inspect_process(pid: u32) -> Result<Option<ProcessSnapshot>, ProcessError> {
    let output = std::process::Command::new("/bin/ps")
        .args([
            "-p",
            &pid.to_string(),
            "-ww",
            "-o",
            "lstart=",
            "-o",
            "command=",
        ])
        .output()?;
    if !output.status.success() {
        return Ok(None);
    }
    let line = String::from_utf8_lossy(&output.stdout);
    let mut fields = line.split_whitespace();
    let mut start_parts = Vec::with_capacity(5);
    for _ in 0..5 {
        let Some(part) = fields.next() else {
            return Ok(None);
        };
        start_parts.push(part);
    }
    let executable = fields.collect::<Vec<_>>().join(" ");
    if executable.is_empty() {
        return Ok(None);
    }
    Ok(Some(ProcessSnapshot {
        start_time: start_parts.join(" "),
        executable,
    }))
}

#[cfg(all(unix, not(target_os = "linux"), not(target_os = "macos")))]
fn inspect_process(pid: u32) -> Result<Option<ProcessSnapshot>, ProcessError> {
    let output = std::process::Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "lstart=", "-o", "command="])
        .output()?;
    if !output.status.success() {
        return Ok(None);
    }
    let line = String::from_utf8_lossy(&output.stdout);
    let mut fields = line.split_whitespace();
    let mut start_parts = Vec::with_capacity(5);
    for _ in 0..5 {
        let Some(part) = fields.next() else {
            return Ok(None);
        };
        start_parts.push(part);
    }
    let executable = fields.collect::<Vec<_>>().join(" ");
    if executable.is_empty() {
        return Ok(None);
    }
    Ok(Some(ProcessSnapshot {
        start_time: start_parts.join(" "),
        executable,
    }))
}

#[cfg(windows)]
fn inspect_process(pid: u32) -> Result<Option<ProcessSnapshot>, ProcessError> {
    // Windows does not expose a portable std API for process start identity.
    // PowerShell's Process API provides the same PID/start-time fence without
    // introducing unauthorized Win32 FFI into the kernel.
    // Get-Process accepts Int32 process IDs. A value outside that range cannot
    // identify a process through this API and must be treated as absent rather
    // than turned into an inspection error during reconciliation.
    let Some(power_shell_pid) = i32::try_from(pid).ok() else {
        return Ok(None);
    };
    let script = format!(
        "$ErrorActionPreference = 'Stop'; \
         try {{ \
             $process = Get-Process -Id {power_shell_pid} -ErrorAction Stop; \
             $start = $process.StartTime.ToUniversalTime().ToFileTimeUtc(); \
             Write-Output $start; \
             Write-Output $process.ProcessName; \
         }} catch {{ \
             if ($null -eq (Get-Process -Id {power_shell_pid} -ErrorAction SilentlyContinue)) {{ exit 3 }}; \
             exit 4; \
         }}"
    );
    let output = std::process::Command::new("powershell.exe")
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            &script,
        ])
        .output()?;
    if !output.status.success() {
        return if output.status.code() == Some(3) {
            Ok(None)
        } else {
            Err(ProcessError::IdentityUnavailable(format!(
                "PowerShell could not inspect PID {pid}"
            )))
        };
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut lines = stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty());
    let Some(start_time) = lines.next() else {
        return Err(ProcessError::IdentityUnavailable(format!(
            "PowerShell returned no start time for PID {pid}"
        )));
    };
    let Some(executable) = lines.next() else {
        return Err(ProcessError::IdentityUnavailable(format!(
            "PowerShell returned no executable for PID {pid}"
        )));
    };
    Ok(Some(ProcessSnapshot {
        start_time: start_time.to_string(),
        executable: executable.to_string(),
    }))
}

#[cfg(all(not(unix), not(windows)))]
fn inspect_process(_pid: u32) -> Result<Option<ProcessSnapshot>, ProcessError> {
    Err(ProcessError::IdentityUnavailable(
        "PID start-time and executable inspection is unsupported on this platform".to_string(),
    ))
}

async fn wait_for_registry_release(
    children: &ChildRegistry,
    process_id: &str,
    deadline: time::Instant,
) -> bool {
    loop {
        if !children.lock().await.contains_key(process_id) {
            return true;
        }
        if time::Instant::now() >= deadline {
            return false;
        }
        time::sleep(std::time::Duration::from_millis(25)).await;
    }
}

async fn wait_for_process_identity_to_disappear(
    pid: u32,
    process_start_time: &str,
    process_executable: &str,
    timeout_ms: u64,
) -> Result<bool, ProcessError> {
    let deadline = time::Instant::now() + std::time::Duration::from_millis(timeout_ms);
    loop {
        if !process_identity_matches(pid, process_start_time, process_executable)?
            && !process_group_exists(pid)?
        {
            return Ok(true);
        }
        if time::Instant::now() >= deadline {
            return Ok(false);
        }
        time::sleep(std::time::Duration::from_millis(25)).await;
    }
}

#[cfg(unix)]
fn process_group_exists(pid: u32) -> Result<bool, ProcessError> {
    i32::try_from(pid).map_err(|_| {
        ProcessError::IdentityUnavailable(format!(
            "process id {pid} cannot be represented as a POSIX group id"
        ))
    })?;
    match send_process_signal(pid, 0) {
        Ok(()) => Ok(true),
        Err(ProcessError::Io(error)) if error.raw_os_error() == Some(libc::ESRCH) => Ok(false),
        Err(ProcessError::Io(error)) if error.raw_os_error() == Some(libc::EPERM) => {
            // The original leader has already disappeared. If the numeric PGID
            // was reused by a group we cannot inspect, it is not safe to retain
            // the job lease or claim that group as ours.
            Ok(false)
        }
        Err(error) => Err(error),
    }
}

#[cfg(windows)]
fn process_group_exists(pid: u32) -> Result<bool, ProcessError> {
    // taskkill /T is the tree operation on Windows. The leader identity is
    // the only portable post-kill observation available without Win32 FFI.
    inspect_process(pid).map(|snapshot| snapshot.is_some())
}

#[cfg(all(not(unix), not(windows)))]
fn process_group_exists(_pid: u32) -> Result<bool, ProcessError> {
    Ok(false)
}

#[cfg(unix)]
fn signal_number(signal: &str) -> Result<i32, ProcessError> {
    match signal {
        "SIGTERM" => Ok(libc::SIGTERM),
        "SIGKILL" => Ok(libc::SIGKILL),
        "SIGINT" => Ok(libc::SIGINT),
        "SIGHUP" => Ok(libc::SIGHUP),
        _ => Err(ProcessError::InvalidSpec(format!(
            "unsupported signal `{signal}`"
        ))),
    }
}

#[cfg(windows)]
fn signal_number(signal: &str) -> Result<i32, ProcessError> {
    match signal {
        "SIGTERM" => Ok(15),
        "SIGKILL" => Ok(9),
        "SIGINT" => Ok(2),
        "SIGHUP" => Ok(1),
        _ => Err(ProcessError::InvalidSpec(format!(
            "unsupported signal `{signal}`"
        ))),
    }
}

#[cfg(all(not(unix), not(windows)))]
fn signal_number(_signal: &str) -> Result<i32, ProcessError> {
    Err(ProcessError::InvalidSpec(
        "signals are unsupported on this platform".to_string(),
    ))
}

async fn release_managed(children: &ChildRegistry, process_id: &str, managed: &ManagedProcessRef) {
    let lease = {
        let mut guard = managed.lock().await;
        guard.child = None;
        guard.pid = None;
        guard.stdin = None;
        guard.process_start_time = None;
        guard.termination_receipt = None;
        guard.lease.take()
    };
    drop(lease);
    children.lock().await.remove(process_id);
}

#[derive(Debug, Clone, Copy)]
enum StreamKind {
    Stdout,
    Stderr,
}

async fn capture_stream<R: tokio::io::AsyncRead + Unpin>(
    reader: &mut R,
    tx: &mpsc::Sender<ProcessEvent>,
    store: &ArtifactStore,
    max_inline: usize,
    kind: StreamKind,
) -> Option<ArtifactRef> {
    let mut buf = vec![0u8; 8192];
    let mut total: Vec<u8> = Vec::new();
    let mut spill_path: Option<std::path::PathBuf> = None;
    let mut spill_file: Option<tokio::fs::File> = None;
    let mut cursor: u64 = 0;
    let mut delivery_open = true;
    let mut read_failed = false;
    loop {
        match reader.read(&mut buf).await {
            Ok(0) => break,
            Ok(n) => {
                let chunk = &buf[..n];
                if spill_file.is_none() && total.len().saturating_add(chunk.len()) <= max_inline {
                    total.extend_from_slice(chunk);
                } else {
                    if spill_file.is_none() {
                        let path = store.root().join("tmp").join(format!(
                            "process-output-{}-{}",
                            std::process::id(),
                            terminus_kernel_protocol::new_id()
                        ));
                        let mut file = tokio::fs::File::create(&path).await.ok()?;
                        if file.write_all(&total).await.is_err() {
                            let _ = tokio::fs::remove_file(&path).await;
                            return None;
                        }
                        spill_path = Some(path);
                        spill_file = Some(file);
                    }
                    let write_failed = match spill_file.as_mut() {
                        Some(file) => file.write_all(chunk).await.is_err(),
                        None => false,
                    };
                    if write_failed {
                        spill_file.take();
                        if let Some(path) = spill_path.take() {
                            let _ = tokio::fs::remove_file(path).await;
                        }
                        return None;
                    }
                }
                cursor += n as u64;
                if delivery_open {
                    let event = match kind {
                        StreamKind::Stdout => ProcessEvent::Stdout(OutputChunk {
                            cursor,
                            bytes: chunk.to_vec(),
                            redacted: false,
                        }),
                        StreamKind::Stderr => ProcessEvent::Stderr(OutputChunk {
                            cursor,
                            bytes: chunk.to_vec(),
                            redacted: false,
                        }),
                    };
                    if tx.send(event).await.is_err() {
                        // A closed observer is not permission to truncate the
                        // authoritative artifact. Continue draining the pipe.
                        delivery_open = false;
                    }
                }
            }
            Err(_) => {
                read_failed = true;
                break;
            }
        }
    }
    if read_failed {
        tracing::warn!(
            stream = ?kind,
            cursor,
            "process output read failed; withholding incomplete artifact"
        );
        drop(spill_file.take());
        if let Some(path) = spill_path.take() {
            let _ = tokio::fs::remove_file(path).await;
        }
        return None;
    }
    if let Some(path) = spill_path {
        if let Some(mut file) = spill_file {
            if file.flush().await.is_err() {
                let _ = tokio::fs::remove_file(&path).await;
                return None;
            }
        }
        let artifact = tokio::task::spawn_blocking({
            let store = store.clone();
            let path = path.clone();
            move || store.ingest_file(&path).ok().map(|(_, artifact)| artifact)
        })
        .await
        .ok()
        .flatten();
        let _ = tokio::fs::remove_file(path).await;
        return artifact;
    }
    if total.is_empty() {
        return None;
    }
    let (_, artifact) = store.ingest(&total).ok()?;
    Some(artifact)
}

#[cfg(unix)]
#[allow(unsafe_code)]
fn kill_process_group(pid: u32) {
    // ADR-0031: `killpg(2)` has no safe Rust binding in std. We use the
    // smallest possible `unsafe` block to call `libc::kill(-pgid, SIGKILL)`
    // and dispatch SIGKILL to the entire process group. The argument is a
    // negative pid which POSIX defines as "the process group whose ID is the
    // absolute value of pid". We hold no resources across the call.
    // SAFETY: `libc::kill` is async-signal-safe per POSIX; the call does not
    // touch Rust-managed memory and we ignore the return value (the worst
    // case is ESRCH, which means the process is already gone — exactly what
    // we want).
    unsafe {
        libc::kill(-(pid as i32), libc::SIGKILL);
    }
}

#[cfg(unix)]
#[allow(unsafe_code)]
fn send_process_signal(pid: u32, signal: i32) -> Result<(), ProcessError> {
    // SAFETY: libc::kill only receives the validated process-group id and an
    // allow-listed signal number; no Rust-managed memory crosses the call.
    let result = unsafe { libc::kill(-(pid as i32), signal) };
    if result == 0 {
        Ok(())
    } else {
        let error = std::io::Error::last_os_error();
        Err(ProcessError::Io(error))
    }
}

#[cfg(unix)]
fn send_process_signal_for_cancellation(pid: u32, signal: i32) -> Result<(), ProcessError> {
    match send_process_signal(pid, signal) {
        Err(ProcessError::Io(error)) if error.raw_os_error() == Some(libc::ESRCH) => Ok(()),
        result => result,
    }
}

#[cfg(windows)]
fn send_process_signal(pid: u32, _signal: i32) -> Result<(), ProcessError> {
    let status = std::process::Command::new("taskkill.exe")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()?;
    if status.success() {
        return Ok(());
    }
    Err(ProcessError::Io(std::io::Error::other(format!(
        "taskkill.exe failed for PID {pid}: {status}"
    ))))
}

#[cfg(windows)]
fn send_process_signal_for_cancellation(pid: u32, signal: i32) -> Result<(), ProcessError> {
    match send_process_signal(pid, signal) {
        Ok(()) => Ok(()),
        Err(_error) if matches!(inspect_process(pid), Ok(None)) => Ok(()),
        Err(error) => Err(error),
    }
}

#[cfg(all(not(unix), not(windows)))]
fn send_process_signal(_pid: u32, _signal: i32) -> Result<(), ProcessError> {
    Err(ProcessError::InvalidSpec(
        "signals are unsupported on this platform".to_string(),
    ))
}

#[cfg(all(not(unix), not(windows)))]
fn send_process_signal_for_cancellation(pid: u32, signal: i32) -> Result<(), ProcessError> {
    send_process_signal(pid, signal)
}

#[cfg(windows)]
fn kill_process_group(pid: u32) {
    let _ = std::process::Command::new("taskkill.exe")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

#[cfg(all(not(unix), not(windows)))]
fn kill_process_group(_pid: u32) {
    // No process groups on non-unix; child kill is handled by tokio.
}

#[cfg(unix)]
fn signal_name(sig: i32) -> &'static str {
    match sig {
        libc::SIGTERM => "TERM",
        libc::SIGKILL => "KILL",
        libc::SIGINT => "INT",
        libc::SIGHUP => "HUP",
        libc::SIGSEGV => "SEGV",
        libc::SIGABRT => "ABRT",
        _ => "UNKNOWN",
    }
}

fn now_rfc3339() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let dur = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    unix_to_rfc3339(dur.as_secs(), dur.subsec_micros())
}

fn unix_to_rfc3339(secs: u64, micros: u32) -> String {
    let days = i64::try_from(secs / 86_400).unwrap_or(i64::MAX);
    let secs_of_day = secs % 86_400;
    let (year, month, day) = civil_from_days(days);
    let hour = secs_of_day / 3_600;
    let minute = (secs_of_day % 3_600) / 60;
    let second = secs_of_day % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{micros:06}Z")
}

fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (
        if m <= 2 { y + 1 } else { y },
        u32::try_from(m).unwrap_or(1),
        u32::try_from(d).unwrap_or(1),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, Ordering};
    use tempfile::tempdir;

    fn store() -> (tempfile::TempDir, Arc<ArtifactStore>) {
        let dir = tempdir().unwrap();
        let store = ArtifactStore::open(dir.path()).unwrap();
        (dir, Arc::new(store))
    }

    #[cfg(unix)]
    #[test]
    fn signal_number_allows_the_documented_signals() {
        assert!(signal_number("SIGTERM").is_ok());
        assert!(signal_number("SIGKILL").is_ok());
        assert!(signal_number("SIGINT").is_ok());
        assert!(signal_number("SIGHUP").is_ok());
        assert!(matches!(
            signal_number("SIGQUIT"),
            Err(ProcessError::InvalidSpec(_))
        ));
    }

    #[cfg(all(not(unix), not(windows)))]
    #[test]
    fn signal_number_rejects_unsupported_platforms() {
        assert!(matches!(
            signal_number("SIGTERM"),
            Err(ProcessError::InvalidSpec(_))
        ));
    }

    #[cfg(windows)]
    #[test]
    fn signal_number_allows_windows_termination_requests() {
        assert!(signal_number("SIGTERM").is_ok());
        assert!(signal_number("SIGKILL").is_ok());
        assert!(matches!(
            signal_number("SIGQUIT"),
            Err(ProcessError::InvalidSpec(_))
        ));
    }

    #[cfg(windows)]
    #[test]
    fn windows_process_inspection_treats_out_of_range_pid_as_missing() {
        assert!(inspect_process(u32::MAX).unwrap().is_none());
    }

    #[test]
    fn identity_fence_allows_a_known_sandbox_wrapper_to_exec_the_target() {
        let sandbox_command = "/usr/bin/sandbox-exec -p policy -- /usr/bin/env -i /bin/cat";
        assert!(executable_matches(sandbox_command, "/bin/cat"));
        assert!(!executable_matches(sandbox_command, "/bin/sh"));
    }

    #[test]
    fn identity_fence_rejects_an_unrelated_wrapper_image() {
        assert!(!executable_matches(
            "/usr/bin/sandbox-exec -p policy -- /bin/cat",
            "/usr/bin/python"
        ));
    }

    #[cfg(windows)]
    #[test]
    fn identity_fence_normalizes_windows_executable_names() {
        assert!(executable_matches("git", r"C:\Git\git.EXE"));
        assert!(executable_matches(r"CMD.EXE /C C:\Git\git.exe", "git"));
        assert!(!executable_matches("git", r"C:\Git\python.EXE"));
    }

    #[tokio::test]
    async fn spawn_capture_and_exit() {
        let (_dir, store) = store();
        let mgr = ProcessManager::new(store);
        let spawn = NormalizedSpawn {
            program: "sh".into(),
            args: vec!["-c".into(), "echo hello; echo err 1>&2".into()],
            env: std::collections::BTreeMap::new(),
            working_dir: None,
            timeout_ms: 5_000,
            shell: true,
            allocate_pty: false,
        };
        let (outcome, mut rx) = mgr.spawn(spawn).await.unwrap();
        let mut got_started = false;
        let mut got_stdout = false;
        let mut got_exit = false;
        let mut exit_code = -999;
        while let Some(ev) = rx.recv().await {
            match ev {
                ProcessEvent::Started(_) => got_started = true,
                ProcessEvent::Stdout(c) => {
                    if String::from_utf8_lossy(&c.bytes).contains("hello") {
                        got_stdout = true;
                    }
                }
                ProcessEvent::Exited(e) => {
                    exit_code = e.exit_code;
                    got_exit = true;
                }
                _ => {}
            }
        }
        assert!(got_started);
        assert!(got_stdout);
        assert!(got_exit);
        assert_eq!(exit_code, 0);
        let _ = outcome;
    }

    #[tokio::test]
    async fn spill_capture_keeps_the_complete_output_artifact() {
        let (_dir, store) = store();
        let expected = "0123456789abcdef".repeat(128);
        let mgr = ProcessManager::new(Arc::clone(&store)).with_max_inline_bytes(32);
        let spawn = NormalizedSpawn {
            program: "sh".into(),
            args: vec!["-c".into(), format!("printf '%s' '{}'", expected)],
            env: std::collections::BTreeMap::new(),
            working_dir: None,
            timeout_ms: 5_000,
            shell: true,
            allocate_pty: false,
        };
        let (_outcome, mut rx) = mgr.spawn(spawn).await.unwrap();
        let mut artifact = None;
        while let Some(event) = rx.recv().await {
            if let ProcessEvent::Exited(exit) = event {
                artifact = exit.stdout_artifact;
            }
        }
        let artifact = artifact.expect("spilled stdout must produce an artifact reference");
        assert_eq!(store.get(&artifact.sha256).unwrap(), expected.as_bytes());
    }

    #[tokio::test]
    async fn closed_event_receiver_does_not_truncate_spilled_output() {
        let (_dir, store) = store();
        let expected = "0123456789abcdef".repeat(128);
        let (tx, rx) = mpsc::channel(1);
        drop(rx);
        let mut reader = std::io::Cursor::new(expected.as_bytes().to_vec());

        let artifact = capture_stream(&mut reader, &tx, &store, 32, StreamKind::Stdout)
            .await
            .expect("closed observers must still receive the complete artifact reference");
        assert_eq!(store.get(&artifact.sha256).unwrap(), expected.as_bytes());
    }

    struct ReadThenError {
        emitted: bool,
    }

    impl tokio::io::AsyncRead for ReadThenError {
        fn poll_read(
            mut self: std::pin::Pin<&mut Self>,
            _cx: &mut std::task::Context<'_>,
            buf: &mut tokio::io::ReadBuf<'_>,
        ) -> std::task::Poll<std::io::Result<()>> {
            if self.emitted {
                return std::task::Poll::Ready(Err(std::io::Error::new(
                    std::io::ErrorKind::Interrupted,
                    "fixture read failure",
                )));
            }
            self.emitted = true;
            buf.put_slice(b"partial output");
            std::task::Poll::Ready(Ok(()))
        }
    }

    #[tokio::test]
    async fn read_failure_withholds_incomplete_artifact() {
        let (_dir, store) = store();
        let (tx, _rx) = mpsc::channel(4);
        let mut reader = ReadThenError { emitted: false };

        let artifact = capture_stream(&mut reader, &tx, &store, 32, StreamKind::Stdout).await;

        assert!(artifact.is_none());
    }

    #[tokio::test]
    async fn cancel_running_process() {
        let (_dir, store) = store();
        let mgr = ProcessManager::new(store);
        let spawn = NormalizedSpawn {
            program: "sh".into(),
            args: vec!["-c".into(), "sleep 30".into()],
            env: std::collections::BTreeMap::new(),
            working_dir: None,
            timeout_ms: 0,
            shell: true,
            allocate_pty: false,
        };
        let (outcome, _rx) = mgr.spawn(spawn).await.unwrap();
        // `spawn` returns as soon as the child is registered; the supervisor
        // task that publishes the running state may not have been polled yet.
        // Poll for the transition instead of asserting on a race.
        assert!(
            wait_until(|| mgr.is_running(&outcome.process_id)).await,
            "process never reached the running state"
        );
        let state = mgr.cancel(&outcome.process_id, "test").await.unwrap();
        assert_eq!(state, "cancelled");
        assert!(
            wait_until(|| async { !mgr.is_running(&outcome.process_id).await }).await,
            "process never left the running state after cancel"
        );
    }

    /// Poll `condition` until it holds or a bounded deadline passes.
    async fn wait_until<F, Fut>(mut condition: F) -> bool
    where
        F: FnMut() -> Fut,
        Fut: std::future::Future<Output = bool>,
    {
        const DEADLINE: std::time::Duration = std::time::Duration::from_secs(5);
        let start = time::Instant::now();
        loop {
            if condition().await {
                return true;
            }
            if start.elapsed() >= DEADLINE {
                return false;
            }
            time::sleep(std::time::Duration::from_millis(10)).await;
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn spawn_records_pid_and_start_identity_and_fences_signals() {
        let (_dir, store) = store();
        let mgr = ProcessManager::new(store);
        let spawn = NormalizedSpawn {
            program: "sleep".into(),
            args: vec!["30".into()],
            env: std::collections::BTreeMap::new(),
            working_dir: None,
            timeout_ms: 0,
            shell: false,
            allocate_pty: false,
        };
        let (outcome, _rx) = mgr.spawn(spawn).await.unwrap();
        let pid = outcome.pid.expect("unix spawn must report a pid");
        let start_time = outcome
            .process_start_time
            .as_deref()
            .expect("unix spawn must report a process start identity");
        let executable = outcome
            .process_executable
            .as_deref()
            .expect("spawn must report its executable identity");

        assert!(outcome.started_at.contains('T'));
        assert!(outcome.started_at.ends_with('Z'));
        assert!(mgr
            .is_process_identity_running(pid, start_time, executable)
            .await
            .unwrap());
        assert!(matches!(
            mgr.signal_verified(pid, "wrong-start", executable, "SIGTERM")
                .await,
            Err(ProcessError::IdentityMismatch(actual_pid)) if actual_pid == pid
        ));
        assert!(matches!(
            mgr.signal_verified(pid, start_time, "not-the-child", "SIGTERM")
                .await,
            Err(ProcessError::IdentityMismatch(actual_pid)) if actual_pid == pid
        ));

        assert_eq!(
            mgr.cancel(&outcome.process_id, "identity-test")
                .await
                .unwrap(),
            "cancelled"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn graceful_cancel_records_sigterm_receipt() {
        let (_dir, store) = store();
        let mgr = ProcessManager::new(store);
        let spawn = NormalizedSpawn {
            program: "sh".into(),
            args: vec![
                "-c".into(),
                "trap 'exit 0' TERM; while :; do sleep 1; done".into(),
            ],
            env: std::collections::BTreeMap::new(),
            working_dir: None,
            timeout_ms: 0,
            shell: true,
            allocate_pty: false,
        };
        let (outcome, mut rx) = mgr.spawn(spawn).await.unwrap();
        assert_eq!(
            mgr.cancel(&outcome.process_id, "graceful-test")
                .await
                .unwrap(),
            "cancelled"
        );

        let mut exit_signal = None;
        while let Some(event) = rx.recv().await {
            if let ProcessEvent::Exited(exit) = event {
                exit_signal = Some(exit.signal);
            }
        }
        assert_eq!(exit_signal.as_deref(), Some("SIGTERM"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stubborn_process_escalates_to_sigkill_receipt() {
        let (_dir, store) = store();
        let mgr = ProcessManager::new(store);
        let spawn = NormalizedSpawn {
            program: "sh".into(),
            args: vec![
                "-c".into(),
                "trap '' TERM; echo ready; while :; do :; done".into(),
            ],
            env: std::collections::BTreeMap::new(),
            working_dir: None,
            timeout_ms: 0,
            shell: true,
            allocate_pty: false,
        };
        let (outcome, mut rx) = mgr.spawn(spawn).await.unwrap();
        let ready = time::timeout(std::time::Duration::from_secs(2), async {
            while let Some(event) = rx.recv().await {
                if let ProcessEvent::Stdout(chunk) = event {
                    if String::from_utf8_lossy(&chunk.bytes).contains("ready") {
                        return true;
                    }
                }
            }
            false
        })
        .await
        .unwrap();
        assert!(ready, "stubborn process did not install its signal handler");
        assert_eq!(
            mgr.cancel(&outcome.process_id, "escalation-test")
                .await
                .unwrap(),
            "sigterm->sigkill"
        );

        let mut exit_signal = None;
        while let Some(event) = rx.recv().await {
            if let ProcessEvent::Exited(exit) = event {
                exit_signal = Some(exit.signal);
            }
        }
        assert_eq!(exit_signal.as_deref(), Some("SIGKILL"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn shutdown_all_kills_and_reaps_the_owned_process_group() {
        let (_dir, store) = store();
        let mgr = ProcessManager::new(store);
        let spawn = NormalizedSpawn {
            program: "sh".into(),
            args: vec!["-c".into(), "sleep 30 & echo $!; wait".into()],
            env: std::collections::BTreeMap::new(),
            working_dir: None,
            timeout_ms: 0,
            shell: true,
            allocate_pty: false,
        };
        let (_outcome, mut rx) = mgr.spawn(spawn).await.unwrap();
        let descendant_pid = time::timeout(std::time::Duration::from_secs(2), async {
            while let Some(event) = rx.recv().await {
                if let ProcessEvent::Stdout(chunk) = event {
                    let value = String::from_utf8_lossy(&chunk.bytes);
                    if let Ok(pid) = value.trim().parse::<u32>() {
                        return Some(pid);
                    }
                }
            }
            None
        })
        .await
        .unwrap()
        .unwrap();
        mgr.shutdown_all().await.unwrap();
        let still_alive = std::process::Command::new("kill")
            .args(["-0", &descendant_pid.to_string()])
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
        assert!(!still_alive, "descendant process survived manager shutdown");
    }

    #[tokio::test]
    async fn timeout_kills_process() {
        let (_dir, store) = store();
        let mgr = ProcessManager::new(store);
        let spawn = NormalizedSpawn {
            program: "sh".into(),
            args: vec!["-c".into(), "sleep 30".into()],
            env: std::collections::BTreeMap::new(),
            working_dir: None,
            timeout_ms: 200,
            shell: true,
            allocate_pty: false,
        };
        let (outcome, mut rx) = mgr.spawn(spawn).await.unwrap();
        let mut got_timeout_exit = false;
        while let Some(ev) = rx.recv().await {
            if let ProcessEvent::Exited(e) = ev {
                if e.signal == "TIMEOUT" {
                    got_timeout_exit = true;
                }
            }
        }
        assert!(got_timeout_exit);
        let _ = outcome;
    }

    #[tokio::test]
    async fn spawn_with_explicit_env() {
        let (_dir, store) = store();
        let mgr = ProcessManager::new(store);
        let mut env = std::collections::BTreeMap::new();
        env.insert("TERMINUS_TEST_VAR".to_string(), "value-123".to_string());
        let spawn = NormalizedSpawn {
            program: "sh".into(),
            args: vec!["-c".into(), "echo $TERMINUS_TEST_VAR".into()],
            env,
            working_dir: None,
            timeout_ms: 5_000,
            shell: true,
            allocate_pty: false,
        };
        let (_outcome, mut rx) = mgr.spawn(spawn).await.unwrap();
        let mut got_value = false;
        while let Some(ev) = rx.recv().await {
            if let ProcessEvent::Stdout(c) = ev {
                if String::from_utf8_lossy(&c.bytes).contains("value-123") {
                    got_value = true;
                }
            }
        }
        assert!(got_value);
    }

    #[tokio::test]
    async fn no_ambient_env_inherited() {
        // Ensure no ambient env is leaked: an explicit env var we set IS
        // visible, but an ambient var (TERMINUS_TEST_LEAK) is NOT.
        std::env::set_var("TERMINUS_TEST_LEAK", "leaked");
        let (_dir, store) = store();
        let mgr = ProcessManager::new(store);
        let mut env = std::collections::BTreeMap::new();
        env.insert("TERMINUS_TEST_MARKER".to_string(), "present".to_string());
        let spawn = NormalizedSpawn {
            program: "sh".into(),
            args: vec![
                "-c".into(),
                "echo \"marker=$TERMINUS_TEST_MARKER leak=$TERMINUS_TEST_LEAK\"".into(),
            ],
            env,
            working_dir: None,
            timeout_ms: 5_000,
            shell: true,
            allocate_pty: false,
        };
        let (_outcome, mut rx) = mgr.spawn(spawn).await.unwrap();
        let mut line = String::new();
        while let Some(ev) = rx.recv().await {
            if let ProcessEvent::Stdout(c) = ev {
                line.push_str(&String::from_utf8_lossy(&c.bytes));
            }
        }
        std::env::remove_var("TERMINUS_TEST_LEAK");
        // Explicit env propagates; ambient TERMINUS_TEST_LEAK does NOT.
        assert_eq!(line.trim(), "marker=present leak=");
    }

    #[tokio::test]
    async fn working_directory_applied() {
        let (_dir, store) = store();
        let tmp = tempdir().unwrap();
        let mgr = ProcessManager::new(store);

        #[cfg(windows)]
        let program = std::env::var_os("ComSpec")
            .unwrap_or_else(|| std::ffi::OsString::from("cmd.exe"))
            .to_string_lossy()
            .into_owned();
        #[cfg(not(windows))]
        let program = "pwd".to_string();

        #[cfg(windows)]
        let args = vec!["/C".to_string(), "cd".to_string()];
        #[cfg(not(windows))]
        let args = Vec::new();

        let spawn = NormalizedSpawn {
            program,
            args,
            env: std::collections::BTreeMap::new(),
            working_dir: Some(PathBuf::from(tmp.path())),
            timeout_ms: 5_000,
            shell: false,
            allocate_pty: false,
        };
        let (_outcome, mut rx) = mgr.spawn(spawn).await.unwrap();
        let mut pwd_line = String::new();
        while let Some(ev) = rx.recv().await {
            if let ProcessEvent::Stdout(c) = ev {
                pwd_line.push_str(&String::from_utf8_lossy(&c.bytes));
            }
        }
        let actual = std::fs::canonicalize(pwd_line.trim()).unwrap();
        let expected = std::fs::canonicalize(tmp.path()).unwrap();
        assert_eq!(actual, expected);
    }

    #[test]
    fn process_timestamp_format_is_rfc3339() {
        assert_eq!(
            unix_to_rfc3339(1_709_208_000, 1),
            "2024-02-29T12:00:00.000001Z"
        );
    }

    #[tokio::test]
    async fn lease_is_released_when_the_child_exits() {
        let (_dir, store) = store();
        let mgr = ProcessManager::new(store);
        let released = Arc::new(AtomicBool::new(false));
        let released_for_lease = Arc::clone(&released);
        let spawn = NormalizedSpawn {
            program: "echo".into(),
            args: vec!["lease".into()],
            env: std::collections::BTreeMap::new(),
            working_dir: None,
            timeout_ms: 5_000,
            shell: false,
            allocate_pty: false,
        };
        let (outcome, mut rx) = mgr
            .spawn_wrapped_with_lease(
                PathBuf::from("echo"),
                vec!["lease".to_string()],
                spawn,
                SpawnLease::new(move || {
                    released_for_lease.store(true, Ordering::Release);
                }),
            )
            .await
            .unwrap();
        while rx.recv().await.is_some() {}
        assert!(released.load(Ordering::Acquire));
        assert!(!mgr.is_running(&outcome.process_id).await);
        assert!(matches!(
            mgr.cancel(&outcome.process_id, "after-exit").await,
            Err(ProcessError::NotFound(_))
        ));
    }
}

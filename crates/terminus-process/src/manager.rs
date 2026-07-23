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
    pub cancel_requested: bool,
    pub allocate_pty: bool,
    lease: Option<SpawnLease>,
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
        self.spawn_command(command, resolved_executable, spawn.timeout_ms, None)
            .await
    }

    /// Spawn a process wrapped in a sandbox binary (e.g. `bwrap`) with a
    /// pre-built argv prefix. `wrapper_argv` MUST already contain the full
    /// sandbox argv INCLUDING the trailing `-- <program> <args...>` (as
    /// produced by `LinuxSandboxBackend::build_bwrap_argv`). The wrapper
    /// binary owns namespace isolation; `ProcessManager` still owns the
    /// process group, timeout, output streaming, and tree-kill on cancel.
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
        // Working directory is set via the wrapper argv (bwrap --chdir); do
        // not also set current_dir or the wrapper may fail to chdir inside
        // the new mount namespace.
        let resolved_executable =
            format!("{} (sandboxed via {})", spawn.program, wrapper.display());
        self.spawn_command(command, resolved_executable, spawn.timeout_ms, None)
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
        let resolved_executable =
            format!("{} (sandboxed via {})", spawn.program, wrapper.display());
        self.spawn_command(command, resolved_executable, spawn.timeout_ms, Some(lease))
            .await
    }

    /// Shared spawn core: take a fully-configured `Command`, spawn it, and
    /// run the streaming supervisor. Used by `spawn` (direct) and
    /// `spawn_wrapped` (sandboxed).
    async fn spawn_command(
        &self,
        mut command: Command,
        resolved_executable: String,
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
        let (tx, rx) = mpsc::channel(64);
        let started = ProcessStarted {
            process_id: process_id.clone(),
            job_id: job_id.clone(),
            resolved_executable: resolved_executable.clone(),
            started_at,
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
            cancel_requested: false,
            allocate_pty: false,
            lease,
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
        // `timeout_ms` is a parameter of `spawn_command`.

        // SPEC §44.2 ownership: this supervisor task owns the child's
        // lifetime. It is not detached — ownership is implicit via the
        // `mpsc::Receiver` held by the caller (`rx`): when the caller drops
        // `rx` or the process exits, this task drains stdout/stderr, captures
        // exit status, ingests output artifacts, and completes. The child is
        // also registered in `self.children` so `cancel()` can kill the
        // process group. Cancellation propagates: dropping the receiver
        // cancels the stream tasks; `kill_process_group` reaps the tree.
        tokio::spawn(async move {
            // Pull child out of the managed wrapper so we can take stdout/stderr.
            let mut child_guard = managed.lock().await;
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

            // Wait with timeout.
            let wait_fut = child.wait();
            let exit_result = if timeout_ms == 0 {
                wait_fut.await
            } else {
                match time::timeout(std::time::Duration::from_millis(timeout_ms), wait_fut).await {
                    Ok(r) => r,
                    Err(_) => {
                        // Timed out; kill the process group.
                        if let Some(pid) = child_pid {
                            kill_process_group(pid);
                            let _ = child.wait().await;
                        }
                        let mut child_guard = managed.lock().await;
                        child_guard.pid = None;
                        child_guard.stdin = None;
                        drop(child_guard);
                        let _ = tx_clone
                            .send(ProcessEvent::Exited(ProcessExited {
                                exit_code: -1,
                                signal: "TIMEOUT".to_string(),
                                exited_at: now_rfc3339(),
                                stdout_artifact: None,
                                stderr_artifact: None,
                            }))
                            .await;
                        release_managed(&children, &pid, &managed).await;
                        return;
                    }
                }
            };
            let status = match exit_result {
                Ok(s) => s,
                Err(e) => {
                    let mut child_guard = managed.lock().await;
                    child_guard.pid = None;
                    child_guard.stdin = None;
                    drop(child_guard);
                    let _ = tx_clone
                        .send(ProcessEvent::Exited(ProcessExited {
                            exit_code: -1,
                            signal: format!("io error: {e}"),
                            exited_at: now_rfc3339(),
                            stdout_artifact: None,
                            stderr_artifact: None,
                        }))
                        .await;
                    release_managed(&children, &pid, &managed).await;
                    return;
                }
            };
            let mut child_guard = managed.lock().await;
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

            let signal = if let Some(code) = status.code() {
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
            release_managed(&children, &pid, &managed).await;
        });

        Ok((
            SpawnOutcome {
                process_id,
                job_id,
                resolved_executable,
            },
            rx,
        ))
    }

    /// Cancel a running process. Returns the final state.
    pub async fn cancel(&self, process_id: &str, _reason: &str) -> Result<String, ProcessError> {
        let managed = {
            let children = self.children.lock().await;
            children
                .get(process_id)
                .cloned()
                .ok_or_else(|| ProcessError::NotFound(process_id.to_string()))?
        };
        // The supervisor owns the child wait. Dispatch the group kill and let
        // the supervisor reap, drain output, and publish the terminal event.
        let pid = {
            let mut guard = managed.lock().await;
            guard.cancel_requested = true;
            guard.pid
        };
        if let Some(pid) = pid {
            kill_process_group(pid);
        }
        Ok("cancelled".to_string())
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
            .child
            .as_ref()
            .and_then(Child::id)
            .ok_or_else(|| ProcessError::NotFound(process_id.to_string()))?;
        let signal_number = signal_number(signal)?;
        send_process_signal(pid, signal_number)?;
        Ok(signal.to_string())
    }

    pub async fn is_running(&self, process_id: &str) -> bool {
        let children = self.children.lock().await;
        if let Some(m) = children.get(process_id) {
            let g = m.lock().await;
            g.pid.is_some() && !g.cancel_requested
        } else {
            false
        }
    }
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

#[cfg(not(unix))]
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
    let mut cursor: u64 = 0;
    let mut spilled = false;
    loop {
        match reader.read(&mut buf).await {
            Ok(0) => break,
            Ok(n) => {
                let chunk = &buf[..n];
                if !spilled {
                    if total.len() + chunk.len() > max_inline {
                        spilled = true;
                    } else {
                        total.extend_from_slice(chunk);
                    }
                }
                cursor += n as u64;
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
                    break;
                }
            }
            Err(_) => break,
        }
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
        Err(ProcessError::Io(std::io::Error::last_os_error()))
    }
}

#[cfg(not(unix))]
fn send_process_signal(_pid: u32, _signal: i32) -> Result<(), ProcessError> {
    Err(ProcessError::InvalidSpec(
        "signals are unsupported on this platform".to_string(),
    ))
}

#[cfg(not(unix))]
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
    format!("{}.{:06}+00:00", dur.as_secs(), dur.subsec_micros())
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

    #[cfg(not(unix))]
    #[test]
    fn signal_number_rejects_unsupported_platforms() {
        assert!(matches!(
            signal_number("SIGTERM"),
            Err(ProcessError::InvalidSpec(_))
        ));
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
        assert!(mgr.is_running(&outcome.process_id).await);
        let state = mgr.cancel(&outcome.process_id, "test").await.unwrap();
        assert_eq!(state, "cancelled");
        assert!(!mgr.is_running(&outcome.process_id).await);
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
        let spawn = NormalizedSpawn {
            program: "pwd".into(),
            args: vec![],
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
        let expected = std::fs::canonicalize(tmp.path()).unwrap();
        assert_eq!(pwd_line.trim(), expected.to_string_lossy());
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

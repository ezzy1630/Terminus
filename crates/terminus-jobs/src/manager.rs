use crate::error::JobError;
use crate::record::{JobOutputChunk, JobRecord};
use crate::state::JobState;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use terminus_kernel_protocol::ProcessEvent;
use terminus_process::{NormalizedSpawn, ProcessManager, SpawnOutcome};
use tokio::sync::Mutex;

type PersistedJobState = (Vec<JobRecord>, HashMap<String, Vec<JobOutputChunk>>);

/// JobManager owns the durable job state and reuses a `ProcessManager`.
#[derive(Debug, Clone)]
pub struct JobManager {
    process_manager: Arc<ProcessManager>,
    jobs: Arc<Mutex<HashMap<String, JobRecord>>>,
    output_chunks: Arc<Mutex<HashMap<String, Vec<JobOutputChunk>>>>,
    persistence_lock: Arc<Mutex<()>>,
    storage_path: Option<PathBuf>,
}

impl JobManager {
    pub fn new(process_manager: Arc<ProcessManager>) -> Self {
        Self {
            process_manager,
            jobs: Arc::new(Mutex::new(HashMap::new())),
            output_chunks: Arc::new(Mutex::new(HashMap::new())),
            persistence_lock: Arc::new(Mutex::new(())),
            storage_path: None,
        }
    }

    pub fn with_storage(
        process_manager: Arc<ProcessManager>,
        storage_path: impl Into<PathBuf>,
    ) -> Self {
        Self {
            process_manager,
            jobs: Arc::new(Mutex::new(HashMap::new())),
            output_chunks: Arc::new(Mutex::new(HashMap::new())),
            persistence_lock: Arc::new(Mutex::new(())),
            storage_path: Some(storage_path.into()),
        }
    }

    async fn persist_state(&self, jobs: &HashMap<String, JobRecord>) -> Result<(), JobError> {
        let Some(path) = self.storage_path.clone() else {
            return Ok(());
        };
        let _persistence_guard = self.persistence_lock.lock().await;
        let mut records: Vec<JobRecord> = jobs.values().cloned().collect();
        records.sort_by(|left, right| left.id.cmp(&right.id));
        let chunks = self.output_chunks.lock().await.clone();
        tokio::task::spawn_blocking(move || persist_state_sqlite(&path, &records, &chunks))
            .await
            .map_err(|error| JobError::Database(format!("sqlite writer task failed: {error}")))??;
        Ok(())
    }

    async fn persist_event_state(
        &self,
        record: &JobRecord,
        appended_chunk: Option<&JobOutputChunk>,
        removed_chunks: &[JobOutputChunk],
    ) -> Result<(), JobError> {
        let Some(path) = self.storage_path.clone() else {
            return Ok(());
        };
        let record = record.clone();
        let appended_chunk = appended_chunk.cloned();
        let removed_chunks = removed_chunks.to_vec();
        let _persistence_guard = self.persistence_lock.lock().await;
        tokio::task::spawn_blocking(move || {
            persist_event_sqlite(&path, &record, appended_chunk.as_ref(), &removed_chunks)
        })
        .await
        .map_err(|error| JobError::Database(format!("sqlite writer task failed: {error}")))??;
        Ok(())
    }

    /// Load persisted job records from the SQLite job store into memory.
    pub async fn load_persisted(&self) -> Result<usize, JobError> {
        let Some(path) = self.storage_path.clone() else {
            return Ok(0);
        };
        let (records, chunks) = tokio::task::spawn_blocking(move || load_state_sqlite(&path))
            .await
            .map_err(|error| JobError::Database(format!("sqlite reader task failed: {error}")))??;
        let count = records.len();
        let mut normalized = false;
        {
            let mut jobs = self.jobs.lock().await;
            jobs.clear();
            for record in records {
                normalized |= record.lease_token.is_empty()
                    || (record.process_executable.is_none()
                        && !record.resolved_executable.is_empty())
                    || (record.output_cursor > 0
                        && record.stdout_cursor == 0
                        && record.stderr_cursor == 0);
                let normalized_record = normalize_record(record);
                jobs.insert(normalized_record.id.clone(), normalized_record);
            }
        }
        {
            let mut output_chunks = self.output_chunks.lock().await;
            output_chunks.clear();
            output_chunks.extend(chunks);
        }
        if normalized {
            let jobs = self.jobs.lock().await;
            self.persist_state(&jobs).await?;
        }
        Ok(count)
    }

    /// Synchronous startup loader for kernel assembly, before an async runtime
    /// is available. Errors are returned to the caller instead of silently
    /// starting with an empty durable job registry.
    pub fn load_persisted_sync(&self) -> Result<usize, JobError> {
        if tokio::runtime::Handle::try_current().is_ok() {
            return std::thread::scope(|scope| {
                scope
                    .spawn(|| self.load_persisted_sync_inner())
                    .join()
                    .map_err(|_| {
                        JobError::Database("durable job loader thread panicked".to_string())
                    })?
            });
        }
        self.load_persisted_sync_inner()
    }

    fn load_persisted_sync_inner(&self) -> Result<usize, JobError> {
        let Some(path) = self.storage_path.clone() else {
            return Ok(0);
        };
        let (records, chunks) = load_state_sqlite(&path)?;
        let count = records.len();
        let mut normalized = false;
        {
            let mut jobs = self.jobs.blocking_lock();
            jobs.clear();
            for record in records {
                normalized |= record.lease_token.is_empty()
                    || (record.process_executable.is_none()
                        && !record.resolved_executable.is_empty())
                    || (record.output_cursor > 0
                        && record.stdout_cursor == 0
                        && record.stderr_cursor == 0);
                let normalized_record = normalize_record(record);
                jobs.insert(normalized_record.id.clone(), normalized_record);
            }
        }
        {
            let mut output_chunks = self.output_chunks.blocking_lock();
            output_chunks.clear();
            output_chunks.extend(chunks);
        }
        if normalized {
            let jobs = self.jobs.blocking_lock();
            let records: HashMap<String, JobRecord> = jobs.clone();
            drop(jobs);
            let chunks = self.output_chunks.blocking_lock().clone();
            persist_state_sync(&self.storage_path, &records, &chunks)?;
        }
        Ok(count)
    }

    /// Register a new job in the `Created` state.
    pub async fn create(&self, record: JobRecord) -> Result<String, JobError> {
        let id = record.id.clone();
        let mut jobs = self.jobs.lock().await;
        if jobs.contains_key(&id) {
            return Err(JobError::AlreadyStarted(id));
        }
        jobs.insert(id.clone(), record);
        self.persist_state(&jobs).await?;
        Ok(id)
    }

    /// Persist the intent to start before the process effect runs. This closes
    /// the ordinary crash window where a process could be spawned while the
    /// durable row still says `CREATED`.
    pub async fn begin_start(
        &self,
        job_id: &str,
        resolved_executable: &str,
        working_directory: Option<&std::path::Path>,
    ) -> Result<(), JobError> {
        let mut jobs = self.jobs.lock().await;
        let record = jobs
            .get_mut(job_id)
            .ok_or_else(|| JobError::NotFound(job_id.to_string()))?;
        record.state = record.state.transition(JobState::Starting)?;
        record.started_at = Some(now_rfc3339());
        record.resolved_executable = resolved_executable.to_string();
        record.cwd = working_directory
            .map(|path| path.display().to_string())
            .unwrap_or_default();
        self.persist_state(&jobs).await
    }

    pub async fn mark_start_failed(&self, job_id: &str, reason: &str) -> Result<(), JobError> {
        let mut jobs = self.jobs.lock().await;
        let record = jobs
            .get_mut(job_id)
            .ok_or_else(|| JobError::NotFound(job_id.to_string()))?;
        if record.state == JobState::Starting {
            record.state = record.state.transition(JobState::Exited)?;
        }
        record.settled_at = Some(now_rfc3339());
        record.termination_receipt = Some(format!("spawn_failed:{reason}"));
        self.persist_state(&jobs).await
    }

    /// Start a job. Transitions Created → Starting → Running (when the
    /// process actually starts streaming events).
    pub async fn start(
        &self,
        job_id: &str,
        spawn: NormalizedSpawn,
    ) -> Result<SpawnOutcome, JobError> {
        self.begin_start(job_id, &spawn.program, spawn.working_dir.as_deref())
            .await?;
        let (outcome, _rx) = match self.process_manager.spawn(spawn).await {
            Ok(value) => value,
            Err(error) => {
                self.mark_start_failed(job_id, &error.to_string()).await?;
                return Err(error.into());
            }
        };
        if let Err(error) = self.attach_started(job_id, &outcome).await {
            let compensation = self
                .compensate_spawned(&outcome, "durable persist failed")
                .await;
            if compensation.is_ok() {
                let _ = self.remove(job_id).await;
            } else {
                tracing::error!(
                    job_id = %job_id,
                    cancellation = ?compensation,
                    "job attach persistence failed and process compensation failed"
                );
            }
            return Err(error);
        }
        Ok(outcome)
    }

    /// Attach a process already authorized and spawned by the kernel's
    /// ProcessService to a durable job record.
    pub async fn attach_started(
        &self,
        job_id: &str,
        outcome: &SpawnOutcome,
    ) -> Result<(), JobError> {
        let mut jobs = self.jobs.lock().await;
        let previous = jobs
            .get(job_id)
            .cloned()
            .ok_or_else(|| JobError::NotFound(job_id.to_string()))?;
        let record = jobs
            .get_mut(job_id)
            .ok_or_else(|| JobError::NotFound(job_id.to_string()))?;
        if record.state == JobState::Created {
            record.state = record.state.transition(JobState::Starting)?;
        }
        record.state = record.state.transition(JobState::Running)?;
        if !outcome.started_at.is_empty() {
            record.started_at = Some(outcome.started_at.clone());
        } else if record.started_at.is_none() {
            record.started_at = Some(now_rfc3339());
        }
        record.resolved_executable = outcome.resolved_executable.clone();
        record.process_identity = Some(outcome.process_id.clone());
        record.pid = outcome.pid;
        record.process_start_time = outcome.process_start_time.clone();
        record.process_executable = outcome.process_executable.clone();
        if let Some(working_directory) = &outcome.working_directory {
            record.cwd = working_directory.clone();
        }
        match self.persist_state(&jobs).await {
            Ok(()) => Ok(()),
            Err(error) => {
                jobs.insert(job_id.to_string(), previous);
                Err(error)
            }
        }
    }

    pub async fn compensate_spawned(
        &self,
        outcome: &SpawnOutcome,
        reason: &str,
    ) -> Result<String, JobError> {
        match self.process_manager.cancel(&outcome.process_id, reason).await {
            Ok(receipt) => Ok(receipt),
            Err(first_error) => match (
                outcome.pid,
                outcome.process_start_time.as_deref(),
                outcome.process_executable.as_deref(),
            ) {
                (Some(pid), Some(start_time), Some(executable)) => self
                    .process_manager
                    .cancel_verified(pid, start_time, executable, reason)
                    .await
                    .map_err(|second_error| {
                        JobError::Database(format!(
                            "spawn compensation failed after process cancel error ({first_error}): {second_error}"
                        ))
                    }),
                _ => Err(JobError::Process(first_error)),
            },
        }
    }

    pub async fn remove(&self, job_id: &str) -> Result<(), JobError> {
        let mut jobs = self.jobs.lock().await;
        jobs.remove(job_id);
        {
            let mut output_chunks = self.output_chunks.lock().await;
            output_chunks.remove(job_id);
        }
        self.persist_state(&jobs).await
    }

    /// Persist a streamed process event in the same durable snapshot as the
    /// job record. Consumers can resume by byte cursor without relying on an
    /// in-memory event channel surviving a control restart.
    pub async fn record_event(&self, job_id: &str, event: &ProcessEvent) -> Result<(), JobError> {
        let lease_token = self
            .get(job_id)
            .await
            .ok_or_else(|| JobError::NotFound(job_id.to_string()))?
            .lease_token;
        self.record_event_with_lease(job_id, &lease_token, event)
            .await
    }

    pub async fn record_event_with_lease(
        &self,
        job_id: &str,
        lease_token: &str,
        event: &ProcessEvent,
    ) -> Result<(), JobError> {
        let mut jobs = self.jobs.lock().await;
        let current_lease = jobs
            .get(job_id)
            .ok_or_else(|| JobError::NotFound(job_id.to_string()))?;
        if current_lease.lease_token != lease_token {
            return Err(JobError::LeaseMismatch(job_id.to_string()));
        }
        let mut persisted_chunk: Option<JobOutputChunk> = None;
        let mut removed_chunks: Vec<JobOutputChunk> = Vec::new();
        match event {
            ProcessEvent::Stdout(chunk) | ProcessEvent::Stderr(chunk) => {
                let stream = if matches!(event, ProcessEvent::Stdout(_)) {
                    "stdout"
                } else {
                    "stderr"
                };
                let length = chunk.bytes.len() as u64;
                let start_cursor = chunk.cursor.checked_sub(length).ok_or_else(|| {
                    JobError::OutputCursorConflict {
                        job_id: job_id.to_string(),
                        stream: stream.to_string(),
                        expected: 0,
                        actual: chunk.cursor,
                    }
                })?;
                let entry = JobOutputChunk {
                    job_id: job_id.to_string(),
                    stream: stream.to_string(),
                    start_cursor,
                    end_cursor: chunk.cursor,
                    bytes: chunk.bytes.clone(),
                    redacted: chunk.redacted,
                };
                let mut output_chunks = self.output_chunks.lock().await;
                let chunks = output_chunks.entry(job_id.to_string()).or_default();
                let duplicate = chunks
                    .iter()
                    .find(|existing| {
                        existing.stream == entry.stream
                            && existing.start_cursor == entry.start_cursor
                            && existing.end_cursor == entry.end_cursor
                    })
                    .cloned();
                if let Some(existing) = duplicate {
                    if existing.bytes == entry.bytes && existing.redacted == entry.redacted {
                        persisted_chunk = Some(existing);
                    } else {
                        return Err(JobError::OutputCursorConflict {
                            job_id: job_id.to_string(),
                            stream: stream.to_string(),
                            expected: existing.end_cursor,
                            actual: entry.end_cursor,
                        });
                    }
                } else {
                    let expected_cursor = if stream == "stdout" {
                        current_lease.stdout_cursor
                    } else {
                        current_lease.stderr_cursor
                    };
                    if start_cursor != expected_cursor {
                        return Err(JobError::OutputCursorConflict {
                            job_id: job_id.to_string(),
                            stream: stream.to_string(),
                            expected: expected_cursor,
                            actual: start_cursor,
                        });
                    }
                    chunks.push(entry.clone());
                    persisted_chunk = Some(entry.clone());
                    let max_output =
                        usize::try_from(current_lease.resource_limits.max_output_bytes)
                            .unwrap_or(usize::MAX);
                    let mut retained_bytes =
                        chunks.iter().map(|chunk| chunk.bytes.len()).sum::<usize>();
                    while retained_bytes > max_output {
                        let removed = chunks.remove(0);
                        retained_bytes = retained_bytes.saturating_sub(removed.bytes.len());
                        removed_chunks.push(removed.clone());
                        let record = jobs
                            .get_mut(job_id)
                            .ok_or_else(|| JobError::NotFound(job_id.to_string()))?;
                        if removed.stream == "stdout" {
                            record.stdout_truncated_before =
                                record.stdout_truncated_before.max(removed.end_cursor);
                        } else {
                            record.stderr_truncated_before =
                                record.stderr_truncated_before.max(removed.end_cursor);
                        }
                    }
                    if !chunks.iter().any(|chunk| {
                        chunk.stream == entry.stream
                            && chunk.start_cursor == entry.start_cursor
                            && chunk.end_cursor == entry.end_cursor
                    }) {
                        persisted_chunk = None;
                    }
                }
                drop(output_chunks);
                let record = jobs
                    .get_mut(job_id)
                    .ok_or_else(|| JobError::NotFound(job_id.to_string()))?;
                if stream == "stdout" {
                    record.stdout_cursor = record.stdout_cursor.max(chunk.cursor);
                } else {
                    record.stderr_cursor = record.stderr_cursor.max(chunk.cursor);
                }
                record.output_cursor = record.stdout_cursor.max(record.stderr_cursor);
            }
            ProcessEvent::Exited(exit) => {
                let record = jobs
                    .get_mut(job_id)
                    .ok_or_else(|| JobError::NotFound(job_id.to_string()))?;
                if record.state == JobState::Running || record.state == JobState::Stopping {
                    record.state = record.state.transition(JobState::Exited)?;
                }
                record.settled_at = Some(exit.exited_at.clone());
                if record.termination_receipt.is_none() {
                    record.termination_receipt = Some(if exit.signal.is_empty() {
                        format!("exit:{}", exit.exit_code)
                    } else {
                        format!("signal:{}", exit.signal)
                    });
                }
                record.stdout_artifact = exit
                    .stdout_artifact
                    .as_ref()
                    .map(|artifact| artifact.sha256.clone());
                record.stderr_artifact = exit
                    .stderr_artifact
                    .as_ref()
                    .map(|artifact| artifact.sha256.clone());
                record.output_artifact = record
                    .stdout_artifact
                    .clone()
                    .or_else(|| record.stderr_artifact.clone());
            }
            ProcessEvent::Started(_) | ProcessEvent::Policy(_) => {}
        }
        let record = jobs
            .get(job_id)
            .cloned()
            .ok_or_else(|| JobError::NotFound(job_id.to_string()))?;
        drop(jobs);
        self.persist_event_state(&record, persisted_chunk.as_ref(), &removed_chunks)
            .await
    }

    /// Return durable chunks whose end cursor is after `from_cursor`.
    pub async fn output_since(
        &self,
        job_id: &str,
        stream: &str,
        from_cursor: u64,
    ) -> Result<Vec<JobOutputChunk>, JobError> {
        if !matches!(stream, "stdout" | "stderr") {
            return Err(JobError::InvalidOutputStream(stream.to_string()));
        }
        if self.get(job_id).await.is_none() {
            return Err(JobError::NotFound(job_id.to_string()));
        }
        let record = self
            .get(job_id)
            .await
            .ok_or_else(|| JobError::NotFound(job_id.to_string()))?;
        let truncated_before = if stream == "stdout" {
            record.stdout_truncated_before
        } else {
            record.stderr_truncated_before
        };
        if from_cursor < truncated_before {
            return Err(JobError::OutputTruncated {
                job_id: job_id.to_string(),
                stream: stream.to_string(),
                available_from: truncated_before,
            });
        }
        let chunks = self.output_chunks.lock().await;
        let mut result = Vec::new();
        for chunk in chunks
            .get(job_id)
            .into_iter()
            .flat_map(|items| items.iter())
            .filter(|chunk| chunk.stream == stream && chunk.end_cursor > from_cursor)
        {
            let start_cursor = from_cursor.max(chunk.start_cursor);
            let offset = usize::try_from(start_cursor - chunk.start_cursor).map_err(|_| {
                JobError::Database("output cursor does not fit in memory index".to_string())
            })?;
            if offset > chunk.bytes.len()
                || chunk.end_cursor
                    != chunk
                        .start_cursor
                        .checked_add(chunk.bytes.len() as u64)
                        .ok_or_else(|| {
                            JobError::Database("output chunk cursor overflow".to_string())
                        })?
            {
                return Err(JobError::Database(format!(
                    "invalid output chunk cursors for job {} stream {}",
                    chunk.job_id, chunk.stream
                )));
            }
            result.push(JobOutputChunk {
                job_id: chunk.job_id.clone(),
                stream: chunk.stream.clone(),
                start_cursor,
                end_cursor: chunk.end_cursor,
                bytes: chunk.bytes[offset..].to_vec(),
                redacted: chunk.redacted,
            });
        }
        Ok(result)
    }

    pub async fn input(&self, job_id: &str, bytes: &[u8]) -> Result<JobState, JobError> {
        let lease_token = self
            .get(job_id)
            .await
            .ok_or_else(|| JobError::NotFound(job_id.to_string()))?
            .lease_token;
        self.input_with_lease(job_id, &lease_token, bytes).await
    }

    pub async fn input_with_lease(
        &self,
        job_id: &str,
        lease_token: &str,
        bytes: &[u8],
    ) -> Result<JobState, JobError> {
        let record = self
            .get(job_id)
            .await
            .ok_or_else(|| JobError::NotFound(job_id.to_string()))?;
        if record.lease_token != lease_token {
            return Err(JobError::LeaseMismatch(job_id.to_string()));
        }
        let process_id = record
            .process_identity
            .ok_or_else(|| JobError::NotFound(format!("process for job {job_id}")))?;
        self.process_manager.write_stdin(&process_id, bytes).await?;
        self.state(job_id)
            .await
            .ok_or_else(|| JobError::NotFound(job_id.to_string()))
    }

    pub async fn signal(&self, job_id: &str, signal: &str) -> Result<JobState, JobError> {
        let lease_token = self
            .get(job_id)
            .await
            .ok_or_else(|| JobError::NotFound(job_id.to_string()))?
            .lease_token;
        self.signal_with_lease(job_id, &lease_token, signal).await
    }

    pub async fn signal_with_lease(
        &self,
        job_id: &str,
        lease_token: &str,
        signal: &str,
    ) -> Result<JobState, JobError> {
        let record = self
            .get(job_id)
            .await
            .ok_or_else(|| JobError::NotFound(job_id.to_string()))?;
        if record.lease_token != lease_token {
            return Err(JobError::LeaseMismatch(job_id.to_string()));
        }
        let process_id = record
            .process_identity
            .clone()
            .ok_or_else(|| JobError::NotFound(format!("process for job {job_id}")))?;
        if let (Some(pid), Some(start_time), Some(executable)) = (
            record.pid,
            record.process_start_time.as_deref(),
            record.process_executable.as_deref(),
        ) {
            self.process_manager
                .signal_verified(pid, start_time, executable, signal)
                .await?;
        } else {
            self.process_manager.signal(&process_id, signal).await?;
        }
        self.state(job_id)
            .await
            .ok_or_else(|| JobError::NotFound(job_id.to_string()))
    }

    /// Stop a running job. Transitions Running → Stopping → Exited.
    pub async fn stop(&self, job_id: &str, reason: &str) -> Result<JobState, JobError> {
        let lease_token = self
            .get(job_id)
            .await
            .ok_or_else(|| JobError::NotFound(job_id.to_string()))?
            .lease_token;
        self.stop_with_lease(job_id, &lease_token, reason).await
    }

    pub async fn stop_with_lease(
        &self,
        job_id: &str,
        lease_token: &str,
        reason: &str,
    ) -> Result<JobState, JobError> {
        let (process_id, pid, process_start_time, process_executable) = {
            let mut jobs = self.jobs.lock().await;
            let record = jobs
                .get_mut(job_id)
                .ok_or_else(|| JobError::NotFound(job_id.to_string()))?;
            if record.lease_token != lease_token {
                return Err(JobError::LeaseMismatch(job_id.to_string()));
            }
            if record.state.is_terminal() {
                return Ok(record.state);
            }
            record.state = record.state.transition(JobState::Stopping)?;
            let values = (
                record.process_identity.clone(),
                record.pid,
                record.process_start_time.clone(),
                record.process_executable.clone(),
            );
            self.persist_state(&jobs).await?;
            values
        };
        let receipt = match (
            pid,
            process_start_time.as_deref(),
            process_executable.as_deref(),
        ) {
            (Some(pid), Some(start_time), Some(executable)) => {
                self.process_manager
                    .cancel_verified(pid, start_time, executable, reason)
                    .await?
            }
            _ => match process_id {
                Some(ref process_id) => self.process_manager.cancel(process_id, reason).await?,
                None => "already-exited".to_string(),
            },
        };
        let mut jobs = self.jobs.lock().await;
        let record = jobs
            .get_mut(job_id)
            .ok_or_else(|| JobError::NotFound(job_id.to_string()))?;
        if record.lease_token != lease_token {
            return Err(JobError::LeaseMismatch(job_id.to_string()));
        }
        if record.state == JobState::Stopping {
            record.state = record.state.transition(JobState::Exited)?;
        }
        record.settled_at = Some(now_rfc3339());
        record.termination_receipt = Some(receipt);
        let final_state = record.state;
        self.persist_state(&jobs).await?;
        Ok(final_state)
    }

    /// Mark a job as exited with the given exit info.
    pub async fn mark_exited(&self, job_id: &str) -> Result<JobState, JobError> {
        let mut jobs = self.jobs.lock().await;
        let record = jobs
            .get_mut(job_id)
            .ok_or_else(|| JobError::NotFound(job_id.to_string()))?;
        // From Running or Stopping we can go to Exited.
        if record.state == JobState::Running || record.state == JobState::Stopping {
            record.state = record.state.transition(JobState::Exited)?;
            record.settled_at = Some(now_rfc3339());
            let final_state = record.state;
            self.persist_state(&jobs).await?;
            Ok(final_state)
        } else {
            Err(JobError::InvalidTransition {
                from: record.state.as_str().to_string(),
                to: "EXITED".to_string(),
            })
        }
    }

    /// Mark a job orphaned when its process disappears unexpectedly.
    pub async fn mark_orphaned(&self, job_id: &str) -> Result<JobState, JobError> {
        let mut jobs = self.jobs.lock().await;
        let record = jobs
            .get_mut(job_id)
            .ok_or_else(|| JobError::NotFound(job_id.to_string()))?;
        record.state = record.state.transition(JobState::Orphaned)?;
        record
            .reconciliation_history
            .push(format!("orphaned:{}", now_rfc3339()));
        let final_state = record.state;
        self.persist_state(&jobs).await?;
        Ok(final_state)
    }

    /// Reconcile against the in-memory process registry or the persisted OS
    /// identity. A missing or mismatched identity is always treated as lost.
    pub async fn reconcile(&self, job_id: &str) -> Result<JobState, JobError> {
        let record = {
            let jobs = self.jobs.lock().await;
            jobs.get(job_id)
                .cloned()
                .ok_or_else(|| JobError::NotFound(job_id.to_string()))?
        };
        if record.state.is_terminal() || record.state == JobState::Created {
            return Ok(record.state);
        }
        let running = match (
            record.process_identity.as_deref(),
            record.pid,
            record.process_start_time.as_deref(),
            record.process_executable.as_deref(),
        ) {
            (Some(process_id), Some(pid), Some(start_time), Some(executable)) => {
                if self.process_manager.is_running(process_id).await {
                    true
                } else {
                    self.process_manager
                        .is_process_identity_running(pid, start_time, executable)
                        .await?
                }
            }
            _ => false,
        };
        let mut jobs = self.jobs.lock().await;
        let record = jobs
            .get_mut(job_id)
            .ok_or_else(|| JobError::NotFound(job_id.to_string()))?;
        if running {
            if record.state == JobState::Starting {
                record.state = record.state.transition(JobState::Running)?;
            }
            record
                .reconciliation_history
                .push(format!("running:{}", now_rfc3339()));
        } else {
            if record.state != JobState::Orphaned {
                record.state = record.state.transition(JobState::Orphaned)?;
            }
            record.state = record.state.transition(JobState::Lost)?;
            record.settled_at = Some(now_rfc3339());
            record
                .reconciliation_history
                .push(format!("lost:{}", now_rfc3339()));
        }
        let state = record.state;
        self.persist_state(&jobs).await?;
        Ok(state)
    }

    /// Synchronous startup reconciliation used while assembling a kernel
    /// before an async runtime exists.
    pub fn reconcile_loaded_sync(&self) -> Result<Vec<(String, JobState)>, JobError> {
        if tokio::runtime::Handle::try_current().is_ok() {
            return std::thread::scope(|scope| {
                scope
                    .spawn(|| self.reconcile_loaded_sync_inner())
                    .join()
                    .map_err(|_| {
                        JobError::Database("durable job reconciler thread panicked".to_string())
                    })?
            });
        }
        self.reconcile_loaded_sync_inner()
    }

    fn reconcile_loaded_sync_inner(&self) -> Result<Vec<(String, JobState)>, JobError> {
        let job_ids: Vec<String> = self
            .jobs
            .blocking_lock()
            .iter()
            .filter_map(|(job_id, record)| {
                (!record.state.is_terminal() && record.state != JobState::Created)
                    .then_some(job_id.clone())
            })
            .collect();
        let mut results = Vec::with_capacity(job_ids.len());
        for job_id in job_ids {
            let record = self
                .jobs
                .blocking_lock()
                .get(&job_id)
                .cloned()
                .ok_or_else(|| JobError::NotFound(job_id.clone()))?;
            let running = match (
                record.pid,
                record.process_start_time.as_deref(),
                record.process_executable.as_deref(),
            ) {
                (Some(pid), Some(start_time), Some(executable)) => self
                    .process_manager
                    .is_process_identity_running_sync(pid, start_time, executable)?,
                _ => false,
            };
            let mut jobs = self.jobs.blocking_lock();
            let record = jobs
                .get_mut(&job_id)
                .ok_or_else(|| JobError::NotFound(job_id.clone()))?;
            if running {
                if record.state == JobState::Starting {
                    record.state = record.state.transition(JobState::Running)?;
                }
                record
                    .reconciliation_history
                    .push(format!("startup-running:{}", now_rfc3339()));
            } else {
                if record.state != JobState::Orphaned {
                    record.state = record.state.transition(JobState::Orphaned)?;
                }
                record.state = record.state.transition(JobState::Lost)?;
                record.settled_at = Some(now_rfc3339());
                record
                    .reconciliation_history
                    .push(format!("startup-lost:{}", now_rfc3339()));
            }
            let state = record.state;
            let records: HashMap<String, JobRecord> = jobs.clone();
            drop(jobs);
            let chunks = self.output_chunks.blocking_lock().clone();
            persist_state_sync(&self.storage_path, &records, &chunks)?;
            results.push((job_id, state));
        }
        Ok(results)
    }

    pub async fn reconcile_all(&self) -> Vec<(String, JobState)> {
        let job_ids: Vec<String> = self.jobs.lock().await.keys().cloned().collect();
        let mut results = Vec::new();
        for job_id in job_ids {
            if let Ok(state) = self.reconcile(&job_id).await {
                results.push((job_id, state));
            }
        }
        results
    }

    /// Clean up orphaned or settled jobs that have exceeded retention.
    pub async fn clean_orphans(&self) -> Vec<String> {
        let mut jobs = self.jobs.lock().await;
        let mut removed = Vec::new();
        jobs.retain(|id, record| {
            if matches!(record.state, JobState::Lost | JobState::Exited) {
                removed.push(id.clone());
                false
            } else {
                true
            }
        });
        let mut output_chunks = self.output_chunks.lock().await;
        for job_id in &removed {
            output_chunks.remove(job_id);
        }
        drop(output_chunks);
        let _ = self.persist_state(&jobs).await;
        removed
    }

    pub async fn get(&self, job_id: &str) -> Option<JobRecord> {
        self.jobs.lock().await.get(job_id).cloned()
    }

    /// Find the durable job that owns a process identity. Process projections
    /// expose the process id, while restart recovery indexes the durable job
    /// record; keeping this lookup here avoids a process-local side map.
    pub async fn find_by_process_id(&self, process_id: &str) -> Option<JobRecord> {
        self.jobs
            .lock()
            .await
            .values()
            .find(|record| record.process_identity.as_deref() == Some(process_id))
            .cloned()
    }

    pub async fn state(&self, job_id: &str) -> Option<JobState> {
        self.jobs.lock().await.get(job_id).map(|r| r.state)
    }
}

fn normalize_record(mut record: JobRecord) -> JobRecord {
    if record.lease_token.is_empty() {
        record.lease_token = format!("lease-{}", terminus_kernel_protocol::new_id());
    }
    if record.process_executable.is_none() && !record.resolved_executable.is_empty() {
        record.process_executable = Some(record.resolved_executable.clone());
    }
    if record.output_cursor > 0 && record.stdout_cursor == 0 && record.stderr_cursor == 0 {
        // Legacy records exposed one combined cursor and did not identify
        // which stream produced it. Preserve the durable record without
        // replaying unknown historical bytes: both streams resume only from
        // the legacy boundary and the reconciliation history records why.
        record.stdout_cursor = record.output_cursor;
        record.stderr_cursor = record.output_cursor;
        record.stdout_truncated_before = record.output_cursor;
        record.stderr_truncated_before = record.output_cursor;
        record.reconciliation_history.push(format!(
            "migrated:legacy-output-cursor:{}",
            record.output_cursor
        ));
    }
    record
}

fn open_sqlite(path: &PathBuf) -> Result<rusqlite::Connection, JobError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let connection = rusqlite::Connection::open(path)
        .map_err(|error| JobError::Database(format!("open {}: {error}", path.display())))?;
    connection
        .busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|error| JobError::Database(format!("configure sqlite busy timeout: {error}")))?;
    connection
        .execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA foreign_keys = ON;
             CREATE TABLE IF NOT EXISTS durable_jobs (
                id TEXT PRIMARY KEY NOT NULL,
                record_json TEXT NOT NULL,
                pid INTEGER,
                process_start_time TEXT,
                process_executable TEXT,
                cwd TEXT NOT NULL DEFAULT '',
                lease_token TEXT NOT NULL DEFAULT '',
                state TEXT NOT NULL DEFAULT 'created',
                output_cursor INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS durable_job_output_chunks (
                job_id TEXT NOT NULL REFERENCES durable_jobs(id) ON DELETE CASCADE,
                stream TEXT NOT NULL,
                start_cursor INTEGER NOT NULL,
                end_cursor INTEGER NOT NULL,
                bytes BLOB NOT NULL,
                redacted INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (job_id, stream, start_cursor)
            );",
        )
        .map_err(|error| JobError::Database(format!("create durable_jobs: {error}")))?;
    for (column, definition) in [
        ("pid", "INTEGER"),
        ("process_start_time", "TEXT"),
        ("process_executable", "TEXT"),
        ("cwd", "TEXT NOT NULL DEFAULT ''"),
        ("lease_token", "TEXT NOT NULL DEFAULT ''"),
        ("state", "TEXT NOT NULL DEFAULT 'created'"),
        ("output_cursor", "INTEGER NOT NULL DEFAULT 0"),
    ] {
        ensure_column(&connection, "durable_jobs", column, definition)?;
    }
    ensure_column(
        &connection,
        "durable_job_output_chunks",
        "redacted",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    Ok(connection)
}

fn ensure_column(
    connection: &rusqlite::Connection,
    table: &str,
    column: &str,
    definition: &str,
) -> Result<(), JobError> {
    let mut query = connection
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|error| JobError::Database(format!("inspect {table} schema: {error}")))?;
    let columns = query
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| JobError::Database(format!("read {table} schema: {error}")))?;
    for existing in columns {
        if existing.map_err(|error| JobError::Database(format!("read {table} column: {error}")))?
            == column
        {
            return Ok(());
        }
    }
    connection
        .execute(
            &format!("ALTER TABLE {table} ADD COLUMN {column} {definition}"),
            [],
        )
        .map_err(|error| JobError::Database(format!("add {table}.{column}: {error}")))?;
    Ok(())
}

fn persist_state_sqlite(
    path: &PathBuf,
    records: &[JobRecord],
    chunks: &HashMap<String, Vec<JobOutputChunk>>,
) -> Result<(), JobError> {
    let mut connection = open_sqlite(path)?;
    let transaction = connection
        .transaction()
        .map_err(|error| JobError::Database(format!("begin durable_jobs transaction: {error}")))?;
    transaction
        .execute("DELETE FROM durable_job_output_chunks", [])
        .map_err(|error| JobError::Database(format!("clear durable_job_output_chunks: {error}")))?;
    transaction
        .execute("DELETE FROM durable_jobs", [])
        .map_err(|error| JobError::Database(format!("clear durable_jobs: {error}")))?;
    {
        let mut insert = transaction
            .prepare(
                "INSERT INTO durable_jobs
                 (id, record_json, pid, process_start_time, process_executable,
                  cwd, lease_token, state, output_cursor, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            )
            .map_err(|error| JobError::Database(format!("prepare durable_jobs insert: {error}")))?;
        for record in records {
            let json = serde_json::to_string(record)?;
            insert
                .execute(rusqlite::params![
                    record.id,
                    json,
                    record.pid.map(i64::from),
                    record.process_start_time,
                    record.process_executable,
                    record.cwd,
                    record.lease_token,
                    record.state.as_str(),
                    i64::try_from(record.output_cursor).map_err(|_| {
                        JobError::Database(format!(
                            "output cursor is too large for job {}",
                            record.id
                        ))
                    })?,
                    now_rfc3339(),
                ])
                .map_err(|error| {
                    JobError::Database(format!("insert job {}: {error}", record.id))
                })?;
        }
    }
    {
        let mut insert = transaction
            .prepare(
                "INSERT INTO durable_job_output_chunks
                 (job_id, stream, start_cursor, end_cursor, bytes, redacted)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            )
            .map_err(|error| JobError::Database(format!("prepare output insert: {error}")))?;
        for (job_id, job_chunks) in chunks {
            for chunk in job_chunks {
                insert
                    .execute(rusqlite::params![
                        job_id,
                        chunk.stream,
                        chunk.start_cursor,
                        chunk.end_cursor,
                        chunk.bytes,
                        i64::from(chunk.redacted),
                    ])
                    .map_err(|error| {
                        JobError::Database(format!("insert output for job {job_id}: {error}"))
                    })?;
            }
        }
    }
    transaction
        .commit()
        .map_err(|error| JobError::Database(format!("commit durable_jobs: {error}")))?;
    Ok(())
}

fn persist_event_sqlite(
    path: &PathBuf,
    record: &JobRecord,
    appended_chunk: Option<&JobOutputChunk>,
    removed_chunks: &[JobOutputChunk],
) -> Result<(), JobError> {
    let mut connection = open_sqlite(path)?;
    let transaction = connection.transaction().map_err(|error| {
        JobError::Database(format!("begin durable job event transaction: {error}"))
    })?;
    let json = serde_json::to_string(record)?;
    transaction
        .execute(
            "INSERT INTO durable_jobs
             (id, record_json, pid, process_start_time, process_executable,
              cwd, lease_token, state, output_cursor, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(id) DO UPDATE SET
               record_json = excluded.record_json,
               pid = excluded.pid,
               process_start_time = excluded.process_start_time,
               process_executable = excluded.process_executable,
               cwd = excluded.cwd,
               lease_token = excluded.lease_token,
               state = excluded.state,
               output_cursor = excluded.output_cursor,
               updated_at = excluded.updated_at",
            rusqlite::params![
                record.id,
                json,
                record.pid.map(i64::from),
                record.process_start_time,
                record.process_executable,
                record.cwd,
                record.lease_token,
                record.state.as_str(),
                i64::try_from(record.output_cursor).map_err(|_| {
                    JobError::Database(format!("output cursor is too large for job {}", record.id))
                })?,
                now_rfc3339(),
            ],
        )
        .map_err(|error| JobError::Database(format!("upsert job {}: {error}", record.id)))?;
    for chunk in removed_chunks {
        transaction
            .execute(
                "DELETE FROM durable_job_output_chunks
                 WHERE job_id = ?1 AND stream = ?2 AND start_cursor = ?3",
                rusqlite::params![chunk.job_id, chunk.stream, chunk.start_cursor],
            )
            .map_err(|error| JobError::Database(format!("delete compacted output: {error}")))?;
    }
    if let Some(chunk) = appended_chunk {
        transaction
            .execute(
                "INSERT OR IGNORE INTO durable_job_output_chunks
                 (job_id, stream, start_cursor, end_cursor, bytes, redacted)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                rusqlite::params![
                    chunk.job_id,
                    chunk.stream,
                    chunk.start_cursor,
                    chunk.end_cursor,
                    chunk.bytes,
                    i64::from(chunk.redacted),
                ],
            )
            .map_err(|error| JobError::Database(format!("append output chunk: {error}")))?;
    }
    transaction
        .commit()
        .map_err(|error| JobError::Database(format!("commit durable job event: {error}")))?;
    Ok(())
}

fn persist_state_sync(
    storage_path: &Option<PathBuf>,
    records: &HashMap<String, JobRecord>,
    chunks: &HashMap<String, Vec<JobOutputChunk>>,
) -> Result<(), JobError> {
    let Some(path) = storage_path else {
        return Ok(());
    };
    let mut records: Vec<JobRecord> = records.values().cloned().collect();
    records.sort_by(|left, right| left.id.cmp(&right.id));
    persist_state_sqlite(path, &records, chunks)
}

fn load_state_sqlite(path: &PathBuf) -> Result<PersistedJobState, JobError> {
    if !path.exists() {
        return Ok((Vec::new(), HashMap::new()));
    }
    let connection = open_sqlite(path)?;
    let mut query = connection
        .prepare("SELECT record_json FROM durable_jobs ORDER BY id")
        .map_err(|error| JobError::Database(format!("prepare durable_jobs query: {error}")))?;
    let rows = query
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| JobError::Database(format!("query durable_jobs: {error}")))?;
    let mut records = Vec::new();
    for row in rows {
        let json =
            row.map_err(|error| JobError::Database(format!("read durable job row: {error}")))?;
        records.push(serde_json::from_str::<JobRecord>(&json)?);
    }
    let mut output_query = connection
        .prepare(
            "SELECT job_id, stream, start_cursor, end_cursor, bytes, redacted
             FROM durable_job_output_chunks
             ORDER BY job_id, stream, start_cursor",
        )
        .map_err(|error| JobError::Database(format!("prepare output query: {error}")))?;
    let rows = output_query
        .query_map([], |row| {
            Ok(JobOutputChunk {
                job_id: row.get(0)?,
                stream: row.get(1)?,
                start_cursor: row.get(2)?,
                end_cursor: row.get(3)?,
                bytes: row.get(4)?,
                redacted: row.get::<_, i64>(5)? != 0,
            })
        })
        .map_err(|error| JobError::Database(format!("query output chunks: {error}")))?;
    let mut chunks: HashMap<String, Vec<JobOutputChunk>> = HashMap::new();
    for row in rows {
        let chunk =
            row.map_err(|error| JobError::Database(format!("read output chunk: {error}")))?;
        chunks.entry(chunk.job_id.clone()).or_default().push(chunk);
    }
    Ok((records, chunks))
}

/// Current time as RFC 3339 UTC with microsecond precision, e.g.
/// `2026-08-24T12:34:56.123456Z`. The previous implementation emitted
/// `<secs>.<micros>+00:00` — no date, no `T` — which every RFC 3339 parser
/// rejects (SPEC §28.1 mandates RFC 3339 UTC timestamps).
fn now_rfc3339() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let dur = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    unix_to_rfc3339(dur.as_secs(), dur.subsec_micros())
}

/// Format unix seconds + microseconds as RFC 3339 UTC (`...Z`). Pure so the
/// calendar math is unit-testable without clock injection.
fn unix_to_rfc3339(secs: u64, micros: u32) -> String {
    let days = i64::try_from(secs / 86_400).unwrap_or(i64::MAX);
    let secs_of_day = secs % 86_400;
    let (year, month, day) = civil_from_days(days);
    let hour = secs_of_day / 3_600;
    let minute = (secs_of_day % 3_600) / 60;
    let second = secs_of_day % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{micros:06}Z")
}

/// Howard Hinnant's `civil_from_days`: days since 1970-01-01 to
/// (year, month, day) in the proleptic Gregorian calendar.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    (
        if m <= 2 { y + 1 } else { y },
        u32::try_from(m).unwrap_or(1),
        u32::try_from(d).unwrap_or(1),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use tempfile::tempdir;
    use terminus_artifacts::ArtifactStore;
    use terminus_process::ProcessManager;

    fn mgr() -> (tempfile::TempDir, JobManager) {
        let dir = tempdir().unwrap();
        let store = ArtifactStore::open(dir.path()).unwrap();
        let process = Arc::new(ProcessManager::new(Arc::new(store)));
        (dir, JobManager::new(process))
    }

    fn sleep_spawn(secs: u64) -> NormalizedSpawn {
        NormalizedSpawn {
            program: "sh".into(),
            args: vec!["-c".into(), format!("sleep {secs}")],
            env: BTreeMap::new(),
            working_dir: None,
            timeout_ms: 0,
            shell: true,
            allocate_pty: false,
        }
    }

    fn echo_spawn() -> NormalizedSpawn {
        NormalizedSpawn {
            program: "sh".into(),
            args: vec!["-c".into(), "echo done".into()],
            env: BTreeMap::new(),
            working_dir: None,
            timeout_ms: 5_000,
            shell: true,
            allocate_pty: false,
        }
    }

    #[tokio::test]
    async fn create_start_stop_state_machine() {
        let (_dir, mgr) = mgr();
        let id = terminus_kernel_protocol::new_id();
        let record = JobRecord::new(id.clone(), "sess", "task", "sleep 30");
        mgr.create(record).await.unwrap();
        assert_eq!(mgr.state(&id).await.unwrap(), JobState::Created);
        mgr.start(&id, sleep_spawn(30)).await.unwrap();
        assert_eq!(mgr.state(&id).await.unwrap(), JobState::Running);
        let final_state = mgr.stop(&id, "test").await.unwrap();
        assert_eq!(final_state, JobState::Exited);
    }

    #[tokio::test]
    async fn reconcile_marks_lost_when_process_gone() {
        let (_dir, mgr) = mgr();
        let id = terminus_kernel_protocol::new_id();
        let record = JobRecord::new(id.clone(), "sess", "task", "echo done");
        mgr.create(record).await.unwrap();
        mgr.start(&id, echo_spawn()).await.unwrap();
        // Poll for the short echo process to exit and reconcile to Lost.
        let mut state = JobState::Running;
        for _ in 0..50 {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            state = mgr.reconcile(&id).await.unwrap();
            if state == JobState::Lost {
                break;
            }
        }
        assert_eq!(state, JobState::Lost);
    }

    #[tokio::test]
    async fn reconcile_keeps_running_job() {
        let (_dir, mgr) = mgr();
        let id = terminus_kernel_protocol::new_id();
        let record = JobRecord::new(id.clone(), "sess", "task", "sleep 30");
        mgr.create(record).await.unwrap();
        mgr.start(&id, sleep_spawn(30)).await.unwrap();
        let state = mgr.reconcile(&id).await.unwrap();
        assert_eq!(state, JobState::Running);
        // Cleanup.
        let _ = mgr.stop(&id, "test").await;
    }

    #[tokio::test]
    async fn double_start_rejected() {
        let (_dir, mgr) = mgr();
        let id = terminus_kernel_protocol::new_id();
        let record = JobRecord::new(id.clone(), "sess", "task", "sleep 30");
        mgr.create(record).await.unwrap();
        mgr.start(&id, sleep_spawn(30)).await.unwrap();
        let err = mgr.start(&id, sleep_spawn(30)).await.unwrap_err();
        assert!(matches!(err, JobError::InvalidTransition { .. }));
        let _ = mgr.stop(&id, "test").await;
    }

    #[tokio::test]
    async fn orphaned_can_become_lost() {
        let (_dir, mgr) = mgr();
        let id = terminus_kernel_protocol::new_id();
        let record = JobRecord::new(id.clone(), "sess", "task", "sleep 30");
        mgr.create(record).await.unwrap();
        mgr.start(&id, sleep_spawn(30)).await.unwrap();
        mgr.mark_orphaned(&id).await.unwrap();
        assert_eq!(mgr.state(&id).await.unwrap(), JobState::Orphaned);
        let _ = mgr.stop(&id, "test").await; // Stopping from Orphaned is invalid.
    }

    #[tokio::test]
    async fn persistent_job_survives_reload() {
        let dir = tempdir().unwrap();
        let store = ArtifactStore::open(dir.path()).unwrap();
        let process = Arc::new(ProcessManager::new(Arc::new(store)));
        let storage_path = dir.path().join("jobs.json");

        let mgr1 = JobManager::with_storage(process.clone(), &storage_path);
        let id = terminus_kernel_protocol::new_id();
        let record = JobRecord::new(id.clone(), "sess-1", "task-1", "echo persistent");
        mgr1.create(record).await.unwrap();
        assert_eq!(mgr1.state(&id).await.unwrap(), JobState::Created);

        // Create a second manager instance pointing to the same storage path and reload
        let mgr2 = JobManager::with_storage(process, &storage_path);
        let loaded = mgr2.load_persisted().await.unwrap();
        assert_eq!(loaded, 1);
        assert_eq!(mgr2.state(&id).await.unwrap(), JobState::Created);
    }

    #[tokio::test]
    async fn durable_output_resumes_from_byte_offsets_after_reload() {
        let dir = tempdir().unwrap();
        let store = Arc::new(ArtifactStore::open(dir.path().join("artifacts")).unwrap());
        let process = Arc::new(ProcessManager::new(Arc::clone(&store)));
        let storage_path = dir.path().join("jobs.sqlite");
        let mgr1 = JobManager::with_storage(Arc::clone(&process), &storage_path);
        let id = terminus_kernel_protocol::new_id();
        mgr1.create(JobRecord::new(id.clone(), "sess", "task", "echo logs"))
            .await
            .unwrap();
        let lease = mgr1.get(&id).await.unwrap().lease_token;

        mgr1.record_event_with_lease(
            &id,
            &lease,
            &ProcessEvent::Stdout(terminus_kernel_protocol::OutputChunk {
                cursor: 5,
                bytes: b"hello".to_vec(),
                redacted: false,
            }),
        )
        .await
        .unwrap();
        mgr1.record_event_with_lease(
            &id,
            &lease,
            &ProcessEvent::Stderr(terminus_kernel_protocol::OutputChunk {
                cursor: 3,
                bytes: b"err".to_vec(),
                redacted: true,
            }),
        )
        .await
        .unwrap();

        let resumed = mgr1.output_since(&id, "stdout", 2).await.unwrap();
        assert_eq!(resumed.len(), 1);
        assert_eq!(resumed[0].start_cursor, 2);
        assert_eq!(resumed[0].end_cursor, 5);
        assert_eq!(resumed[0].bytes, b"llo");
        mgr1.record_event_with_lease(
            &id,
            &lease,
            &ProcessEvent::Stdout(terminus_kernel_protocol::OutputChunk {
                cursor: 5,
                bytes: b"hello".to_vec(),
                redacted: false,
            }),
        )
        .await
        .unwrap();
        assert_eq!(mgr1.get(&id).await.unwrap().stdout_cursor, 5);
        assert!(matches!(
            mgr1.record_event_with_lease(
                &id,
                "stale-lease",
                &ProcessEvent::Stdout(terminus_kernel_protocol::OutputChunk {
                    cursor: 6,
                    bytes: b"!".to_vec(),
                    redacted: false,
                }),
            )
            .await,
            Err(JobError::LeaseMismatch(_))
        ));

        let mgr2 = JobManager::with_storage(process, &storage_path);
        assert_eq!(mgr2.load_persisted().await.unwrap(), 1);
        let resumed_after_reload = mgr2.output_since(&id, "stdout", 2).await.unwrap();
        assert_eq!(resumed_after_reload, resumed);
        assert_eq!(
            mgr2.output_since(&id, "stdout", 5).await.unwrap(),
            Vec::new()
        );
        assert_eq!(mgr2.get(&id).await.unwrap().stdout_cursor, 5);
        assert_eq!(mgr2.get(&id).await.unwrap().stderr_cursor, 3);
    }

    #[test]
    fn startup_reload_marks_a_missing_process_lost() {
        let dir = tempdir().unwrap();
        let store = ArtifactStore::open(dir.path().join("artifacts")).unwrap();
        let process = Arc::new(ProcessManager::new(Arc::new(store)));
        let storage_path = dir.path().join("jobs.sqlite");
        let id = terminus_kernel_protocol::new_id();
        let mut record = JobRecord::new(id.clone(), "sess", "task", "missing");
        record.state = JobState::Created.transition(JobState::Starting).unwrap();
        record.pid = Some(u32::MAX);
        record.process_start_time = Some("missing-start".to_string());
        record.process_executable = Some("missing-executable".to_string());
        record.process_identity = Some("persisted-process".to_string());
        let records = [(id.clone(), record)].into_iter().collect();
        persist_state_sync(&Some(storage_path.clone()), &records, &HashMap::new()).unwrap();

        let manager = JobManager::with_storage(process, &storage_path);
        assert_eq!(manager.load_persisted_sync().unwrap(), 1);
        let reconciled = manager.reconcile_loaded_sync().unwrap();
        assert_eq!(reconciled, vec![(id.clone(), JobState::Lost)]);
        let record = manager.jobs.blocking_lock().get(&id).cloned().unwrap();
        assert_eq!(record.state, JobState::Lost);
        assert!(record
            .reconciliation_history
            .iter()
            .any(|entry| entry.starts_with("startup-lost:")));
    }

    #[tokio::test]
    async fn reload_reconciles_live_pid_and_records_termination_receipt() {
        let dir = tempdir().unwrap();
        let store = Arc::new(ArtifactStore::open(dir.path().join("artifacts")).unwrap());
        let process1 = Arc::new(ProcessManager::new(Arc::clone(&store)));
        let storage_path = dir.path().join("jobs.sqlite");
        let mgr1 = JobManager::with_storage(Arc::clone(&process1), &storage_path);
        let id = terminus_kernel_protocol::new_id();
        mgr1.create(JobRecord::new(id.clone(), "sess", "task", "sleep 30"))
            .await
            .unwrap();
        let outcome = mgr1.start(&id, sleep_spawn(30)).await.unwrap();
        assert!(outcome.pid.is_some());
        assert!(outcome.process_start_time.is_some());

        // A fresh ProcessManager has no in-memory child handle. Reconciliation
        // must use the persisted PID/start identity instead.
        let process2 = Arc::new(ProcessManager::new(Arc::clone(&store)));
        let mgr2 = JobManager::with_storage(process2, &storage_path);
        assert_eq!(mgr2.load_persisted().await.unwrap(), 1);
        assert_eq!(mgr2.reconcile(&id).await.unwrap(), JobState::Running);
        assert_eq!(
            mgr2.stop(&id, "restart-test").await.unwrap(),
            JobState::Exited
        );
        let record = mgr2.get(&id).await.unwrap();
        assert!(matches!(
            record.termination_receipt.as_deref(),
            Some("cancelled") | Some("sigterm->sigkill")
        ));
    }

    #[test]
    fn rfc3339_formatting_known_instants() {
        assert_eq!(unix_to_rfc3339(0, 0), "1970-01-01T00:00:00.000000Z");
        // 2024-02-29T12:00:00Z (leap day).
        assert_eq!(
            unix_to_rfc3339(1_709_208_000, 1),
            "2024-02-29T12:00:00.000001Z"
        );
        // 2026-08-24T00:00:00Z.
        assert_eq!(
            unix_to_rfc3339(1_787_529_600, 999_999),
            "2026-08-24T00:00:00.999999Z"
        );
        // End of leap year 2000.
        assert_eq!(
            unix_to_rfc3339(978_307_199, 0),
            "2000-12-31T23:59:59.000000Z"
        );
    }
}

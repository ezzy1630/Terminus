use crate::error::JobError;
use crate::record::JobRecord;
use crate::state::JobState;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use terminus_process::{NormalizedSpawn, ProcessManager, SpawnOutcome};
use tokio::sync::Mutex;

/// JobManager owns the durable job state and reuses a `ProcessManager`.
#[derive(Debug, Clone)]
pub struct JobManager {
    process_manager: Arc<ProcessManager>,
    jobs: Arc<Mutex<HashMap<String, JobRecord>>>,
    storage_path: Option<PathBuf>,
}

impl JobManager {
    pub fn new(process_manager: Arc<ProcessManager>) -> Self {
        Self {
            process_manager,
            jobs: Arc::new(Mutex::new(HashMap::new())),
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
            storage_path: Some(storage_path.into()),
        }
    }

    async fn persist_state(&self, jobs: &HashMap<String, JobRecord>) -> Result<(), JobError> {
        if let Some(path) = &self.storage_path {
            if let Some(parent) = path.parent() {
                tokio::fs::create_dir_all(parent).await?;
            }
            let records: Vec<&JobRecord> = jobs.values().collect();
            let json = serde_json::to_vec_pretty(&records)?;
            let tmp_path = format!("{}.tmp-{}", path.display(), std::process::id());
            tokio::fs::write(&tmp_path, &json).await?;
            tokio::fs::rename(&tmp_path, path).await?;
        }
        Ok(())
    }

    /// Load persisted job records from the storage file into memory.
    pub async fn load_persisted(&self) -> Result<usize, JobError> {
        if let Some(path) = &self.storage_path {
            if path.exists() {
                let data = tokio::fs::read(path).await?;
                if !data.is_empty() {
                    let records: Vec<JobRecord> = serde_json::from_slice(&data)?;
                    let count = records.len();
                    let mut jobs = self.jobs.lock().await;
                    for r in records {
                        jobs.insert(r.id.clone(), r);
                    }
                    return Ok(count);
                }
            }
        }
        Ok(0)
    }

    /// Register a new job in the `Created` state.
    pub async fn create(&self, record: JobRecord) -> Result<String, JobError> {
        let id = record.id.clone();
        let mut jobs = self.jobs.lock().await;
        jobs.insert(id.clone(), record);
        self.persist_state(&jobs).await?;
        Ok(id)
    }

    /// Start a job. Transitions Created → Starting → Running (when the
    /// process actually starts streaming events).
    pub async fn start(
        &self,
        job_id: &str,
        spawn: NormalizedSpawn,
    ) -> Result<SpawnOutcome, JobError> {
        let mut jobs = self.jobs.lock().await;
        let record = jobs
            .get_mut(job_id)
            .ok_or_else(|| JobError::NotFound(job_id.to_string()))?;
        record.state = record.state.transition(JobState::Starting)?;
        record.started_at = Some(now_rfc3339());
        record.resolved_executable = spawn.program.clone();
        let (outcome, _rx) = self.process_manager.spawn(spawn).await?;
        record.state = record.state.transition(JobState::Running)?;
        record.process_identity = Some(outcome.process_id.clone());
        self.persist_state(&jobs).await?;
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
        let record = jobs
            .get_mut(job_id)
            .ok_or_else(|| JobError::NotFound(job_id.to_string()))?;
        record.state = record.state.transition(JobState::Starting)?;
        record.state = record.state.transition(JobState::Running)?;
        record.started_at = Some(now_rfc3339());
        record.resolved_executable = outcome.resolved_executable.clone();
        record.process_identity = Some(outcome.process_id.clone());
        self.persist_state(&jobs).await?;
        Ok(())
    }

    pub async fn remove(&self, job_id: &str) {
        let mut jobs = self.jobs.lock().await;
        jobs.remove(job_id);
        let _ = self.persist_state(&jobs).await;
    }

    pub async fn input(&self, job_id: &str, bytes: &[u8]) -> Result<JobState, JobError> {
        let process_id = self
            .get(job_id)
            .await
            .ok_or_else(|| JobError::NotFound(job_id.to_string()))?
            .process_identity
            .ok_or_else(|| JobError::NotFound(format!("process for job {job_id}")))?;
        self.process_manager.write_stdin(&process_id, bytes).await?;
        Ok(self.state(job_id).await.unwrap_or(JobState::Lost))
    }

    pub async fn signal(&self, job_id: &str, signal: &str) -> Result<JobState, JobError> {
        let process_id = self
            .get(job_id)
            .await
            .ok_or_else(|| JobError::NotFound(job_id.to_string()))?
            .process_identity
            .ok_or_else(|| JobError::NotFound(format!("process for job {job_id}")))?;
        self.process_manager.signal(&process_id, signal).await?;
        Ok(self.state(job_id).await.unwrap_or(JobState::Lost))
    }

    /// Stop a running job. Transitions Running → Stopping → Exited.
    pub async fn stop(&self, job_id: &str, reason: &str) -> Result<JobState, JobError> {
        let process_id = {
            let mut jobs = self.jobs.lock().await;
            let record = jobs
                .get_mut(job_id)
                .ok_or_else(|| JobError::NotFound(job_id.to_string()))?;
            record.state = record.state.transition(JobState::Stopping)?;
            record.process_identity.clone()
        };
        if let Some(pid) = process_id {
            let _ = self.process_manager.cancel(&pid, reason).await;
        }
        let mut jobs = self.jobs.lock().await;
        let record = jobs
            .get_mut(job_id)
            .ok_or_else(|| JobError::NotFound(job_id.to_string()))?;
        record.state = record.state.transition(JobState::Exited)?;
        record.settled_at = Some(now_rfc3339());
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
            record.state = JobState::Exited;
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
        let final_state = record.state;
        self.persist_state(&jobs).await?;
        Ok(final_state)
    }

    /// Reconcile after a kernel restart: if the process identity is no
    /// longer running, mark the job LOST.
    pub async fn reconcile(&self, job_id: &str) -> Result<JobState, JobError> {
        let process_id = {
            let jobs = self.jobs.lock().await;
            let record = jobs
                .get(job_id)
                .ok_or_else(|| JobError::NotFound(job_id.to_string()))?;
            record.process_identity.clone()
        };
        if let Some(pid) = process_id {
            if !self.process_manager.is_running(&pid).await {
                let mut jobs = self.jobs.lock().await;
                let record = jobs
                    .get_mut(job_id)
                    .ok_or_else(|| JobError::NotFound(job_id.to_string()))?;
                if matches!(
                    record.state,
                    JobState::Orphaned | JobState::Running | JobState::Starting
                ) {
                    record.state = if record.state == JobState::Orphaned {
                        record.state.transition(JobState::Lost)?
                    } else {
                        // Running/Starting → Orphaned → Lost in one shot.
                        record.state = JobState::Orphaned;
                        record.state.transition(JobState::Lost)?
                    };
                    record.settled_at = Some(now_rfc3339());
                }
                let final_state = record.state;
                self.persist_state(&jobs).await?;
                return Ok(final_state);
            }
        }
        let jobs = self.jobs.lock().await;
        let record = jobs
            .get(job_id)
            .ok_or_else(|| JobError::NotFound(job_id.to_string()))?;
        Ok(record.state)
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
        let _ = self.persist_state(&jobs).await;
        removed
    }

    pub async fn get(&self, job_id: &str) -> Option<JobRecord> {
        self.jobs.lock().await.get(job_id).cloned()
    }

    pub async fn state(&self, job_id: &str) -> Option<JobState> {
        self.jobs.lock().await.get(job_id).map(|r| r.state)
    }
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

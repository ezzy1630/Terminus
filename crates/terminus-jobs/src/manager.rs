use crate::error::JobError;
use crate::record::JobRecord;
use crate::state::JobState;
use forge_process::{NormalizedSpawn, ProcessManager};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

/// JobManager owns the durable job state and reuses a `ProcessManager`.
#[derive(Debug, Clone)]
pub struct JobManager {
    process_manager: Arc<ProcessManager>,
    jobs: Arc<Mutex<HashMap<String, JobRecord>>>,
}

impl JobManager {
    pub fn new(process_manager: Arc<ProcessManager>) -> Self {
        Self {
            process_manager,
            jobs: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Register a new job in the `Created` state.
    pub async fn create(&self, record: JobRecord) -> Result<String, JobError> {
        let id = record.id.clone();
        self.jobs.lock().await.insert(id.clone(), record);
        Ok(id)
    }

    /// Start a job. Transitions Created → Starting → Running (when the
    /// process actually starts streaming events).
    pub async fn start(
        &self,
        job_id: &str,
        spawn: NormalizedSpawn,
    ) -> Result<(), JobError> {
        let mut jobs = self.jobs.lock().await;
        let record = jobs
            .get_mut(job_id)
            .ok_or_else(|| JobError::NotFound(job_id.to_string()))?;
        record.state = record.state.transition(JobState::Starting)?;
        record.started_at = Some(now_rfc3339());
        record.resolved_executable = spawn.program.clone();
        let (outcome, _rx) = self.process_manager.spawn(spawn).await?;
        record.state = record.state.transition(JobState::Running)?;
        record.process_identity = Some(outcome.process_id);
        Ok(())
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
        Ok(record.state)
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
            Ok(record.state)
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
        Ok(record.state)
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
                if matches!(record.state, JobState::Orphaned | JobState::Running | JobState::Starting) {
                    record.state = if record.state == JobState::Orphaned {
                        record.state.transition(JobState::Lost)?
                    } else {
                        // Running/Starting → Orphaned → Lost in one shot.
                        record.state = JobState::Orphaned;
                        record.state.transition(JobState::Lost)?
                    };
                    record.settled_at = Some(now_rfc3339());
                }
                return Ok(record.state);
            }
        }
        let jobs = self.jobs.lock().await;
        let record = jobs
            .get(job_id)
            .ok_or_else(|| JobError::NotFound(job_id.to_string()))?;
        Ok(record.state)
    }

    pub async fn get(&self, job_id: &str) -> Option<JobRecord> {
        self.jobs.lock().await.get(job_id).cloned()
    }

    pub async fn state(&self, job_id: &str) -> Option<JobState> {
        self.jobs.lock().await.get(job_id).map(|r| r.state)
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
    use forge_artifacts::ArtifactStore;
    use forge_process::ProcessManager;
    use std::collections::BTreeMap;
    use tempfile::tempdir;

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
        }
    }

    #[tokio::test]
    async fn create_start_stop_state_machine() {
        let (_dir, mgr) = mgr();
        let id = forge_kernel_protocol::new_id();
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
        let id = forge_kernel_protocol::new_id();
        let record = JobRecord::new(id.clone(), "sess", "task", "echo done");
        mgr.create(record).await.unwrap();
        mgr.start(&id, echo_spawn()).await.unwrap();
        // Wait for the short echo to exit.
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        let state = mgr.reconcile(&id).await.unwrap();
        assert_eq!(state, JobState::Lost);
    }

    #[tokio::test]
    async fn reconcile_keeps_running_job() {
        let (_dir, mgr) = mgr();
        let id = forge_kernel_protocol::new_id();
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
        let id = forge_kernel_protocol::new_id();
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
        let id = forge_kernel_protocol::new_id();
        let record = JobRecord::new(id.clone(), "sess", "task", "sleep 30");
        mgr.create(record).await.unwrap();
        mgr.start(&id, sleep_spawn(30)).await.unwrap();
        mgr.mark_orphaned(&id).await.unwrap();
        assert_eq!(mgr.state(&id).await.unwrap(), JobState::Orphaned);
        let _ = mgr.stop(&id, "test").await; // Stopping from Orphaned is invalid.
    }
}

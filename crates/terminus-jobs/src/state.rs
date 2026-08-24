use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JobState {
    Created,
    Starting,
    Running,
    Stopping,
    Exited,
    Orphaned,
    Lost,
}

impl JobState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Created => "CREATED",
            Self::Starting => "STARTING",
            Self::Running => "RUNNING",
            Self::Stopping => "STOPPING",
            Self::Exited => "EXITED",
            Self::Orphaned => "ORPHANED",
            Self::Lost => "LOST",
        }
    }

    /// True if the state is terminal (no further transitions allowed).
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Exited | Self::Lost)
    }

    /// Validate a transition. Returns the new state or an error.
    pub fn transition(self, to: JobState) -> Result<JobState, crate::JobError> {
        let ok = matches!(
            (self, to),
            (Self::Created, Self::Starting)
                | (Self::Starting, Self::Running)
                | (Self::Starting, Self::Exited)
                | (Self::Running, Self::Stopping)
                | (Self::Running, Self::Exited)
                | (Self::Stopping, Self::Exited)
                | (Self::Running, Self::Orphaned)
                | (Self::Starting, Self::Orphaned)
                | (Self::Stopping, Self::Orphaned)
                | (Self::Orphaned, Self::Lost)
                | (Self::Orphaned, Self::Exited)
        );
        if ok {
            Ok(to)
        } else {
            Err(crate::JobError::InvalidTransition {
                from: self.as_str().to_string(),
                to: to.as_str().to_string(),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn created_to_starting() {
        assert_eq!(
            JobState::Created.transition(JobState::Starting).unwrap(),
            JobState::Starting
        );
    }

    #[test]
    fn starting_to_running() {
        assert_eq!(
            JobState::Starting.transition(JobState::Running).unwrap(),
            JobState::Running
        );
    }

    #[test]
    fn running_to_exited() {
        assert_eq!(
            JobState::Running.transition(JobState::Exited).unwrap(),
            JobState::Exited
        );
    }

    #[test]
    fn running_to_orphaned_to_lost() {
        let orphaned = JobState::Running.transition(JobState::Orphaned).unwrap();
        let lost = orphaned.transition(JobState::Lost).unwrap();
        assert_eq!(lost, JobState::Lost);
    }

    #[test]
    fn terminal_states_reject_transitions() {
        let err = JobState::Exited.transition(JobState::Running).unwrap_err();
        assert!(matches!(err, crate::JobError::InvalidTransition { .. }));
    }

    #[test]
    fn invalid_created_to_running() {
        let err = JobState::Created.transition(JobState::Running).unwrap_err();
        assert!(matches!(err, crate::JobError::InvalidTransition { .. }));
    }
}

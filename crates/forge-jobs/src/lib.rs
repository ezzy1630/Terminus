//! Durable job state machine (SPEC.md Section 34.12, 28.6).
//!
//! Jobs are long-running processes that survive across control-plane
//! reconnects. The `JobManager` owns a `ProcessManager` and tracks each job
//! through its state machine:
//!
//! ```text
//! CREATED → STARTING → RUNNING → EXITED
//!                  ↘            ↗
//!                   STOPPING ───┘
//!                       ↘
//!                       ORPHANED → LOST (after reconcile)
//! ```

#![forbid(unsafe_code)]

mod error;
mod manager;
mod record;
mod state;

pub use error::JobError;
pub use manager::JobManager;
pub use record::{JobRecord, JobResourceLimits};
pub use state::JobState;

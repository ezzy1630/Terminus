//! Async child-process manager (SPEC.md Section 34.11, 31.4).
//!
//! `ProcessManager` owns child processes started from a `CommandSpec`. It:
//! - spawns with structured argv or shell, in a process group;
//! - captures stdout/stderr to the artifact store as bounded chunks;
//! - enforces a timeout;
//! - kills the process tree on cancel;
//! - streams `ProcessEvent`s via an async channel.
//!
//! No ambient environment is inherited; the caller supplies an explicit
//! `public_env` map and any secret capability URIs are routed through
//! `terminus-secrets` (the process manager itself does not dereference them).
//!
//! ## `unsafe` policy
//!
//! This crate contains exactly one `unsafe` block, in
//! `manager::kill_process_group`, to call `libc::kill(-pgid, SIGKILL)`. The
//! rationale is recorded in `docs/decisions/ADR-0031-controlled-unsafe-killpg.md`:
//! there is no safe Rust API in std for `killpg(2)`, and the
//! alternative — leaking orphan processes — is worse than a contained,
//! well-documented `unsafe` block. The block is the smallest possible and
//! touches only signal dispatch.

#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]
#![deny(unsafe_code)]

mod error;
mod manager;
mod spec;

pub use error::ProcessError;
pub use manager::{ManagedProcess, ProcessManager};
pub use spec::{NormalizedSpawn, SpawnOutcome};

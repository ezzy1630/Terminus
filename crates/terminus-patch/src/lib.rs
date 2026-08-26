//! Transactional patch engine (SPEC.md Section 34.7, 34.8).
//!
//! `PatchEngine` applies a list of `PatchEdit`s against a workspace
//! baseline. The algorithm:
//! 1. validate request and scope;
//! 2. resolve all paths canonically (via `PathResolver`);
//! 3. acquire per-path leases (lexicographic order to avoid deadlock);
//! 4. verify baseline per-file hashes;
//! 5. copy affected files into a transaction overlay (`$tmp/tx-<id>/`);
//! 6. apply all operations to the overlay;
//! 7. run validation (parse / line-count sanity);
//! 8. write a durable transaction journal;
//! 9. apply staged file replacements atomically;
//! 10. on failure, roll back from the overlay snapshots.
//!
//! The patch is atomic at the Terminus transaction layer, not at the native
//! filesystem layer. The journal and snapshots guarantee recovery from
//! partial host-level application.

#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]
#![forbid(unsafe_code)]

mod engine;
mod error;
mod fallback;
mod journal;
mod unified_diff;
mod validate;

pub use engine::{compute_line_hash, PatchEngine, Transaction};
pub use error::PatchError;
pub use journal::{JournalEntry, JournalRecord};
pub use unified_diff::{parse_unified_diff, target_path, DiffHunk, HunkLine, ParsedUnifiedDiff};
pub use validate::{ValidationProfile, ValidationResult};

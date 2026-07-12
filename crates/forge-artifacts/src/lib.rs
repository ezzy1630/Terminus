//! Content-addressed artifact store (SPEC.md Section 29.3, 29.4).
//!
//! Layout: `$FORGE_DATA/artifacts/sha256/ab/cd/<hash>` with sidecar metadata
//! files. Ingest streams bytes into a temp file while computing SHA-256,
//! fsyncs, atomically renames into the CAS path if absent, and fsyncs the
//! parent directory. Garbage collection is reference-aware and dry-run
//! capable.

#![forbid(unsafe_code)]

mod error;
mod gc;
mod metadata;
mod store;

pub use error::ArtifactError;
pub use gc::{GcDryRunReport, GcReport};
pub use metadata::{
    ArtifactMetadata, Confidentiality, RedactionStatus, RetentionClass, TrustLabel,
};
pub use store::ArtifactStore;

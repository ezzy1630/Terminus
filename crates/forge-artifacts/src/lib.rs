//! Content-addressed artifact store (SPEC.md Section 29.3, 29.4).
//!
//! Layout: `$FORGE_DATA/artifacts/sha256/ab/cd/<hash>` with sidecar metadata
//! files. Ingest streams bytes into a temp file while computing SHA-256,
//! fsyncs, atomically renames into the CAS path if absent, and fsyncs the
//! parent directory. Garbage collection is reference-aware and dry-run
//! capable.
//!
//! Metadata is persisted to BOTH a SQLite database (`metadata.db` at the
//! store root) and a JSON sidecar file. SQLite is the primary store; the
//! JSON sidecar is a fallback for backwards compatibility and for tools
//! that read metadata without a SQLite client.

#![forbid(unsafe_code)]

mod error;
mod gc;
mod metadata;
mod sqlite;
mod store;

pub use error::ArtifactError;
pub use gc::{GcDryRunReport, GcReport};
pub use metadata::{
    ArtifactLink, ArtifactMetadata, Confidentiality, ContentEncoding, RedactionStatus,
    RetentionClass, TrustLabel,
};
pub use sqlite::SqliteMetadataStore;
pub use store::ArtifactStore;

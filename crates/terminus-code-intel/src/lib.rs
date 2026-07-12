//! High-level symbol index and diagnostics surface (SPEC.md Section 34.13).
//!
//! This crate exposes a small, language-agnostic API:
//! - `inspect_symbol` — fetch a symbol's definition range and signature;
//! - `find_references` — find references to a symbol across the workspace;
//! - `diagnose_files` — placeholder for compiler/linter diagnostics;
//! - `workspace_diff` — summarize uncommitted changes.
//!
//! The default implementation is a stub that returns "language not indexed".
//! Wiring real tree-sitter parsers is a M5 task; the high-level surface is
//! stable.

#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]
#![forbid(unsafe_code)]

mod error;
mod index;
mod inspect;
mod symbols;

pub use error::CodeIntelError;
pub use index::{InMemorySymbolIndex, SymbolIndex};
pub use inspect::{
    CodeIntelService, DiagnoseResult, InspectResult, ReferenceResult, WorkspaceDiff,
};
pub use symbols::{Symbol, SymbolKind};

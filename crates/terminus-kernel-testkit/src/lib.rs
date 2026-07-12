//! Test helpers for the Terminus kernel.
//!
//! Provides a fake kernel, an in-memory artifact store, a mock sandbox, and
//! builders for `RequestContext` / `EffectIntent` / `CommandSpec` so
//! downstream crates (control plane, providers, etc.) can write integration
//! tests without spinning up the full HTTP server.

#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]
#![forbid(unsafe_code)]

mod builders;
mod fake_kernel;
mod mock_sandbox;
mod store;

pub use builders::{CommandSpecBuilder, EffectIntentBuilder, RequestContextBuilder};
pub use fake_kernel::FakeKernel;
pub use mock_sandbox::MockSandbox;
pub use store::InMemoryArtifactStore;

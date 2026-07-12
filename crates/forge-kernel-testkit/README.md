# forge-kernel-testkit

Test helpers for the Forge kernel.

Provides a `FakeKernel` that records invocations and returns success-shaped
responses, an `InMemoryArtifactStore` for fast unit tests, a `MockSandbox`
that reports `Enforced`, and builders for `RequestContext`, `EffectIntent`,
and `CommandSpec`. Downstream crates (control plane, providers, evals) use
these to write integration tests without spinning up the full HTTP server.

# @forge/testkit

Fixtures and builders for Forge tests. Used by all other packages' tests.

## Public API

- ID helpers: `fakeUuid7`, `fakeContentHash`, `fakeArtifactUri`,
  `fakeArtifactRef`, `fakeTimestamp`, `fakeTraceId`, `fakePrincipal`,
  `fakeModelKey`, `deterministicIds()`.
- Builders: `buildRequestContext`, `buildEffectIntent`, `buildCommandSpec`,
  `buildAcceptanceCriterion`, `buildAllowedScope`, `buildTaskBudget`,
  `buildTaskContract`, `buildTask`, `buildSourceDescriptor`, `buildFreshness`,
  `buildSelectionFeatures`, `buildContextScope`, `buildContextFragment`.
- `FakeEventSink`: in-memory `EventSink` that captures all emitted events.
- `FakeProvider`: scripted streaming text, tool calls, errors, rate limits,
  continuation IDs, cache usage, malicious args. Convenience constructors
  `fakeTextProvider` and `fakeToolCallProvider`.
- `FakeKernel`: in-memory artifact store and mock sandbox.

## Invariants

- Fixtures MUST NOT touch the real filesystem, network, or process tree.
- Fixture-generated IDs are deterministic per `deterministicIds()` instance.
- Call `resetTestkitCounter()` between tests for full isolation.

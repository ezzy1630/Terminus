# @terminus/adapter-sdk

External harness adapter SDK. Per SPEC §12.4, §35.11–35.12.

## Public API

- `ExternalAdapter` + `StdioJsonRpcAdapter` (Boundary C).
- Factory: `createFixtureAgentAdapter` (the deterministic conformance double).
  Terminus drives models with its own loop and does not delegate tasks to
  other coding harnesses, so no product adapters ship.
- `InMemoryAdapterRegistry`, live `runCapabilityProbe` / `applyProbeToRegistry`.
- `independentlyVerifyHarnessResult` — workspace inspect + verification engine.
- `runAdapterConformance` — honesty / schema suite.

## Invariants

- Terminus independently inspects the final workspace. Inner-harness self-report
  is not sufficient evidence.
- Schema failure gets at most one correction attempt.
- Declared/observed capability discrepancies may disable the adapter.

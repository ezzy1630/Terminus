# @terminus/adapter-sdk

External harness adapter SDK. Per SPEC §12.4, §35.11.

## Public API

- `ExternalAdapter` interface with `launch(contract, signal)`,
  `streamEvents(signal)`, `cancel(reason)`, `collectResult()`.
- `AdapterCapabilityProfile` with fields: `exactContextVisibility`,
  `toolInterception`, `filesystemEnforcement`, `networkEnforcement`,
  `secretIsolation`, `sessionResume`, `typedResults`, `artifactExport`,
  `cancellation`, `modelSelection`, `nativeCompaction`.
- `AdapterContract`, `AdapterBudgets`, `AdapterEvent`, `AdapterResult`.
- `validateCapabilityProfile(declared, observed)` — surfaces declared/observed
  discrepancies.
- `validateAdapterResult(result, allowRetry)` — schema validation with
  at-most-one correction attempt.

## Invariants

- Terminus independently inspects the final workspace, collects artifacts, and
  runs verification. Inner-harness self-report is not sufficient evidence.
- Schema failure gets at most one correction attempt. After that the result is
  treated as failed, not guessed from prose.
- Declared/observed capability discrepancies may disable the adapter.

# @forge/domain

Canonical Forge domain types, identifiers, state machine enums, and typed error classes.

Pure types and zod schemas — no I/O, no side effects. This is the lowest layer
of the Forge control plane. Per SPEC §28.1 identifiers use UUIDv7 strings,
content hashes use `sha256:<hex>`, artifact URIs use `artifact://sha256/<hex>`,
and resource URIs use `workspace://`, `session://`, `task://`, `turn://`,
`job://`, `agent://`, `memory://`, `tool://`, `rule://`, `verification://`.

All monetary values are integer `Micros` (bigint); token and byte counts are
bigints. Floating-point money is forbidden.

## Public API

- Identifiers: `Uuid7`, `ContentHash`, `ArtifactUri`, `ResourceUri`,
  `Rfc3339Timestamp`, `Micros`, `TokenCount`, `ByteCount`, `ModelKey`,
  `PrincipalId`, `TraceId`, `CursorToken`.
- State machines: `TaskStatus`, `TurnState`, `ToolCallState`,
  `SideEffectState`, `JobState`, `ContextEpochState` and their transition
  tables.
- Aggregates: `Workspace`, `Session`, `Thread`, `Task`, `TaskContract`,
  `Turn`, `Episode`, `ProviderAttempt`, `ContextEpoch`, `ContextManifest`,
  `ContextFragment`, `Artifact`, `ArtifactRef`, `ToolCall`, `PolicyDecision`,
  `Approval`, `SideEffect`, `Job`, `Agent`, `Delegation`, `VerificationPlan`,
  `VerificationNode`, `VerificationResult`, `MemoryClaim`, `Capability`,
  `CapabilityActivation`, `IdempotencyRecord`, `Lease`, `SemanticEvent`,
  `EventStreamCursor`.
- Errors: `ForgeError` and subclasses (`ValidationError`, `NotFoundError`,
  `ConflictError`, `PolicyDeniedError`, `ApprovalRequiredError`,
  `BudgetExhaustedError`, `TimeoutError`, `CancelledError`, `ProviderError`,
  `UnknownSettlementError`, etc.) plus `ErrorEnvelope` zod schema.

## Dependencies

`zod`. No other runtime dependencies.

## Invariants

- Never import provider SDKs or kernel internals here.
- Domain objects are immutable by default (use `readonly`).
- No `any`; use `unknown` and decode at boundaries.

# Testing strategy

This document summarizes Forge's testing layers (SPEC §46.1) and per-tier practices. The normative source is `SPEC.md` §46; this document is a navigation aid.

## Testing layers (SPEC §46.1)

Forge uses 12 testing layers:

1. **Unit tests** — state transitions, schema validation, policy matching, path normalization, context scoring, cache planning, task scope, event serialization, cost calculations, memory invalidation, verification DAG scheduling, adapter normalization.
2. **Property tests** — canonical path resolution never escapes root; patch round-trip + rollback restores exact bytes; event sequences monotonic per aggregate; idempotent operations return equivalent results; context allocation never exceeds hard budget; hard-required fragments never omitted; complete tool episodes never split; policy strictness monotonic when restrictive rules added; secret values never in model-visible projections; artifact hashes stable across compression; graph scheduling respects dependencies and terminates.
3. **Parser/protocol fuzz tests** — shell and command AST parser; path/symlink resolver; patch anchor parser and applicator; unified diff parser; Protobuf/JSON public decoders; MCP descriptors and tool schemas; provider response projection; context manifest decoder; policy rule parser; archive and notebook readers; redaction and log parsers.
4. **Component tests with fakes** — fake provider (SPEC §46.8), fake kernel (`forge-kernel-testkit`).
5. **Kernel integration tests** — real OS features (SPEC §46.5).
6. **Control/kernel contract tests** — current×current and current×previous (SPEC §46.6).
7. **End-to-end task tests** — clean pinned repository/environment (SPEC §46.7).
8. **Recovery/chaos tests** — fault injection at every durable boundary (SPEC §46.9).
9. **Security/adversarial tests** — per-PR, nightly, release tiers (SPEC §46.10).
10. **External-harness conformance tests** — adapter SDK fixture agent (SPEC §46.6).
11. **Benchmark/evaluation suites** — eval-smoke, eval-targeted, eval-nightly, eval-release, eval-research (SPEC §46.11).
12. **Release and upgrade tests** — upgrade/rollback drill (SPEC §46.17, §50.9).

A high pass count in unit tests does not replace effect-boundary or end-to-end testing.

## Unit tests (SPEC §46.2)

Cover: state transitions and invalid transitions; schema validation; policy matching and precedence; path normalization; context scoring and allocation; cache planning; task scope calculations; event serialization; cost calculations; memory invalidation; verification DAG scheduling; adapter normalization.

Tests SHOULD avoid network and real provider calls. The fake provider (SPEC §46.8) and fake kernel (`forge-kernel-testkit`) are used.

## Property tests (SPEC §46.3)

- Canonical path resolution never escapes its root.
- Patch round-trip plus rollback restores exact bytes.
- Event sequences are monotonic per aggregate.
- Idempotent operations return equivalent results.
- Context allocation never exceeds hard budget.
- Hard-required fragments are never omitted.
- Complete tool episodes are never split.
- Policy strictness is monotonic when restrictive rules are added.
- Secret values never occur in model-visible projections.
- Artifact hashes remain stable across compression encoding.
- Graph scheduling respects dependencies and terminates.

## Fuzz targets (SPEC §46.4)

At minimum:

```
shell and command AST parser
path/symlink resolver
patch anchor parser and applicator
unified diff parser
Protobuf/JSON public decoders
MCP descriptors and tool schemas
provider response projection
context manifest decoder
policy rule parser
archive and notebook readers
redaction and log parsers
```

Fuzz findings become permanent regression fixtures.

## Kernel integration tests (SPEC §46.5)

Run against real OS features:

- sandbox construction and teardown;
- read-only/writable/protected path behavior;
- network denial and proxy-only access;
- secret injection and revocation;
- process-tree kill including forked children;
- PTY input/output;
- job recovery after control-plane restart;
- cgroup/Job Object resource limits;
- journal recovery after forced crash at each patch-commit step;
- Git worktree protections;
- extension/MCP isolation.

## Contract tests (SPEC §46.6)

Generated protocol descriptor fixtures tested across:

- current control plane to current kernel;
- current control plane to previous supported kernel;
- previous supported control client to current public API;
- OpenCode compatibility facade against inherited clients;
- adapter SDK fixture agent.

Contract tests verify decoding, semantic behavior, and error codes.

## End-to-end tests (SPEC §46.7)

Each e2e test starts from a clean pinned repository/environment and drives the public API or client:

- create session/task;
- receive events;
- approve or deny effects;
- perform edits and tests;
- interrupt/restart;
- resume;
- verify final state and evidence;
- export trace.

Provider-dependent e2e tests have deterministic fake-provider equivalents and separate live-provider suites.

## Fake provider (SPEC §46.8)

The fake provider supports scripted:

- streaming text;
- tool calls;
- malformed schemas;
- transient errors;
- rate limits;
- continuation IDs;
- cache usage reports;
- long outputs;
- cancellation races;
- malicious tool arguments.

Required for reproducible runtime testing.

## Recovery and chaos tests (SPEC §46.9)

Inject failure after every durable boundary:

- before/after event commit;
- before/after provider send;
- during stream;
- before/after tool authorization;
- during patch application;
- after external effect starts;
- during artifact ingestion;
- during checkpoint replacement;
- while a job forks;
- during database migration.

Assertions: no silent data loss; no duplicated settled effect; recoverable or explicit manual-review state; artifact/event integrity; correct client resynchronization.

## Security test tiers (SPEC §46.10)

### Per-PR

- static policy tests;
- path traversal regressions;
- secret redaction fixtures;
- extension manifest validation;
- dependency and secret scans.

### Nightly dedicated Linux runner

- namespace/sandbox escape suite;
- network proxy bypass;
- process-tree escape;
- kernel fuzz corpus;
- malicious MCP/plugin suite.

### Release

- full adversarial benchmark;
- external penetration-test findings resolved or accepted;
- signed artifact verification;
- clean-room install/upgrade/downgrade.

See `docs/security/non-bypassability-tests.md` for the test plan.

## Evaluation test tiers (SPEC §46.11)

- `eval-smoke` — small deterministic tasks, required per PR for agent-behavior changes.
- `eval-targeted` — cohort associated with changed component.
- `eval-nightly` — broad pinned suite with repeated runs as budget permits.
- `eval-release` — full promotion suite and baseline comparison.
- `eval-research` — exploratory and non-gating.

See `docs/architecture/evaluation-lab.md` for the eval lab deep dive.

## CI workflow (SPEC §46.12)

### Fast pull-request workflow

```
format/lint
 → codegen drift
 → type/check/build
 → unit/property tests
 → architecture boundaries
 → dependency/security scans
 → changed-package integration tests
 → targeted eval smoke when required
```

### Full workflow

```
all platforms build
 → kernel integration
 → e2e/recovery
 → security dedicated runners
 → compatibility and upstream parity
 → targeted/full evals
 → package and install tests
```

See `.github/workflows/ci.yml`.

## Platform matrix (SPEC §46.13)

- Linux x86_64: full control/kernel/security/eval support.
- Linux arm64: build and core integration; expand to full support.
- macOS arm64 and x86_64 where maintained: client/control and backend tests.
- Windows x86_64: client/control/kernel and explicit sandbox-profile tests.
- WSL2: Linux backend compatibility tests.
- Container/micro-VM images: pinned environment tests.

A platform is "supported" only when release tests run there.

## Dependency policy (SPEC §46.14)

CI runs:

- `cargo deny` (license/advisory/ban/source);
- Rust and npm audit tools with triage policy;
- lockfile integrity;
- SBOM generation;
- package provenance checks;
- container scanning;
- forbidden lifecycle-script checks;
- stale dependency reporting.

Automated updates never merge solely because tests pass; security-sensitive dependencies require owner review.

## Related

- `docs/quality/release-gates.md` — release gate criteria.
- `docs/security/non-bypassability-tests.md` — security test plan.
- `docs/architecture/evaluation-lab.md` — eval lab deep dive.
- SPEC §46 (testing, CI/CD, release), §50 (acceptance).

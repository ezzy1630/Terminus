# Effect kernel

This document is the deep dive for the Rust effect kernel (SPEC §13, §31, §36). The kernel is the non-bypassable trust boundary that authorizes and executes processes, mutations, network, secrets, and extension workloads. It is governed by ADR-0003 (Rust kernel), ADR-0007 (gRPC over UDS), ADR-0013 (patch transactions), ADR-0014 (Linux Bubblewrap), ADR-0015 (proxy egress), ADR-0016 (secret broker), ADR-0019 (extension runtime).

## Service groups (SPEC §31.1)

| Service | Responsibility | Crate |
|---|---|---|
| `KernelInfoService` | Version, health, supported backends/services | `terminus-kernel` |
| `FileService` | Read files with outlines, ranges, symbols, hashes, elisions, artifacts | `terminus-fs` |
| `PatchService` | Apply and reconcile journaled patch transactions | `terminus-patch` |
| `ProcessService` | Start structured processes; stream stdout/stderr/exited | `terminus-process` |
| `JobService` | Durable, restart-survivable jobs; stream, input, signal, stop, get | `terminus-jobs` |
| SandboxService | Construct/teardown sandboxes; report capabilities | `terminus-sandbox` |
| PolicyService | Evaluate effect policy; return decision | `terminus-policy` |
| SecretService | Issue/revoke capabilities; inject at exec; redact output | `terminus-secrets` |
| ConnectorService | L7 connector broker: grant-bound credentialed external operations | `terminus-connector` |
| NetworkService | Egress proxy; destination allowlist; DNS brokering | `terminus-egress` |
| GitService | Protected worktree/commit/merge operations | `terminus-git` |
| CodeIntelService | Tree-sitter symbols, structural search, LSP/DAP facade | `terminus-code-intel` |
| ExtensionService | WASI/process extension host; capability enforcement | `terminus-extension-runtime` |

## Phase 4: secrets, connectors and sandbox TCB (ADR-0035)

Roadmap Phase 4 closes the two remaining trust gaps: raw credential
exposure and unproven enforcement claims.

**Opaque connector grants.** `SecretHandle::value()` is crate-private and
`as_env_pair()` no longer exists; the only sanctioned raw-material consumer
is the L7 connector path inside this boundary. Callers receive
[`ConnectorGrant`](../../crates/terminus-secrets/src/grant.rs) — an HMAC-signed,
short-lived token bound to connector id, destination host/port/scheme,
method + path class, task id, effect id, expiry and use limit. Grants carry
a SHA-256 digest of the credential, never the credential. Consumption is
atomic and durable (`GrantStore`, temp-file + rename), so replay across
retries or process restarts fails closed.

**L7 connector broker.** `ConnectorService` → `ConnectorBroker::execute`
validates every binding field before any side effect, resolves the
credential through the secret broker inside the trusted zone, authorizes the
connection through the L4 egress proxy (`terminus-egress` remains the lower
layer), consumes the grant immediately before wire dispatch, scrubs echoed
credential material from responses, and returns a hashed typed receipt.
Models, tools, extensions and artifacts never see credential bytes.
For `https`, rustls validates platform roots while reqwest connects only to the
DNS address set approved by the egress broker. Request and response bytes are
bounded and charged to the egress budget. Unsupported schemes fail closed.

**Sandbox enforcement truth.** Backends report what they MEASURE:

- `terminus-sandbox-container` generates hardened OCI argv
  (`--read-only --cap-drop=ALL --security-opt=no-new-privileges --user …
  --tmpfs… --memory… --cpus… --pids-limit… [--network=none]`); every
  `Enforced` claim cites a generated flag. Without hardened options the
  report stays Degraded and secure modes refuse it.
- `terminus-sandbox-macos` translates `SandboxProfile` into a deny-default
  Seatbelt program with per-rule `(subpath …)` allowances and launches all
  payloads under `/usr/bin/env -i` so ambient environment cannot reach them.
  Availability is proven functionally (running a trivial profile), not by
  flag probes.
- `terminus-sandbox-windows` intentionally has no AppContainer wiring (Win32
  FFI requires a dedicated unsafe ADR per SPEC §44.2) and reports
  Unsupported always; restrictive profiles route to container/microVM
  fallbacks.
- `terminus-sandbox-microvm` provides tier-3 selection (hypervisor detection,
  digest-pinned rootfs, generated machine config without NICs under Deny);
  experimental per ADR-0027, fail-closed when unconfigured.

**Tier policy and secure mode.** `RiskTier` (0–4, SPEC §19.1) defines
accumulating control floors;
`SandboxManager::select_secure(profile, tier)` admits only backends whose
enforcement report MEASURES those controls as Enforced, naming the gap for
every rejection. Degraded acceptance in secure modes is impossible.

**Effective-control probes.** `just platform-probes` runs canary payloads
through each backend's real wrapper (filesystem escape, network egress,
ambient-secret read) and writes
`docs/generated/platform-probes.json`. Unmeasurable never counts as
enforcement; release declarations derive from this artifact.

**Canary gate.** `just security` includes `secret_canary_e2e`: a credential
canary traverses mint → grant → trusted execution and must appear in no
grant token, receipt, or persisted kernel file.
| ArtifactService | Content-addressed ingest, streaming, GC | `terminus-artifacts` |
| AuthService | Kernel instance identity; short-lived capability tokens | `terminus-authz` |

The full protocol is in `proto/terminus/kernel/v1/kernel.proto` (Appendix D). The mini-service bootstrap uses JSON-over-HTTP; the canonical protocol is gRPC over UDS.

## Request validation order (SPEC §31.3)

Every RPC is validated in this order:

1. **Capability token** — verify against kernel instance identity.
2. **RequestContext** — request_id, idempotency_key, session/task/turn IDs, traceparent.
3. **EffectIntent** — user_intent_ref, task_contract_hash, trust/confidentiality labels, taint sources, policy_profile_id, expected_effect_class.
4. **Policy decision** — `terminus-policy` evaluates the effect against the active policy profile.
5. **Approval check** — if required, verify an approval record bound to the normalized action hash.
6. **Sandbox enforcement** — `terminus-sandbox` constructs/reuses a sandbox for the operation.
7. **Resource limits** — cgroup/Job Object limits (memory, CPU, PIDs, open files).
8. **Execute** — perform the effect through the appropriate leaf service.
9. **Audit** — record effect, decision, approval, settlement, evidence.
10. **Reconcile** — on unknown settlement, reconcile before retry.

## Capability tokens (SPEC §31.6)

The kernel issues short-lived capability tokens bound to:

- kernel instance identity;
- session/task/turn;
- effect class;
- resource identity;
- scope;
- expiry.

Tokens are validated on every RPC. Compromised tokens are revocable. The `terminus-authz` crate implements token issuance and validation.

## Sandbox backends (SPEC §13.4, §36.5–§36.8, ADR-0014, ADR-0027)

| Backend | Platform | Status | Use case |
|---|---|---|---|
| `terminus-sandbox-linux` (Bubblewrap) | Linux | ADOPTED | Default local trusted workspace |
| `terminus-sandbox-macos` | macOS | ADOPTED (Phase 4) | Deny-by-default Seatbelt profile generation (ADR-0035 §4) |
| `terminus-sandbox-windows` | Windows | Scaffolded | Windows client/control (honest degraded reporting) |
| `terminus-sandbox-container` | Linux | OPEN (ADR-0027) | Untrusted repos, evals, extensions |

The Linux backend (ADR-0014) provides: new user/PID/mount/network namespaces, no-new-privileges, seccomp, cgroup v2, symlink containment, process-tree ownership. Container/micro-VM backend selection is OPEN (ADR-0027).

Degraded-mode detection (SPEC §36.4, §26.3 #11): when the requested sandbox cannot be enforced, Terminus fails closed or requires explicit user selection of a named degraded profile.

## Command policy (SPEC §13.5, §36.9)

The command policy engine (`terminus-policy`) normalizes commands via a shell AST parser and evaluates them against versioned rule sets. The default rule set (`policies/command/default.yaml`) has 6 rules: allow-local-tests, allow-read-tools, prompt-git-push, deny-download-pipe-interpreter, deny-protected-path-write, deny-external-state-write-default.

Rules match on: program, args, shell dialect, cwd, env, secret capabilities. Decisions are `allow`, `deny`, or `prompt`. Denials include a safe explanation.

## Secret broker (SPEC §13.6, §36.13, ADR-0016)

- No ambient secrets (`secrets.direct_environment: deny`).
- Brokered capabilities: `secret://provider/capability/<id>` URIs.
- Short-lived, per-task scoped, TTL-bound.
- Injected into child process environment at `exec` time (after model issues command).
- Output redaction (`terminus-secrets/src/redact.rs`).
- Audit log: every secret use.

Default secrets policy: `policies/secrets/default.yaml` (brokered capabilities for github, gitlab, database, aws, providers with TTLs and redaction patterns).

## Network egress (SPEC §13.6, §36.12, ADR-0015)

- No direct sockets (`network.direct_sockets: deny`).
- Proxy required (`network.proxy_required: true`).
- Destination allowlist (`network.destinations: []` by default).
- Brokered DNS (`network.dns: brokered`).
- Private-address denial (RFC 1918, loopback, link-local).
- Rate limits.
- Fail-closed (proxy down → egress denied).

Implementation: `crates/terminus-egress`. Default network policy: `policies/network/default.yaml`.

## Patch transactions (SPEC §11.6, §34.7–§34.10, ADR-0013)

- Snapshot-anchored (WorkspaceBaseline with per-file hashes).
- Journaled (every transaction recorded before apply).
- Validation profiles (format-and-parse, parse-only, none).
- Commit modes (PREVIEW_ONLY, STAGE_ONLY, APPLY_TO_WORKTREE).
- Crash recovery (journal replay on restart).
- Transient-invalid isolated mode (multi-file transactions).
- Path leases (prevent concurrent conflicting edits).

Implementation: `crates/terminus-patch` + `crates/terminus-fs`.

## Process and job ownership (SPEC §11.7, §34.11, §34.12)

- Every subprocess is owned by a process-tree supervisor (`ManagedProcess`).
- Process-tree kill reaps forked children across process groups.
- Structured stdio streaming with bounded inline capture and CAS artifact spillover.
- Timeout and cancellation propagate cleanly without detached background tasks.
- Job state records and output artifacts persist across restarts for deterministic reconciliation (`JobReconciled` event).

Implementation: `crates/terminus-process` + `crates/terminus-jobs`.

## Extension runtime (SPEC §12.3, §35.4, ADR-0019)

- Out-of-process by default.
- WASI (Wasmtime) for sandboxed execution where appropriate.
- No lifecycle scripts.
- Explicit installation with lockfiles and signatures.
- Capability declaration enforced by kernel.

Implementation: `crates/terminus-extension-runtime`.

## Code intelligence (SPEC §11.8, §34.13)

- Tree-sitter symbols and structural search (`crates/terminus-code-intel/src/symbols.rs`, `inspect.rs`).
- LSP/DAP facade.
- Index freshness tracking.
- `inspect` operations: diagnostics, symbols, references, diff, test status.

## Audit, evidence, and reconciliation (SPEC §36.3, §27.3)

Every effect records:

- resource identity;
- requested scope;
- operation class;
- reversibility;
- idempotency class;
- data trust and confidentiality labels;
- user-intent linkage;
- policy decision;
- approval decision if required;
- settlement state (success | failure | unknown);
- evidence artifact.

Unknown settlement requires reconciliation before retry (SPEC §26.3 #9).

## Non-bypassability enforcement

The kernel is the only path to host effects. Architecture-boundary checks (SPEC §42.5) verify no direct process/filesystem/socket/secret access in TypeScript. The non-bypassability tests (SPEC §27.4, `docs/security/non-bypassability-tests.md`) attempt bypasses from every zone; a supported configuration denies or routes every attempt.

## Evaluation plan

- Kernel integration tests (SPEC §46.5): sandbox, paths, network, secrets, process-tree, PTY, job recovery, cgroup, journal recovery, Git worktree, extension/MCP isolation.
- Recovery/chaos tests (SPEC §46.9): fault injection at every durable boundary.
- Security tests (SPEC §46.10): per-PR, nightly, release tiers.
- Load/backpressure tests (SPEC §48.6 exit gate).

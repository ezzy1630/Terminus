# ADR-0035: Secret, connector and sandbox TCB

- **Status:** ADOPTED
- **Date:** 2026-08-22
- **Decision owner:** security owner + runtime architecture owner
- **Supersedes:** none
- **Related:** `Terminus — Research/roadmap.md` (Phase 4), SPEC §13.4, §13.6, §17–§19 (research SPEC), ADR-0027 (container/microVM selection), ADR-0034 (effect ledger), audit findings 4.6/4.7/4.8

## Context

Phase 3 made every mutation attributable through the Transactional Effect
Ledger and single-use authorization instances. Phase 4 closes the two remaining
trust gaps the audit identified:

1. **Raw secret exposure surface.** `SecretHandle::value()` and
   `as_env_pair()` are public APIs; any future caller could move raw secret
   bytes into process env or model context. The in-memory provider is the only
   bundled implementation. SPEC §3.4 requires raw secret material never enter
   model input/output, generic tool results, workflow state, ordinary
   artifact/log storage, or extension address space.
2. **Enforcement claims not yet true.** macOS accepts restrictive profiles in
   degraded mode when `sandbox-exec` exists even though Seatbelt profile
   generation is a stub; Windows accepts profiles in degraded mode without any
   AppContainer wiring; the container backend reports Degraded because it emits
   only `run --rm --init [--network=none]`. "Configured" must become
   "Enforced" only where measured controls prove it.

## Decision

### 1. Opaque connector grants replace raw secret handles

`terminus-secrets` gains `ConnectorGrant`: an HMAC-signed, short-lived,
single-purpose grant that carries **no secret material** — only a provider
handle reference, digest of the bound credential, and binding fields
(connector id, destination, operation class, task id, effect id, expiry, use
limit). `SecretHandle::value()` becomes `pub(crate)` and `as_env_pair()` is
removed from the public API; raw-value access is possible only inside the
crate (fixture/test providers) and inside trusted connector execution.

The `InMemoryProvider` is annotated fixture-only: production wiring MUST use a
provider that mints short-lived credentials (workload identity / OAuth / vault
dynamic secrets). `GrantIssuer` issues grants bound to a workload identity;
grants are consumed exactly once at the broker.

### 2. L7 connector broker (`terminus-connector`)

New crate implementing the trusted-execution side of SPEC §18.2:

- `ConnectorBroker::execute(grant, operation)` validates the grant binding
  against the exact operation (connector, destination host/port/scheme,
  method+path class), consumes the grant atomically, resolves the credential
  via a `CredentialSource` trait *inside* the trusted boundary, invokes the
  `TrustedConnector`, redacts sensitive response fields, records request/response
  hashes and a semantic receipt.
- The broker authorizes egress through the existing L4 `EgressProxy`
  (terminus-egress remains the lower layer; its DNS/IP/private-range controls
  apply to every connection the broker opens).
- General tools, models, and extensions receive typed receipts and handles —
  never credentials.
- Credential use is exact-operation bound: replayed grants, wrong destination,
  wrong method/path class, wrong task/effect binding, expired or revoked
  grants all fail closed with typed errors.

### 3. Hardened OCI profiles (container backend)

When a hardened profile is requested, `ContainerSandboxBackend` generates argv
that provably maps to enforcement features:

- read-only rootfs (`--read-only`), non-root user (`--user`),
  `--cap-drop ALL`, `--security-opt no-new-privileges`,
  `--tmpfs /tmp` (noexec,nosuid), memory/CPU/PID limits, explicit workspace
  bind-mount policy, `--network=none` for deny profiles.

The enforcement report derives each `Enforced` feature from the argv actually
emitted (flag→feature proof map); removing a flag from the generator removes it
from the report. Tests pin this correspondence.

### 4. Real macOS Seatbelt profile generation

`MacOsSandboxBackend` implements `SandboxProfile → Seatbelt .sb` translation:
deny-by-default with explicit `(allow file-write*/subpath WORKSPACE)`,
network rules per profile, process-exec restrictions. `spawn_wrapper` writes
the generated profile to a private temp file and returns a
`sandbox-exec -f profile.sb -- prog argv` wrapper. Profiles are accepted only
when `sandbox-exec` exists AND generation succeeds; degraded acceptance is
removed — unsupported requirements fail closed. The report claims `Enforced`
only for controls the generated profile actually constrains.

### 5. Windows: WSL2/container fallback, fail closed

Real AppContainer/Job Object wiring requires Win32 FFI (`unsafe`) under
SPEC §44.2 and cannot be conformance-tested on the current development hosts;
this ADR does not authorize that unsafe scope. Instead the Windows backend
reports `Unsupported` honestly and restrictive profiles on Windows MUST be
satisfied by the container or microVM fallback backends; secure modes fail
closed when no enforcing backend exists. This is the roadmap's sanctioned
"secure VM fallback" branch.

### 6. microVM backend selection (experimental)

New crate `terminus-sandbox-microvm` provides tier-3 selection per SPEC §19.1:
digest-pinned rootfs/kernel requirement, hypervisor binary detection
(Firecracker/cloud-hypervisor), fail-closed when absent. Experimental tier per
ADR-0027; production enablement still requires the ADR-0027 amendment evidence.

### 7. Sandbox tier policy and secure mode

`terminus-sandbox` gains risk tiers (Tier 0–4) and a secure-mode selector:
`select_for_tier(profile, tier)` refuses backends whose enforcement status or
feature set is below the tier's minimum. Secure mode rejects Degraded/Unsupported
backends for required features instead of accepting them.

### 8. Effective-control probes and generated platform matrix

Probe suite runs canary programs through each backend's spawn wrapper:

- filesystem escape probe (write outside workspace must fail),
- network egress probe (connect must fail under Deny),
- ambient-secret probe (env var must be absent).

Results are measured, not configured. `just platform-probes` runs the probes on
the current host and emits a machine-readable matrix consumed by the release
decision tooling; declarations derive from probe artifacts (SPEC §19.3).

### 9. Residue scanning and raw-secret canary gate

`ResidueScanner` scans captured output/artifact bytes for registered secret
material (literal + SHA-256 digest matching). An integration canary suite
(`secret_canary_e2e`) drives secret minting → grant issuance → connector
execution → job output capture and asserts the canary value appears in no tool
result envelope, log record, artifact, or ledger state. Wired into
`just security`.

## Alternatives Considered

- **Keep raw-value API private-by-convention:** rejected; convention failed
  audit review once already and the compiler can enforce this one.
- **Environment-variable injection via kernel-mediated spawn:** rejected as the
  production path; env survives process boundaries, leaks into child
  grandchildren, and cannot be operation-bound.
- **Implement AppContainer now:** rejected; requires narrowly scoped unsafe +
  Windows-only conformance runners; the fail-closed fallback satisfies the
  phase contract without weakening security claims.
- **TLS-terminating L7 proxy:** rejected for this phase; end-to-end TLS stays
  intact, the broker executes requests kernel-side with certificate validation
  delegated to the platform TLS stack. ADR-0044 later lands that HTTPS path
  with egress-approved DNS pinning.

## Consequences

- Raw secret material is unreachable outside the secrets crate and trusted
  connector execution; the type system enforces what the audit demanded.
- Every credentialed external operation resolves to principal/task/effect/
  authorization/expiry through grant consumption records.
- Platform support declarations become probe-derived; Degraded no longer
  silently passes secure-mode selection anywhere.
- Container/macOS backends move from honest-Degraded to proven-Enforced for
  the controls their generated argv/profiles actually implement.

## Security Impact

Directly closes audit blockers 6 ("Remove raw-secret access from general
runtime code"), 7 ("hardened OCI profiles"), and 8 ("reject degraded sandbox
profiles at policy level for secure modes").

## Evaluation Plan

- Grant binding/replay/expiry tests in `crates/terminus-secrets`.
- Connector broker fault/binding tests in `crates/terminus-connector`.
- Canary/exfiltration suite `crates/terminus-kernel/tests/secret_canary_e2e.rs`
  added to `just security`.
- Argv↔report proof-map tests in `crates/terminus-sandbox-container`.
- Seatbelt golden-profile and fail-closed tests in `crates/terminus-sandbox-macos`.
- Probe suite unit tests plus host-run recipe emitting the support matrix.
- Full validation via `just check`, `just check-all`.

## Rollback

Each slice is independently revertible. Reverting restores honest-Degraded
reporting and fixture-gated raw access; grants remain additive types.

# Terminus Repository Audit

## 1. Scope and evidence

Repository: `https://github.com/ezzy1630/Terminus`  
Branch: `codex/release-blocker-closure`  
HEAD: `64d385c7b9efedee96b229432937622aa1aba720`  
Existing specification: `SPEC.md`, version 1.0.0, research cut July 11, 2026, approximately 318 KB.

The audit reviewed:

- the complete repository tree;
- the full existing specification;
- README and security/release declarations;
- CI, nightly, Linux evidence and release workflows;
- Rust kernel, approval, authorization, process, job, secret, egress and sandbox paths;
- representative adapters;
- evaluation framework structure;
- root build/release recipes.

No local build or test run was performed in this environment. “Observed” below means visible in source or repository metadata, not runtime-proven.

## 2. Executive assessment

The repository is **not vaporware**. It contains a serious specification, broad architecture, substantive Rust and TypeScript modules, a meaningful evaluation package, release engineering, code generation, security tests and client scaffolding.

Its central problem is that several critical names and declarations describe the **intended contract**, while the implementation still provides a process-local or stub version:

- “durable” jobs are held in an in-memory map;
- approvals, revocations, nonces, secret providers and secret audit are process-local;
- the container backend reports broad enforcement not produced by its Docker arguments;
- macOS and Windows backends explicitly accept profiles in degraded stub mode;
- at least the Codex adapter is a placeholder that returns `completed` without invoking Codex;
- the active branch’s HEAD has no associated CI workflow run;
- release metadata can state an empty limitations list despite known degraded backends and accepted security findings.

This is fixable. The specification’s strongest ideas should be retained, but release truth and runtime semantics must be rebuilt before adding more surface area.

## 3. Maturity matrix

| Subsystem | Source maturity | Evidence maturity | Assessment |
|---|---:|---:|---|
| Existing `SPEC.md` | High | N/A | unusually comprehensive; now behind the 2026 frontier in durability, workflow compilation, trust separation and harness evolution |
| Repository organization | High | Medium | broad, coherent modules and boundary intent |
| Canonical protocols/schemas | Medium–High | Low–Medium | substantial codegen and protocol work; conformance not demonstrated at HEAD |
| Rust effect kernel | Medium–High | Low | real process, policy, fs, egress and sandbox code; full non-bypassability not proven |
| Approval system | Medium scaffold | Low | operation binding exists; storage and consumption semantics are not durable |
| Capability tokens | Medium–High primitive | Low | signed/scoped tokens exist; revocation/nonce state is local and empty scope means unlimited |
| Jobs/processes | Medium local runtime | Low | useful process supervision; “durable” job state is not durable |
| Secrets | Early scaffold | Low | raw values and environment-pair export remain possible; providers/revocation/audit are in-memory |
| Egress | Medium L4 proxy | Low–Medium | DNS/IP/host/port/scheme and byte controls; no L7 intent, method/path or credential confinement |
| Linux sandbox | Medium–High | Medium by design, no HEAD run | strongest platform path; needs current signed conformance evidence |
| macOS sandbox | Stub/degraded | Honest source declaration | profile generation not implemented |
| Windows sandbox | Stub/degraded | Honest source declaration | AppContainer/Job Object wiring not implemented |
| Container sandbox | Early wrapper | Overclaimed | Docker invocation does not justify all reported enforced features |
| Adapters | Scaffold | Low | representative Codex runner is a no-op completion stub |
| Evaluation framework | Medium–High | Low at HEAD | meaningful package and release recipes; active commit lacks run evidence |
| Clients | Broad source presence | Unknown | cannot infer production UX from file counts |
| Release engineering | High intent | Low current proof | SBOM/signing/evidence architecture is strong; branch/run and declaration gaps block trust |
| Evolution lab | Strong spec | Minimal proof | not yet a demonstrated trace-to-promotion loop |

## 4. Detailed findings

### 4.1 Branch and CI truth

The repository’s active/default branch is `codex/release-blocker-closure`, but the main CI workflow is configured for `main` and `dev`. The reviewed HEAD has no associated workflow runs or combined status evidence.

Consequences:

- README test counts are claims, not current release evidence;
- source changes may bypass the primary workflow;
- a release specification that treats missing infrastructure as failure is not being applied to the active branch.

**Required correction:** all protected branches and pull requests must run the same required checks; release metadata must embed the exact workflow run, artifacts, environment and commit.

### 4.2 Release workflow declarations

The release workflow includes valuable practices:

- `cargo deny`, `bun audit`, `pip-audit`;
- boundary and codegen checks;
- cross-platform artifacts;
- SBOMs, signatures and provenance;
- signed Linux enforcement evidence;
- four-owner approval variables.

But the machine-readable release decision is generated with:

- broad platform support;
- `known_limitations: []`;
- accepted risks `FIND-001` and `FIND-002`;
- an evaluation-report path that is not clearly produced in the shown release dependency graph.

A release decision must be **derived from evidence**, not written from hard-coded optimistic fields.

### 4.3 Approval store

Source: `crates/terminus-kernel/src/approvals.rs`

Positive:

- operation hash;
- expiry and use limits;
- resolution metadata;
- atomic process-local consume;
- tests for changed hashes, expiry, revocation and use count.

Critical gaps:

- records live in `Mutex<HashMap<...>>`;
- a restart loses approvals and consumption state;
- consumption searches for any matching operation hash rather than consuming a named authorization instance;
- scope is stored, but validity is primarily hash/time/count based;
- the operation hash covers program, arguments, cwd, environment digest and secret capabilities, but not a complete typed effect intent;
- `use_limit = 0` means unlimited, which is unsafe as a casual default;
- no prepared/dispatched/observed/committed relationship exists between authorization and effect.

**Disposition:** retain concepts; replace storage and lifecycle with durable authorization-instance consumption attached to the effect ledger.

### 4.4 Capability tokens

Source: `crates/terminus-authz/src/token.rs`

Positive:

- HMAC-signed claims;
- principal/session/task/workspace/kernel binding;
- operation classes;
- scope fields;
- optional action hash;
- expiry and audience checks;
- scope matching tests.

Critical gaps:

- revocation and nonce state are in-memory;
- the HMAC secret and rotation/distribution model are not a durable identity system;
- nonce comments allow repeated presentation of the same token during its lifetime;
- an empty maximum scope means unrestricted authority;
- `Admin` is a superuser operation class;
- there is no single-use or monotonic consumption binding to an effect instance;
- no distributed replay protection or epoch invalidation.

**Disposition:** evolve to short-lived, asymmetric or workload-identity-bound capabilities with explicit resource handles, effect IDs, epochs and durable consumption.

### 4.5 Job and process runtime

Sources:

- `crates/terminus-jobs/src/manager.rs`
- `crates/terminus-process/src/manager.rs`

Positive:

- process groups and tree kill on Unix;
- bounded output capture with artifact spill;
- timeouts;
- stdin and signal control;
- wrapper path for sandboxing;
- process leases;
- explicit job states and reconciliation APIs.

Critical gaps:

- jobs are an `Arc<Mutex<HashMap<...>>>`;
- process registry is process-local;
- “reconcile after a kernel restart” cannot work after a true restart because the job records vanish;
- a direct unsandboxed spawn path exists; safety depends on all callers routing correctly;
- process supervisor tasks are not a durable workflow;
- dropping a client receiver does not provide a persisted cancellation contract;
- exit and external-effect state are not transactional.

**Disposition:** keep the local process supervisor as a worker primitive; replace `JobManager` with a durable task/effect service.

### 4.6 Secrets

Source: `crates/terminus-secrets/src/broker.rs`

Positive:

- metadata separate from values;
- best-effort zeroing;
- revocation concept;
- audit concept;
- provider abstraction.

Critical gaps:

- the general API returns `SecretHandle::value()`;
- `as_env_pair` explicitly turns a secret into an environment value;
- providers, revocations and audit are process-local;
- the included production implementation is an in-memory test provider;
- destination restrictions are metadata, not enforced at use;
- a caller that can request a handle can inspect raw bytes;
- best-effort zeroing is not a guarantee against copies.

This does not meet the north-star rule “secrets never enter model or general runtime context.”

**Disposition:** replace raw-secret handles with brokered operations, L7 credential injection, workload identities and opaque one-purpose grants.

### 4.7 Egress

Sources:

- `crates/terminus-egress/src/broker.rs`
- `crates/terminus-egress/src/policy.rs`

Positive:

- private Unix socket;
- kernel-side DNS resolution;
- every returned IP checked;
- private/loopback/link-local denial;
- numeric connection opened by broker;
- host suffix, port, scheme and byte limits;
- lease-oriented lifetime.

Critical gaps:

- TLS is intentionally opaque;
- HTTP method, path, headers and body cannot be authorized;
- credentials cannot be safely bound to an exact API operation;
- the sandbox client declares the `scheme`;
- byte relaying is not semantic effect verification;
- no request/response content policy or DLP exists.

**Disposition:** preserve this as a lower-level transport broker, then add an L7 connector/effect broker for authenticated external systems.

### 4.8 Sandbox implementations

#### Linux

The Linux backend is the strongest path, with substantial source and an intended signed evidence workflow. It still requires current, commit-bound CI evidence and adversarial conformance before release claims.

#### macOS

Source explicitly states:

- Seatbelt profile generation is not implemented;
- the backend reports `Degraded`;
- restrictive profiles may be accepted when `sandbox-exec` is present even though generation is a stub.

Acceptance in degraded mode is dangerous unless the caller is guaranteed to reject degraded enforcement for the requested risk tier.

#### Windows

Source explicitly states:

- AppContainer and Job Object wiring are not implemented;
- capability mapping is a stub;
- restrictive profiles can be accepted in degraded mode.

The same fail-closed issue applies.

#### Container

Source: `crates/terminus-sandbox-container/src/lib.rs`

The generated Docker command includes approximately:

- `docker run --rm --init`;
- optional `--network=none`;
- digest-pinned image;
- command and args.

It does not visibly configure:

- a read-only root filesystem;
- workspace mount policy;
- user namespace/non-root user;
- capability drop;
- seccomp;
- `no-new-privileges`;
- process/memory/CPU limits;
- device denial;
- egress proxy wiring.

Yet the enforcement report marks filesystem isolation, process isolation, cgroup limits, mount namespace and PID namespace as enforced when configured. Docker provides some defaults, but the wrapper does not prove the claimed profile-specific properties.

**Disposition:** report only verified effective controls; generate hardened OCI specs and test the resulting runtime, not the configuration flag.

### 4.9 Adapters

Source: `adapters/codex/runner.ts`

The representative Codex adapter:

- declares a capability profile with `lastVerified: null`;
- responds to `run`;
- emits `started`;
- returns `status: completed`, an empty file/test/artifact set and “untrusted self-report”;
- does not launch or communicate with Codex.

This is useful protocol scaffolding but not an adapter implementation.

The repository must distinguish:

- **fixture adapter**;
- **contract stub**;
- **experimental integration**;
- **conformance-tested production adapter**.

A stub must never be discoverable as production-capable.

### 4.10 Evaluation

The Python evaluation package is substantial. It includes:

- baselines;
- CLI;
- cohort tasks;
- eval tiers;
- experiment manifests;
- graders;
- hidden-test guard;
- promotion gates;
- analysis and dashboards.

The root `justfile` has smoke, full, release and promotion-related commands. This is a major strength.

The gap is evidence integration:

- no HEAD workflow run;
- the main branch trigger mismatch;
- release dependency paths do not clearly prove all required evals ran;
- adapters can complete without real work, which can contaminate integration tests unless fixture-only classification is strict;
- benchmark claims in README must be generated from signed result artifacts.

## 5. Positive foundations to retain

1. Context compiler and manifests.
2. Artifact spill and content-addressed evidence.
3. Rust separation for effects.
4. Typed protocol/codegen intent.
5. Minimal harness control arm.
6. Evaluation package and promotion concepts.
7. Selective orchestration and isolated worktrees.
8. Policy/sandbox/approval conceptual separation.
9. Signed artifacts, SBOM and supply-chain intent.
10. Divergence-budget and strangler architecture.
11. Explicit degraded/unsupported reporting in macOS/Windows source.
12. Strong root task runner and release-gate ambition.

## 6. Critical release blockers

1. Run required CI on the actual protected branch and commit.
2. Generate support claims and limitations from current conformance evidence.
3. Replace process-local “durable” state.
4. Implement the transactional effect ledger and uncertainty semantics.
5. Bind every authorization instance to one effect lifecycle and durable consumption.
6. Remove raw-secret access from general runtime code; add L7 brokered credentials.
7. Correct container enforcement reporting and implement hardened OCI profiles.
8. Reject degraded sandbox profiles at policy level for secure modes.
9. Mark all adapter stubs as fixtures; implement real process/protocol adapters.
10. Make release evals a hard dependency with signed immutable artifacts.
11. Turn fuzzing from `|| true` evidence-only loops into meaningful gating tiers.
12. Eliminate hard-coded empty limitations and accepted-risk IDs from release output.
13. Add complete protocol conformance across clients and workers.
14. Prove no direct effect paths exist with static boundary scans and runtime probes.
15. Publish a system card for every release.

## 7. Keep / extend / replace / delete

| Current area | Decision | Reason |
|---|---|---|
| Existing product objective | Keep | correct ambition and verified-utility framing |
| Fork-assisted strangler | Keep, time-bound | fastest path; must not remain permanent architectural dependency |
| Context compiler | Extend | add object handles, trust separation and world-model queries |
| Minimal Bash mode | Keep permanently | control arm and recovery mode |
| Rust process/fs primitives | Keep | useful worker-level TCB components |
| Current approval/job stores | Replace | process-local, not durable |
| Capability token concepts | Extend/replace implementation | strong claims model, weak distributed lifecycle |
| Secret handle API | Replace | exposes raw values |
| L4 egress broker | Keep as lower layer | useful but insufficient |
| macOS/Windows stub acceptance | Delete | degraded support cannot masquerade as safe execution |
| Container “enforced” report | Replace | must be evidence-derived |
| Adapter protocol | Keep | good boundary |
| Adapter no-op runners | Fixture-only or delete | not production adapters |
| Eval package | Extend and integrate | strong base; make release-critical |
| Hard-coded release decisions | Delete | derive from evidence |
| Generic dashboard framing | Replace | operator cockpit and organizational map |
| Default root coordinator | Do not add | use federated departmental operators and deterministic capability directory |

## 8. Immediate conclusion

Do not add another large feature to the current branch before Phase 0 of `roadmap.md`. The highest-leverage work is to establish a truthful baseline, fix CI, classify stubs, and build the durable effect/task substrate. Otherwise every advanced feature will rest on state and security semantics that cannot survive the failures a “best harness” must handle.

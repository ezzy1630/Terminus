# Terminus research execution ledger

Date: 2026-08-23
Research source: `Terminus — Research/`
Acceptance surface: this checkout, its fresh desktop renderer, and evidence
bound to the eventual release commit

`Terminus — Research/manifest.json` preserves the historical research-cut
identity and also hashes the dated implementation companion. Its original
branch, commit, and no-execution scope describe the 2026-08-21 source snapshot;
the separate reconciliation fields describe the August 23 companion. This
ledger records current-checkout implementation and gates.

## Status rules

This ledger separates implementation from acceptance:

- **local slice** means source and focused tests exist in this checkout;
- **locally verified** means the relevant local command passed during the
  integration run;
- **exit gate passed** requires every roadmap exit criterion and its required
  current, immutable evidence;
- **blocked** means the gate needs an environment, signature, independent
  actor, measured workload, user study, or adoption result that this checkout
  cannot manufacture.

No source declaration, fixture, generated schema, or green unit suite is an
external gate. Experimental implementation may continue past an unpassed gate,
but it remains experimental and cannot become the default on that basis.

## Research-package audit

The original documents in `Terminus — Research/` remain historical inputs, not
a living status report. `implementation-reconciliation.md` is the dated
companion for the current candidate. On 2026-08-23, all ten content-file
SHA-256 hashes in the manifest matched the files in this checkout. The original
branch name, reviewed commit, competitor assessments, source audit, and
statement that tests were not run remain facts about the 2026-08-21 research
cut. They must not be read as current-checkout implementation or verification
claims. `SPEC.md` in that package remains normative and was not rewritten
during reconciliation.

## Phase reconciliation

| Research phase | Local implementation state | Exit-gate state | Missing acceptance evidence |
|---|---|---|---|
| 0 — Truth, reproducibility, freeze | Maturity registry, system-card/release tooling, fail-closed eval exit command, standalone check, clean-source release identity gate, and this ledger exist. Optimistic release checkboxes were reset. | **Blocked** | Clean exact-release commit, signed CI evidence, dedicated Linux enforcement, live pinned baseline runs, multi-seed variance, and real owner signatures. |
| 1 — ARP v2 and canonical domain | Existing local vertical slice in domain, runtime protocol, public API/client, compatibility fixtures, and generated schemas. A live deterministic E2E verifies CLI/desktop parity over the same ARP v2 task and effect ledger. | **Unverified** | Full integrated current/previous compatibility evidence and independent client/runtime evidence bound to the clean candidate commit. |
| 2 — Durable task substrate | Existing local persistence, artifact, lifecycle, recovery, and export vertical slices. A live local drill derives canonical checkpoint content on the server, verifies its bytes/hash/schema across restart, then recovers and resumes the original task through the production loader. A kernel gRPC test proves the checkpoint owner link is retained by GC. Caller-authored checkpoint state and unsigned import fail closed under ADR-0042. Prepared-admission recovery and startup owner-link reconciliation now have local coverage. | **Unverified** | Trusted signed-import staging and atomic admission, authoritative failure-injected owner-link recovery across every authoritative store, clean candidate-bound crash/interrupt/export evidence, supported-platform migration/recovery drills, and external release evidence. |
| 3 — Transactional effects and authority | Existing kernel protocol, effect ledger, authorization, reconciliation, and kernel-client slices. | **Blocked** | Complete first-party bypass fixture inventory, supported-Linux adversarial evidence, and signed non-bypassability result. |
| 4 — Secret, connector, and sandbox TCB | Existing broker, connector, sandbox, policy, protected Git, and effective-control probes. | **Blocked** | Dedicated supported-Linux security suite, production TLS connector transport, and platform-specific support evidence; native Windows enforcement is absent. |
| 5 — Context and State OS | Existing Context IR/compiler, manifests, checkpoints, retrieval, memory, and explanation paths. | **Blocked** | Held-out long-horizon comparison proving lower context/cost without requirement loss; memory remains disabled by default. |
| 6 — ACI, editing, and verification | Existing bounded tools, transactional patches, code intelligence, verification DAG, claim/evidence admission, and completion path. | **Blocked** | Fixed-model/fixed-budget cohort evidence, edit-dialect comparison, and current release-scale recovery evidence. |
| 7 — Workflow and skill compiler | Existing typed Workflow IR, compiler, static validation, deterministic controller, and standard-workflow local slice. | **Unverified** | Current integrated execution evidence plus representative workflow outcome and safety comparisons. |
| 8 — Model profiles, routing, and orchestration | Canonical routing uses provider-neutral model/profile references; provider-owned catalogs bind those references to adapter/rendering details. Deterministic routing, posteriors, selective delegation, reviewer, workspace, and stagnation mechanisms exist locally. | **Blocked** | Live-provider conformance and preregistered fixed-model routing/orchestration benefit without cost, latency, safety, or privacy regression. |
| 9 — Unified clients and operator cockpit | Authenticated CLI/TUI/ACP/public-client surfaces and an Electron desktop cockpit local slice exist. The desktop uses decoded resource states with explicit loading, empty, stale, error, and unavailable handling instead of success-shaped fixtures. The desktop suite passes 337 tests with 11 environment skips. An unsigned local package passes identity, runtime-inventory, startup, renderer-CSP, authenticated-request, and public-health checks; its blank initial surface does not open an SSE stream without a selected task, so the launch probe is not a pass record. | **Unverified** | Populated control-plane continuity/reconnect coverage, measured keyboard/accessibility behavior, mobile/web parity, sub-100 ms interaction measurement, and user-study evidence. |
| 10 — Computer use and general agency | Provider-neutral observation fusion, semantic target verification, pool leases, takeover, data-flow, connector/profile, and ambiguous-submit coordinators exist as local pure contracts. The public boundary does not make browser, desktop, clipboard, DLP, or settlement effects authoritative without trusted backend receipts. | **Blocked** | Governed browser/desktop effects through the real kernel, trusted observation/DLP/settlement receipt verification, hostile-fixture and recovery coverage, evidence artifacts, and fixed-budget computer-use benchmarks. |
| 11 — Evolution Lab | ADR-0040 and sealed offline contracts cover trace attribution, hidden partitions, causal ablations, ordered receipts, signed promotion binding, canary rollback, Pareto archive, repair memory, and model/harness factorials. | **Blocked** | A candidate mined from a real failure, real held-out transfer, security/chaos execution, real canary improvement, and observed automatic rollback. |
| 12 — Ecosystem and dominance | Standalone runtime ownership is adopted; inherited OpenCode runtime/build code and fork tooling are retired. Evidence-derived contiguous L0–L6 assessment exists offline. Existing registry/extension/adapter/remote components remain experimental or fixture-tier as recorded in `maturity.yaml`. | **Blocked** | Locked competitor comparison, independent reproduction, meaningful adoption, signed marketplace/third-party conformance evidence, and a release with no critical security or durability exception. |

## Phase 10 public trust boundary

The local coordinator contracts are intentionally more capable than the public
control-plane integration. At the public boundary in this working tree:

- UI observations are referenced by a trusted adapter receipt; caller-authored
  screenshot, DOM, and accessibility payloads are not accepted. Without a
  receipt verifier/store, observation admission, reads, target verification,
  action dispatch, takeover, and settlement reconciliation return an explicit
  unavailable error.
- UI evidence is referenced by an immutable trusted receipt and is not admitted
  without a configured computer-use receipt verifier.
- data-flow evaluation accepts opaque resource handles and immutable DLP and
  destination-evidence references. The TypeScript control plane does not read a
  caller-supplied clipboard/file sample or dereference the handle; it returns an
  explicit unavailable error until a kernel DLP verifier is configured.
- pool leases, download quarantine, connectors, and intervention application do
  not synthesize execution when their governed backends are absent.

These fail-closed routes are boundary evidence, not evidence that computer use
works. Phase 10 remains blocked on trusted adapters and real kernel-mediated
effects.

## Consequences

The local research implementation can be completed without counterfeiting the
research program's empirical results. The following phrases are prohibited
until their gates have current evidence:

- “production-grade” for an experimental component;
- “non-bypassable” without the complete supported-platform adversarial suite;
- “Phase 11 complete” without a real held-out promotion and canary;
- “L6” or “dominance proven” without locked comparisons and independent
  reproduction;
- “stable release ready” without signed candidate-bound release evidence.

OpenCode remains valid as historical research and an external comparison. It is
not a first-party runtime, build dependency, compatibility layer, or source of
canonical types.

## Current local UI evidence

A historical exact unsigned arm64 packaged process was inspected in light and
dark appearance. It showed the truthful offline shell, Mission Board
unavailable state, lazy Org Map unavailable state, and working sidebar
hide/restore control. The current unsigned package was rebuilt and exercised
for runtime identity, startup, renderer CSP, authenticated requests, and
public health, but its launch probe did not observe an SSE stream because no
task was selected. This is local interaction evidence only; it does not
substitute for a populated live-provider run, an accessibility study, or a
signed release artifact.

The corresponding working-tree bundle measurement is recorded in
`apps/desktop/docs/ui-performance.md`: the main renderer chunk is 356.55 kB raw
/ 107.11 kB gzip, down from 555.19 kB raw / 159.72 kB gzip before the current
chunk boundaries. The complete initial renderer graph, including preloads and
CSS, is 743.80 kB raw / 214.43 kB gzip; Mission Board remains lazy at 25.07 kB
raw / 7.34 kB gzip, and the Command Palette is lazy at 6.73 kB raw / 2.91 kB
gzip. Vite emits neither an oversized-chunk warning nor a circular-chunk
warning. Signing, populated live-control-plane behavior, and interaction
latency remain separate gates.

The deterministic live E2E also passes task creation, server-derived checkpoint
artifact ingestion, canonical byte/hash/schema verification across control-plane
restart, recovery, resume of the original task through the production loader,
SSE client parity, and the trusted-receipt effect
boundary including denial and cancellation. A focused kernel gRPC test verifies
the durable link and GC retention contract; focused workspace-registration and
effect-isolation tests prove distinct-root registration and cross-root denial.
The E2E itself uses one configured resolver root and does not substitute for
supported-platform multi-root evidence. `just check-all` passes on the current
candidate. The strict release evaluator still rejects fixture-tier evaluation
as stable release evidence, fallback SBOM generation is unsigned, and owner
approvals and hosted Linux evidence are absent. These local results therefore
cannot be promoted into a release decision.

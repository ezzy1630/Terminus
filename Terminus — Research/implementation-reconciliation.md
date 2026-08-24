# Implementation Reconciliation — August 23, 2026

This is the current implementation companion to the August 21 research cut.
The original audit, scorecard, roadmap, and source analysis remain point-in-time
documents. This file does not rewrite their historical observations. It maps
their recommendations to the current Terminus candidate and separates source
implementation from evidence still required for a stable product claim.

**Candidate branch:** `codex/terminus-standalone-harness`
**Base revision:** `299e7517e4836a7ecf11f4925385f013704a1026`
**Candidate identity:** generated contracts are committed in `2080b0d`; the
standalone-retirement, artifact-owner, Phase 9/10, desktop, CI/release, and
audit slices are separated into logical commits on this branch. The latest
implementation commit is `dc5a23f`, following the Cubic fixes in `ab9a5ac`,
`16472f5`, `030f527`, `defc129`, `30068f6`, and `5cede5c`. Hosted run
`32714614661` exercised the exact pushed candidate at `9a678ba`. The candidate
was merged into `main` at `885e426`; the final evidence-doc follow-up is
`ef23012`; dependency cleanup is recorded in `2b15e33`, and final main run
`32720031136` is green on that head. All 24 addressed Cubic review threads are
resolved.
**Evidence rule:** implemented source, passing local checks, packaged-surface
inspection, and release evidence are distinct states.

## Current outcome

Terminus now has one architectural owner. First-party applications use
Terminus-owned ARP, public API, client, provider, orchestration, context, and
kernel contracts. The OpenCode bridge, pinned source metadata, overlays,
divergence tooling, upstream parity jobs, and inherited renderer effect paths
have been removed. Historical OpenCode references remain only where it is a
competitor or a recorded bootstrap decision. ADR-0039 and
`just standalone-check` define and mechanically enforce this boundary.

The desktop is a standalone provider-neutral operator client. It does not ship
a PTY, embedded terminal, local screen-capture path, provider secret path, or
external harness runtime. It exposes typed task, approval, review, evidence,
organization, effect, fleet, and causal-replay state from the Terminus control
plane and fails visibly when that authority is unavailable.

This is a substantial implementation slice, not proof that every north-star
gate has passed. `maturity.yaml` remains authoritative: no component is
`production` until exact-candidate conformance and signed evidence exist.
The dependency graph is refreshed in `ee6fef8` and the root asar importer is
recorded in `46f8ea3`; `bun audit --production` reports no vulnerabilities on
the committed candidate.

## Twelve-leap reconciliation

| Research leap | Current implementation | Evidence still required |
|---|---|---|
| Durable runtime | Persistent domain/control-plane repositories, restart contracts, resumable event cursors, bounded renderer projections, and a versioned multi-step desktop mutation journal exist. A deterministic live-kernel/control-plane drill passes create, checkpoint, restart, recovery, and resume locally. | Full stream/interrupt/export drills against a clean exact candidate; durable job and coordinator recovery beyond process-local state. |
| Semantic effect transactions | The effect ledger/state model, approval-binding contract, uncertain outcomes, idempotency, reconciliation, and operator effect surfaces are represented. | End-to-end settlement and recovery through real kernel, connector, browser, and desktop backends under crash and replay. |
| Trust-separated cognition | Kernel ownership, trusted-state admission, taint-bearing approval data, fail-closed provider state, and isolated capability contracts exist. | Current adversarial suite evidence across every supported execution profile and an approved security assessment. |
| Workflow and skill compiler | Typed workflow IR, validation, deterministic controller, owner-test classification, and focused tests exist. | Model-in-loop comparison demonstrating the Phase 7 outcome gate on pinned cohorts. |
| Object-capability data plane | Scoped capability, secret grant, artifact, source-version, and effect-reference contracts exist across the public and kernel boundaries. | Complete capability-flow conformance, revocation/restart evidence, and removal or isolation of remaining experimental/stub extension paths. |
| Proof-carrying completion | Verification DAG, claim/evidence contracts, completion records, artifact views, and independent-review orchestration exist. | Exact environment-backed completion trials showing false-completion prevention on held-out tasks. |
| Capability-maximal model neutrality | Canonical model profiles, deterministic stage routing, provider-owned renderers, continuation metadata, and provider-neutral public contracts exist. | Live OpenAI, Anthropic, Google, and local-provider golden/conformance evidence plus quality/cost comparisons. |
| Expected-value orchestration | Selective scheduling, scoped agents, clean review, budgets, loop detection, and Phase 8 tests exist. | One-agent versus scout/writer/reviewer ablations on separable and non-separable cohorts. |
| Operator cockpit | The desktop ships typed cockpit destinations, attention and intervention flows, approvals, evidence review, docked navigation, keyboard access, persistent drafts, and explicit loading/empty/stale/error states. | Populated live-control-plane usability runs, VoiceOver testing, latency traces, and approval-fatigue measurement. |
| Governed computer use | Typed Phase 10 resources, lease/receipt boundaries, DLP-sensitive contracts, and non-capturing desktop placeholders exist and fail closed. | Governed browser/desktop executors, policy-bound pools, receipt verification, takeover/recovery drills, and comparative evaluation. |
| Sealed evolution lab | Evaluation schemas, held-out guard contracts, causal/counterfactual structures, dashboards, canary and promotion mechanisms exist. | Real sealed runs, trusted signatures, canary rollback evidence, and an approved promotion decision. |
| Evidence-backed product truth | Machine-readable maturity, release gates, standalone checks, package inspection, explicit offline UI, generated evidence mechanisms, and a mandatory clean-source identity check exist. | Clean committed candidate, signed/notarized artifact, signed SBOM/provenance, real owner approvals, release-tier evaluation, and published evidence tied to that commit. |

## Standalone desktop acceptance surface

The earlier exact packaged arm64 inspection remains historical evidence. The
current candidate has also been exercised from source and through an unsigned
local directory package:

- Electron main and preload code compile from Terminus source; the renderer is
  fully bundled and runtime `dependencies` are empty.
- `app.asar` contains only compiled `dist`, `dist-electron`, and package
  metadata. It contains no workspace sources, tests, runtime `node_modules`,
  OpenCode bridge, `node-pty`, terminal drawer, screen-capture API, or unpacked
  native payload.
- Electron Asar integrity metadata matches the generated archive.
- The historical exact packaged renderer opened from the ASAR, showed the real
  offline control-plane state, opened Mission Board and Org Map through their
  lazy routes, preserved explicit unavailable states, switched light/dark
  appearance, and hid and restored the docked sidebar.
- The current desktop suite passes 337 tests; 11 explicitly skipped tests require
  backend surfaces not present in the isolated renderer test environment.
- The deterministic E2E boots the live kernel and control plane, creates and
  checkpoints a task from server-derived state, verifies its canonical artifact
  bytes, SHA-256 metadata, and strict schema, restarts and re-verifies the same
  artifact, then recovers and resumes the original checkpointed task through
  the production loader. It verifies SSE parity between CLI and
  desktop clients, and confirms that advancement—including denial and
  cancellation—fails closed without trusted receipts. A focused kernel gRPC
  test proves the required owner link is stored and excluded from GC.
- Production chunk boundaries reduce the main renderer chunk from 555.19 kB
  to 356.55 kB raw while keeping destination code lazy. The exact initial
  renderer graph, including preloads and CSS, is 743.80 kB raw / 214.43 kB
  gzip; Mission Board remains a 25.07 kB raw lazy chunk and the Command
  Palette is a 6.73 kB raw lazy chunk.

The current unsigned package passed identity, runtime-inventory, kernel/control
startup, renderer-CSP, authenticated-request, and public-health checks. Its
launch probe did not observe an SSE stream because the blank initial surface
had no selected task; the probe therefore did not produce a pass evidence
record. Apple signing, notarization, stapling, and Gatekeeper assessment are
intentionally out of scope for this candidate, per the operator decision.

## Current validation boundary

The local verification matrix is green for `bun audit --production`,
`just check-all` (463 TypeScript tests, 229 Python tests, and the Rust
workspace/unit/integration suites), `just e2e`,
`just fault-injection`, `just fuzz-smoke`, `just release-drills`,
`just eval-smoke`, `just eval-full`, `just eval-release`, `just canary`, and a
60-second soak after the Cubic fixes. `just sbom-verify` passed with the
repository's fallback SPDX generator because `syft` is not installed. Hosted
run `32714614661` passed the exact pushed candidate across the supported Linux,
macOS, and Windows jobs, security, integration, public-path, M12 evidence,
standalone, architecture, protobuf, and codegen checks; every running job
executed `actions/checkout`. Eval smoke was skipped because this pull request
did not carry the `agent-behavior` label, as required by the workflow condition.
The strict
`just release-check` still rejects fixture-tier evaluation as stable release
evidence, and the full 24-hour soak and signed provenance remain unverified.

## Remaining program gates

The following are deliberate blockers, not hidden completion claims:

1. **Exact-candidate matrix — hosted slice passed; program gate open.** The
   security, chaos, property/fuzz, migration/release-drill, fixture-eval, and
   short-soak commands pass locally. Hosted run `32714614661` is green for the
   exact pushed candidate; the required 24-hour soak remains.
2. **Live provider — blocked by credential state.** The anonymous OpenCode Zen
   endpoint answered a minimal `nemotron-3.5-lightning-free` request, but the
   kernel-mediated provider path requires a real `secret://opencode/zen`
   credential and the keyring has none. No fake credential was installed, so
   the end-to-end provider gate remains unclaimed.
3. **Stubs — fail-closed retention verified.** `maturity.yaml` now describes
   unsupported sandbox, extension, and adapter paths accurately. Runtime stubs
   return unavailable/blocked outcomes and do not emit completed success; the
   declaration-only adapters remain explicitly `stub` and are not promoted.
4. **Multi-root isolation — local slice passed; program gate open.** The
   workspace-registration and effect-isolation Rust tests exercise distinct
   roots and cross-root denial. Cross-platform exact-candidate evidence is
   still part of gate 1.
5. **Artifact-link reconciliation — local slice passed; program gate open.**
   The owner-bound `Link` RPC, immutable checkpoint binding, startup scan,
   orphan grace/quarantine, rebind, and prepared-admission recovery are covered
   by focused Rust/TypeScript tests and the deterministic E2E. Failure-injected
   production-backend evidence is still required.
6. **Held-out evidence — unverified.** `eval-smoke`, `eval-full`, and
   `eval-release` are fixture-tier results only. The live-provider and held-out
   cohort evidence for routing, orchestration, memory, computer use, and
   harness-superiority claims remains outstanding.
7. **Distribution/approval gate — intentionally waived in part.** The local
   unsigned package was exercised, and fallback SBOM generation passed. Apple
   signing/notarization is intentionally skipped; signed provenance, owner
   approvals, and release-commit-bound evidence remain absent.

Until those gates pass, Terminus is an experimental standalone harness with a
working operator client and extensive contracts—not a stable release and not
an objectively proven “best harness.”

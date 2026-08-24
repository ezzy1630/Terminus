# ADR-0038: Unified clients, attention coordinator, structured interventions, and operator cockpit

- **Status:** ADOPTED
- **Date:** 2026-08-23
- **Decision owner:** runtime architecture owner + clients owner + UX/operator cockpit owner
- **Supersedes:** none
- **Related:** `Terminus — Research/roadmap.md` (Phase 9), SPEC §1, §4 (Organization & Federation), §9 (Clients & Interfaces), §16 (Operator Cockpit & UI), §29 (Human Interaction & Approvals), §32 (Client Architecture & Protocols), §33 (Observability, Tracing & Replay), §44 (Mobile & Fleet Supervision), ADR-0043

> ADR-0043 supersedes section 5's peer-view desktop navigation and refines how
> v2-only records enter an interactive client. The task identity, attention,
> intervention, replay, and underlying cockpit capability decisions remain in
> force.

## Context

Operating autonomous coding agents at production scale introduces three critical interaction challenges:
1. **Surface Divergence and Inconsistent Session Identity:** Clients (CLI, TUI, Desktop, Web/Fleet, Mobile, IDE) frequently diverge in protocol, state machine representations, and authentication models, risking dual-source discrepancies, lost session context, and inconsistent authorization state.
2. **Human Question Fatigue and Trivial Inquiries:** Agents that interrupt operators for obvious, derivable, or immaterial decisions cause cognitive exhaustion, leading operators to auto-approve risky operations.
3. **Black-Box Execution and Lack of Causal Understanding:** When an autonomous task fails, operators lack the tools to inspect what context was omitted, trace step-by-step model decisions against exact input manifests, or test counterfactual interventions.

This decision defines the Phase 9 architecture; implementation and roadmap-exit
evidence are tracked separately:
- **Unified Client Surfaces over ARP v2:** CLI, TUI, Desktop Cockpit, Mobile Supervision, and IDE (via Agent Client Protocol) use one Task/Attempt identity and resumable event contract.
- **Attention Coordinator & Materiality Assessment:** Interruptions are filtered through 7 strict materiality triggers (`interpretation_divergence`, `authority_expansion`, `irreversible_effect`, `external_effect`, `missing_grant`, `human_taste`, `confidence_collapse`). All material questions present an explicit option-consequence matrix.
- **14-Verb Structured Intervention Suite:** Operators have first-class, audited control via 14 canonical verbs (`focus`, `ignore`, `elaborate`, `change_constraint`, `edit_plan`, `approve_exact_effect`, `deny_narrow`, `pause`, `resume`, `takeover`, `fork`, `rewind`, `terminate`, `request_independent_review`).
- **Causal Replay & Counterfactual Engine:** Deterministic replay of non-model steps, pinned-input model re-execution, context omission diagnostics, and counterfactual variation experiments.
- **10-View Desktop Operator Cockpit:** Inspection and control suite (Organization Map, Department Rooms, Mission Ledger, Workflow Graph, World State, Effect Queue, Claim Evidence Graph, Artifact & Diff Inspector, Fleet & Budget Monitor, Causal Replay).

## Decision

### 1. Unified Client Architecture & ACP Bridge (SPEC §9, §32)

All client surfaces MUST interact with the Terminus Operating System through the canonical `/v2/*` HTTP and SSE API:
- **CLI (`apps/cli`):** Scriptable, task-first automation surface for CI/CD and terminal workflows.
- **TUI (`apps/tui`):** Terminal-native dashboard with live SSE streaming, approval prompts, and intervention commands.
- **Desktop Cockpit (`apps/desktop`):** Keyboard-first operator interface with 10 integrated views and subsystem modals. Sub-100 ms interaction latency is an acceptance target that requires measurement; it is not inferred from source.
- **IDE ACP Bridge (`apps/ide-acp`):** Agent Client Protocol implementation synchronizing editor selections, active files, open tabs, diagnostic reports, and inline approvals without privilege escalation.
- **Mobile Supervision:** Gateway enabling remote low-bandwidth session management and quick-action responses (`pause`, `resume`, `approve_effect`, `terminate`, `request_review`).

#### Task identity and projections

`Task` is one aggregate with one durable ID. ARP v1 and ARP v2 are protocol
projections of that aggregate; they are not separately identified tasks and
MUST NOT be joined through caller-supplied or best-effort mapping rows. A task
created with v1 session/thread context receives a v2 projection under the same
ID. A v2-only task remains explicitly v2-only until real session/thread context
is supplied; compatibility code may not invent placeholder session or thread
IDs. Startup recovery repairs a missing v2 projection from authoritative v1
state before the public listener accepts requests.

Aggregate event sequence numbers share one durable allocator across protocol
projections. A v1 event and a v2 snapshot for the same Task therefore advance
one sequence domain rather than racing independent counters.

The canonical v2 scope includes an optional structured `pathScope` projection
for v1 read paths, write paths, and external-system allowlists. A v2 contract
associated with v1 session/thread context is retained verbatim with its v1
contract version. V1-origin contracts derive only the authority they actually
represent: read paths permit local reads, write paths permit local writes, and
neither grants process-spawn or external-effect authority implicitly. Missing
scope information projects to no authority; compatibility must not widen it.

### 2. Attention Coordinator & Materiality Triggers (SPEC §29.3, §16.2)

The system MUST NOT prompt the human operator unless a question satisfies at least one of the 7 verified materiality criteria:
1. `interpretation_divergence`: Mutually incompatible interpretations of task requirements.
2. `authority_expansion`: An operation requires capabilities outside the task's current authority ceiling.
3. `irreversible_effect`: Mutation cannot be undone or compensated by kernel rollback.
4. `external_effect`: Mutation communicates with external networks/APIs without prior authorization.
5. `missing_grant`: Required OAuth/secret credential is absent.
6. `human_taste`: Aesthetic, visual, or editorial judgment is the final acceptance oracle.
7. `confidence_collapse`: Model posterior reliability drops below the required risk threshold.

Immaterial or mechanically derivable questions are rejected and resolved automatically from codebase context. Every material question MUST provide an explicit option-to-consequence matrix.

### 3. Structured Intervention Suite (SPEC §16.3)

Operators interact with running tasks via 14 structured intervention verbs with typed payloads, audit logging, and state machine transition validation:
- `focus`: Narrows attention to a specific subsystem or file.
- `ignore`: Bypasses non-blocking diagnostics or paths.
- `elaborate`: Injects instructions or requirement clarifications.
- `change_constraint`: Adjusts cost caps, timeout, or security policies.
- `edit_plan`: Modifies workflow DAG nodes or guarded edges.
- `approve_exact_effect`: Issues a single-use authorization token for an exact effect ID.
- `deny_narrow`: Denies an effect and tightens the authority ceiling.
- `pause` / `resume`: Halts and restarts autonomous progress.
- `takeover`: Transfers execution control to the human operator.
- `fork`: Creates an independent branch/attempt from current state.
- `rewind`: Rolls back workspace mutations to a previous checkpoint.
- `terminate`: Aborts task execution with documented rationale.
- `request_independent_review`: Triggers a detached clean-context reviewer.

### 4. Causal Replay & Omission Diagnostics (SPEC §33, §19)

Execution history is recorded as a DAG of `CausalStep` records containing:
- Exact input manifest hashes and model output hashes.
- Context omission diagnostics computing the causal relevance score ($0.0 \dots 1.0$) of omitted blocks.
- Counterfactual simulation capability predicting outcome deltas ($\Delta \text{Success}$, $\Delta \text{Cost}$, $\Delta \text{Latency}$) under alternative model profiles or interventions.

### 5. 10-View Operator Cockpit (SPEC §16.1)

The desktop application provides 10 dedicated views accessible via sidebar and command palette shortcuts:
1. `OrganizationMapView`: Departmental topology and capability directory.
2. `DepartmentRoomsView`: Active agent rooms, workers, specialists, reviewers, and supervisors.
3. `MissionLedgerView`: Proof-carrying contracts, claims, and authority bounds.
4. `WorkflowGraphView`: Interactive Workflow IR visualization and node execution states.
5. `WorldStateView`: Resource handles, environment hashes, and contradiction monitoring.
6. `EffectQueueView`: 17-state transactional effect ledger.
7. `ClaimEvidenceGraphView`: Immutable verification receipts bound to acceptance claims.
8. `ArtifactDiffInspectorView`: Multi-file semantic diffs with hash-anchored patches.
9. `FleetBudgetView`: Token accounting classes and microVM lease allocation.
10. `CausalReplayView`: Step scrubber and counterfactual experiment launcher.

## Consequences

### Positive
- One canonical contract can align CLI, TUI, Desktop, Web/Fleet, Mobile, and IDE surfaces.
- Materiality filtering can reduce question fatigue without hiding consequential choices.
- Causal records make exact inputs, omissions, and interventions inspectable when the underlying evidence exists.
- Typed interventions replace ambiguous free-form control messages.

### Neutral
- Public API surface expands to support organizational topology, attention assessments, interventions, and causal traces.
- Client applications depend on standardized ARP v2 schema registry.

### Negative

- Ten peer views create navigation and information-density pressure. The client
  must use progressive disclosure, stable task identity, and semantic resource
  states rather than fabricated summaries.
- Mobile, desktop, terminal, and IDE parity increases compatibility and
  reconnect test cost.
- Counterfactual predictions are hypotheses, not evidence of what would have
  happened; the UI must label them accordingly.

## Alternatives

- **Separate client-specific state models.** Rejected because approval, task,
  and evidence identity would drift across surfaces.
- **A single all-purpose dashboard.** Rejected because dense unrelated state
  harms scanability and keyboard navigation.
- **Free-form intervention chat only.** Rejected because authority changes and
  exact effects require typed, auditable intent.

## Security and privacy impact

Clients are presentation boundaries, not effect authorities. Exact-effect
approval remains bound to the kernel authorization record. Counterfactual and
causal views may expose sensitive task context, so API responses retain trust,
scope, and redaction metadata and must not synthesize missing evidence.

## Verification and evaluation

- Decoder tests cover malformed, loading, empty, unavailable, and valid
  resource states without success-shaped fallback data.
- Client tests cover task continuity, resumable cursors, intervention proposal
  versus application, confirmation for consequential verbs, focus management,
  Escape dismissal, and keyboard navigation.
- Fresh rendered verification covers representative views at laptop and narrow
  widths in light and dark appearance.
- The roadmap exit remains unverified until latency is measured and mobile/web
  parity plus operator usability are exercised on real task data.

## Migration and rollback

The `/v2/*` resources are additive. Clients may hide an unavailable view, but
must preserve an explicit unavailable state and cannot replace it with mock
data. Individual cockpit routes can be rolled back independently; canonical
task, intervention, and evidence schemas require normal protocol compatibility
rules and cannot be rolled back only in one client.

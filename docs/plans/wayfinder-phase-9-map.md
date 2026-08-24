# Wayfinder Map — Phase 9 Unified Clients and Operator Cockpit

**tracker:** local-markdown
**label:** wayfinder:map
**status:** local-contract-slice-implemented; roadmap-exit-unverified

## Destination

The Phase 9 local contract slice is implemented when Terminus provides unified
client contracts and local surfaces (task-first CLI, TUI, desktop operator
cockpit, IDE ACP bridge, mobile supervision contract), an Attention Coordinator
with 7 materiality triggers and consequence matrices, a 14-verb structured
intervention suite, an organization topology and capability directory, and
causal-replay contracts with omission diagnostics and counterfactual
hypotheses. This is not the roadmap exit gate.

Earlier-phase source exists, but its roadmap gates remain independently evidence-bound. No earlier phase is inferred complete from source declarations.

## Notes

Domain: provider-neutral coding-agent operating system; this map covers the Phase 9 local implementation slice. Keep Rust effects behind the kernel RPC, keep provider wire details in provider packages, preserve unrelated work, and report observed/proven/blocked facts separately.

Canonical terms:

- **OrganizationDirectory**: federated organization topology, departmental workspaces, process-local operator-agent and room projections, and deterministic capability resolution; restart persistence is not part of this local slice;
- **AttentionCoordinator**: human attention firewall evaluating 7 materiality triggers (`interpretation_divergence`, `authority_expansion`, `irreversible_effect`, `external_effect`, `missing_grant`, `human_taste`, `confidence_collapse`) and consequence matrices;
- **InterventionManager**: 14-verb structured intervention engine (`focus`, `ignore`, `elaborate`, `change_constraint`, `edit_plan`, `approve_exact_effect`, `deny_narrow`, `pause`, `resume`, `takeover`, `fork`, `rewind`, `terminate`, `request_independent_review`);
- **CausalReplayEngine**: process-local step-lineage recording, context omission diagnostics, and counterfactual hypotheses. Deterministic non-model replay and pinned-input model re-execution are planned contracts, not implemented runtime capabilities; restart continuity remains unverified;
- **DesktopCockpit**: local operator-cockpit component suite. The task workspace mounts overview, activity, changes, replay, usage, and evidence; the other view/modal components remain contract slices until a reachable route or command mounts them;
- **AcpBridge**: Terminus custom JSON-RPC-over-stdio adapter. It is not ACP v1 compatible, and editor-host conformance remains unverified.

## Decisions so far

- [Phase 9 destination and scope](wayfinder-phase-9-ticket.md): implement unified clients, attention coordinator, 14 structured interventions, organization topology, causal replay engine, ACP IDE protocol bridge, and Desktop Cockpit 10-view suite. ADR-0038 recorded.

## Local implementation evidence

The Phase 9 Unified Clients and Operator Cockpit contract slice is present:

- Canonical domain aggregates and Zod schemas in `@terminus/domain`, with
  schemas emitted through the shared v2 code-generation registry.
- Organization and Capability Directory (`OrganizationDirectory`) providing deterministic capability resolution without a centralized root agent bottleneck; its current maps are process-local.
- Attention Coordinator (`AttentionCoordinator`) requiring trusted materiality
  evidence before admitting a question and presenting explicit
  option-consequence matrices.
- Structured Intervention Manager (`InterventionManager`) supporting all 14 canonical verbs with typed payloads and state machine transitions.
- Causal Replay Engine (`CausalReplayEngine`) recording process-local lineage and
  supporting omission diagnostics only with trusted evaluator evidence;
  counterfactual outputs remain hypotheses. Deterministic replay and pinned-input
  model re-execution are not implemented, and restart lineage is not proven.
- Typed ARP v2 endpoint contracts in `@terminus/public-api`, decoded SDK methods
  in `@terminus/public-client`, and local HTTP/SSE handlers in
  `terminus-control`. Missing executors and trusted verifiers fail closed.
- Task-first CLI commands in `apps/cli`, text-mode TUI commands in `apps/tui`,
  and custom JSON-RPC-over-stdio methods in `apps/ide-acp`.
- Desktop operator cockpit task routes and modal overlays in `apps/desktop`;
  only the mounted routes count as UI evidence.
- Focused unit, API, ACP, and desktop behavioral tests are part of the local
  handoff gate; their existence is not release or user-study evidence.

Fresh offline desktop rendering has been inspected. Populated live behavior,
latency, mobile/web parity, reconnect continuity, accessibility measurement,
and operator user-study evidence remain unverified; see
`terminus-research-execution-ledger.md`.

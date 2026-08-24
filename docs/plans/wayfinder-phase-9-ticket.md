# Phase 9 — Unified Clients and Operator Cockpit

**parent:** [Wayfinder Map — Phase 9 Unified Clients and Operator Cockpit](wayfinder-phase-9-map.md)
**label:** wayfinder:task
**status:** local-contract-slice-implemented; roadmap-exit-unverified
**assignee:** codex

## Question

What implementation and evidence are required to make Phase 9 real on this
checkout, including any Phase 0–8 gap that blocks its acceptance surface?

## Acceptance

- Canonical domain aggregates (`Organization`, `Department`, `OperatorAgent`, `AgentRoom`, `CapabilityDirectoryEntry`, `MaterialQuestion`, `AttentionAssessment`, `StructuredIntervention`, `CausalStep`, `CausalReplayTrace`, `CounterfactualExperiment`, `MobileSupervisionSession`, `AcpContextInjection`) and schema codegen;
- Organization and Capability Directory (`OrganizationDirectory`) providing federated departmental workspaces and deterministic capability lookups;
- Attention Coordinator (`AttentionCoordinator`) enforcing 7 materiality triggers (`interpretation_divergence`, `authority_expansion`, `irreversible_effect`, `external_effect`, `missing_grant`, `human_taste`, `confidence_collapse`) and option-consequence matrices;
- Structured Intervention Manager (`InterventionManager`) supporting 14 canonical verbs (`focus`, `ignore`, `elaborate`, `change_constraint`, `edit_plan`, `approve_exact_effect`, `deny_narrow`, `pause`, `resume`, `takeover`, `fork`, `rewind`, `terminate`, `request_independent_review`);
- Causal Replay Engine (`CausalReplayEngine`) calculating context omission diagnostics and running counterfactual experiments;
- Public API endpoints in `@terminus/public-api`, client SDK methods in `@terminus/public-client`, and HTTP/SSE route handlers in `terminus-control`;
- CLI commands in `apps/cli`, TUI interactive screens in `apps/tui`, and ACP methods in `apps/ide-acp`;
- Electron Desktop Operator Cockpit 10-view suite (`OrganizationMapView`, `DepartmentRoomsView`, `MissionLedgerView`, `WorkflowGraphView`, `WorldStateView`, `EffectQueueView`, `ClaimEvidenceGraphView`, `ArtifactDiffInspectorView`, `FleetBudgetView`, `CausalReplayView`, `AttentionCenterModal`, `StructuredInterventionModal`) with explicit loading/empty/error states and keyboard-operable dialogs; sub-100 ms response remains a measured exit-gate target;
- `ADR-0038` recorded; local handoff requires `just codegen-check`,
  `just check`, `just check-all`, and `just eval-smoke` to pass on the integrated
  working tree. Those checks do not satisfy the measured or external exit
  criteria.

## Resolution

The Phase 9 contract slice exists across `@terminus/domain`,
`@terminus/orchestration`, `@terminus/public-api`, `@terminus/public-client`,
`terminus-control`, `apps/cli`, `apps/tui`, `apps/ide-acp`, and `apps/desktop`.
ADR-0038 records the architecture. Final integrated local verification is the
handoff gate, not proof of the roadmap exit. Latency, populated cross-client
continuity, parity, accessibility, and user-study evidence remain unverified as
recorded in
`terminus-research-execution-ledger.md`.

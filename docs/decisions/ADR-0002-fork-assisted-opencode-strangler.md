# ADR-0002: Fork-assisted OpenCode strangler strategy

- **Status:** ADOPTED
- **Date:** 2025-07-11
- **Decision owner:** upstream owner
- **Supersedes:** none
- **Related:** SPEC §6, §42.2

## Context

OpenCode already provides durable sessions, multiple clients, provider adapters, a typed context source registry, context epochs, LSP/MCP integrations, and TUI/web/desktop/IDE surfaces. Greenfield reimplementation would cost years and lose parity with a mature ecosystem. But OpenCode's ambient-authority plugin model, Bun-specific APIs, and provider-coupled assumptions are unacceptable as Terminus's permanent architecture (SPEC §6.1).

We need a strategy that reuses OpenCode's bootstrap assets without becoming trapped by them.

## Decision

Adopt a **fork-assisted strangler** strategy:

1. Pin an exact upstream OpenCode commit in `upstream/opencode.lock.json`.
2. Add a divergence budget (`upstream/divergence-budget.yaml`) per SPEC §6.1.
3. Extract five seams before adding differentiated features: Agent Runtime Protocol, Execution RPC, Context IR schema, artifact/evidence API, provider adapter interface.
4. Keep inherited behavior available behind feature flags until Terminus-owned replacements reach parity.
5. Isolate Bun-specific APIs behind compatibility modules for Terminus-owned code (ADR-0026).
6. Run upstream behavior-parity tests continuously.
7. Propose generic fixes upstream; track modified files and merge-conflict hours.
8. Set a maximum divergence budget per release; publish a divergence report.

The architecture is successful if any of OpenCode's clients, session store, provider adapters, context compiler implementation language, scheduler, or tool host can be replaced independently after bootstrap (SPEC §6.2). The Rust effect boundary, ARP, Context IR, and evidence store survive any replacement.

## Alternatives

- **Pure fork.** Rejected: inherits OpenCode's ambient-authority plugin model; cannot enforce non-bypassability (ADR-0014, ADR-0019).
- **Greenfield.** Rejected: years of rework; loses parity with mature ecosystem; delays the eval baseline (ADR-0001).
- **Vendor dependency without fork.** Rejected: cannot apply security patches deterministically; cannot enforce divergence budget.

## Consequences

- The `open-code-bridge` package is a permanent first-class seam.
- Every inherited effect path MUST be inventoried in `docs/security/effect-bypass-register.yaml` (SPEC §27.5).
- Upstream sync CI runs continuously; merge conflicts are tracked.
- Terminus-owned code MAY NOT use Bun-specific APIs except in the bridge (ADR-0026).
- The minimal baseline (ADR-0025) remains runnable as a control arm.

## Security Impact

High. The strangler strategy is what allows us to remove OpenCode's ambient effect paths over time without a flag day. The bypass register (SPEC §27.5) is the contract that tracks this removal.

## Evaluation Plan

- Upstream parity suite runs on every PR that touches inherited files.
- Divergence report is reviewed at each release gate (SPEC §46.18).
- Exit gate for M1 (SPEC §48.4): every critical invariant is either achievable through a stable seam or mapped to a narrowly owned fork patch.

## Migration

This ADR defines the migration itself. Each inherited package is replaced behind a Terminus interface; the bypass register tracks the order.

## Rollback

If the strangler stalls (Risk R1), accelerate replacement of the affected package behind Terminus interfaces. The exit strategy (SPEC §6.2) ensures the Rust boundary, ARP, Context IR, and evidence store survive any partial rollback.

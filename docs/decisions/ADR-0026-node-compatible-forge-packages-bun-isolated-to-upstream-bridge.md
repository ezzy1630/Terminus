# ADR-0026: Node-compatible Forge packages; Bun isolated to upstream bridge

- **Status:** PROVISIONAL
- **Date:** 2025-07-11
- **Decision owner:** upstream owner
- **Supersedes:** none
- **Related:** SPEC §43.2, §42.2

## Context

OpenCode is built on Bun and uses Bun-specific APIs in places. During bootstrap (ADR-0002), we inherit this. But Bun-specific APIs in Forge-owned packages would: (1) tie Forge to Bun permanently, (2) make Forge packages unusable in Node-only environments (CI, IDEs, edge runtimes), (3) complicate the exit strategy (SPEC §6.2 — the context compiler implementation language should be replaceable).

SPEC §43.2 says: "New Forge packages MUST NOT use Bun-specific APIs except in an explicit compatibility adapter."

## Decision

Adopt **Node-compatible Forge packages with Bun isolated to the upstream bridge** per SPEC §43.2 and §42.2:

1. **Node-compatible** — all Forge-owned packages (`packages/*` except `open-code-bridge`) target modern Node.js LTS and standards-based ESM. No Bun-specific APIs.
2. **Bun isolated to `open-code-bridge`** — the `packages/open-code-bridge` package is the only place Bun-specific APIs may appear. It wraps inherited OpenCode code and exposes a Node-compatible interface to the rest of Forge.
3. **pnpm workspaces** — Forge-owned packages use pnpm workspaces for package management (SPEC §43.2). Bun is used for the bridge and for running the inherited OpenCode dev server during bootstrap.
4. **Effect (the library) where beneficial** — use Effect where inherited architecture or typed service composition benefits; do not require Effect in leaf utility packages without reason (SPEC §43.2).
5. **Runtime schemas at every boundary** — runtime validation (Effect Schema or zod) at every package boundary (SPEC §43.2).
6. **Generated clients** — use generated clients rather than hand-written wire code (SPEC §43.2).

Status is PROVISIONAL because the Bun-to-Node migration of the bridge is subject to a replacement gate: once the OpenCode bridge is fully replaced by Forge-owned packages (ADR-0002 exit), Bun may be removed entirely.

## Alternatives

- **Bun everywhere.** Rejected: ties Forge to Bun permanently; loses Node compatibility; complicates exit strategy.
- **Node only (no Bun at all).** Rejected for bootstrap: OpenCode is Bun-based; cannot inherit without Bun during bootstrap.
- **Deno.** Rejected: smaller ecosystem; no clear benefit over Node+pnpm.
- **Effect everywhere (no plain TS).** Rejected (SPEC §43.2): overkill for leaf utility packages.

## Consequences

- `packages/open-code-bridge` is the only Bun-using package.
- All other Forge packages run on Node LTS.
- `bun install` is used during bootstrap (it resolves the workspace); `pnpm` is the documented workspace manager.
- Architecture-boundary checks (SPEC §42.5) verify no Bun-specific APIs outside the bridge.
- The exit strategy (SPEC §6.2) is preserved: the bridge can be removed without touching Forge-owned packages.

## Security Impact

Low. Node compatibility does not directly affect security, but it does ensure Forge packages run in standard environments (CI, IDEs) where security tooling is mature. Isolating Bun to the bridge limits the attack surface of Bun-specific APIs.

## Evaluation Plan

- Architecture-boundary checks (SPEC §42.5) verify no Bun-specific APIs outside `packages/open-code-bridge`.
- Node compatibility tests: every Forge package imports cleanly under Node LTS.
- Bridge isolation tests: removing the bridge does not break Forge-owned packages (mock the bridge interface).

## Migration

The bridge is introduced in M1 (SPEC §48.4 task 12). Bun-specific APIs in Forge-owned code are moved to the bridge or replaced with Node-compatible equivalents. The bridge is removed when OpenCode is fully replaced (ADR-0002 exit).

## Rollback

If Node compatibility proves too restrictive for a legitimate use case, add an explicit compatibility adapter (do not spread Bun APIs across Forge packages). If the bridge cannot be removed on schedule, extend the divergence budget (do not promote Bun to Forge-owned packages).

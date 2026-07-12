# ADR-0004: Separate public, kernel, and adapter protocols

- **Status:** ADOPTED
- **Date:** 2025-07-11
- **Decision owner:** protocol owner
- **Supersedes:** none
- **Related:** SPEC §7.1, §31, §35.11

## Context

A single JSON-RPC protocol for everything is unnecessarily constraining. The public product API, the internal privileged RPC, and the external-agent adapter surface have different change rates, trust levels, transport requirements, and consumer populations. Conflating them produces either a leaky privileged surface (security risk) or an over-constrained public surface (productivity risk).

OpenCode uses one JSON-RPC protocol for client/server and inherits that for plugins/MCP. Forge needs three distinct boundaries.

## Decision

Adopt **three separate protocols** per SPEC §7.1:

1. **Public product API** — HTTP/OpenAPI + SSE (or WebSocket, ADR-0029 OPEN) for clients (TUI, CLI, web, desktop, IDE/ACP, SDK, CI). Generated TypeScript/Rust/Python clients. OpenCode-compatible HTTP/OpenAPI retained during bootstrap (ADR-0008).
2. **Internal privileged RPC** — Protobuf/gRPC over Unix-domain socket locally, mTLS remotely. Strict schemas, deadlines, cancellation, idempotency, capability tokens. No generic "execute arbitrary JSON" escape hatch (ADR-0007).
3. **External-agent adapter protocol** — ACP v1 where supported; native adapters for Codex/Claude Code/Pi/OpenHands. Capability probes discover observed behavior; adapters normalize lifecycle, artifacts, budgets, and results while preserving a machine-readable declaration of what remains opaque (SPEC §35.11).

Each protocol has its own source of truth, code generator, version, and compatibility window (SPEC §45.1).

## Alternatives

- **One JSON-RPC protocol for everything.** Rejected: leaky privileged surface; cannot enforce capability tokens; cannot evolve public API independently.
- **gRPC for the public API too.** Rejected: poorer browser/IDE story; harder OpenAPI generation; OpenCode compatibility lost.
- **Adapter protocol folded into public API.** Rejected: external harnesses are Z4 untrusted; they need their own boundary with capability probes.

## Consequences

- Three code generators: `buf` for kernel proto, OpenAPI generator for public API, adapter SDK for external harnesses (SPEC §45.3).
- Three compatibility windows: public API versioned before release; kernel protocol has buf breaking-change checks; adapter protocol tracks ACP + per-harness versions.
- The `packages/public-client`, `packages/forge-kernel-client` (generated), and `packages/adapter-sdk` are separate packages.
- Contract tests run current×current and current×previous for each boundary (SPEC §46.6).

## Security Impact

High. Separation is what allows the kernel protocol to enforce capability tokens, deadlines, and idempotency without leaking those constraints into the public API. The adapter protocol's capability probes (SPEC §35.11) are what make external-harness discrepancies visible rather than trusted.

## Evaluation Plan

- Buf breaking-change checks run in CI for the kernel protocol.
- OpenAPI compatibility tests run for the public API.
- Adapter SDK has a fixture agent with zero declared discrepancies; real adapters (codex, claude-code, pi, oh-my-pi, omnigent, openhands) have realistic discrepancies surfaced in the UI (SPEC §35.11).

## Migration

Each protocol is introduced in its own milestone: M2 (public API skeleton), M3 (kernel proto v1), M9 (adapter SDK). See `docs/plans/roadmap.md`.

## Rollback

Each protocol can be versioned independently. A breaking change requires a new major version and a compatibility window; it cannot be silently rolled back. If a protocol fails, replace its implementation behind the interface — do not collapse protocols together.

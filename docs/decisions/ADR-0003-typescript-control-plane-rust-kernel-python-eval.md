# ADR-0003: TypeScript control plane + Rust effect kernel + Python eval lab

- **Status:** ADOPTED
- **Date:** 2025-07-11
- **Decision owner:** runtime owner
- **Supersedes:** none
- **Related:** SPEC §5, §43.1, §43.2, §43.3

## Context

A coding-agent operating system has three very different change rates and trust requirements:

1. **Product/cognition logic** (sessions, tasks, context, providers, orchestration, verification) iterates quickly with rich type systems and a large ecosystem. TypeScript is appropriate.
2. **Privileged effect enforcement** (process trees, filesystem correctness, PTYs, parsers, hard security invariants) needs a smaller trusted-computing base with deterministic memory safety and no GC pauses. Rust is appropriate.
3. **Offline evaluation and statistical analysis** benefits from Python's columnar data ecosystem (Polars/Pandas/DuckDB/Arrow) but must never sit on the production enforcement path. Python is appropriate.

A monolithic single-language design either bloats the trusted base (all-TypeScript) or starves the product layer of iteration speed (all-Rust). Putting Python on the production path would violate non-bypassability (SPEC §5.2).

## Decision

Adopt a **three-language architecture**:

- **TypeScript** owns the control plane (`terminus-control`): sessions, tasks, threads, turns, episodes, context compiler, provider renderers, orchestration, verification, capability registry, public API, clients. TypeScript has **no ambient effect authority** — all privileged operations route through the kernel RPC (ADR-0007).
- **Rust** owns the privileged effect kernel (`terminus-kernel`): sandbox broker, process/PTY/job manager, filesystem snapshot/edit transactions, network egress proxy, secret broker, resource/cgroup limits, LSP/DAP/Tree-sitter services, extension runtime. Rust is the **non-bypassable trust boundary** (SPEC §5.2).
- **Python** owns the offline evaluation laboratory (`terminus-eval`): runners, graders, analysis, statistics, dashboards, research. Python reads exported traces/artifacts; it never owns production effects.

SPEC §43.1–§43.3 define the per-language stacks. SPEC §42.4 defines the dependency direction (UI packages do not import kernel internals; provider packages do not import orchestration; Python eval code never becomes a production runtime dependency).

## Alternatives

- **All-Rust.** Rejected: slows product iteration; poorer provider SDK ecosystem; harder context-compiler exploration.
- **All-TypeScript with Node subprocess sandboxing.** Rejected: cannot enforce non-bypassability (SPEC §5.2); GC pauses break PTY/process-tree ownership.
- **All-Python or Python-on-path.** Rejected: violates non-bypassability; GIL breaks process-tree ownership; no zeroizing secret types.
- **Go kernel.** Rejected: GC pauses; weaker unsafe-code story than Rust for sandbox/PTY work.

## Consequences

- Three toolchains must be pinned and bootstrapped (`mise.toml`).
- Cross-language contracts are Protobuf (kernel RPC), JSON Schema (domain/events/tools), and TypeScript runtime schemas (public API) per SPEC §45.1.
- The `terminus-kernel-testkit` crate provides a fake kernel for TS-side development.
- The Python eval lab consumes Parquet/JSONL exports; it does not call the kernel RPC directly.
- Architecture-boundary checks (SPEC §42.5) forbid forbidden imports across languages.

## Security Impact

High. The language split is what makes non-bypassability enforceable. Rust's `unsafe` discipline, ownership model, and lack of GC are prerequisites for the sandbox/process/secret brokers. TypeScript's lack of ambient authority (enforced by architecture-boundary checks) is what prevents Z1 code from spawning host processes.

## Evaluation Plan

- Architecture-boundary checks run in CI (SPEC §42.5).
- Each language has its own test layers (SPEC §46.1).
- Cross-language contract tests run current×current and current×previous (SPEC §46.6).

## Migration

ADR-0039 establishes the TypeScript control plane as Terminus-owned. External harnesses integrate through the adapter protocol and do not define control-plane packages.

## Rollback

Cannot roll back without abandoning non-bypassability. If a language choice fails, replace that language's component behind its interface (e.g., swap a Rust crate for another Rust crate, or a TS package for another TS package) — do not collapse the language boundary.

# Architecture overview

This document is the entry point for Terminus's architecture. It summarizes the layered design from SPEC §5 and links to the per-subsystem deep dives. The normative source is `SPEC.md` §5–§47; this document is a navigation aid.

## Layered architecture (SPEC §5)

```
┌──────────────────────────────────────────────────────────────────────────┐
│ CLIENTS                                                                  │
│ TUI · CLI · Web · Desktop · IDE/ACP · SDK · CI · Remote supervisor      │
└──────────────────────────────┬───────────────────────────────────────────┘
                               │ Public API / ACP adapter (ADR-0008)
┌──────────────────────────────▼───────────────────────────────────────────┐
│ CONTROL AND COGNITION PLANE — TypeScript, OpenCode-derived initially    │
│ (ADR-0003)                                                              │
│                                                                          │
│ Session/task engine     Context Compiler (ADR-0009)    Provider renderers│
│ Model broker (ADR-0022) Scope/policy coordinator       Agent scheduler   │
│                          (ADR-0020)                                     │
│ Verification planner    Capability registry            External-agent    │
│  (ADR-0021)              (ADR-0017/18/19)              adapters (ADR-0004)│
└───────────────┬───────────────────────────┬──────────────────────────────┘
                │ privileged effects RPC    │ unprivileged capability RPC
                │ (ADR-0007)                 │
┌───────────────▼────────────────────┐  ┌───▼──────────────────────────────┐
│ EXECUTION/SECURITY MICROKERNEL     │  │ CAPABILITY PLANE                │
│ Rust, non-bypassable (ADR-0014)    │  │                                  │
│                                   │  │ Built-in tools · Agent Skills    │
│ Sandbox broker                    │  │ MCP servers · first-party packs  │
│ PTY/process/job manager           │  │ third-party plugins · adapters   │
│ FS snapshot/edit transactions     │  │                                  │
│ Network egress proxy (ADR-0015)   │  │ Discovery · activation · trust   │
│ Secret broker (ADR-0016)          │  │ schema pinning · conformance      │
│ Resource/cgroup limits            │  │                                  │
│ LSP/DAP/Tree-sitter services      │  │ Runs out of process by default   │
└───────────────┬────────────────────┘  └──────────────────────────────────┘
                │
┌───────────────▼──────────────────────────────────────────────────────────┐
│ WORKSPACES                                                               │
│ Local worktrees · containers · gVisor · micro-VMs · remote sandboxes    │
└──────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────┐
│ EVIDENCE, EVALUATION, AND EVOLUTION PLANE                                │
│ Exact manifests (ADR-0010) · artifacts · traces · replay · ablations     │
│ security conformance · A/B tests · cost/cache analytics · feature gates  │
└──────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────┐
│ DATA PLANE (ADR-0005)                                                    │
│ SQLite/WAL · semantic event log · content-addressed blobs · Git ·        │
│ OpenTelemetry · Parquet analytics · optional FTS/vector indexes          │
└──────────────────────────────────────────────────────────────────────────┘
```

## Why this is better than one monolithic daemon (SPEC §5.1)

Different responsibilities have different change rates and trust requirements:

- Provider APIs, prompts, schemas, and UI iterate quickly — TypeScript is appropriate.
- Process trees, filesystem correctness, PTYs, parsers, and hard security invariants require a smaller Rust trusted-computing base.
- Extensions and MCP servers should be replaceable and isolated.
- Evaluation and statistical analysis benefit from Python and columnar data but should not sit on the enforcement path.

## Subsystem deep dives

| Subsystem | Document | SPEC |
|---|---|---|
| Trust zones and non-bypassability | `trust-boundaries.md` | §5.2, §27 |
| Context Compiler | `context-compiler.md` | §8, §33 |
| Effect kernel | `effect-kernel.md` | §13, §31, §36 |
| Agent–Computer Interface (ACI) | `aci.md` | §11, §34 |
| Orchestration | `orchestration.md` | §14, §37 |
| Verification | `verification.md` | §17, §40 |
| Evaluation lab | `evaluation-lab.md` | §18, §41 |
| Data plane | `data-plane.md` | §7.3, §29 |

## Process topology (SPEC §27.1)

```
terminus client(s)
    │ HTTPS/UDS HTTP + SSE
    ▼
terminus-control (TypeScript, port 3050)
    │ gRPC over Unix domain socket (or JSON-over-HTTP in mini-service bootstrap)
    ▼
terminus-kernel (Rust, port 3040, privileged effect boundary)
    ├── sandboxed command/job processes
    ├── LSP/DAP/index workers
    ├── plugin/WASI workers
    ├── MCP server processes
    └── external harness adapter processes

terminus-eval (Python, offline or isolated)
    └── reads exported traces/artifacts; never owns production effects
```

`terminus-control` owns cognition and product state. `terminus-kernel` owns authority to affect the host or external systems. Clients own presentation and user interaction. Python owns offline analysis only.

## Decisions governing this architecture

See `docs/decisions/` for the 30 ADRs from Appendix H. Key architectural ADRs:

- ADR-0001 — Primary metric: verified successful tasks per dollar-hour.
- ADR-0002 — Fork-assisted OpenCode strangler strategy.
- ADR-0003 — TS control plane + Rust kernel + Python eval.
- ADR-0004 — Separate public, kernel, adapter protocols.
- ADR-0005 — Hybrid SQLite/events/artifact persistence.
- ADR-0007 — gRPC/Protobuf over UDS for kernel RPC.
- ADR-0009 — Context IR + provider-specific renderers.
- ADR-0014 — Linux Bubblewrap secure backend.
- ADR-0025 — Permanent minimal baseline + feature promotion gates.

## Next steps

- For implementation details: read the relevant `crates/*/README.md` or `packages/*/README.md`.
- For decisions: read `docs/decisions/ADR-*.md`.
- For operations: read `docs/runbooks/*.md`.
- For the full contract: read `SPEC.md`.

# ADR-0051: Language Server Protocol (LSP) client and server registry

- **Status:** ADOPTED
- **Date:** 2026-08-26
- **Decision owner:** developer tools / context compiler owner
- **Supersedes:** none
- **Related:** SPEC §11.3, §34.13; ADR-0012; ADR-0038

## Context

High-fidelity code intelligence (definition jumping, type hovers, references, symbol trees, compiler diagnostics) in modern agent harnesses like OpenCode is powered by direct LSP server integration rather than naive regex or symbol guessing.

Previously, Terminus inspect tools were stubs or relied on ad-hoc regex heuristics.

## Decision

1. Adopt `@terminus/lsp` providing:
   - JSON-RPC 2.0 transport and client lifecycle (`initialize`, `didOpen`, `didChange`, `didClose`, `shutdown`, `exit`).
   - Semantic operations (`definition`, `references`, `hover`, `documentSymbol`).
   - Diagnostic streaming and event dispatching.
   - Built-in server registry (`typescript-language-server`, `pyright`, `rust-analyzer`, `gopls`, `clangd`).
   - Workspace root ancestor resolution.
2. The control plane can bridge LSP instances over the kernel process RPC without giving language servers direct unmediated filesystem access.

## Consequences

- The `inspect` tool and context compilers have structured access to language servers.
- Language server lifecycle is encapsulated behind safe client and transport boundaries.

# @terminus/lsp

Production Language Server Protocol (LSP) client, JSON-RPC transport, and server registry (ADR-0051).

## Capabilities

- JSON-RPC 2.0 client over pluggable transport.
- Lifecycle management (`initialize`, `initialized`, `shutdown`, `exit`).
- Document synchronization (`didOpen`, `didChange`, `didClose`).
- Semantic operations (`definition`, `references`, `hover`, `documentSymbol`).
- Diagnostics publishing and subscription.
- Preconfigured language server configurations (`tsserver`, `pyright`, `rust-analyzer`, `gopls`, `clangd`).
- Workspace root discovery.

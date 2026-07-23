WASI extension and process-isolated hosts for the Terminus kernel.

## Behavior

- **Process host** — clears environment, verifies entrypoint content hashes,
  enforces wall-clock and output caps, speaks JSON-RPC on stdio.
- **WASI host** — validates Wasm magic + content hash; executes via isolated
  `wasmtime` CLI when available; otherwise fails closed with `Unavailable`.
- Never silently executes native in-process third-party code.

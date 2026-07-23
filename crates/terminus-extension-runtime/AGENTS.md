# AGENTS.md — terminus-extension-runtime

## Local rules

- **Fail closed.** When no WASI backend (`wasmtime` on PATH / feature) is
  available, `execute` MUST return `ExtensionError::Unavailable`. Never
  silently execute native code instead.
- **Process isolation is real.** `ProcessExtensionHost` clears the environment,
  verifies entrypoint hashes, and enforces wall-clock + output caps.
- **Manifest validation is real.** Even with no WASI runtime, `validate_manifest`
  MUST run on every extension so malformed manifests are rejected early.
- **No ambient authority.** Extensions receive only declared capabilities.
  Do not pass the kernel's capability token into the extension.
- **No `unsafe`.** No panics.

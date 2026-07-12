# AGENTS.md — terminus-extension-runtime

## Local rules

- **Fail closed.** When no WASI runtime is linked, `execute` MUST return
  `ExtensionError::Unavailable`. Never silently execute native code instead.
- **Manifest validation is real.** Even with no runtime, `validate_manifest`
  MUST run on every extension so malformed manifests are rejected early.
- **No ambient authority.** Extensions receive only declared capabilities.
  Do not pass the kernel's capability token into the extension.
- **No `unsafe`.** No panics.

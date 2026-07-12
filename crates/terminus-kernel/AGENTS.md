# AGENTS.md — forge-kernel

## Local rules

- **Library only.** The kernel is a library. The HTTP server lives in
  `mini-services/forge-kernel`. Do not add an HTTP server here.
- **Every effect takes a RequestContext + EffectIntent.** No exceptions.
  Production paths MUST go through the service methods so policy and audit
  apply.
- **No `unwrap`/`expect`/`panic`** in production paths. Use `KernelError`.
- **Fail closed.** When a backend is unavailable, return a typed error
  rather than degrading silently.
- **No `unsafe`.** No panics.

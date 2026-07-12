# AGENTS.md — terminus-process

## Local rules

- **No ambient environment.** `env_clear()` is mandatory on every spawn.
  Caller provides explicit `public_env` and secret capability URIs.
- **Process groups.** Spawn every child in a new process group on Unix so
  cancel can kill the whole tree. On non-Unix, document the limitation.
- **One `unsafe` block.** Only `kill_process_group` may contain `unsafe`.
  Any new `unsafe` requires a new ADR.
- **Bounded output.** Inline output is capped at `max_inline_bytes`; larger
  outputs spill to the artifact store and the receiver sees an
  `ArtifactRef` in `ProcessExited`.
- **No panics** in production paths. Mutex poisoning is recovered via
  `into_inner()`.
- **Cancellation safety.** `cancel()` MUST kill the process group, reap the
  child, and remove the entry from the manager map.

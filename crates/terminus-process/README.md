# terminus-process

Async child-process manager for the Terminus kernel.

`ProcessManager` spawns child processes from a `CommandSpec`, captures
stdout/stderr to the artifact store as bounded `ProcessEvent`s, enforces a
timeout, and kills the process tree on cancel. No ambient environment is
inherited: the caller supplies an explicit `public_env` map and secret
capability URIs are routed through `terminus-secrets`, never dereferenced here.

The crate contains exactly one `unsafe` block — `kill_process_group` — which
is documented in `manager.rs` (ADR-0001) and reviewed for being the smallest
possible wrapper around `libc::kill(-pgid, SIGKILL)`. There is no safe Rust
API for `killpg(2)` in std; the alternative — leaking orphan processes — is
worse than a contained, well-documented `unsafe` block.

# ADR-0031: Controlled `unsafe` block for process-group kill (`killpg`)

- **Status:** ADOPTED
- **Date:** 2026-07-12
- **Decision owner:** security-runtime owner
- **Supersedes:** none
- **Related:** SPEC §44.2, §34.11, ADR-0001

## Context

`terminus-process` must own and reap entire process trees on cancellation/timeout (SPEC §34.11: "every subprocess is owned by a process-tree abstraction"; §44.2: "no detached `tokio::spawn` without a supervising task group"). On Unix, killing a whole process group requires `killpg(2)` (equivalently `kill(-pgid, SIGKILL)`). There is no safe Rust binding for `killpg` in `std` or in the crate's dependency set. The alternatives — killing only the direct child (orphans its descendants) or leaking the tree — are strictly worse for the non-bypassability and process-ownership invariants.

SPEC §44.2 permits a low-level crate to use narrowly scoped `unsafe` only with: (1) an ADR, (2) a safety comment, (3) Miri/fuzz tests where applicable, and (4) security-owner review. The workspace sets `unsafe_code = "deny"`; this crate overrides it with `#[allow(unsafe_code)]` scoped to the single function.

## Decision

Permit exactly one `unsafe` block in `terminus-process::kill_process_group`, scoped to the single `libc::kill(-(pid as i32), libc::SIGKILL)` call. The block:

- is the smallest possible (one FFI call, no resources held across it);
- touches no Rust-managed memory;
- ignores the return value (the only failure is `ESRCH`, meaning the process is already gone — the desired state);
- is gated behind `#[cfg(unix)]` with a no-op fallback on non-Unix;
- is the sole reason `terminus-process` opts out of `unsafe_code = "deny"`.

## Alternatives

- **Kill only the direct child (`child.kill()`).** Rejected: orphans descendant processes, violating process-tree ownership and creating escape hatches.
- **`nix` crate `killpg`.** Rejected at this time: adds a dependency for a single call; can be reconsidered if more signal/process APIs are needed.
- **Process groups via `setsid` + `kill(0)`.** Equivalent `unsafe` surface; no benefit over `libc::kill(-pgid)`.

## Consequences

- `terminus-process` carries `#[allow(unsafe_code)]` and one `unsafe` block, documented and bounded.
- Any additional `unsafe` in this crate requires a new ADR or an amendment to this one.
- The block is covered by the orphan/escape test suite (`crates/terminus-process` tests that spawn children and assert the group is reaped on timeout/cancel).

## Security Impact

Positive. Contained `unsafe` for tree-kill is safer than the alternative of orphaned processes that could outlive supervision and continue to act on the host. The block cannot be used to read/write memory or escalate privileges; it only dispatches a signal to a pid group the kernel already owns.

## Evaluation Plan

- Unit tests in `terminus-process` spawn a process that forks a long-running child, then cancel/timeout and assert both the parent and child are reaped (no orphans).
- `cargo deny` and the workspace `unsafe_code = "deny"` lint keep this the only `unsafe` in the crate.
- Security-owner review recorded against this ADR before merge.

## Migration

N/A — the block already exists; this ADR retroactively provides the required authorization and corrects a prior comment that misattributed it to ADR-0001 (the success-metric decision, which is unrelated to `unsafe`).

## Rollback

Replace `libc::kill(-pgid)` with a safe binding (e.g. `nix::unistd::killpg`) and remove `#[allow(unsafe_code)]`, restoring workspace-wide `unsafe_code = "deny"`.

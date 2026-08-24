# ADR-0014: Linux Bubblewrap secure backend

- **Status:** ADOPTED
- **Date:** 2025-07-11
- **Decision owner:** security runtime
- **Supersedes:** none
- **Related:** SPEC §13.4, §36.5

## Context

The Linux sandbox backend is the primary enforcement mechanism for the non-bypassability invariant (SPEC §5.2) on the most common deployment platform. It must: isolate the workspace from the host filesystem, prevent direct network sockets, prevent privilege escalation, limit resources (CPU/memory/PIDs/files), and own the process tree (including forked children).

OpenCode's upstream uses a permissions model that is insufficient as a security boundary (SPEC §4 competitive synthesis). Codex's Linux sandbox (Bubblewrap-based) is a strong reference (SPEC §4, Appendix B).

## Decision

Adopt a **Linux Bubblewrap secure backend** per SPEC §13.4 and §36.5:

- **New user and PID namespaces** — sandboxed processes cannot see or signal host processes.
- **New mount namespace** — read-only root, writable worktree, denied paths (`.git`, Terminus state, secret store, host).
- **No-new-privileges** — `setuid`/`setgid` cannot escalate.
- **Seccomp filter** — system calls restricted to a deny-by-default allowlist.
- **Cgroup v2** — memory, CPU, PID, and open-file limits enforced (SPEC §36.4 defaults: 2 GiB memory, 600 CPU seconds, 256 PIDs, 1024 open files).
- **Network namespace** — no direct sockets; proxy-only egress (ADR-0015).
- **Symlink containment** — `symlinks: contained_only` in the default policy (SPEC §36.4).
- **Process-tree ownership** — all forked children are tracked and killed on cancellation (SPEC §36.5).

Implementation: `crates/terminus-sandbox-linux`. macOS and Windows backends are scaffolded with honest capability reporting (SPEC §36.6, §36.7).

## Alternatives

- **Permissions-only model (OpenCode upstream).** Rejected: cannot enforce non-bypassability (SPEC §4, §5.2).
- **Docker/containerd as the only backend.** Rejected: too heavy for the default local case; daemon dependency; slower startup. Container backends are for untrusted evals/extensions (ADR-0027 OPEN).
- **Firejail.** Rejected: less maintained than Bubblewrap; narrower community.
- **Landlock.** Considered as a complement, not a replacement (Landlock is path-only; doesn't do namespaces).
- **Raw `chroot`/`unshare`.** Rejected: too easy to get wrong; Bubblewrap encapsulates the patterns.

## Consequences

- The Linux backend is the reference; macOS/Windows backends honestly report degraded capability.
- Bubblewrap must be installed on Linux (`apt install bubblewrap` or equivalent).
- The default policy profile (`policies/sandbox/secure-local-default.yaml`) is the first-run default (SPEC §36.4).
- Degraded-mode detection reports when the requested sandbox cannot be enforced (SPEC §36.4, §26.3 #11).
- Container/micro-VM backends (ADR-0027) are selected for untrusted evals/extensions.

## Security Impact

Critical. This is the primary enforcement mechanism on Linux. The non-bypassability tests (SPEC §27.4, `docs/security/non-bypassability-tests.md`) must pass on the Linux backend before any release calls the effect boundary non-bypassable.

## Evaluation Plan

- Namespace/sandbox escape suite (nightly, dedicated Linux runner, SPEC §46.10).
- Process-tree escape tests (fork, daemonize, PID namespace).
- Network proxy bypass tests (raw socket, DNS rebinding, private address).
- Path traversal/symlink escape tests (property + race).
- Cgroup enforcement tests (memory limit, PID limit).
- Adversarial benchmark at release (SPEC §46.10).

## Migration

The Linux backend is introduced in M4 (SPEC §48.7). First-party direct effect paths are release-blocking defects; the retired inherited-source tombstone grants no exception (ADR-0039).

## Rollback

If Bubblewrap is unavailable on a host, Terminus fails closed or requires explicit user selection of a named degraded profile (SPEC §26.3 #11). Do not silently fall back to no sandbox.

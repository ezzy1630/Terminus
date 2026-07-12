# ADR-0027: Container/micro-VM backend selection

- **Status:** OPEN
- **Date:** 2025-07-11
- **Decision owner:** runtime owner
- **Supersedes:** none
- **Related:** SPEC §13.4, §36.8, §49.5

## Context

The Linux Bubblewrap backend (ADR-0014) is the default for local trusted workspaces. But for untrusted repositories, evals, and extensions, Bubblewrap may not be sufficient isolation: a kernel exploit in the host could allow escape, and Bubblewrap shares the host kernel. Container runtimes (Docker, Podman, containerd) and micro-VMs (gVisor, Firecracker, Kata) provide stronger isolation at higher cost.

SPEC §49.5 lists "specific container/micro-VM backend" as deliberately experimental. We need to decide which backend(s) to support, when to select each, and how they integrate with the kernel's sandbox trait.

## Decision (OPEN)

This ADR is OPEN. The experiment owner is the runtime owner. The decision will be made after M4 (SPEC §48.7) ships the Linux Bubblewrap backend and M9 (SPEC §48.12) ships the container backend for untrusted evals/extensions.

Candidate backends under evaluation:

1. **Podman** (rootless containers) — strong isolation, no daemon, good Linux support. Candidate for untrusted evals.
2. **Docker** (with rootless mode) — broad ecosystem, but daemon dependency.
3. **gVisor** (kernel-level sandbox) — strong isolation, Linux only, performance overhead.
4. **Firecracker** (micro-VM) — very strong isolation, AWS-origin, requires Linux + KVM.
5. **Kata Containers** (micro-VM with container interface) — strong isolation, broader hardware support than Firecracker.

Selection criteria (to be evaluated):
- Isolation strength (escape difficulty).
- Performance overhead (startup time, runtime overhead).
- Resource cost (memory, CPU).
- Platform support (Linux only? macOS? Windows?).
- Operational complexity (daemon? KVM? setup?).
- Digest-pinning support (SPEC §36.8 — `evals/environments/*.lock` use digest-pinned images).

The selection will be made via a new ADR (this one promoted to ADOPTED with the chosen backend(s)) after the evaluation.

## Alternatives

- **Bubblewrap only.** Rejected for untrusted: shared host kernel; insufficient for malicious repos.
- **All backends supported.** Rejected: operational complexity; testing matrix explosion.
- **Pick one without evaluation.** Rejected (SPEC §49.5): must be evidence-based.

## Consequences (once a backend is chosen)

- The chosen backend(s) implement the `SandboxBackend` trait in `crates/forge-sandbox`.
- `crates/forge-sandbox-container` already exists as a scaffold.
- Digest-pinned container images are required (SPEC §36.8).
- The container-untrusted policy profile (`policies/sandbox/container-untrusted.yaml`) is the default for untrusted repos.
- The non-bypassability tests (SPEC §27.4) must pass on the chosen backend.

## Security Impact

High (once chosen). The container/micro-VM backend is the enforcement mechanism for untrusted repos. Selection must be evidence-based. The non-bypassability tests must pass.

## Evaluation Plan

- Escape difficulty: adversarial suite (SPEC §46.10).
- Performance overhead: startup time, runtime overhead benchmarks.
- Resource cost: memory, CPU measurements.
- Platform support: test on Linux, macOS (where applicable), Windows (where applicable).
- Digest-pinning: `evals/environments/*.lock` images are pinned and verified.
- Operational complexity: setup time, daemon/KVM requirements.

## Migration

The container backend scaffold is introduced in M4 (SPEC §48.7 task 16) and M9 (SPEC §48.12 task 7). The chosen backend is selected after evaluation.

## Rollback

If the chosen backend proves insufficient (escape, performance, platform), select a different backend via a new ADR. The `SandboxBackend` trait isolates the choice; switching backends does not affect the kernel protocol.

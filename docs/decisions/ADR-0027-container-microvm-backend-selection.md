# ADR-0027: Container/micro-VM backend selection

- **Status:** ADOPTED (digest-pinned OCI container first)
- **Date:** 2025-07-11
- **Adopted:** 2026-07-23
- **Decision owner:** runtime owner
- **Supersedes:** none
- **Related:** SPEC §13.4, §36.8, §49.5, ADR-0014, ADR-0030

## Context

The Linux Bubblewrap backend (ADR-0014) is the default for local trusted workspaces. For untrusted repositories, evals, extensions, and remote environments, stronger isolation is required. SPEC §36.8 requires digest-pinned images.

## Decision

**First remote/untrusted backend: digest-pinned OCI containers** via Docker or Podman (`crates/terminus-sandbox-container`).

- Image references MUST be `repository@sha256:<64-hex>`. Mutable tags (`:latest`) are rejected.
- An in-process execution pool leases slots bound to a pinned image.
- Micro-VM backends (Firecracker / Kata / gVisor) remain experimental and are not the M11 default.
- Local trusted workspaces continue to use Bubblewrap (ADR-0014).

## Consequences

- `ContainerSandboxBackend::configure` requires a digest-pinned reference.
- Spawn wrappers emit digest references only.
- Eval environment lockfiles must carry real digests before production use.
- Selecting Firecracker/Kata later requires amending this ADR with escape and performance evidence.

## Security Impact

High for untrusted/remote. Digest pinning prevents tag mutability attacks. Container isolation still shares the host kernel; micro-VMs remain the path for higher assurance later.

## Evaluation Plan

- Unit tests reject `alpine:latest`.
- Pool lease/release tests.
- Non-bypassability suite on the configured container backend before production enablement.

## Migration

Callers migrate from `with_runtime_configured(true)` to `configure(runtime, "repo@sha256:…", slots)`.

## Rollback

Fail closed: unconfigured container backend returns `Unsupported`. Operators fall back to Bubblewrap for trusted local work only.

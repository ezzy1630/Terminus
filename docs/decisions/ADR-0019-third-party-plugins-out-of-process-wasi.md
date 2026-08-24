# ADR-0019: Third-party plugins out of process/WASI

- **Status:** ADOPTED
- **Date:** 2025-07-11
- **Decision owner:** ecosystem owner
- **Supersedes:** none
- **Related:** SPEC §12.3, §35.4

## Context

OpenCode's upstream plugin model allows in-process plugins that can auto-install packages and receive shell access (SPEC §4 competitive synthesis, §36.17). This is unacceptable for Terminus: in-process third-party code can bypass the kernel (violating SPEC §5.2), read ambient secrets, and corrupt the control plane's memory.

Third-party plugins are Z4 untrusted. They must run in separate processes or WASI sandboxes with declared capabilities, no lifecycle scripts, and supply-chain pinning.

## Decision

Adopt **third-party plugins out of process or WASI** per SPEC §12.3 and §35.4:

1. **Out of process by default** — third-party plugins run in separate processes communicating via the kernel RPC (ADR-0007) or a narrow capability RPC. No in-process third-party code.
2. **WASI for sandboxed execution** — where WASI is appropriate (pure-computation plugins, no host I/O beyond declared capabilities), plugins run under Wasmtime with declared WASI capabilities (SPEC §43.1).
3. **No lifecycle scripts** — `extensions.lifecycle_scripts: deny` in the default policy (SPEC §36.4). No `postinstall`, `preuninstall`, or other lifecycle hooks from third-party packages in production builds.
4. **Explicit installation** — extension installation is explicit (user action, not automatic). Lockfiles pin versions and integrity hashes.
5. **Signatures** — plugins are signed; signatures verified at install and load (SPEC §46.17).
6. **Lockfiles** — `extension.lock.json` pins all active extensions; changes require user action.
7. **Capability declaration** — every plugin declares its capabilities (filesystem, network, secrets, subprocesses, model-visibility) in a manifest. The kernel enforces these.
8. **Disabled auto-install** — automatic plugin installation is disabled in the secure Terminus profile (SPEC §48.4 task 13).

Implementation: `crates/terminus-extension-runtime` (host, manifest validation) + `packages/extension-host` (TS-side coordination). Schemas: `schemas/capabilities/plugin.json`.

## Alternatives

- **In-process third-party plugins.** Rejected (SPEC §49.6, §4): ambient authority; cannot enforce non-bypassability; supply-chain risk.
- **Plugins with lifecycle scripts.** Rejected (SPEC §49.6): supply-chain attacks; arbitrary code at install time.
- **Automatic plugin installation.** Rejected (SPEC §49.6): untrusted code runs without user action.
- **WASI only (no out-of-process).** Rejected: not all plugins can run under WASI (e.g., plugins needing a real Node runtime); out-of-process is the fallback.

## Consequences

- Plugins are first-class capabilities in the Terminus registry.
- Plugin manifests are validated at load; capability changes trigger reauthorization (like MCP, ADR-0018).
- The `extension.lock.json` is the source of truth for active extensions.
- Plugin processes are owned by the kernel; killed on cancellation or unload.
- Wasmtime is a required dependency for WASI plugins (SPEC §43.1).

## Security Impact

Critical. This is what prevents third-party code from acquiring ambient effects (SPEC §26.3 #8). The non-bypassability tests (SPEC §27.4) include plugin bypass attempts. The security evals (`evals/security/workspace-escape.yaml`) test plugin escapes. Supply-chain scans and SBOM are required (SPEC §46.14, §36.17).

## Evaluation Plan

- Install and escape suite (nightly, SPEC §46.10): malicious plugin attempts to escape; kernel denies.
- Lifecycle-script tests: third-party package with `postinstall` is rejected.
- Signature verification tests: unsigned plugin is rejected.
- Lockfile tests: out-of-lockfile plugin is rejected.
- Capability enforcement tests: plugin without `network` capability cannot make network calls.

## Migration

Plugins are introduced in M9 (SPEC §48.12) only through the Terminus extension runtime. No inherited in-process plugin exception remains (ADR-0039).

## Rollback

If a plugin proves malicious, revoke and quarantine it (incident process, `docs/runbooks/compromised-extension.md`). If WASI proves too restrictive for a legitimate plugin, run it out-of-process instead (do not allow in-process). Do not silently re-enable a quarantined plugin.

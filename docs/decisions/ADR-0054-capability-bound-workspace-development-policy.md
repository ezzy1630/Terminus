# ADR-0054: Capability-bound workspace development command policy

- **Status:** PROPOSED
- **Date:** 2026-08-30
- **Decision owner:** security owner
- **Supersedes:** none
- **Related:** SPEC §13, §26.2, §31, §36; ADR-0012; ADR-0045

## Context

Terminus exposes session permission profiles named `full-access`, `auto`, and
`ask`. Those profiles control whether the control plane asks before a tool
call. They do not select the kernel command policy. Every native agent process
request currently names `secure-local-default`, whose intentionally narrow
allowlist admits common test runners and read tools but default-denies ordinary
local development commands such as `true`, `sleep`, `make`, and project-local
scripts.

The result is a false contract: `full-access` removes the control-plane prompt
but the kernel still refuses most benign commands. Making the global default
policy permissive would fix the symptom by weakening every caller, including
tokens that were never authorized for unattended development. Trusting the
caller-supplied `EffectIntent.policy_profile_id` without binding it to the
capability token would be a policy-confusion vulnerability.

Current coding harnesses converge on a useful separation: approval policy says
whether to interrupt the operator, while an OS sandbox or container remains the
containment boundary. Explicit no-sandbox modes exist, but their own guidance
reserves them for an outer container or VM.

## Decision

1. Keep `secure-local-default` as the kernel's default command policy. Native
   standalone process tools continue to request this curated policy, including
   in development mode; no control-plane flag or environment variable promotes
   them to a broader policy.
2. Retain the signed, capability-bound `workspace-development` policy binding
   as dormant implementation for a future isolated execution path. It admits
   arbitrary `EXECUTE_LOCAL` processes only with bounded runtime, output, and
   environment, while hard-denying classified raw network access, external
   state mutation, secret use, sandbox/plugin/credential administration, and
   download-to-interpreter pipelines. Because a subprocess can traverse the
   whole mounted workspace regardless of its initial cwd, control may mint
   this profile only when the task contract explicitly grants `**` read and
   write scope; the signed capability records `**`, not merely the cwd.
3. Promotion requires a distinct `workspace-development-isolated` prepared
   sandbox with an atomic wrapper-plus-proof contract and complete hard
   controls for process, filesystem, network, secret, external-state, and
   recovery boundaries. Until that isolated profile exists and passes targeted
   adversarial evaluation, every native standalone process remains on
   `secure-local-default` and the dormant binding fails closed.
4. Keep the enforced `secure-local-default` sandbox profile for the dormant
   policy binding as well. Ambient network and secrets remain unavailable;
   protected Git configuration and hooks remain write-protected. A command
   policy never selects or weakens a sandbox. macOS Seatbelt is unsupported for
   arbitrary binaries in this slice and is not evidence for promotion.
5. Bind every non-default command policy to the signed task capability. The
   control broker may mint only known policy profile ids. Process execution
   rejects a caller-selected non-default profile unless the validated token
   names it. Legacy tokens with no policy-profile claim retain authority only
   for `secure-local-default`.
6. Keep control-plane permission profiles independent. `full-access` means no
   interactive approvals for in-scope workspace tools, not unrestricted host
   authority. Rename its user-facing label to **Full workspace access** and say
   explicitly that host access remains sandboxed.
7. Do not add a host-level `danger-full-access` mode in this change. A future
   `admin` mode requires an explicit privileged contract, durable audit,
   external-isolation attestation or an equally strong boundary, targeted
   adversarial evaluation, and the approvals required by the repository's
   security change policy.

## Promotion gate

This proposal is not an authorization to expose a broad native execution mode.
The implementation must remain unreachable from standalone tool dispatch until
the distinct `workspace-development-isolated` profile is prepared, its wrapper
and proof are committed atomically, all hard controls are enforced by the
kernel, and the required security approvals and adversarial evaluation are
complete. No environment flag, permission-profile setting, or degraded sandbox
fallback may bypass this gate.

## Reconciliation with ADR-0045

ADR-0045 remains in force: control-plane `allow` never bypasses kernel policy,
capabilities, or sandboxing. This ADR does not weaken
`secure-local-default`. It adds a separate kernel policy that is reachable only
through an explicitly bound capability, so the kernel remains authoritative.

## Consequences

- Ordinary local development continues to use the curated command policy until
  the isolated promotion gate is satisfied.
- Compromise of an Exec token that was not minted for
  `workspace-development` cannot select the wider command policy.
- Commands that need raw network or credential authority continue through
  typed, brokered effects rather than inheriting ambient host access.
- The profile is intentionally not equivalent to Codex
  `danger-full-access`, Claude Code `bypassPermissions`, or Hermes `yolo` on a
  local backend. Terminus remains fail-closed at the kernel and sandbox layers.

## Retained macOS boundary risk

The current Seatbelt backend is not a workspace-only filesystem boundary. It
also grants documented writes to shared package-manager caches and Darwin
per-user cache/temp paths so local toolchains function, and it permits broad
Mach service lookup for Darwin userland compatibility. Those allowances
predate this ADR and were already reachable through allowed package-manager
scripts, but arbitrary local commands make the exposure more obvious: a
hostile repository can attempt persistent cache poisoning or abuse a local
service as a confused deputy.

The user-facing claim is therefore only that host access remains OS-sandboxed,
not that the host is immutable. Before treating this profile as a high-trust
production containment boundary, either move writable caches to per-workspace
storage and narrow Mach lookup with adversarial probes, or run Terminus behind
an approved disposable VM/container boundary. This retained risk requires
security-owner review and is not silently reclassified as solved here.

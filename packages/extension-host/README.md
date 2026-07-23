# @terminus/extension-host

Isolated extension control. Per SPEC §35.9, §35.10.

## Public API

- `HookKind`: `observe_only`, `propose_annotation`, `propose_policy_input`,
  `propose_context_fragment`, `propose_tool_result_transform`, `veto`.
- `WasiExtensionHost`, `ProcessExtensionHost` — require `KernelExtensionPort`
  (no ambient in-process third-party execution).
- `InProcessExtensionHost` — builtin/first_party only.
- `HookRunner` — deterministic order, hard timeouts, crash→veto, transform conflicts fail.
- `installExtension` / `uninstallExtension` with SBOM + provenance; lifecycle
  scripts disabled for untrusted.

## Invariants

- Hooks receive immutable event views.
- Hook ordering is deterministic; wall-clock timeouts are enforced.
- Security policy uses the strictest applicable result.
- Non-security transform conflicts fail rather than depend on load order.
- Lifecycle scripts are denied by default for untrusted packages.

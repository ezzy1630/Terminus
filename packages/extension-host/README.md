# @terminus/extension-host

Isolated extension control. Per SPEC §35.9, §35.10.

## Public API

- `HookKind`: `observe_only`, `propose_annotation`, `propose_policy_input`,
  `propose_context_fragment`, `propose_tool_result_transform`, `veto`.
- `WasiExtensionHost`, `ProcessExtensionHost` — stubs that record invocations.
- `HookRunner` — runs hooks in deterministic order (priority then extension
  ID). Security policy uses the strictest applicable result. Non-security
  transform conflicts fail rather than depend on nondeterministic load order.
- `validateInstallation(input)` — validates an extension installation request
  (lifecycle scripts denied by default).

## Invariants

- Hooks receive immutable event views.
- Hook ordering is deterministic and recorded.
- Security policy uses the strictest applicable result.
- Non-security transform conflicts fail rather than depend on nondeterministic
  load order.
- Lifecycle scripts are denied by default.

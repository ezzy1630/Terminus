# @forge/policy-coordinator

High-level policy coordinator that translates task contracts into kernel
capability requests. Per SPEC §13, §36.

## Public API

- `PolicyCoordinator` with `authorizeEffect(intent, taskId, scope, principal)`,
  `requestApproval(operationHash, scope, risk, taskId, requestedBy,
  policyDecision)`, `resolveApproval(id, decision, decidedBy)`.
- `EffectIntent` shape (matches the kernel's `EffectIntent` proto).
- `KernelPolicyClient` interface — bridges to the kernel RPC client.
- `PolicyRepository` for persistence.

## Invariants

- Approval does not disable sandboxing. Sandboxing does not imply the action
  is authorized.
- A deny decision throws `PolicyDeniedError` immediately.
- A prompt decision creates an `Approval` record and throws
  `ApprovalRequiredError` with the approval id.
- "Always allow" requires a separate policy-edit flow, not a casual approval
  button.

# @forge/policy-coordinator — local rules

## Non-negotiable

- Approval does NOT disable sandboxing.
- Deny decisions throw `PolicyDeniedError` immediately.
- Prompt decisions throw `ApprovalRequiredError` with the approval id.
- "Always allow" requires a separate policy-edit flow.

## What NOT to add

- Direct kernel socket access (use `KernelPolicyClient`).
- Filesystem or process mutation.
- Bypass paths around policy.

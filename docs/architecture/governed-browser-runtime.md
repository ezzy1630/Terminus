# Governed browser runtime boundary

Terminus now reserves a dedicated `computer_use` capability and a versioned
`ComputerUseService` protocol with two operations:

- `Observe` returns an immutable browser observation shape: URL/title/viewport,
  a screenshot artifact, a semantic-tree artifact, semantic targets, explicit
  truncation/continuation fields, and a receipt reference.
- `Act` accepts only `navigate`, `click`, `type_text`, `scroll`, or `wait`, and
  carries the observation id and version that authorize the action.

The current kernel build intentionally does not claim browser execution. The
HTTP boundary validates the capability, origin, action vocabulary, semantic
target requirement, and all bounds, then returns `sandbox_unavailable` without
launching a process or manufacturing receipts. The gRPC service is additive in
the canonical protocol; its runtime adapter remains disabled until it can
provide all of the following in one kernel-owned lease:

1. a pinned browser executable and a fresh, non-reused profile per task;
2. proxy-bound egress with DNS rebinding and private/loopback address denial;
3. CDP/automation transport owned by the kernel rather than the control plane;
4. immutable screenshot and semantic-tree artifacts with durable signed
   observation/action receipts; and
5. cleanup and crash recovery that prove the profile and process cannot leak
   into another task.

Google Chrome is installed on the development host, but that alone is not an
admissible runtime: a desktop-installed browser does not provide the required
proxy, profile isolation, receipt verification, or kernel-owned transport.
Enabling the adapter therefore requires a separate security/evaluation change
and the two approvals required for sandboxing and network policy changes.

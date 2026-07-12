# Product modes

Forge supports eight product modes (SPEC §26.2). Each mode is a **policy profile** over the same domain model; it is not a separate implementation. A client MUST display the effective mode, sandbox backend, network policy, active worktree, budget, and whether enforcement is degraded.

## Mode table (SPEC §26.2)

| Mode | Purpose | Writable effects | Network | Agents | Default verification |
|---|---|---:|---:|---:|---|
| `explain` | Read-only questions and repository orientation | none | deny unless research requested | one | source coverage |
| `plan` | Produce a task contract and implementation plan | none | scoped | one plus optional read-only scout | plan consistency |
| `edit` | Ordinary local code changes | active worktree only | deny by default | one | parse, diagnostics, narrow tests |
| `autonomous` | Longer bounded implementation | active isolated worktree | brokered allowlist | selective | task-specific verification DAG |
| `review` | Detached code/security review | none | deny by default | reviewer only | evidence-backed findings |
| `research` | External and repository research | artifact writes only | brokered allowlist | selective scouts | source quality and claim coverage |
| `eval` | Controlled benchmark run | disposable environment | suite-defined | suite-defined | hidden grader |
| `admin` | Explicitly privileged maintenance | policy-defined | policy-defined | policy-defined | mandatory audit and approval |

`admin` MUST NOT be the default.

## Mode details

### `explain`

Read-only. The model can read files, search, and inspect, but cannot modify, execute, or access the network. Used for "how does this work?" questions. Verification: source coverage (the answer cites real source).

### `plan`

Read-only with optional read-only scout. Produces a task contract (Appendix E.1) and implementation plan. No writable effects. Network is scoped (e.g., to read documentation). Verification: plan consistency (the plan matches the contract and acceptance criteria).

### `edit`

Ordinary local code changes. Writable effects are limited to the active worktree. Network is denied by default. Single agent. Verification: parse, diagnostics, narrow tests (fast feedback).

### `autonomous`

Longer bounded implementation. Writable effects in an isolated worktree. Network is brokered with an allowlist. Selective agents (scouts, writers, reviewer per ADR-0020). Verification: task-specific verification DAG (ADR-0021).

### `review`

Detached code/security review. No writable effects. Network denied by default. Reviewer only (no writer). Verification: evidence-backed findings (the reviewer's findings cite real code).

### `research`

External and repository research. Artifact writes only (no worktree mutation). Network is brokered with an allowlist. Selective scouts. Verification: source quality and claim coverage (claims cite real sources).

### `eval`

Controlled benchmark run. Disposable environment (digest-pinned container/micro-VM, ADR-0027). Network is suite-defined. Agents are suite-defined. Verification: hidden grader (the grader is never projected to model context, SPEC §41.4).

### `admin`

Explicitly privileged maintenance. Used for: database migrations, sandbox backend changes, secret rotation, extension installation, policy profile changes. Writable effects and network are policy-defined. Agents are policy-defined. Verification: mandatory audit and approval (every admin action is audited and requires approval).

## Mode selection

- The default mode for a new session is `edit` (for coding) or `explain` (for read-only questions).
- The user can switch modes via the client UI.
- `admin` mode requires explicit user action (it is never the default).
- `eval` mode is entered only via the eval lab (`forge-eval` CLI).
- Mode changes are recorded in the audit log.

## Enforcement

The mode is a policy profile (SPEC §36.4). The policy coordinator (`packages/policy-coordinator`) compiles the effective policy from:

```
platform authority
  ↓
organization policy
  ↓
workspace policy
  ↓
session mode policy
  ↓
task contract
```

Lower layers cannot weaken non-overridable organization or platform controls (SPEC Appendix F). The effective configuration and provenance are inspectable.

## Related

- `docs/product/objectives.md` — product objectives.
- `docs/architecture/orchestration.md` — orchestration and verification per mode.
- SPEC §26.2 (product modes), §36.4 (default policy profile), Appendix F (reference configuration).

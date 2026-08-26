# ADR-0050: Lifecycle hooks contract and admission

- **Status:** ADOPTED
- **Date:** 2026-08-26
- **Decision owner:** plugin / extension architecture owner
- **Supersedes:** none
- **Related:** SPEC §12, §35; ADR-0018; ADR-0019

## Context

Extensions and third-party harnesses (such as Codex hooks, OpenCode plugins, and Grok build hooks) require intercepted lifecycle events around tool execution, turn transitions, permissions, and context compaction.

## Decision

1. Add lifecycle hook contract in `@terminus/adapter-sdk`:
   - `HookPoint`: `tool.execute.before`, `tool.execute.after`, `turn.started`, `turn.completed`, `permission.ask`, `session.compacting`, `provider.attempt`.
   - `HookDispatcher`: stable execution order by priority and registration order.
   - Strict size boundary: `MAX_HOOK_PAYLOAD_BYTES = 128 KB` to prevent memory exhaustion or unbounded mutation.
   - Bounded execution timeout (`DEFAULT_HOOK_TIMEOUT_MS = 5000ms`).
   - Supports pipeline status: `allow`, `modify` (with validated transformed payload), and `abort`.
2. Admission control: untrusted plugins or extensions must declare required hook capabilities and are isolated from ambient authority.

## Consequences

- Extensions can safely inspect or mutate parameters at well-defined lifecycle boundaries.
- Hook failures and timeouts are captured in structured execution reports without crashing the control plane.

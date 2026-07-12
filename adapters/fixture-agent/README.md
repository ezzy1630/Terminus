# Fixture Agent Adapter

The fixture-agent adapter profile describes Terminus's deterministic
no-model test double (SPEC §35.11, §41.2). The fixture agent is NOT a
real coding agent; it is a test fixture used by the eval lab to
regression-test the harness itself.

## Capability profile summary

The fixture agent has full context visibility, full tool interception,
native enforcement of every control, native session resume, native
typed results, complete artifact export, reliable cancellation, and
controlled model selection. It is the canonical "perfect" adapter:
every control is native, every capability is observed exactly as
declared, and there are zero discrepancies.

## When to use

The fixture agent is enabled only in the eval lab. It is used:
- to regression-test the harness end-to-end (kernel, control plane,
  eval lab) without depending on a real provider;
- as the upper bound for adapter fidelity in the promotion gate;
- as the deterministic baseline in harness-controlled comparisons
  where the comparison is between two harness configurations, not
  between two models.

## Why no model

The fixture agent replays a recorded trajectory. There is no model
call. This makes eval runs deterministic, free, and fast — ideal for
regression testing. The trade-off is that the fixture agent cannot
exercise model-dependent behavior (prompt sensitivity, tool-call
discipline); for those, use the real baselines (terminus-minimal,
terminus-full, Codex, Claude Code, Pi, Oh My Pi, OpenHands).

## Runner

The adapter is implemented as a JSON-RPC 2.0-over-stdio process in
`runner.ts` (SPEC §30.1 Boundary C). Launch it with Bun:

```bash
bun run adapters/fixture-agent/runner.ts
```

Lifecycle methods: `initialize` (returns the capability profile), `run`
(streams `adapter/event` notifications then returns an `AdapterResult`),
`cancel`, and `shutdown`. `run` accepts an optional `trajectoryPath` to
replay a recorded trajectory; without one it performs a deterministic no-op
run. A `--selftest` flag runs a canned `initialize` exchange and exits 0.

The runner uses only `node:readline` and read-only `node:fs` (for the
trajectory); it is intended to run inside an outer Terminus sandbox.

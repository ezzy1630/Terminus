# Fixture Agent Adapter

The fixture-agent adapter profile describes Forge's deterministic
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
discipline); for those, use the real baselines (forge-minimal,
forge-full, Codex, Claude Code, Pi, Oh My Pi, OpenHands).

# Codex Adapter

The Codex adapter profile describes the OpenAI Codex harness as an
external worker (SPEC §12.4, §35.11, §35.12). Terminus delegates a
well-scoped task contract to Codex; Codex runs in a disposable
worktree with explicit budgets and a permitted capability set. Terminus
independently inspects the final workspace, collects artifacts, and
runs verification — Codex's self-report is not sufficient evidence.

## Capability profile summary

Codex has strong native session-resume, typed tool events, and
cancellation. Its context visibility is partial (Terminus cannot see the
full prompt Codex sends to the model), its model selection is opaque
(Codex chooses the model unless Terminus constrains it), and its
filesystem/network/secret enforcement is weaker than Terminus's. Terminus
therefore supplies an outer sandbox and brokered network; the adapter
is enabled only when those outer controls are active.

## Discrepancies

Live probes detected four discrepancies between declared and observed
capabilities. Each is surfaced in the UI; the adapter is disabled
until Terminus's outer controls compensate.

## When to use

Codex is selected for special strengths (strong implementer, fast
session resume) on tasks where Terminus can supply the missing controls.
It is NOT selected for untrusted repositories or for tasks touching
secrets, network, or external state.

# test-run

Run the narrowest test subset that exercises the current change.

## When to use

Use this skill after applying a patch to verify the change. The skill prefers
narrow targeted tests over the full suite to keep wall-clock and token cost
low. It escalates to the full suite only when the verification plan demands it.

## Inputs

- The set of files modified by the most recent patch transaction.
- The verification plan for the active task (or a synthesized one).
- Optional explicit test selector from the model.

## Procedure

1. Ask the kernel `CODE_INTEL_INSPECT` for symbols/tests reachable from each
   modified file via the test dependency graph.
2. Build a candidate command for the workspace's native runner:
   - `cargo test <name>` for Rust
   - `pytest -k <expr>` for Python
   - `pnpm test -- <pattern>` / `vitest run <pattern>` for TS/JS
   - `go test -run <regex> ./...` for Go
3. Classify the command with the policy engine. Test commands for the active
   worktree typically resolve to `allow_with_constraints` (max runtime, output
   size, redaction of common secret env vars).
4. Submit the command via `EXEC_RUN` with the constraint envelope.
5. Capture the structured test report artifact and surface a compact summary:
   pass/fail/error counts, failing test names, and a pointer to the artifact.

## Important rules

- Always pass `--no-color` / `NO_COLOR=1` so the report parses cleanly.
- Never pipe output through a shell; let the kernel capture it directly.
- If the runner writes artifacts (junit XML, tap), keep them and reference them
  in the result envelope; do not paste their content into the transcript.
- If a test would touch the network, the policy engine will deny; do not
  attempt to bypass by setting env vars.

## Failure modes

- `POLICY_DENIED` — the proposed command touched a denied path or env var.
  Resubmit with a narrower selector.
- `TIMEOUT` — the test subset exceeded the runtime constraint. Surface the
  timeout and let the model decide whether to split the run further.
- `BUDGET_EXHAUSTED` — the task budget for compute seconds is exhausted.

## Output

A test result fragment containing pass/fail/error counts, the failing tests,
and the artifact URI of the full report. Never paraphrase the failure message;
include it verbatim from the report artifact.

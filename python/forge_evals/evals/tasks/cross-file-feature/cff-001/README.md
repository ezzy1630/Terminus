        # Add retry option to client and propagate to call sites

        Cohort: `cross_file_feature` (SPEC §41.3).

        Add a `retry: int = 0` keyword argument to `Client.request()` in `src/client.py`. Update all three call sites in `src/api.py`, `src/cli.py`, and `src/scheduler.py` to pass `retry=3` for idempotent operations.

The function signature change must be backward-compatible (default value preserves existing behaviour).


        ## Files

        - `task.yaml` — task metadata, budgets, secrets, grader version.
        - `prompt.md` — the prompt shown to the agent.
        - `environment.lock` — pinned environment (Python, system deps).
        - `setup.sh` — workspace setup script (run before the agent).
        - `grader/run.py` — the grader entrypoint (SPEC §41.11 ScriptGrader).
        - `hidden/` — hidden test files (never projected into model context).
        - `expected-properties.yaml` — post-run expected property invariants.
        - `policy.yaml` — policy rule overrides for this task.

        This is a *synthetic* minimal task package (audit A3 fix #5). It is
        self-contained and can be graded without a real agent loop.

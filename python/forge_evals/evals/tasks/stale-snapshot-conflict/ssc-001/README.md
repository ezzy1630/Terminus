        # Resolve stale snapshot edit conflict

        Cohort: `stale_snapshot_conflict` (SPEC §41.3).

        An edit to `src/config.py` was based on a stale snapshot of the file. The current HEAD has a different version of the line you tried to edit. The agent's patch failed to apply cleanly.

Re-read `src/config.py` from disk, identify the conflict, and redo the edit so the patch applies. The intent is to change `DEFAULT_TIMEOUT = 30` to `DEFAULT_TIMEOUT = 60`.


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

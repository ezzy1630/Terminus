        # Add type annotations to 5 independent modules

        Cohort: `parallelizable_task` (SPEC §41.3).

        Add type annotations to 5 modules that have no interdependencies:
- src/strings.py
- src/numbers.py
- src/dates.py
- src/paths.py
- src/hashes.py

Each module can be annotated independently. A parallel agent should be able to dispatch one sub-agent per module.


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

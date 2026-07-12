        # Fix failing test in unseen repo

        Cohort: `unfamiliar_repository` (SPEC §41.3).

        The test suite is failing: `tests/test_calc.py::test_divide_by_zero` expects `Calculator.divide(1, 0)` to raise `ZeroDivisionError`, but the current implementation returns `float('inf')`.

Fix `src/calc.py` so that dividing by zero raises `ZeroDivisionError`.


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

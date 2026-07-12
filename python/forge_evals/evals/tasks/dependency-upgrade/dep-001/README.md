        # Upgrade pydantic from 1.x to 2.x

        Cohort: `dependency_upgrade` (SPEC §41.3).

        Upgrade `pydantic` from 1.x to 2.x. Update `src/models.py` to use the new v2 API:
- Replace `class Config:` with `model_config = ConfigDict(...)`
- Replace `.dict()` calls with `.model_dump()`
- Replace `.parse_obj()` calls with `.model_validate()`

Update `pyproject.toml` to require `pydantic>=2.0`.


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

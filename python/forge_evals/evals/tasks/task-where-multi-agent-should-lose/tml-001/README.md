        # Coordinated refactor that punishes over-parallelization

        Cohort: `task_where_multi_agent_should_lose` (SPEC §41.3).

        Refactor `src/pipeline.py` so that all 5 stages (extract, transform, validate, load, report) share a single `Context` object instead of passing 12 individual parameters.

This task has tight cross-cutting coupling: a multi-agent approach that dispatches one sub-agent per stage will produce inconsistent Context field names and fail. A single-agent approach (or a careful sequential plan) succeeds.


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

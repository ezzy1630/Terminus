        # Complete feature after context compaction

        Cohort: `compaction_mid_implementation` (SPEC §41.3).

        Context was compacted mid-implementation. The plan called for adding a `--verbose` flag to the CLI. The flag parser was added to `src/cli.py` but the handler was not.

Wire up the `--verbose` flag in `src/cli.py` so that passing it sets the log level to DEBUG. Verify with `python -m src.cli --verbose --help`.


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

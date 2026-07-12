        # Generate tests for parser edge cases

        Cohort: `test_generation` (SPEC §41.3).

        Generate pytest tests for `src/parser.py`. Cover at minimum:
- empty input
- input with only whitespace
- input with a single token
- input with trailing newline
- input with unicode characters

Write the tests to `tests/test_parser.py`. The tests must pass against the current implementation.


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

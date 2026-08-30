# Fix missing import causing compile error

Cohort: `build_failure` (SPEC §41.3).

The build is broken: `src/main.py` references `sys.exit` but does not `import sys`. Add the missing import. The build must succeed with `python -c 'import src.main'`.


## Files

- `task.yaml` — task metadata, budgets, secrets, grader version.
- `prompt.md` — the prompt shown to the agent.
- `environment.lock` — pinned environment (Python, system deps).
- `setup.sh` — workspace setup script (run before the agent).
- `grader/run.py` — the grader entrypoint (SPEC §41.11 ScriptGrader).
- `hidden/` — hidden test files (never projected into model context).
- `expected-properties.yaml` — post-run expected property invariants.
- `policy.yaml` — policy rule overrides for this task.

This is a deterministic local fixture. `setup.sh` creates a small Python
repository with an import-time defect; the grader imports the module and runs
its behavior tests. The private regression test is staged only while grading.

# Fix missing import causing compile error

Task ID: `build-001`

The build is broken: `src/main.py` references `sys.exit` but does not `import sys`. Add the missing import. The build must succeed with `python -c 'import src.main'`.


## Acceptance criteria

The grader checks that the changes described above have been applied.
See `grader/run.py` for the exact checks.

## Out of scope

- Any change not described above.
- Network egress (unless explicitly allowed in `task.yaml`).
- Reading or modifying files under `hidden/`.

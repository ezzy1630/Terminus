# Fix missing import causing an import-time build failure

Task ID: `build-001`

The build is broken: `src/main.py` references `sys.exit` but does not `import sys`. Add the missing import. The build must succeed with `python -c 'import src.main'` and `pytest -q`.


## Acceptance criteria

The grader imports the module and executes the behavior tests. It does not
accept a comment or a matching string as a fix.

## Out of scope

- Any change not described above.
- Network egress (unless explicitly allowed in `task.yaml`).
- Reading or modifying files under `hidden/`.

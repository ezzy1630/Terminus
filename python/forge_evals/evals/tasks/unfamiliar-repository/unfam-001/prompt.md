        # Fix failing test in unseen repo

        Task ID: `unfam-001`

        The test suite is failing: `tests/test_calc.py::test_divide_by_zero` expects `Calculator.divide(1, 0)` to raise `ZeroDivisionError`, but the current implementation returns `float('inf')`.

Fix `src/calc.py` so that dividing by zero raises `ZeroDivisionError`.


        ## Acceptance criteria

        The grader checks that the changes described above have been applied.
        See `grader/run.py` for the exact checks.

        ## Out of scope

        - Any change not described above.
        - Network egress (unless explicitly allowed in `task.yaml`).
        - Reading or modifying files under `hidden/`.

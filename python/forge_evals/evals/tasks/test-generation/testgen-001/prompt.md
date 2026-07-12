        # Generate tests for parser edge cases

        Task ID: `testgen-001`

        Generate pytest tests for `src/parser.py`. Cover at minimum:
- empty input
- input with only whitespace
- input with a single token
- input with trailing newline
- input with unicode characters

Write the tests to `tests/test_parser.py`. The tests must pass against the current implementation.


        ## Acceptance criteria

        The grader checks that the changes described above have been applied.
        See `grader/run.py` for the exact checks.

        ## Out of scope

        - Any change not described above.
        - Network egress (unless explicitly allowed in `task.yaml`).
        - Reading or modifying files under `hidden/`.

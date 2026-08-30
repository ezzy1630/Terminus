        # Generate tests for parser edge cases

        Task ID: `testgen-001`

        Generate pytest tests for `src/parser.py`. Cover at minimum:
- empty input
- input with only whitespace
- input with a single token
- input with trailing newline
- input with unicode characters

Write the tests to `tests/test_parser.py`. The tests must pass against the current implementation and should assert the returned token lists, not just that the function can be called. Keep the production parser unchanged.


        ## Acceptance criteria

        The grader runs the submitted tests and mutation checks that each requested
        edge case is genuinely protected. Comments, names, and matching strings do
        not count as coverage.

        ## Out of scope

        - Any change not described above.
        - Network egress (unless explicitly allowed in `task.yaml`).
        - Reading or modifying files under `hidden/`.

        # Complete feature after context compaction

        Task ID: `cmi-001`

        Context was compacted mid-implementation. The plan called for adding a `--verbose` flag to the CLI. The flag parser was added to `src/cli.py` but the handler was not.

Wire up the `--verbose` flag in `src/cli.py` so that passing it sets the log level to DEBUG. Verify with `python -m src.cli --verbose --help`.


        ## Acceptance criteria

        The grader checks that the changes described above have been applied.
        See `grader/run.py` for the exact checks.

        ## Out of scope

        - Any change not described above.
        - Network egress (unless explicitly allowed in `task.yaml`).
        - Reading or modifying files under `hidden/`.

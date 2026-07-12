        # Add type annotations to 5 independent modules

        Task ID: `pt-001`

        Add type annotations to 5 modules that have no interdependencies:
- src/strings.py
- src/numbers.py
- src/dates.py
- src/paths.py
- src/hashes.py

Each module can be annotated independently. A parallel agent should be able to dispatch one sub-agent per module.


        ## Acceptance criteria

        The grader checks that the changes described above have been applied.
        See `grader/run.py` for the exact checks.

        ## Out of scope

        - Any change not described above.
        - Network egress (unless explicitly allowed in `task.yaml`).
        - Reading or modifying files under `hidden/`.

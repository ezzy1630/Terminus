        # Resume interrupted refactor after checkpoint

        Task ID: `ir-001`

        A previous agent session was interrupted while renaming `getUserData` to `fetch_user_data` across the codebase. The checkpoint shows 4 of 6 call sites updated.

Resume the refactor: update the remaining 2 call sites in `src/handlers/profile.py` and `src/handlers/admin.py`. The build and test suite must pass after the rename.


        ## Acceptance criteria

        The grader checks that the changes described above have been applied.
        See `grader/run.py` for the exact checks.

        ## Out of scope

        - Any change not described above.
        - Network egress (unless explicitly allowed in `task.yaml`).
        - Reading or modifying files under `hidden/`.

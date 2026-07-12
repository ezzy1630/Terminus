        # Resolve stale snapshot edit conflict

        Task ID: `ssc-001`

        An edit to `src/config.py` was based on a stale snapshot of the file. The current HEAD has a different version of the line you tried to edit. The agent's patch failed to apply cleanly.

Re-read `src/config.py` from disk, identify the conflict, and redo the edit so the patch applies. The intent is to change `DEFAULT_TIMEOUT = 30` to `DEFAULT_TIMEOUT = 60`.


        ## Acceptance criteria

        The grader checks that the changes described above have been applied.
        See `grader/run.py` for the exact checks.

        ## Out of scope

        - Any change not described above.
        - Network egress (unless explicitly allowed in `task.yaml`).
        - Reading or modifying files under `hidden/`.

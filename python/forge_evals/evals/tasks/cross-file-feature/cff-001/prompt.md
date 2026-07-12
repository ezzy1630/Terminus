        # Add retry option to client and propagate to call sites

        Task ID: `cff-001`

        Add a `retry: int = 0` keyword argument to `Client.request()` in `src/client.py`. Update all three call sites in `src/api.py`, `src/cli.py`, and `src/scheduler.py` to pass `retry=3` for idempotent operations.

The function signature change must be backward-compatible (default value preserves existing behaviour).


        ## Acceptance criteria

        The grader checks that the changes described above have been applied.
        See `grader/run.py` for the exact checks.

        ## Out of scope

        - Any change not described above.
        - Network egress (unless explicitly allowed in `task.yaml`).
        - Reading or modifying files under `hidden/`.

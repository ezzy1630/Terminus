# Add retry option to client and propagate it across call sites

        Task ID: `cff-001`

        Add a `retry: int = 0` keyword argument to `Client.request()` in `src/client.py`. Update all three call sites in `src/api.py`, `src/cli.py`, and `src/scheduler.py` to pass `retry=3` for idempotent operations.

The function signature change must be backward-compatible (default value
preserves existing behavior). Do not change the request paths or return shape.


        ## Acceptance criteria

The grader calls the client and all three entry points with a recording
transport. It checks the actual keyword values and existing behavior; comments
and matching strings do not count.

        ## Out of scope

        - Any change not described above.
        - Network egress (unless explicitly allowed in `task.yaml`).
        - Reading or modifying files under `hidden/`.

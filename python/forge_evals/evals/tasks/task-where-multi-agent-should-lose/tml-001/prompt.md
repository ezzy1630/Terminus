        # Coordinated refactor that punishes over-parallelization

        Task ID: `tml-001`

        Refactor `src/pipeline.py` so that all 5 stages (extract, transform, validate, load, report) share a single `Context` object instead of passing 12 individual parameters.

This task has tight cross-cutting coupling: a multi-agent approach that dispatches one sub-agent per stage will produce inconsistent Context field names and fail. A single-agent approach (or a careful sequential plan) succeeds.


        ## Acceptance criteria

        The grader checks that the changes described above have been applied.
        See `grader/run.py` for the exact checks.

        ## Out of scope

        - Any change not described above.
        - Network egress (unless explicitly allowed in `task.yaml`).
        - Reading or modifying files under `hidden/`.

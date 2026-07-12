        # Upgrade pydantic from 1.x to 2.x

        Task ID: `dep-001`

        Upgrade `pydantic` from 1.x to 2.x. Update `src/models.py` to use the new v2 API:
- Replace `class Config:` with `model_config = ConfigDict(...)`
- Replace `.dict()` calls with `.model_dump()`
- Replace `.parse_obj()` calls with `.model_validate()`

Update `pyproject.toml` to require `pydantic>=2.0`.


        ## Acceptance criteria

        The grader checks that the changes described above have been applied.
        See `grader/run.py` for the exact checks.

        ## Out of scope

        - Any change not described above.
        - Network egress (unless explicitly allowed in `task.yaml`).
        - Reading or modifying files under `hidden/`.

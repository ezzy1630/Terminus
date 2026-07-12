        # Migrate SQLite schema from v1 to v2

        Task ID: `mig-001`

        Apply migration `0002_add_user_email.sql` to the SQLite schema. The migration adds a non-null `email` column to the `users` table with a default value of `''`.

Write the migration to `migrations/sqlite/0002_add_user_email.sql` and update `prisma/schema.prisma` to match.


        ## Acceptance criteria

        The grader checks that the changes described above have been applied.
        See `grader/run.py` for the exact checks.

        ## Out of scope

        - Any change not described above.
        - Network egress (unless explicitly allowed in `task.yaml`).
        - Reading or modifying files under `hidden/`.

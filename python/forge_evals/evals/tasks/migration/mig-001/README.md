        # Migrate SQLite schema from v1 to v2

        Cohort: `migration` (SPEC §41.3).

        Apply migration `0002_add_user_email.sql` to the SQLite schema. The migration adds a non-null `email` column to the `users` table with a default value of `''`.

Write the migration to `migrations/sqlite/0002_add_user_email.sql` and update `prisma/schema.prisma` to match.


        ## Files

        - `task.yaml` — task metadata, budgets, secrets, grader version.
        - `prompt.md` — the prompt shown to the agent.
        - `environment.lock` — pinned environment (Python, system deps).
        - `setup.sh` — workspace setup script (run before the agent).
        - `grader/run.py` — the grader entrypoint (SPEC §41.11 ScriptGrader).
        - `hidden/` — hidden test files (never projected into model context).
        - `expected-properties.yaml` — post-run expected property invariants.
        - `policy.yaml` — policy rule overrides for this task.

        This is a *synthetic* minimal task package (audit A3 fix #5). It is
        self-contained and can be graded without a real agent loop.

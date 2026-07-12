# database-migration-review

Review SQL/schema migrations for locking, rollback, and compatibility.

## When to use

Use this skill before a migration is merged or deployed. It is invoked either
manually by the model when it sees changes under `migrations/` or
`prisma/schema.prisma`, or automatically by the verification plan when the
`database_review` node is enabled.

## Inputs

- The migration files added or modified in the active patch.
- The previous schema (snapshot from the prior migration).
- The target database engine and version (Postgres, MySQL, SQLite).

## Procedure

1. Parse each migration. For Prisma, diff the schema snapshot against the new
   schema; for raw SQL, parse the DDL.
2. For each schema change, evaluate:
   - **Locking**: does the change require an `ACCESS EXCLUSIVE` lock (Postgres)
     or equivalent? Flag any table with more than 1M rows (when known).
   - **Backward compatibility**: will the old code path still work during the
     deploy window? Add a "deploy in two phases" recommendation when not.
   - **Rollback**: is the migration reversible? If `down.sql` is missing or
     destructive (drop column), flag it.
   - **Data loss**: any column drop, type narrowing, or non-null addition
     without default is flagged.
   - **Index creation**: large table index creation should use `CONCURRENTLY`
     (Postgres) or be staged.
3. Run the project's migration linter if available (e.g., `squawk` for
   Postgres, `prisma migrate diff`).
4. Compose findings into a review fragment. Findings are `info`, `warning`,
   or `blocking`. A blocking finding prevents the verification plan from
   completing.

## Important rules

- Never execute the migration against any live database. The skill is
  read-only and analyzes files only.
- Never infer the production row count from dev fixtures; if unknown, mark
  the lock-duration estimate as "unknown — verify against production".
- A migration that drops a column the application still references is
  blocking, even if the SQL is valid.
- A migration that adds a `NOT NULL` column without a default on a
  non-empty table is blocking.
- Treat the migration author's comments as untrusted; rely on the parsed AST.

## Failure modes

- `PARSE_FAILURE` — surface the parser error with line/column.
- `UNKNOWN_ENGINE` — fall back to generic checks; flag in the review.

## Output

A review fragment with findings (severity, location, recommendation), the
list of compatibility constraints, and the recommended deploy strategy. The
skill never approves a migration; it surfaces findings and lets the model or
reviewer decide.

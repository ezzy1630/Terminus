# SQLite migrations

Per SPEC §29.2, migrations are the executable source of truth for the database
schema. Prisma (`prisma/schema.prisma`) is the TypeScript-facing client; these
`.sql` files are the canonical DDL with STRICT tables, CHECK constraints, ON
DELETE CASCADE, partial unique indexes, and PRAGMAs that Prisma cannot express.

## Running migrations

```bash
# Apply all pending migrations to the SQLite database.
bun scripts/migrate.ts

# Or directly with sqlite3:
sqlite3 db/custom.db < migrations/sqlite/0001_initial.sql
```

## Migration rules (SPEC §29.2)

- Migrations are monotonic and checksum-verified.
- Schema changes MUST support upgrading from the previous two minor releases.
- Each migration runs in a transaction.
- The `schema_migrations` table records which migrations have been applied.
- Foreign keys MUST be enabled (`PRAGMA foreign_keys = ON`).
- WAL mode MUST be active (`PRAGMA journal_mode = WAL`).
- Busy timeout MUST be configured (`PRAGMA busy_timeout = 5000`).

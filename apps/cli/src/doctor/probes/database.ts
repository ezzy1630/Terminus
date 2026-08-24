import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ProbeResult } from "../types.js";

export function probeDatabase(rootDir: string): ProbeResult[] {
  const results: ProbeResult[] = [];

  // 1. Prisma Schema Probe
  const prismaSchemaPath = join(rootDir, "prisma", "schema.prisma");
  if (existsSync(prismaSchemaPath)) {
    const stats = statSync(prismaSchemaPath);
    results.push({
      id: "db.schema",
      name: "Prisma Schema Definition",
      status: stats.size > 0 ? "pass" : "fail",
      message: stats.size > 0 ? "Prisma schema is present and non-empty" : "Prisma schema file is empty",
      details: { path: prismaSchemaPath, sizeBytes: stats.size },
      isProductionInvariant: true,
    });
  } else {
    results.push({
      id: "db.schema",
      name: "Prisma Schema Definition",
      status: "fail",
      message: "prisma/schema.prisma not found",
      recommendation: "Ensure prisma/schema.prisma exists in the repository root",
      isProductionInvariant: true,
    });
  }

  // 2. SQLite Migrations Probe
  const migrationsDir = join(rootDir, "migrations", "sqlite");
  if (existsSync(migrationsDir)) {
    const sqlFiles = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
    if (sqlFiles.length >= 10) {
      results.push({
        id: "db.migrations",
        name: "SQLite Schema Migrations",
        status: "pass",
        message: `Found ${sqlFiles.length} canonical SQLite migrations (0001 through 0010)`,
        details: { count: sqlFiles.length, migrations: sqlFiles },
        isProductionInvariant: true,
      });
    } else {
      results.push({
        id: "db.migrations",
        name: "SQLite Schema Migrations",
        status: "warn",
        message: `Expected at least 10 migrations, found ${sqlFiles.length}`,
        details: { count: sqlFiles.length, migrations: sqlFiles },
        recommendation: "Verify migrations under migrations/sqlite/",
        isProductionInvariant: true,
      });
    }
  } else {
    results.push({
      id: "db.migrations",
      name: "SQLite Schema Migrations",
      status: "fail",
      message: "migrations/sqlite directory not found",
      recommendation: "Ensure migrations/sqlite exists with canonical SQL files",
      isProductionInvariant: true,
    });
  }

  // 3. Database URL and SQLite Storage Access
  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl) {
    results.push({
      id: "db.connection",
      name: "Database Connection Configuration",
      status: "pass",
      message: `DATABASE_URL is configured (${dbUrl.startsWith("file:") ? "SQLite file" : "custom provider"})`,
      details: { url: dbUrl },
      isProductionInvariant: false,
    });
  } else {
    results.push({
      id: "db.connection",
      name: "Database Connection Configuration",
      status: "warn",
      message: "DATABASE_URL is not explicitly set; defaulting to local dev SQLite",
      recommendation: "Set DATABASE_URL in environment or .env for custom database location",
      isProductionInvariant: false,
    });
  }

  return results;
}

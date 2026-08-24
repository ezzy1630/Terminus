import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { runControlMigrations } from "../../migrations/control-runtime";

declare const __TERMINUS_CONTROL_BUILD_VERSION__: string;
declare const __TERMINUS_CONTROL_BUILD_COMMIT__: string;
declare const __TERMINUS_CONTROL_BUILD_TARGET__: string;
declare const __TERMINUS_CONTROL_BUILD_SOURCE_CLEAN__: boolean;

function runtimeRoot(): string {
  return dirname(dirname(process.execPath));
}

function defaultDatabaseUrl(): string {
  return `file:${process.env.HOME ?? process.cwd()}/.local/share/terminus/terminus.db`;
}

function configurePackagedPrismaEngine(root: string): void {
  const engine = join(root, "lib", "terminus", "query-engine.node");
  if (!existsSync(engine)) throw new Error(`packaged Prisma query engine is missing: ${engine}`);
  process.env.PRISMA_QUERY_ENGINE_LIBRARY = engine;
}

function usage(): string {
  return [
    "usage: terminus-control <command>",
    "",
    "commands:",
    "  migrate   apply checksum-verified SQLite migrations, then exit",
    "  serve     start the Terminus control service",
    "  version   print packaged runtime identity",
  ].join("\n");
}

const command = process.argv[2];
const root = runtimeRoot();
switch (command) {
  case "migrate": {
    if (process.argv.length !== 3) throw new Error("migrate accepts no positional arguments");
    const result = runControlMigrations(
      process.env.DATABASE_URL ?? defaultDatabaseUrl(),
      join(root, "share", "terminus", "migrations", "sqlite"),
    );
    console.log(`migrations complete: ${result.applied} applied, ${result.total} total`);
    break;
  }
  case "serve":
    if (process.argv.length !== 3) throw new Error("serve accepts no positional arguments");
    configurePackagedPrismaEngine(root);
    await import("../../mini-services/terminus-control/src/index");
    break;
  case "version":
  case "--version":
    console.log(JSON.stringify({
      schema: "terminus.control-runtime.identity.v1",
      version: __TERMINUS_CONTROL_BUILD_VERSION__,
      candidate_commit: __TERMINUS_CONTROL_BUILD_COMMIT__,
      source_tree_clean: __TERMINUS_CONTROL_BUILD_SOURCE_CLEAN__,
      target: __TERMINUS_CONTROL_BUILD_TARGET__,
    }));
    break;
  case "help":
  case "--help":
  case "-h":
    console.log(usage());
    break;
  default:
    console.error(usage());
    process.exitCode = 2;
}

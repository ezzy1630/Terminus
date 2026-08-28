#!/usr/bin/env bun
/**
 * changed.ts — targeted, incremental contract & schema codegen.
 *
 * Inspects modified files and only executes the necessary codegen targets,
 * dramatically accelerating inner development loops when editing domain
 * aggregates, proto definitions, configs, or events.
 *
 * Usage:
 *   bun run tools/codegen/changed.ts           # run targeted generators for modified files
 *   bun run tools/codegen/changed.ts --all     # run full codegen suite
 *   bun run tools/codegen/changed.ts --dry-run # show targets that would run
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const ROOT = process.env.TERMINUS_ROOT ?? process.env.FORGE_ROOT ?? join(import.meta.dir, "..", "..");

interface CodegenTarget {
  id: string;
  description: string;
  command: string[];
  patterns: RegExp[];
}

const TARGETS: CodegenTarget[] = [
  {
    id: "proto",
    description: "Protobuf types and descriptor sets",
    command: ["buf", "generate", "proto"],
    patterns: [/^proto\//],
  },
  {
    id: "v2-schemas",
    description: "ARP v2 JSON Schemas and registry",
    command: ["bun", "run", "tools/codegen/v2-schemas.ts"],
    patterns: [
      /^packages\/domain\//,
      /^schemas\/v2\//,
      /^tools\/codegen\/v2-schemas\.ts/,
    ],
  },
  {
    id: "public-api",
    description: "Public API contract & markdown catalog",
    command: ["bun", "run", "tools/codegen/public-api.ts"],
    patterns: [
      /^packages\/public-api\//,
      /^packages\/public-client\//,
      /^tools\/codegen\/public-api\.ts/,
    ],
  },
  {
    id: "events",
    description: "Event catalog types, schemas, and fixtures",
    command: ["bun", "run", "tools/codegen/events.ts"],
    patterns: [
      /^packages\/runtime-protocol\//,
      /^tools\/codegen\/events\.ts/,
    ],
  },
  {
    id: "tools",
    description: "Tool schema dialects and validators",
    command: ["bun", "run", "tools/codegen/tools.ts"],
    patterns: [
      /^packages\/adapter-sdk\//,
      /^packages\/capability-registry\//,
      /^tools\/codegen\/tools\.ts/,
    ],
  },
  {
    id: "config",
    description: "System config schema and documentation",
    command: ["bun", "run", "tools/codegen/config.ts"],
    patterns: [
      /^packages\/config\//,
      /^terminus\.config\.yaml/,
      /^tools\/codegen\/config\.ts/,
    ],
  },
  {
    id: "sqlx",
    description: "SQLx offline query metadata",
    command: ["bun", "run", "tools/codegen/sqlx.ts"],
    patterns: [
      /^crates\/.*\/queries\//,
      /^migrations\//,
      /^tools\/codegen\/sqlx\.ts/,
    ],
  },
  {
    id: "docs",
    description: "Generated markdown docs and ADR index",
    command: ["bun", "run", "tools/codegen/docs.ts"],
    patterns: [
      /^docs\/decisions\//,
      /^docs\/architecture\//,
      /^tools\/codegen\/docs\.ts/,
    ],
  },
];

function getChangedFiles(): string[] {
  const diff = spawnSync("git", ["status", "--porcelain", "-uall"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (diff.status !== 0 || !diff.stdout) {
    return [];
  }
  const lines = diff.stdout.split("\n");
  const files: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Format: 'XY path' or 'XY orig -> dest'
    const match = trimmed.match(/^[A-Z?]{1,2}\s+(?:.*?->\s+)?(.+)$/);
    if (match && match[1]) {
      files.push(match[1].trim());
    }
  }
  return files;
}

function runCommand(cmd: string[]): boolean {
  console.log(`[codegen-changed] running: ${cmd.join(" ")}`);
  const res = spawnSync(cmd[0]!, cmd.slice(1), {
    cwd: ROOT,
    stdio: "inherit",
  });
  return res.status === 0;
}

function main(): void {
  const args = process.argv.slice(2);
  const forceAll = args.includes("--all");
  const dryRun = args.includes("--dry-run");

  if (forceAll) {
    console.log("[codegen-changed] --all specified; executing all targets");
    for (const target of TARGETS) {
      if (dryRun) {
        console.log(`[dry-run] would run: ${target.id} (${target.description})`);
      } else {
        const ok = runCommand(target.command);
        if (!ok) {
          console.error(`[codegen-changed] target failed: ${target.id}`);
          process.exit(1);
        }
      }
    }
    console.log("[codegen-changed] completed all targets");
    return;
  }

  const changed = getChangedFiles();
  if (changed.length === 0) {
    console.log("[codegen-changed] no modified files detected; nothing to regenerate");
    return;
  }

  const targetsToRun = new Set<CodegenTarget>();
  for (const file of changed) {
    for (const target of TARGETS) {
      if (target.patterns.some((p) => p.test(file))) {
        targetsToRun.add(target);
      }
    }
  }

  if (targetsToRun.size === 0) {
    console.log("[codegen-changed] modified files do not affect derived contracts; skipping");
    return;
  }

  console.log(`[codegen-changed] detected ${changed.length} modified file(s), triggering ${targetsToRun.size} target(s):`);
  for (const target of targetsToRun) {
    console.log(` - ${target.id}: ${target.description}`);
  }

  for (const target of targetsToRun) {
    if (dryRun) {
      console.log(`[dry-run] would run ${target.command.join(" ")}`);
    } else {
      const ok = runCommand(target.command);
      if (!ok) {
        console.error(`[codegen-changed] target failed: ${target.id}`);
        process.exit(1);
      }
    }
  }
  console.log("[codegen-changed] finished incremental codegen");
}

main();

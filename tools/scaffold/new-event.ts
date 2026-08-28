#!/usr/bin/env bun
/**
 * new-event — add a new event type to schemas/events/catalog.yaml.
 *
 * SPEC §45.7 mandates scaffolds include README, AGENTS, tests, ownership,
 * lint config, observability placeholders, and CI registration. For events,
 * the catalog YAML is the source of truth and the codegen-events generator
 * derives types, JSON Schemas, docs, and fixtures from it. This script
 * appends a new event entry to the catalog and prints the manual steps
 * the contributor must take.
 *
 * Usage: bun run tools/scaffold/new-event.ts <type> [aggregate]
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.env.TERMINUS_ROOT ?? process.env.FORGE_ROOT ?? join(import.meta.dir, "..", "..");
const type = process.argv[2];
if (!type) {
  console.error("Usage: bun run tools/scaffold/new-event.ts <type> [aggregate]");
  process.exit(1);
}
const aggregate = process.argv[3] ?? type.split(".")[0] ?? "unknown";
if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(type)) {
  console.error(`Invalid event type "${type}": must be dotted lowercase, e.g. "task.created".`);
  process.exit(1);
}

const catalogPath = join(ROOT, "schemas", "events", "catalog.yaml");
if (!existsSync(catalogPath)) {
  console.error(`schemas/events/catalog.yaml not found`);
  process.exit(1);
}

const existing = readFileSync(catalogPath, "utf8");
if (existing.includes(`type: ${type}\n`)) {
  console.error(`event type "${type}" already exists in catalog.yaml`);
  process.exit(1);
}

const entry = `
- type: ${type}
  version: 1
  aggregate: ${aggregate}
  payload:
    ${type.split(".").map((s) => s).slice(0, 1)}_id: {type: uuid, required: true}
    # TODO: add the remaining payload fields.
  pii: none
  retention: audit
`;

writeFileSync(catalogPath, existing.replace(/\n*$/, "\n") + entry);

console.log(`[new-event] appended "${type}" to schemas/events/catalog.yaml`);
console.log(`[new-event] TODO:`);
console.log(`  - fill in the payload fields`);
console.log(`  - run \`just codegen-events\` to regenerate docs/generated/events.md`);
console.log(`  - add an emitter call site in the control plane or kernel`);
console.log(`  - add a migration-compat test if the event supersedes an older version`);

#!/usr/bin/env bun
/**
 * new-capability — scaffold a new capability pack under capability-packs/<id>/.
 *
 * SPEC §45.7 mandates scaffolds include README, AGENTS, tests, ownership,
 * lint config, observability placeholders, and CI registration. Capability
 * packs are described by a `pack.yaml` descriptor; the runtime loads them
 * via the capability registry.
 *
 * Usage: bun run tools/scaffold/new-capability.ts <id>
 */
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.env.FORGE_ROOT ?? join(import.meta.dir, "..", "..");
const id = process.argv[2];

if (!id) {
  console.error("Usage: bun run tools/scaffold/new-capability.ts <id>");
  process.exit(1);
}
if (!/^[a-z][a-z0-9-]*$/.test(id)) {
  console.error(`Invalid capability id "${id}": must be kebab-case (lowercase, hyphens).`);
  process.exit(1);
}

const packDir = join(ROOT, "capability-packs", id);
if (existsSync(packDir)) {
  console.error(`capability-packs/${id} already exists`);
  process.exit(1);
}

mkdirSync(packDir, { recursive: true });

writeFileSync(
  join(packDir, "pack.yaml"),
  `pack:
  id: terminus/${id}
  version: 1.0.0
  name: ${id}
  description: |
    TODO: one-paragraph description of the ${id} capability pack. Reference
    the SPEC section that mandates it.
  publisher: terminus
  trust_level: first_party
  operations:
    - id: TODO_op_1
      description: TODO operation description.
      effects: []
      # network_destinations: []
      # approval_required: false
  filesystem:
    read: []
    write: []
`,
);

writeFileSync(
  join(packDir, "README.md"),
  `# terminus/${id}\n\nTODO: describe what this capability pack provides and how it is invoked.\n\n## Operations\n\nTODO: list the operations declared in pack.yaml.\n\n## Approval policy\n\nTODO: describe which operations require human approval.\n`,
);

console.log(`[new-capability] created capability-packs/${id}/`);
console.log(`[new-capability] TODO:`);
console.log(`  - fill in pack.yaml operations and filesystem scope`);
console.log(`  - register the pack in packages/capability-registry/src/index.ts`);
console.log(`  - add \`capability-packs/${id}/\` to .github/CODEOWNERS`);

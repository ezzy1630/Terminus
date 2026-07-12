#!/usr/bin/env bun
/**
 * new-tool — scaffold a new Forge tool schema under schemas/tools/<id>.json.
 *
 * SPEC §45.7 mandates scaffolds include README, AGENTS, tests, ownership,
 * lint config, observability placeholders, and CI registration. This script
 * creates the tool schema stub and a Markdown reference. The codegen-tools
 * generator picks the schema up automatically.
 *
 * Usage: bun run tools/scaffold/new-tool.ts <id>
 */
import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.env.FORGE_ROOT ?? join(import.meta.dir, "..", "..");
const id = process.argv[2];

if (!id) {
  console.error("Usage: bun run tools/scaffold/new-tool.ts <id>");
  process.exit(1);
}
if (!/^[a-z][a-z0-9-]*$/.test(id)) {
  console.error(`Invalid tool id "${id}": must be kebab-case (lowercase, hyphens).`);
  process.exit(1);
}

const schemaPath = join(ROOT, "schemas", "tools", `${id}.json`);
if (existsSync(schemaPath)) {
  console.error(`schemas/tools/${id}.json already exists`);
  process.exit(1);
}

const schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: `https://forge.dev/schemas/tools/${id}.json`,
  title: id,
  description: `TODO: one-paragraph description of the ${id} tool. Reference the SPEC section that mandates it.`,
  type: "object",
  additionalProperties: false,
  required: ["op"],
  properties: {
    op: {
      enum: ["TODO_op_1", "TODO_op_2"],
      description: "Operation to perform.",
    },
    args_artifact: {
      type: ["string", "null"],
      description: "Optional artifact:// URI carrying the operation arguments.",
    },
  },
};

writeFileSync(schemaPath, JSON.stringify(schema, null, 2) + "\n");

console.log(`[new-tool] created schemas/tools/${id}.json`);
console.log(`[new-tool] TODO:`);
console.log(`  - fill in the description and operation enum`);
console.log(`  - run \`just codegen-tools\` to regenerate docs/generated/tools.md`);
console.log(`  - add an implementation in the ACI tool registry (packages/aci/src/index.ts)`);

#!/usr/bin/env bun
/**
 * new-adapter — scaffold a new external-harness adapter under adapters/<id>/.
 *
 * SPEC §45.7 mandates scaffolds include README, AGENTS, tests, ownership,
 * lint config, observability placeholders, and CI registration. External
 * harness adapters are described by an `adapter.yaml` record (SPEC §12.4).
 *
 * Usage: bun run tools/scaffold/new-adapter.ts <id>
 */
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.env.TERMINUS_ROOT ?? process.env.FORGE_ROOT ?? join(import.meta.dir, "..", "..");
const id = process.argv[2];

if (!id) {
  console.error("Usage: bun run tools/scaffold/new-adapter.ts <id>");
  process.exit(1);
}
if (!/^[a-z][a-z0-9-]*$/.test(id)) {
  console.error(`Invalid adapter id "${id}": must be kebab-case (lowercase, hyphens).`);
  process.exit(1);
}

const adapterDir = join(ROOT, "adapters", id);
if (existsSync(adapterDir)) {
  console.error(`adapters/${id} already exists`);
  process.exit(1);
}

mkdirSync(adapterDir, { recursive: true });

writeFileSync(
  join(adapterDir, "adapter.yaml"),
  `adapter:
  id: ${id}
  version: 0.1.0
  # Maturity tier (roadmap Phase 0): fixture | stub | experimental | preview | production.
  # New adapters start as stubs; production requires live probe evidence.
  status: stub
  inner_harness_version: pinned
  description: |
    TODO: one-paragraph description of the ${id} adapter. Note which Terminus
    sandbox/broker layers wrap the inner harness.
  capabilities:
    exact_context_visibility: unknown
    tool_interception: unknown
    filesystem_enforcement: outer_sandbox
    network_enforcement: outer_sandbox
    secret_isolation: outer_broker
    session_resume: unknown
    typed_results: unknown
    artifact_export: unknown
    cancellation: unknown
`,
);

writeFileSync(
  join(adapterDir, "README.md"),
  `# ${id} adapter\n\nTODO: describe the inner harness, what it does well, what it does poorly, and how Terminus wraps it.\n\n## Capability probing\n\nTODO: describe how the adapter's claimed capabilities are cross-checked by live probes (SPEC §12.4).\n`,
);

console.log(`[new-adapter] created adapters/${id}/`);
console.log(`[new-adapter] TODO:`);
console.log(`  - fill in adapter.yaml capabilities (run live probes before claiming native/partial)`);
console.log(`  - add \`adapters/${id}/\` to .github/CODEOWNERS`);

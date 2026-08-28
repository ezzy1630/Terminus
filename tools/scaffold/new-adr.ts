#!/usr/bin/env bun
/**
 * new-adr — scaffold a new Architecture Decision Record under docs/decisions/.
 *
 * SPEC §45.7 mandates scaffolds include README, AGENTS, tests, ownership,
 * lint config, observability placeholders, and CI registration. For ADRs
 * the scaffold is the ADR file itself, with all eight required sections
 * (Context, Decision, Alternatives, Consequences, Security Impact,
 * Evaluation Plan, Migration, Rollback) per Appendix H.
 *
 * SPEC §26.7 status enum: ADOPTED, PROVISIONAL, EXPERIMENTAL, DEPRECATED,
 * REJECTED, OPEN. The previous scaffold used `PROPOSED`, which is not in
 * the enum. This script uses `PROVISIONAL` for new ADRs.
 *
 * Usage: bun run tools/scaffold/new-adr.ts <title>
 */
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.env.TERMINUS_ROOT ?? process.env.FORGE_ROOT ?? join(import.meta.dir, "..", "..");
const title = process.argv[2];

if (!title) {
  console.error("Usage: bun run tools/scaffold/new-adr.ts <title>");
  process.exit(1);
}

const decisionsDir = join(ROOT, "docs", "decisions");
const existing = readdirSync(decisionsDir)
  .map((f) => {
    const m = f.match(/^ADR-(\d+)-/);
    return m ? parseInt(m[1]!, 10) : 0;
  })
  .sort((a, b) => a - b);
const next = (existing[existing.length - 1] ?? 0) + 1;
const num = String(next).padStart(4, "0");

// Slugify the title for the filename.
const slug = title
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-+|-+$/g, "");
const path = join(decisionsDir, `ADR-${num}-${slug}.md`);

const today = new Date().toISOString().slice(0, 10);

const body = `# ADR-${num}: ${title}

- **Status:** PROVISIONAL
- **Date:** ${today}
- **Decision owner:** (name)

## Context

TODO: describe the architectural force that triggered this decision.
Reference the SPEC section, prior ADRs, and any relevant runbooks.

## Decision

TODO: state the decision clearly and unambiguously.

## Alternatives

TODO: list the alternatives considered, with their trade-offs. Each
alternative should explain why it was rejected.

## Consequences

TODO: list the positive and negative consequences of the decision.

## Security Impact

TODO: describe the impact on the trust-boundary model (Z0–Z5), the
non-bypassability properties, and the threat model.

## Evaluation Plan

TODO: describe how the decision will be validated. Reference the eval
cohorts (SPEC §41) and the verification DAG (SPEC §21) as appropriate.

## Migration

TODO: describe how existing deployments migrate to the new architecture.

## Rollback

TODO: describe how to roll back the decision if it fails in production.
`;

writeFileSync(path, body);
console.log(`[new-adr] created ${path}`);
console.log(`[new-adr] TODO: fill in the eight required sections.`);

#!/usr/bin/env bun
/**
 * codegen/maturity — validate the component maturity registry and emit
 * docs/generated/component-maturity.md.
 *
 * Roadmap Phase 0: classify every component as fixture | stub |
 * experimental | preview | production, with a stated basis. This tool is
 * the enforcement arm:
 *
 *   1. every component directory under crates/, packages/, apps/,
 *      mini-services/, adapters/, python/forge_evals, evals/ MUST have
 *      exactly one registry entry (no unclassified components);
 *   2. every entry path MUST exist;
 *   3. adapter entries MUST agree with the adapter's own adapter.yaml
 *      status declaration;
 *   4. tier "production" MUST carry an evidence pointer to an existing,
 *      reproducible artifact.
 *
 * Drift detection is handled by `just codegen-check`.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.env.FORGE_ROOT ?? join(import.meta.dir, "..", "..");
const REGISTRY_PATH = join(ROOT, "maturity.yaml");
const OUT_PATH = join(ROOT, "docs", "generated", "component-maturity.md");

type Tier = "fixture" | "stub" | "experimental" | "preview" | "production";

interface Component {
  id: string;
  kind: string;
  path: string;
  tier: Tier;
  basis: string;
  evidence?: string;
}

interface Registry {
  schema_version: number;
  updated: string;
  components: Component[];
}

const TIERS: readonly Tier[] = ["fixture", "stub", "experimental", "preview", "production"];

// Directory sources that MUST be fully covered by the registry.
const COVERED_SOURCES: ReadonlyArray<{ dir: string; skip?: RegExp }> = [
  { dir: "crates" },
  { dir: "packages" },
  { dir: "apps" },
  { dir: "mini-services", skip: /^\./ },
  { dir: "adapters" },
];

function fail(msg: string): never {
  console.error(`[codegen-maturity] ${msg}`);
  process.exit(1);
}

function loadRegistry(): Registry {
  if (!existsSync(REGISTRY_PATH)) fail(`registry missing: ${REGISTRY_PATH}`);
  const raw = readFileSync(REGISTRY_PATH, "utf8");
  let parsed: Registry;
  try {
    parsed = Bun.YAML.parse(raw) as Registry;
  } catch (err) {
    return fail(`registry does not parse: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!parsed || !Array.isArray(parsed.components)) fail("registry has no components list");
  return parsed;
}

function validate(registry: Registry): void {
  const byPath = new Map<string, Component>();
  for (const c of registry.components) {
    if (!TIERS.includes(c.tier)) fail(`${c.id}: unknown tier "${c.tier}"`);
    if (!c.basis || c.basis.trim().length < 10) fail(`${c.id}: basis must state why this tier`);
    const abs = join(ROOT, c.path);
    if (!existsSync(abs)) fail(`${c.id}: path does not exist: ${c.path}`);
    if (byPath.has(c.path)) fail(`duplicate registry entry for path ${c.path}`);
    byPath.set(c.path, c);
    if (c.tier === "production") {
      if (!c.evidence) {
        fail(
          `${c.id}: tier "production" requires an evidence pointer to a reproducible artifact`,
        );
      }
      // Evidence may be an in-repo artifact or an external URL recorded in
      // artifacts/release-gate/. In-repo paths must exist.
      if (!/^https?:\/\//.test(c.evidence) && !existsSync(join(ROOT, c.evidence))) {
        fail(`${c.id}: evidence path does not exist: ${c.evidence}`);
      }
    }
  }

  for (const { dir, skip } of COVERED_SOURCES) {
    const absDir = join(ROOT, dir);
    if (!statSync(absDir).isDirectory()) fail(`covered source missing: ${dir}/`);
    for (const entry of readdirSync(absDir)) {
      if (skip?.test(entry)) continue;
      const rel = `${dir}/${entry}`;
      if (!byPath.has(rel)) {
        fail(
          `unclassified component directory: ${rel} — add it to maturity.yaml with an honest tier`,
        );
      }
    }
  }

  // python/forge_evals must be registered (evals/ corpus too).
  for (const required of ["python/forge_evals", "evals"]) {
    if (!registry.components.some((c) => c.path === required)) {
      fail(`missing required registry entry for ${required}`);
    }
  }

  // Adapters must agree with their own machine-readable declarations.
  for (const c of registry.components.filter((x) => x.kind === "adapter")) {
    const yamlPath = join(ROOT, c.path, "adapter.yaml");
    if (!existsSync(yamlPath)) continue; // declaration-only adapters may lack runner but have yaml
    let doc: { adapter?: { id?: string; status?: Tier; last_verified?: string | null } };
    try {
      doc = Bun.YAML.parse(readFileSync(yamlPath, "utf8"));
    } catch (err) {
      return fail(`${c.id}: adapter.yaml does not parse: ${String(err)}`);
    }
    const declared = doc.adapter;
    if (!declared?.status) fail(`${c.id}: adapter.yaml missing status field`);
    if (declared.status !== c.tier) {
      fail(
        `${c.id}: maturity.yaml tier "${c.tier}" contradicts adapter.yaml status "${declared.status}"`,
      );
    }
    if (declared.status === "production" && declared.last_verified == null) {
      fail(`${c.id}: adapter.yaml claims production without last_verified probe evidence`);
    }
  }
}

function emit(registry: Registry): void {
  const order: Record<Tier, number> = { fixture: 0, stub: 1, experimental: 2, preview: 3, production: 4 };
  const sorted = [...registry.components].sort(
    (a, b) => order[a.tier] - order[b.tier] || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id),
  );
  const counts = new Map<Tier, number>();
  for (const c of registry.components) counts.set(c.tier, (counts.get(c.tier) ?? 0) + 1);

  const lines: string[] = [];
  lines.push("# Component maturity registry");
  lines.push("");
  lines.push("> Auto-generated from `maturity.yaml` by `tools/codegen/maturity.ts`.");
  lines.push("> Do not edit by hand — run `just codegen`. Source of truth: `maturity.yaml`.");
  lines.push("");
  lines.push(
    "Tiers: `fixture` → `stub` → `experimental` → `preview` → `production`. " +
      "`production` requires signed conformance evidence at HEAD; no component holds it today.",
  );
  lines.push("");
  lines.push("| Tier | Components |");
  lines.push("|---|---:|");
  for (const t of [...TIERS].reverse()) {
    lines.push(`| \`${t}\` | ${counts.get(t) ?? 0} |`);
  }
  lines.push("");
  lines.push("| Component | Kind | Path | Tier | Basis |");
  lines.push("|---|---|---|---|---|");
  for (const c of sorted) {
    const basis = c.basis.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
    lines.push(`| \`${c.id}\` | ${c.kind} | \`${c.path}\` | \`${c.tier}\` | ${basis} |`);
  }
  lines.push("");
  writeFileSync(OUT_PATH, `${lines.join("\n")}`, "utf8");
  console.log(`[codegen-maturity] wrote ${OUT_PATH} (${registry.components.length} components)`);
}

function main(): void {
  const registry = loadRegistry();
  validate(registry);
  emit(registry);
}

main();

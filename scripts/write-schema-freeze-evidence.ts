#!/usr/bin/env bun
/**
 * Write schema-freeze.json evidence from schemas/STABLE_VERSIONS.yaml.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const STABLE_PATH = join(ROOT, "schemas", "STABLE_VERSIONS.yaml");
const OUT_DIR = join(ROOT, "artifacts", "release-gate");
const OUT_PATH = join(OUT_DIR, "schema-freeze.json");

mkdirSync(OUT_DIR, { recursive: true });

if (!existsSync(STABLE_PATH)) {
  writeFileSync(
    OUT_PATH,
    `${JSON.stringify(
      {
        status: "missing_stable_versions",
        generatedAt: new Date().toISOString(),
        path: "schemas/STABLE_VERSIONS.yaml",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  console.error(`[schema-freeze] missing ${STABLE_PATH}`);
  process.exit(1);
}

const raw = readFileSync(STABLE_PATH, "utf8");
const parsed = Bun.YAML.parse(raw) as Record<string, unknown>;

const evidence = {
  status: "frozen",
  generatedAt: new Date().toISOString(),
  source: "schemas/STABLE_VERSIONS.yaml",
  freeze: parsed,
};

writeFileSync(OUT_PATH, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
console.log(`[schema-freeze] wrote ${OUT_PATH}`);

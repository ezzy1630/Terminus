#!/usr/bin/env bun
/**
 * codegen-config — emit a Markdown reference for the Forge config schema.
 *
 * SPEC §45.3 mandates a `codegen-config` generator that produces JSON
 * Schema, docs, and a sample config from the zod config schema in
 * `packages/config`. This script emits the Markdown reference under
 * `docs/generated/config.md` by introspecting the zod schema at runtime.
 *
 * JSON Schema emission and sample config emission are future additions
 * (tracked separately). The zod v4 internal API (`_zod.def`) is used for
 * introspection; when zod stabilises a public introspection API we
 * should switch to it.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { forgeConfigSchema } from "../../packages/config/src/index.ts";

const ROOT = process.env.FORGE_ROOT ?? join(import.meta.dir, "..", "..");
const OUT_DIR = join(ROOT, "docs", "generated");
const OUT = join(OUT_DIR, "config.md");

interface FieldInfo {
  path: string;
  type: string;
  default: string;
  description: string;
}

interface ZodLike {
  _zod?: { def: Record<string, unknown> };
}

/** Unwrap optional/default/nullable wrappers to reach the underlying type. */
function unwrap(schema: unknown): { schema: ZodLike; def: Record<string, unknown> } {
  let s = schema as ZodLike;
  let d = s?._zod?.def ?? {};
  while (typeof d["type"] === "string" && (d["type"] === "default" || d["type"] === "optional" || d["type"] === "nullable" || d["type"] === "catch" || d["type"] === "prefault")) {
    const inner = d["innerType"] as ZodLike | undefined;
    if (!inner) break;
    s = inner;
    d = inner._zod?.def ?? {};
  }
  return { schema: s, def: d };
}

function typeName(def: Record<string, unknown>): string {
  const t = def["type"];
  switch (t) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "int":
      return "integer";
    case "boolean":
      return "boolean";
    case "literal": {
      const vals = (def["values"] as unknown[]) ?? (def["value"] !== undefined ? [def["value"]] : []);
      return "literal: " + vals.map((v) => JSON.stringify(v)).join(" | ");
    }
    case "enum": {
      const entries = def["entries"] as Record<string, unknown> | undefined;
      const values = entries ? Object.values(entries) : ((def["values"] as unknown[]) ?? []);
      return "enum: " + values.map((v) => JSON.stringify(v)).join(" | ");
    }
    case "array":
      return "array";
    case "object":
      return "object";
    case "record":
      return "record";
    case "null":
      return "null";
    case "nullable":
      return "nullable";
    case "default":
    case "optional":
    case "catch":
    case "prefault":
      // Unwrapped above; this shouldn't fire for clean schemas.
      return "any";
    default:
      return String(t ?? "unknown");
  }
}

function defaultOf(def: Record<string, unknown>): string {
  const dv = def["defaultValue"];
  if (dv === undefined) return "—";
  if (typeof dv === "function") return "(computed)";
  if (dv === null) return "null";
  if (typeof dv === "string") return JSON.stringify(dv);
  if (typeof dv === "object") {
    try {
      return JSON.stringify(dv);
    } catch {
      return "(object)";
    }
  }
  return String(dv);
}

function descriptionOf(schema: unknown): string {
  const z = schema as ZodLike;
  const def = z?._zod?.def ?? {};
  // zod v4 stores description in bag.meta or via .describe()
  const bag = def["bag"] as { description?: string; meta?: { description?: string } } | undefined;
  if (bag?.description) return bag.description;
  if (bag?.meta?.description) return bag.meta.description;
  return "";
}

function walk(schema: unknown, prefix: string, out: FieldInfo[]): void {
  // Capture the default from the OUTER wrapper (default/catch/prefault)
  // before unwrapping to find the underlying type. zod v4 stores defaults
  // on the wrapper, not the inner schema.
  const outerDef = (schema as ZodLike)?._zod?.def ?? {};
  const capturedDefault = defaultOf(outerDef);
  const { schema: inner, def } = unwrap(schema);
  const t = def["type"];
  if (t === "object") {
    const shape = (def["shape"] ?? {}) as Record<string, unknown>;
    for (const [key, child] of Object.entries(shape)) {
      walk(child, prefix ? `${prefix}.${key}` : key, out);
    }
    return;
  }
  if (t === "record") {
    // Records are maps keyed by string. Record the path and stop recursing.
    out.push({
      path: prefix,
      type: "record<string, …>",
      default: capturedDefault,
      description: descriptionOf(inner),
    });
    return;
  }
  if (t === "array") {
    out.push({
      path: prefix,
      type: "array",
      default: capturedDefault,
      description: descriptionOf(inner),
    });
    return;
  }
  // leaf
  out.push({
    path: prefix,
    type: typeName(def),
    default: capturedDefault,
    description: descriptionOf(inner),
  });
}

function main(): void {
  const fields: FieldInfo[] = [];
  walk(forgeConfigSchema, "", fields);
  if (fields.length === 0) {
    console.error("[codegen-config] no fields introspected from forgeConfigSchema");
    process.exit(1);
  }
  const lines: string[] = [];
  lines.push("# Forge Configuration Reference");
  lines.push("");
  lines.push("> Auto-generated by `tools/codegen/config.ts`. Do not edit by hand.");
  lines.push("> Source of truth: `packages/config/src/index.ts` (zod schema).");
  lines.push("> Layered load order is documented in SPEC Appendix F.");
  lines.push("");
  lines.push(`Total settings: **${fields.length}**`);
  lines.push("");
  lines.push("| Path | Type | Default |");
  lines.push("|---|---|---|");
  for (const f of fields) {
    lines.push(`| \`${f.path}\` | ${f.type} | ${f.default} |`);
  }
  lines.push("");
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT, lines.join("\n") + "\n", "utf8");
  console.log(`[codegen-config] wrote ${OUT} (${fields.length} settings)`);
}

main();

#!/usr/bin/env bun
/**
 * codegen-events — emit a Markdown catalog from schemas/events/catalog.yaml.
 *
 * SPEC §45.5 mandates a generator that derives runtime types, JSON Schemas,
 * and a Markdown catalog from the YAML event catalog. This script emits the
 * Markdown catalog under docs/generated/events.md. Runtime type generation
 * (TS zod + Rust serde) is a future addition (tracked separately).
 *
 * The script is deliberately dependency-light so it runs in CI without
 * extra installs: it parses the catalog as YAML via a tiny line-based
 * parser (the catalog uses a small subset of YAML) so we don't pull in
 * js-yaml at codegen time. If the catalog grows more complex features,
 * swap this for `js-yaml`.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.env.TERMINUS_ROOT ?? process.env.FORGE_ROOT ?? join(import.meta.dir, "..", "..");
const SRC = join(ROOT, "schemas", "events", "catalog.yaml");
const OUT_DIR = join(ROOT, "docs", "generated");
const OUT = join(OUT_DIR, "events.md");

interface EventField {
  name: string;
  type: string;
  required: boolean;
}
interface EventEntry {
  type: string;
  version: number;
  aggregate: string;
  pii: string;
  retention: string;
  fields: EventField[];
}

function parseCatalog(text: string): EventEntry[] {
  // Minimal YAML subset parser tailored to schemas/events/catalog.yaml.
  // Recognises top-level list items (`- type: ...`) and indented `key: value`
  // pairs, plus a `payload:` block which introduces field entries.
  const lines = text.split("\n");
  const events: EventEntry[] = [];
  let cur: EventEntry | null = null;
  let inPayload = false;
  let inPayloadSubObject: string | null = null;

  function flush(): void {
    if (cur) events.push(cur);
    cur = null;
    inPayload = false;
    inPayloadSubObject = null;
  }

  for (const raw of lines) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;
    const trimmed = raw.trim();
    if (indent === 0 && trimmed.startsWith("- ")) {
      flush();
      cur = { type: "", version: 0, aggregate: "", pii: "", retention: "", fields: [] };
      inPayload = false;
      inPayloadSubObject = null;
      const rest = trimmed.slice(2);
      applyKv(rest);
    } else if (indent === 0) {
      // top-level scalar; treat as comment / metadata
      continue;
    } else if (cur) {
      if (indent === 2 && trimmed === "payload:") {
        inPayload = true;
        inPayloadSubObject = null;
        continue;
      }
      if (indent === 2) {
        inPayload = false;
        inPayloadSubObject = null;
        applyKv(trimmed);
        continue;
      }
      if (inPayload) {
        // indent >=4 inside payload
        if (indent === 4) {
          inPayloadSubObject = null;
          const m = trimmed.match(/^([a-zA-Z0-9_]+):\s*\{(.*)\}\s*$/);
          if (m) {
            const name = m[1]!;
            const inner = m[2]!;
            cur.fields.push(parseFieldInline(name, inner));
          } else if (trimmed.endsWith(":")) {
            // sub-object: name:\n  ...  (e.g., usage:)
            inPayloadSubObject = trimmed.slice(0, -1).trim();
          } else if (trimmed.includes(":")) {
            // nested-object field; we record it with object type
            const m2 = trimmed.match(/^([a-zA-Z0-9_]+):\s*$/);
            if (m2) {
              inPayloadSubObject = m2[1]!;
            }
          }
          continue;
        }
        if (indent === 6 && inPayloadSubObject) {
          // fields under a sub-object (e.g., usage.properties.prompt_tokens)
          const m = trimmed.match(/^([a-zA-Z0-9_]+):\s*\{(.*)\}\s*$/);
          if (m) {
            const name = `${inPayloadSubObject}.${m[1]}`;
            const inner = m[2]!;
            cur.fields.push(parseFieldInline(name, inner));
          }
          continue;
        }
      }
    }
  }
  flush();

  function applyKv(s: string): void {
    if (!cur) return;
    const m = s.match(/^([a-zA-Z0-9_]+):\s*(.*)$/);
    if (!m) return;
    const [, k, v] = m;
    if (k === "type") cur.type = unquote(v!);
    else if (k === "version") cur.version = parseInt(unquote(v!), 10);
    else if (k === "aggregate") cur.aggregate = unquote(v!);
    else if (k === "pii") cur.pii = unquote(v!);
    else if (k === "retention") cur.retention = unquote(v!);
  }
  return events;
}

function parseFieldInline(name: string, inner: string): EventField {
  // inner looks like: `type: uuid, required: true`
  const parts = inner.split(",").map((s) => s.trim());
  let type = "unknown";
  let required = false;
  for (const p of parts) {
    const [k, v] = p.split(":").map((s) => s.trim());
    if (k === "type") type = unquote(v ?? "");
    else if (k === "required") required = unquote(v ?? "") === "true";
  }
  return { name, type, required };
}

function unquote(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

function render(events: EventEntry[]): string {
  const lines: string[] = [];
  lines.push("# Terminus Semantic Event Catalog");
  lines.push("");
  lines.push("> Auto-generated by `tools/codegen/events.ts`. Do not edit by hand.");
  lines.push("> Source of truth: `schemas/events/catalog.yaml` (SPEC §45.5).");
  lines.push("");
  lines.push(`Total events: **${events.length}**`);
  lines.push("");
  lines.push("| Type | Version | Aggregate | PII | Retention | Required fields |");
  lines.push("|---|---:|---|---|---|---|");
  for (const e of events) {
    const req = e.fields.filter((f) => f.required).map((f) => `\`${f.name}\``).join(", ") || "—";
    lines.push(`| \`${e.type}\` | ${e.version} | ${e.aggregate} | ${e.pii} | ${e.retention} | ${req} |`);
  }
  lines.push("");
  lines.push("## Field reference");
  lines.push("");
  for (const e of events) {
    lines.push(`### \`${e.type}\``);
    lines.push("");
    lines.push(`- **Aggregate:** ${e.aggregate}`);
    lines.push(`- **Version:** ${e.version}`);
    lines.push(`- **PII classification:** ${e.pii}`);
    lines.push(`- **Retention:** ${e.retention}`);
    lines.push("");
    if (e.fields.length === 0) {
      lines.push("_No payload fields._");
      lines.push("");
      continue;
    }
    lines.push("| Field | Type | Required |");
    lines.push("|---|---|---|");
    for (const f of e.fields) {
      lines.push(`| \`${f.name}\` | ${f.type} | ${f.required ? "yes" : "no"} |`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function main(): void {
  const src = readFileSync(SRC, "utf8");
  const events = parseCatalog(src);
  if (events.length === 0) {
    console.error("[codegen-events] no events parsed; refusing to write empty catalog");
    process.exit(1);
  }
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT, render(events) + "\n", "utf8");
  console.log(`[codegen-events] wrote ${OUT} (${events.length} events)`);
}

main();

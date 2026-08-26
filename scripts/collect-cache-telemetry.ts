#!/usr/bin/env bun
/**
 * Collect prompt-cache telemetry from the semantic event log (R7).
 *
 * The control plane emits `context.cache_ratio_observed` (per provider
 * attempt) and `context.cache_ratio_warning` events while turns run. This
 * script aggregates them into an evidence artifact for the release gate.
 *
 * Status semantics (honest by construction):
 *  - "measured": at least one observed ratio; carries average/min ratios and
 *    the consecutive-low-miss detector verdict. A live-tier average below the
 *    threshold fails the m12 exit gate.
 *  - "no_data": no live cache observations exist yet. The artifact states
 *    this explicitly instead of fabricating zeros.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";

type JsonRecord = Record<string, unknown>;

const ROOT = join(import.meta.dir, "..");
const OUT_DIR = join(ROOT, "artifacts", "release-gate");
const OUT_PATH = join(OUT_DIR, "cache-telemetry.json");

const RAW_DB = process.env.TERMINUS_CACHE_TELEMETRY_DB ?? process.env.DATABASE_URL ?? "";
if (!RAW_DB) {
  console.error(
    "[collect-cache-telemetry] set TERMINUS_CACHE_TELEMETRY_DB (or the control plane's DATABASE_URL) to the control-plane SQLite URL",
  );
  process.exit(2);
}
// Normalize like the control plane does: bare paths become file: URLs, and a
// leading ~ expands to $HOME so workflow inputs can use either form.
const DATABASE_URL = (() => {
  if (RAW_DB.startsWith("file:")) return RAW_DB;
  const expanded = RAW_DB.startsWith("~")
    ? `${process.env.HOME ?? ""}${RAW_DB.slice(1)}`
    : RAW_DB;
  return `file:${expanded}`;
})();

const THRESHOLD = Number(process.env.TERMINUS_CACHE_RATIO_THRESHOLD ?? "0.7");

function parsePayload(raw: string): JsonRecord {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return value as JsonRecord;
    }
  } catch {
    // Fall through to the empty record below.
  }
  return {};
}

const database = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });

try {
  const [observed, warnings] = await Promise.all([
    database.semanticEvent.findMany({
      where: { eventType: "context.cache_ratio_observed" },
      orderBy: { occurredAt: "asc" },
      select: { payloadJson: true, occurredAt: true },
    }),
    database.semanticEvent.findMany({
      where: { eventType: "context.cache_ratio_warning" },
      orderBy: { occurredAt: "asc" },
      select: { payloadJson: true, occurredAt: true },
      take: 100,
    }),
  ]);

  const ratios = observed
    .map((event) => parsePayload(event.payloadJson))
    .map((payload) => payload.ratio)
    .filter((ratio): ratio is number => typeof ratio === "number" && Number.isFinite(ratio));

  const averageRatio = ratios.length === 0
    ? null
    : ratios.reduce((sum, ratio) => sum + ratio, 0) / ratios.length;
  const minimumRatio = ratios.length === 0 ? null : Math.min(...ratios);

  const status = ratios.length === 0
    ? "no_data"
    : averageRatio !== null && averageRatio >= THRESHOLD
      ? "measured"
      : "measured_below_threshold";

  const artifact = {
    generatedAt: new Date().toISOString(),
    status,
    threshold: THRESHOLD,
    attemptsObserved: ratios.length,
    averageRatio: averageRatio === null ? null : Number(averageRatio.toFixed(4)),
    minimumRatio: minimumRatio === null ? null : Number(minimumRatio.toFixed(4)),
    warningsEmitted: warnings.length,
    lastWarning:
      warnings.length === 0
        ? null
        : { occurredAt: warnings[warnings.length - 1]!.occurredAt.toISOString(), payload: parsePayload(warnings[warnings.length - 1]!.payloadJson).warning ?? null },
    note:
      ratios.length === 0
        ? "no live-model cache observations exist yet; fixture runs do not produce cache telemetry"
        : undefined,
  };

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_PATH, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  console.log(`[collect-cache-telemetry] wrote ${OUT_PATH} (status=${status}, attempts=${ratios.length})`);
} finally {
  await database.$disconnect();
}

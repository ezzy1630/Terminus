#!/usr/bin/env bun
/**
 * Collect ops metrics for the release gate (SPEC §26.6).
 * Categories mirror docs/product/metrics.md: runtime, agent quality, security.
 *
 * Values are honest by construction: when a live evidence source exists
 * (currently artifacts/release-gate/cache-telemetry.json from R7) its real
 * measurements populate the corresponding fields and the status flips to
 * "measured"; without live sources the artifact stays an explicit
 * placeholder with zeros instead of fabricated numbers.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type CounterMap = Record<string, number>;

type OpsMetrics = {
  generatedAt: string;
  status: "placeholder" | "measured";
  runtime: CounterMap;
  agentQuality: CounterMap;
  security: CounterMap;
};

const ROOT = join(import.meta.dir, "..");
const OUT_DIR = join(ROOT, "artifacts", "release-gate");
const OUT_PATH = join(OUT_DIR, "ops-metrics.json");

const metrics: OpsMetrics = {
  generatedAt: new Date().toISOString(),
  status: "placeholder",
  runtime: {
    total_latency_s: 0,
    time_to_first_useful_action_s: 0,
    context_compilation_ms: 0,
    tool_overhead_ms: 0,
    restart_success: 0,
    resume_success: 0,
  },
  agentQuality: {
    final_success: 0,
    first_patch_success: 0,
    acceptance_criterion_coverage: 0,
    regression_rate: 0,
    changed_line_excess: 0,
    changed_file_excess: 0,
    user_corrections: 0,
    user_approvals: 0,
    input_tokens: 0,
    output_tokens: 0,
    cached_tokens: 0,
    reasoning_tokens: 0,
    tool_schema_tokens: 0,
  },
  security: {
    unsafe_attempts: 0,
    policy_denials: 0,
    sandbox_escapes: 0,
    stale_context_incidents: 0,
    stale_write_incidents: 0,
    plugin_descriptor_changes: 0,
  },
};

// Fold in measured cache telemetry when it exists (R7). Fixture runs never
// produce telemetry, so absence keeps the placeholder status.
const cacheTelemetryPath = join(OUT_DIR, "cache-telemetry.json");
if (existsSync(cacheTelemetryPath)) {
  try {
    const telemetry = JSON.parse(readFileSync(cacheTelemetryPath, "utf8")) as Record<string, unknown>;
    if (telemetry.status === "measured" && typeof telemetry.averageRatio === "number") {
      metrics.status = "measured";
      metrics.agentQuality.prompt_cache_hit_ratio = Number(telemetry.averageRatio.toFixed(4));
      metrics.agentQuality.prompt_cache_attempts_observed =
        typeof telemetry.attemptsObserved === "number" ? telemetry.attemptsObserved : 0;
    }
  } catch {
    // An unparseable telemetry file must not fabricate a measured status.
  }
}

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT_PATH, `${JSON.stringify(metrics, null, 2)}\n`, "utf8");

console.log(`[ops-metrics] wrote ${OUT_PATH}`);

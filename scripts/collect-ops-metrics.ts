#!/usr/bin/env bun
/**
 * Collect ops metrics for the release gate (SPEC §26.6).
 * Categories mirror docs/product/metrics.md: runtime, agent quality, security.
 *
 * Values are honest by construction: cache telemetry and durable repair
 * records are read only when their evidence sources are supplied. Their real
 * measurements populate the corresponding fields and the status flips to
 * "measured"; without live sources the artifact stays an explicit
 * placeholder with zeros instead of fabricated numbers.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { deriveRepairMetrics } from "@terminus/verification";
import {
  aggregateRepairMetrics,
  type RepairMetricsAggregate,
  type RepairMetricsAggregateInput,
} from "./ops-metrics.ts";

type CounterMap = Record<string, number>;

type OpsMetrics = {
  generatedAt: string;
  status: "placeholder" | "measured";
  runtime: CounterMap;
  agentQuality: CounterMap;
  security: CounterMap;
  repair: RepairMetricsAggregate;
};

const ROOT = join(import.meta.dir, "..");
const OUT_DIR = join(ROOT, "artifacts", "release-gate");
const OUT_PATH = join(OUT_DIR, "ops-metrics.json");

const REPAIR_DB_URL = process.env.TERMINUS_OPS_METRICS_DB ?? process.env.DATABASE_URL ?? "";

function parseRecord(value: string | null): Record<string, unknown> {
  if (value === null) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // An invalid optional field remains unobserved and is represented as null.
  }
  return {};
}

function metricDecimal(value: unknown): string | null {
  if (typeof value === "bigint") return value >= 0n ? value.toString() : null;
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  return typeof value === "string" && /^\d+$/.test(value) ? value : null;
}

function stringArray(value: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string")
      ? parsed
      : [];
  } catch {
    return [];
  }
}

function terminalReason(value: string | null): string | null {
  if (value === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (typeof parsed === "string" && parsed.length > 0) return parsed;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  for (const key of ["repair_stop_reason", "reason"]) {
    const reason = record[key];
    if (typeof reason === "string" && reason.length > 0) return reason;
  }
  return null;
}

function requiredVerificationPassed(input: {
  readonly nodes: readonly { readonly id: string; readonly required: boolean }[];
  readonly results: readonly { readonly nodeId: string; readonly attempt: number; readonly status: string }[];
}): boolean {
  const latest = new Map<string, { readonly attempt: number; readonly status: string }>();
  for (const result of input.results) {
    const prior = latest.get(result.nodeId);
    if (prior === undefined || result.attempt > prior.attempt) latest.set(result.nodeId, result);
  }
  return input.nodes
    .filter((node) => node.required)
    .every((node) => latest.get(node.id)?.status === "pass");
}

function normalizeDatabaseUrl(raw: string): string {
  if (raw.startsWith("file:")) return raw;
  const expanded = raw.startsWith("~")
    ? `${process.env.HOME ?? ""}${raw.slice(1)}`
    : raw;
  return `file:${expanded}`;
}

async function collectRepairMetrics(): Promise<RepairMetricsAggregate> {
  if (REPAIR_DB_URL === "") {
    return aggregateRepairMetrics([]);
  }

  const database = new PrismaClient({ datasources: { db: { url: normalizeDatabaseUrl(REPAIR_DB_URL) } } });
  try {
    const [tasks, completionRecords, plans] = await Promise.all([
      database.task.findMany({
        select: {
          id: true,
          status: true,
          terminalReasonJson: true,
          turns: {
            select: {
              id: true,
              startedAt: true,
              completedAt: true,
              providerAttempts: {
                select: { usageJson: true, costMicros: true },
              },
            },
          },
          repairAttempts: {
            orderBy: { attemptNumber: "asc" },
            select: {
              attemptNumber: true,
              state: true,
              failureSignaturesJson: true,
              terminalReasonJson: true,
              repairTurnId: true,
            },
          },
        },
      }),
      database.completionRecord.findMany({
        select: { taskId: true, status: true, admissionState: true },
      }),
      database.verificationPlan.findMany({
        orderBy: { createdAt: "desc" },
        select: {
          taskId: true,
          nodes: { select: { id: true, required: true } },
          results: { select: { nodeId: true, attempt: true, status: true } },
        },
      }),
    ]);

    const completionByTask = new Map(completionRecords.map((record) => [record.taskId, record]));
    const latestPlanByTask = new Map<string, (typeof plans)[number]>();
    for (const plan of plans) {
      if (!latestPlanByTask.has(plan.taskId)) latestPlanByTask.set(plan.taskId, plan);
    }

    const normalized: RepairMetricsAggregateInput[] = tasks.map((task) => {
      const repairTurnIds = new Set(
        task.repairAttempts
          .map((attempt) => attempt.repairTurnId)
          .filter((turnId): turnId is string => turnId !== null),
      );
      const repairProviderAttempts = task.turns
        .filter((turn) => repairTurnIds.has(turn.id))
        .flatMap((turn) => turn.providerAttempts)
        .map((attempt) => {
          const usage = parseRecord(attempt.usageJson);
          return {
            inputTokens: metricDecimal(usage.inputTokens),
            outputTokens: metricDecimal(usage.outputTokens),
            costMicros: attempt.costMicros === null || attempt.costMicros === 0
              ? null
              : metricDecimal(attempt.costMicros),
          };
        });
      const repairTurns = task.turns
        .filter((turn) => repairTurnIds.has(turn.id))
        .map((turn) => ({
          startedAtMs: turn.startedAt?.getTime() ?? null,
          completedAtMs: turn.completedAt?.getTime() ?? null,
        }));
      const plan = latestPlanByTask.get(task.id);
      const completion = completionByTask.get(task.id);
      const derived = deriveRepairMetrics({
        taskStatus: task.status,
        terminalReason: terminalReason(task.terminalReasonJson),
        completionAdmissionCommitted: completion?.status === "completed"
          && completion.admissionState === "COMMITTED",
        finalRequiredPredicatesPassed: plan === undefined ? null : requiredVerificationPassed(plan),
        repairAttempts: task.repairAttempts.map((attempt) => ({
          attemptNumber: attempt.attemptNumber,
          state: attempt.state,
          failureSignatures: stringArray(attempt.failureSignaturesJson),
          terminalReason: terminalReason(attempt.terminalReasonJson),
        })),
        repairProviderAttempts,
        repairTurns,
      });
      return derived;
    });
    return aggregateRepairMetrics(normalized);
  } finally {
    await database.$disconnect();
  }
}

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
  repair: aggregateRepairMetrics([]),
};

// Fold in measured cache telemetry when it exists (R7). Fixture runs never
// produce telemetry, so absence keeps that part of the artifact unmeasured.
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

const repairMetrics = await collectRepairMetrics();
metrics.repair = repairMetrics;
if (repairMetrics.tasksObserved > 0) metrics.status = "measured";

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT_PATH, `${JSON.stringify(metrics, null, 2)}\n`, "utf8");

console.log(`[ops-metrics] wrote ${OUT_PATH}`);

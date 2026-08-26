/**
 * @terminus/cron — Deterministic cron & interval scheduling (ADR-0049).
 *
 * Rules:
 * - Timezone-free UTC only.
 * - 5-field standard cron: minute (0-59), hour (0-23), dayOfMonth (1-31), month (1-12), dayOfWeek (0-6).
 * - Interval schedules: milliseconds interval.
 * - Daily schedules: "HH:MM" UTC.
 * - Catchup protection: clamps next run calculation to prevent execution storms.
 */
import { z } from "zod";

// ────────────────────────────── Schedule Schemas ─────────────────────────────

export const cronExpressionScheduleSchema = z.object({
  type: z.literal("cron"),
  expr: z.string().min(9).max(128),
});

export const intervalScheduleSchema = z.object({
  type: z.literal("interval"),
  everyMs: z.number().int().min(1_000).max(365 * 24 * 3600 * 1_000),
});

export const dailyScheduleSchema = z.object({
  type: z.literal("daily"),
  /** "HH:MM" in UTC (24-hour format). */
  timeUtc: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
});

export const scheduleSchema = z.discriminatedUnion("type", [
  cronExpressionScheduleSchema,
  intervalScheduleSchema,
  dailyScheduleSchema,
]);

export type Schedule = z.infer<typeof scheduleSchema>;

export const cronJobStateSchema = z.enum(["active", "paused", "disabled"]);
export type CronJobState = z.infer<typeof cronJobStateSchema>;

export const cronJobSchema = z.object({
  id: z.string().min(1).max(255),
  schedule: scheduleSchema,
  state: cronJobStateSchema,
  lastRunAt: z.string().nullable(),
  nextRunAt: z.string(),
  consecutiveFailures: z.number().int().nonnegative().default(0),
  maxCatchupRuns: z.number().int().positive().default(1),
  payload: z.record(z.string(), z.unknown()).default({}),
});

export type CronJob = z.infer<typeof cronJobSchema>;

// ─────────────────────────── Cron Expression Parser ─────────────────────────

interface FieldMatcher {
  matches(value: number): boolean;
}

function parseField(field: string, min: number, max: number): FieldMatcher {
  const parts = field.split(",");
  const allowed = new Set<number>();

  for (const part of parts) {
    if (part === "*") {
      for (let i = min; i <= max; i++) allowed.add(i);
    } else if (part.startsWith("*/")) {
      const step = parseInt(part.slice(2), 10);
      if (isNaN(step) || step <= 0) throw new Error(`Invalid step: ${part}`);
      for (let i = min; i <= max; i += step) allowed.add(i);
    } else if (part.includes("-")) {
      const [startStr, endStr] = part.split("-");
      const start = parseInt(startStr!, 10);
      const end = parseInt(endStr!, 10);
      if (isNaN(start) || isNaN(end) || start < min || end > max || start > end) {
        throw new Error(`Invalid range: ${part}`);
      }
      for (let i = start; i <= end; i++) allowed.add(i);
    } else {
      const num = parseInt(part, 10);
      if (isNaN(num) || num < min || num > max) {
        throw new Error(`Value ${part} out of range [${min}, ${max}]`);
      }
      allowed.add(num);
    }
  }

  return {
    matches(v: number): boolean {
      return allowed.has(v);
    },
  };
}

export interface ParsedCron {
  readonly minutes: FieldMatcher;
  readonly hours: FieldMatcher;
  readonly daysOfMonth: FieldMatcher;
  readonly months: FieldMatcher;
  readonly daysOfWeek: FieldMatcher;
}

export function parseCron(expr: string): ParsedCron {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`Expected 5 cron fields, got ${fields.length}: "${expr}"`);
  }

  return {
    minutes: parseField(fields[0]!, 0, 59),
    hours: parseField(fields[1]!, 0, 23),
    daysOfMonth: parseField(fields[2]!, 1, 31),
    months: parseField(fields[3]!, 1, 12),
    daysOfWeek: parseField(fields[4]!, 0, 6),
  };
}

// ────────────────────────── Next Run Computation ───────────────────────────

export function computeNextRunAt(schedule: Schedule, fromDate: Date): Date | null {
  switch (schedule.type) {
    case "interval": {
      return new Date(fromDate.getTime() + schedule.everyMs);
    }

    case "daily": {
      const [hourStr, minuteStr] = schedule.timeUtc.split(":");
      const targetHour = parseInt(hourStr!, 10);
      const targetMinute = parseInt(minuteStr!, 10);

      const next = new Date(fromDate.getTime());
      next.setUTCHours(targetHour, targetMinute, 0, 0);

      if (next.getTime() <= fromDate.getTime()) {
        next.setUTCDate(next.getUTCDate() + 1);
      }
      return next;
    }

    case "cron": {
      const parsed = parseCron(schedule.expr);
      // Start searching 1 minute ahead (truncated to full minute)
      const current = new Date(fromDate.getTime());
      current.setUTCSeconds(0, 0);
      current.setUTCMinutes(current.getUTCMinutes() + 1);

      // Search up to 366 days ahead in 1-minute increments
      const maxIterations = 366 * 24 * 60;
      for (let i = 0; i < maxIterations; i++) {
        const month = current.getUTCMonth() + 1; // 1-12
        const date = current.getUTCDate(); // 1-31
        const dayOfWeek = current.getUTCDay(); // 0-6
        const hour = current.getUTCHours(); // 0-23
        const minute = current.getUTCMinutes(); // 0-59

        if (
          parsed.months.matches(month) &&
          parsed.daysOfMonth.matches(date) &&
          parsed.daysOfWeek.matches(dayOfWeek) &&
          parsed.hours.matches(hour) &&
          parsed.minutes.matches(minute)
        ) {
          return new Date(current.getTime());
        }

        current.setUTCMinutes(current.getUTCMinutes() + 1);
      }

      return null;
    }
  }
}

// ────────────────────────── Due Jobs & Advancement ──────────────────────────

/**
 * Filter jobs that are currently active and due for execution.
 */
export function dueJobs(jobs: readonly CronJob[], now: Date): readonly CronJob[] {
  const nowMs = now.getTime();
  return jobs.filter((job) => {
    if (job.state !== "active") return false;
    const nextMs = new Date(job.nextRunAt).getTime();
    return nextMs <= nowMs;
  });
}

/**
 * Advance a job's schedule after a run.
 */
export function advanceJob(job: CronJob, now: Date): CronJob {
  const next = computeNextRunAt(job.schedule, now);
  return {
    ...job,
    lastRunAt: now.toISOString(),
    nextRunAt: next ? next.toISOString() : job.nextRunAt,
  };
}

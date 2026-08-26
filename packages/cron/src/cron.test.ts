import { describe, expect, test } from "bun:test";
import {
  computeNextRunAt,
  dueJobs,
  advanceJob,
  parseCron,
  type CronJob,
  type Schedule,
} from "./index.js";

describe("cron expression parser", () => {
  test("parses standard wildcards", () => {
    const parsed = parseCron("* * * * *");
    expect(parsed.minutes.matches(0)).toBe(true);
    expect(parsed.minutes.matches(59)).toBe(true);
    expect(parsed.hours.matches(12)).toBe(true);
  });

  test("parses step intervals", () => {
    const parsed = parseCron("*/15 * * * *");
    expect(parsed.minutes.matches(0)).toBe(true);
    expect(parsed.minutes.matches(15)).toBe(true);
    expect(parsed.minutes.matches(30)).toBe(true);
    expect(parsed.minutes.matches(45)).toBe(true);
    expect(parsed.minutes.matches(10)).toBe(false);
  });

  test("parses range intervals", () => {
    const parsed = parseCron("0 9-17 * * *");
    expect(parsed.hours.matches(9)).toBe(true);
    expect(parsed.hours.matches(17)).toBe(true);
    expect(parsed.hours.matches(8)).toBe(false);
    expect(parsed.hours.matches(18)).toBe(false);
  });

  test("throws on invalid field count", () => {
    expect(() => parseCron("* * *")).toThrow();
  });
});

describe("computeNextRunAt", () => {
  test("computes next run for interval schedule", () => {
    const schedule: Schedule = { type: "interval", everyMs: 60_000 };
    const from = new Date("2026-08-26T12:00:00.000Z");
    const next = computeNextRunAt(schedule, from);
    expect(next?.toISOString()).toBe("2026-08-26T12:01:00.000Z");
  });

  test("computes next run for daily schedule same day", () => {
    const schedule: Schedule = { type: "daily", timeUtc: "15:30" };
    const from = new Date("2026-08-26T12:00:00.000Z");
    const next = computeNextRunAt(schedule, from);
    expect(next?.toISOString()).toBe("2026-08-26T15:30:00.000Z");
  });

  test("computes next run for daily schedule next day", () => {
    const schedule: Schedule = { type: "daily", timeUtc: "10:00" };
    const from = new Date("2026-08-26T12:00:00.000Z");
    const next = computeNextRunAt(schedule, from);
    expect(next?.toISOString()).toBe("2026-08-27T10:00:00.000Z");
  });

  test("computes next run for hourly cron", () => {
    const schedule: Schedule = { type: "cron", expr: "0 * * * *" };
    const from = new Date("2026-08-26T12:15:00.000Z");
    const next = computeNextRunAt(schedule, from);
    expect(next?.toISOString()).toBe("2026-08-26T13:00:00.000Z");
  });
});

describe("dueJobs & advanceJob", () => {
  const baseJob: CronJob = {
    id: "job-1",
    schedule: { type: "interval", everyMs: 300_000 },
    state: "active",
    lastRunAt: null,
    nextRunAt: "2026-08-26T12:00:00.000Z",
    consecutiveFailures: 0,
    maxCatchupRuns: 1,
    payload: { task: "cleanup" },
  };

  test("identifies due jobs when time is past nextRunAt", () => {
    const now = new Date("2026-08-26T12:05:00.000Z");
    const due = dueJobs([baseJob], now);
    expect(due.length).toBe(1);
    expect(due[0]!.id).toBe("job-1");
  });

  test("ignores paused jobs", () => {
    const pausedJob: CronJob = { ...baseJob, state: "paused" };
    const now = new Date("2026-08-26T12:05:00.000Z");
    const due = dueJobs([pausedJob], now);
    expect(due.length).toBe(0);
  });

  test("advances job correctly", () => {
    const now = new Date("2026-08-26T12:00:00.000Z");
    const advanced = advanceJob(baseJob, now);
    expect(advanced.lastRunAt).toBe("2026-08-26T12:00:00.000Z");
    expect(advanced.nextRunAt).toBe("2026-08-26T12:05:00.000Z");
  });
});

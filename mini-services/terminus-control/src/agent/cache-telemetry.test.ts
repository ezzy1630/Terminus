import { describe, expect, test } from "bun:test";
import {
  CacheRatioMonitor,
  cacheReadRatio,
  DEFAULT_CACHE_RATIO_THRESHOLD,
} from "./cache-telemetry.js";

describe("R7 cache ratio telemetry", () => {
  test("ratio is null when nothing was predicted cached (cold prefix)", () => {
    expect(cacheReadRatio(0n, 0n)).toBeNull();
    expect(cacheReadRatio(0n, 5_000n)).toBeNull();
    expect(cacheReadRatio(10_000n, 9_500n)).toBeCloseTo(0.95);
  });

  test("a single low attempt does not fire; consecutive misses do", () => {
    const monitor = new CacheRatioMonitor();
    const cold = monitor.record("a1", 10_000n, 200n);
    expect(cold.ratio).toBeCloseTo(0.02);
    expect(monitor.status().warning).toBeNull();
    monitor.record("a2", 10_000n, 300n);
    const status = monitor.status();
    expect(status.consecutiveLowMisses).toBe(2);
    expect(status.warning).toMatch(/stable prefix/i);
  });

  test("a healthy attempt resets the consecutive counter", () => {
    const monitor = new CacheRatioMonitor();
    monitor.record("a1", 10_000n, 100n);
    expect(monitor.status().warning).toBeNull();
    monitor.record("a2", 10_000n, 9_900n);
    expect(monitor.status().consecutiveLowMisses).toBe(0);
    expect(monitor.status().warning).toBeNull();
  });

  test("snapshot is serializable with string bigint fields for evidence artifacts", () => {
    const monitor = new CacheRatioMonitor();
    monitor.record("a1", 4_000n, 3_000n);
    const snapshot = monitor.snapshot();
    const serialized = JSON.stringify(snapshot);
    expect(serialized).toContain("\"predicted\":\"4000\"");
    expect(serialized).toContain("\"actual\":\"3000\"");
    expect(snapshot.averageRatio).toBeCloseTo(0.75);
    expect(snapshot.lowAttempts).toBe(0);
  });

  test("default threshold matches the release gate constant", () => {
    expect(DEFAULT_CACHE_RATIO_THRESHOLD).toBe(0.7);
  });
});

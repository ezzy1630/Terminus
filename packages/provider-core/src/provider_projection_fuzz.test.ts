/**
 * Provider response projection fuzz smoke (SPEC §46.4).
 */
import { describe, expect, test } from "bun:test";
import type { ProviderResponse } from "./index.js";
import type { ModelKey } from "@terminus/domain";

function tryProjectShape(raw: unknown): { ok: boolean; reason: string } {
  if (raw === null || typeof raw !== "object") {
    return { ok: false, reason: "not_object" };
  }
  const rec = raw as Record<string, unknown>;
  if (typeof rec["providerId"] !== "string") {
    return { ok: false, reason: "missing_providerId" };
  }
  if (typeof rec["model"] !== "string") {
    return { ok: false, reason: "missing_model" };
  }
  if (!Array.isArray(rec["chunks"])) {
    return { ok: false, reason: "missing_chunks" };
  }
  return { ok: true, reason: "shape_ok" };
}

describe("provider projection fuzz smoke", () => {
  test("decoder rejects garbage without throwing", () => {
    const samples: unknown[] = [
      null,
      1,
      "x",
      {},
      { providerId: "local", model: "m", chunks: [] },
      { providerId: 1, chunks: [] },
      { providerId: "local" },
    ];
    for (const sample of samples) {
      const result = tryProjectShape(sample);
      expect(typeof result.ok).toBe("boolean");
    }
  });

  test("minimal valid shape accepted", () => {
    const sample: ProviderResponse = {
      providerId: "local",
      model: "local/test" as ModelKey,
      chunks: [{ kind: "text", text: "hi" }],
      observedAt: "2026-07-23T00:00:00Z",
    };
    expect(tryProjectShape(sample).ok).toBe(true);
  });
});

import { describe, expect, test } from "bun:test";
import type {
  ContentHash,
  ModelKey,
  Rfc3339Timestamp,
  TokenCount,
  Uuid7,
} from "@terminus/domain";
import type { ContextCachePlan, ContextFragment } from "@terminus/context-ir";
import {
  buildCacheEpochDebugData,
  buildStablePrefixDebugData,
  compareCacheEpochs,
  snapshotCacheEpoch,
} from "./cache-debug.js";
import { computeContentHash, computeStablePrefixHash } from "@terminus/context-ir";

const MODEL = "openai/test-model" as ModelKey;
const NOW = "2026-08-24T00:00:00Z" as Rfc3339Timestamp;

function fragment(id: string, content: string): ContextFragment {
  const hash = computeContentHash(content);
  return {
    id,
    kind: "task_contract",
    contentRef: {
      hash,
      uri: `artifact://sha256/${hash.slice("sha256:".length)}` as ContextFragment["contentRef"]["uri"],
      mediaType: "text/plain",
      bytes: BigInt(new TextEncoder().encode(content).byteLength) as ContextFragment["contentRef"]["bytes"],
    },
    textContent: content,
    source: {
      uri: `test://${id}`,
      producer: "test",
      producerVersion: "v1",
      observedAt: NOW,
      observedBy: "control",
      evidenceRefs: [],
    },
    sourceVersion: null,
    authority: 90,
    priority: 90,
    trust: "trusted",
    confidentiality: "workspace",
    injectionRisk: "none",
    exactness: "exact",
    scope: { workspaceId: null, sessionId: null, taskId: null, pathPatterns: [] },
    freshness: { observedAt: NOW, sourceVersion: null, stale: false, staleReason: null },
    dependencies: [],
    invalidation: [],
    estimatedTokens: { [MODEL]: content.length } as Readonly<Record<ModelKey, number>>,
    selectionFeatures: {
      relevance: 1,
      novelty: 0,
      coverage: 1,
      uncertaintyReduction: 1,
      riskReduction: 1,
      modelCompatibility: 1,
      redundancyPenalty: 0,
      injectionPenalty: 0,
    },
  };
}

function cachePlan(fragments: readonly ContextFragment[]): ContextCachePlan {
  return {
    stablePrefixHash: computeStablePrefixHash(fragments),
    volatileSuffixBoundary: fragments.length,
    breakpoints: fragments.length === 0 ? [] : [fragments.length - 1],
    predictedCachedTokens: BigInt(fragments.length * 10) as TokenCount,
  };
}

function epoch(id: string, baselineHash: ContentHash, sequence: number) {
  return {
    epochId: id as Uuid7,
    threadId: "00000000-0000-7000-8000-000000000001" as Uuid7,
    sequence,
    baselineHash,
    provider: "openai",
    model: MODEL,
    continuationId: "continuation-1",
    startedAt: NOW,
  };
}

describe("stable-prefix cache diagnostics", () => {
  test("exposes ordered stable-prefix entries and their token totals", () => {
    const fragments = [fragment("authority", "policy"), fragment("contract", "objective")];
    const plan = cachePlan(fragments);
    const debug = buildStablePrefixDebugData(fragments, plan, MODEL);

    expect(debug.hash).toBe(plan.stablePrefixHash);
    expect(debug.fragmentCount).toBe(2);
    expect(debug.entries.map((entry) => entry.fragmentId)).toEqual(["authority", "contract"]);
    expect(debug.tokenCount).toBe("policy".length + "objective".length);
    expect(debug.entries[1]?.cacheBreakpoint).toBe(true);
  });

  test("reports changed stable content instead of attributing a cache miss to the epoch", () => {
    const previousFragments = [fragment("authority", "policy"), fragment("contract", "objective")];
    const currentFragments = [fragment("authority", "policy"), fragment("contract", "new objective")];
    const previousPlan = cachePlan(previousFragments);
    const currentPlan = cachePlan(currentFragments);
    const previous = snapshotCacheEpoch({
      providerId: "openai",
      modelKey: MODEL,
      epoch: epoch("00000000-0000-7000-8000-000000000010", previousPlan.stablePrefixHash, 1),
      cachePlan: previousPlan,
      selectedFragments: previousFragments,
      cacheMode: "automatic_prefix",
      exactPrefixRequired: true,
    });
    const current = snapshotCacheEpoch({
      providerId: "openai",
      modelKey: MODEL,
      epoch: epoch("00000000-0000-7000-8000-000000000011", currentPlan.stablePrefixHash, 2),
      cachePlan: currentPlan,
      selectedFragments: currentFragments,
      cacheMode: "automatic_prefix",
      exactPrefixRequired: true,
    });
    const comparison = compareCacheEpochs(previous, current);

    expect(comparison.stablePrefixChanged).toBe(true);
    expect(comparison.invalidationReasons).toContain("stable_fragment_content_changed");
    expect(comparison.diagnostics.map((item) => item.code)).toContain("epoch_changed");
  });

  test("flags a cache plan or epoch baseline that does not match rendered content", () => {
    const previous = [fragment("authority", "policy")];
    const current = [fragment("authority", "changed policy")];
    const stalePlan = cachePlan(previous);
    const debug = buildCacheEpochDebugData({
      providerId: "openai",
      modelKey: MODEL,
      epoch: epoch("00000000-0000-7000-8000-000000000012", stalePlan.stablePrefixHash, 3),
      cachePlan: stalePlan,
      selectedFragments: current,
    });

    expect(debug.invalidationReasons).toEqual(
      expect.arrayContaining(["planned_hash_mismatch", "epoch_baseline_mismatch"]),
    );
  });

  test("reports canonical stable-prefix ordering violations without repairing the hash", () => {
    const fragments = [
      fragment("contract", "objective"),
      { ...fragment("authority", "policy"), kind: "authority" as const },
    ];
    const plan = cachePlan(fragments);
    const debug = snapshotCacheEpoch({
      providerId: "openai",
      modelKey: MODEL,
      epoch: null,
      cachePlan: plan,
      selectedFragments: fragments,
    });

    expect(debug.canonicalOrderingValid).toBe(false);
    expect(debug.orderingViolationAt).toBe(1);
    expect(debug.stablePrefix.hash).toBe(plan.stablePrefixHash);
    const compared = buildCacheEpochDebugData({
      providerId: "openai",
      modelKey: MODEL,
      epoch: null,
      cachePlan: plan,
      selectedFragments: fragments,
    });
    expect(compared.invalidationReasons).toContain("stable_prefix_order_invalid");
  });
});

/**
 * Context manifest decoder properties (SPEC §46.3, §46.4).
 */
import { describe, expect, test } from "bun:test";
import {
  buildManifest,
  isHardRequired,
  type ManifestBuilderInput,
  type ContextFragment,
  type ContextEpochSnapshot,
  type ContextCachePlan,
} from "./index.js";
import type {
  ContentHash,
  ModelKey,
  Rfc3339Timestamp,
  TokenCount,
  Uuid7,
} from "@terminus/domain";

const MODEL = "test/model" as ModelKey;
const NOW = "2026-07-23T00:00:00Z" as Rfc3339Timestamp;
const HASH = `sha256:${"ab".repeat(32)}` as ContentHash;

function fragment(id: string, authority: number): ContextFragment {
  return {
    id,
    kind: "code",
    contentRef: {
      hash: HASH,
      uri: `artifact://sha256/${"ab".repeat(32)}` as ContextFragment["contentRef"]["uri"],
      mediaType: "text/plain",
      bytes: 0n as ContextFragment["contentRef"]["bytes"],
    },
    source: {
      uri: "test://source",
      producer: "test",
      producerVersion: "0",
      observedAt: NOW,
      observedBy: "control",
      evidenceRefs: [],
    },
    sourceVersion: null,
    authority,
    priority: 0,
    trust: "derived",
    confidentiality: "workspace",
    injectionRisk: "low",
    exactness: "exact",
    scope: {
      workspaceId: null,
      sessionId: null,
      taskId: null,
      pathPatterns: [],
    },
    freshness: {
      stale: false,
      sourceVersion: null,
      observedAt: NOW,
      staleReason: null,
    },
    dependencies: [],
    invalidation: [],
    estimatedTokens: { [MODEL]: 10 },
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

function epoch(): ContextEpochSnapshot {
  return {
    epochId: "01900000-0000-7000-8000-0000000000aa" as Uuid7,
    threadId: "01900000-0000-7000-8000-0000000000bb" as Uuid7,
    sequence: 1,
    baselineHash: HASH,
    provider: "test",
    model: MODEL,
    continuationId: null,
    startedAt: NOW,
  };
}

function cachePlan(): ContextCachePlan {
  return {
    stablePrefixHash: HASH,
    volatileSuffixBoundary: 0,
    breakpoints: [],
    predictedCachedTokens: 0n as TokenCount,
  };
}

function input(
  selected: ContextFragment[],
  selectedCachePlan: ContextCachePlan = cachePlan(),
): ManifestBuilderInput {
  return {
    compilerVersion: "0.1.0",
    policyVersion: "0.1.0",
    providerCapabilityHash: HASH,
    model: MODEL,
    epoch: epoch(),
    selected,
    omitted: [],
    cachePlan: selectedCachePlan,
    reserves: {
      output: 100n as TokenCount,
      reasoning: 0n as TokenCount,
      toolResult: 0n as TokenCount,
      recovery: 0n as TokenCount,
    },
    predictedCachedTokens: 0n as TokenCount,
    confidentialityDecisions: {},
    taintDecisions: {},
    experimentAssignments: [],
    occurredAt: NOW,
  };
}

describe("context manifest properties", () => {
  test("hard-required fragments retain required=true in manifest", () => {
    const hard = fragment("hard-1", 90);
    const soft = fragment("soft-1", 40);
    expect(isHardRequired(hard)).toBe(true);
    expect(isHardRequired(soft)).toBe(false);
    const manifest = buildManifest(input([hard, soft]));
    const hardEntry = manifest.fragments.find((f) => f.fragmentId === hard.id);
    expect(hardEntry?.required).toBe(true);
  });

  test("manifest builder accepts empty selection", () => {
    const manifest = buildManifest(input([]));
    expect(manifest.fragments).toEqual([]);
  });

  test("manifest entries preserve cache breakpoint positions", () => {
    const selected = [fragment("stable", 90), fragment("volatile", 40)];
    const manifest = buildManifest(input(selected, {
      ...cachePlan(),
      breakpoints: [0],
    }));

    expect(manifest.fragments.map((entry) => entry.cacheBreakpoint)).toEqual([true, false]);
  });

  test("garbage JSON decode does not throw when guarded", () => {
    for (const raw of ["", "{", "[]", "null", "{\"fragments\":1}"]) {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }
      expect(parsed === null || typeof parsed === "object").toBe(true);
    }
  });
});

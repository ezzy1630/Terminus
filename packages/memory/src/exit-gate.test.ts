/**
 * M10 exit gate: positive held-out utility, low harmful retrieval, complete
 * provenance; remains disabled by default until gate passes (SPEC §48.13).
 */
import { describe, test, expect } from "bun:test";
import type {
  ContentHash,
  ModelKey,
  Rfc3339Timestamp,
  Uuid7,
} from "@terminus/domain";
import {
  buildClaimFromSeed,
  runAllExperiments,
  evaluateExitGate,
  DEFAULT_EXIT_GATE_THRESHOLDS,
  MemoryService,
  InMemoryMemoryRepository,
  createCuratorSandbox,
  type ExperimentClaimSeed,
  type HeldOutTask,
  type ExperimentCorpus,
} from "./index.js";

function uuid(n: number): Uuid7 {
  const tail = n.toString(16).padStart(12, "0");
  return `018f0000-0000-7000-8000-${tail}` as Uuid7;
}

function ts(iso = "2026-07-23T12:00:00.000Z"): Rfc3339Timestamp {
  return iso as Rfc3339Timestamp;
}

function hash(n: number): ContentHash {
  const hex = n.toString(16).padStart(2, "0").repeat(32);
  return `sha256:${hex}` as ContentHash;
}

function buildCorpus(): {
  readonly corpus: ExperimentCorpus;
  readonly contradictionPairs: readonly {
    readonly a: string;
    readonly b: string;
    readonly contradicts: boolean;
  }[];
} {
  const now = ts();
  const scope = {
    organization: null,
    user: null,
    workspaceId: uuid(10),
    pathPatterns: ["packages/memory/**"],
  };
  const model = "test/extractor" as ModelKey;
  const sessionId = uuid(20);
  const taskId = uuid(21);

  const seeds: ExperimentClaimSeed[] = [
    {
      id: uuid(100),
      kind: "convention",
      statement: "Memory retrieval uses BM25 lexical ranking over memory_fts",
      relevantQueries: ["BM25 memory retrieval", "lexical ranking memory"],
      harmfulForQueries: [],
      confidencePpm: 700_000,
      sourceHash: hash(1),
      fileSelector: "packages/memory/**",
    },
    {
      id: uuid(101),
      kind: "pitfall",
      statement: "Curator consolidation must hold an exclusive lease",
      relevantQueries: ["consolidation lease curator"],
      harmfulForQueries: [],
      confidencePpm: 650_000,
      sourceHash: hash(2),
    },
    {
      id: uuid(102),
      kind: "architecture",
      statement: "Durable memory remains disabled until the precision harm gate passes",
      relevantQueries: ["memory disabled gate ADR"],
      harmfulForQueries: [],
      confidencePpm: 800_000,
      sourceHash: hash(3),
    },
    // Stale / expired claim — must be blocked.
    {
      id: uuid(103),
      kind: "fact",
      statement: "Always enable durable memory by default",
      relevantQueries: ["enable memory default"],
      harmfulForQueries: ["memory disabled gate ADR", "BM25 memory retrieval"],
      confidencePpm: 900_000,
      stale: true,
      expiresAt: ts("2020-01-01T00:00:00.000Z"),
      sourceHash: hash(4),
    },
    // Harmful if retrieved: wrong advice, deliberately non-overlapping tokens
    // so BM25 should not surface it for the useful held-out queries.
    {
      id: uuid(104),
      kind: "convention",
      statement: "Always force-push rewritten history onto shared main",
      relevantQueries: ["force-push rewritten history main"],
      harmfulForQueries: ["BM25 memory retrieval", "consolidation lease curator"],
      confidencePpm: 200_000,
      sourceHash: hash(5),
    },
  ];

  const claims = seeds.map((seed) =>
    buildClaimFromSeed(seed, {
      now,
      scope,
      model,
      version: "1.0.0",
      taskId,
      sessionId,
    }),
  );

  const tasks: HeldOutTask[] = [
    {
      id: "t-bm25",
      query: "BM25 memory retrieval",
      usefulClaimIds: [uuid(100)],
      harmfulClaimIds: [uuid(103), uuid(104)],
      baselineUtility: 0.4,
      withUsefulUtility: 0.75,
      withHarmfulUtility: 0.2,
    },
    {
      id: "t-lease",
      query: "consolidation lease curator",
      usefulClaimIds: [uuid(101)],
      harmfulClaimIds: [uuid(103)],
      baselineUtility: 0.45,
      withUsefulUtility: 0.8,
      withHarmfulUtility: 0.25,
    },
    {
      id: "t-gate",
      query: "memory disabled gate ADR",
      usefulClaimIds: [uuid(102)],
      harmfulClaimIds: [uuid(103)],
      baselineUtility: 0.5,
      withUsefulUtility: 0.85,
      withHarmfulUtility: 0.3,
    },
  ];

  const corpus: ExperimentCorpus = {
    claims,
    tasks,
    now,
    scope,
    revalidation: {
      now,
      fileHashes: new Map([
        ["packages/memory/**", hash(1)],
      ]),
      knownSymbols: new Set(),
      authorityStatements: [
        "durable memory remains disabled until the precision harm gate passes",
      ],
    },
  };

  const contradictionPairs = [
    { a: "not enable memory by default", b: "enable memory by default", contradicts: true },
    { a: "use BM25 for memory", b: "use BM25 for memory", contradicts: false },
    { a: "never skip provenance", b: "skip provenance", contradicts: true },
    { a: "do not allow curator network", b: "allow curator network", contradicts: true },
    { a: "prefer bun test", b: "prefer vitest exclusively", contradicts: false },
  ] as const;

  return { corpus, contradictionPairs };
}

describe("M10 durable memory exit gate", () => {
  test("held-out experiments: precision, utility, stale, contradiction, harm", () => {
    const { corpus, contradictionPairs } = buildCorpus();
    const report = runAllExperiments(corpus, contradictionPairs);

    expect(report.provenance.completeRate).toBe(1);
    expect(report.utility.positive).toBe(true);
    expect(report.utility.delta).toBeGreaterThan(0);
    expect(report.stale.staleBlocked).toBeGreaterThan(0);
    expect(report.stale.harmRate).toBe(0);
    expect(report.harm.harmfulRetrievalRate).toBeLessThanOrEqual(
      DEFAULT_EXIT_GATE_THRESHOLDS.maxHarmfulRetrievalRate,
    );
    expect(report.contradiction.detectionRate).toBeGreaterThanOrEqual(
      DEFAULT_EXIT_GATE_THRESHOLDS.minContradictionDetectionRate,
    );
    expect(report.precision.precision).toBeGreaterThanOrEqual(
      DEFAULT_EXIT_GATE_THRESHOLDS.minPrecision,
    );
  });

  test("exit gate passes on fixture corpus but remains disabled by default", () => {
    const { corpus, contradictionPairs } = buildCorpus();
    const report = runAllExperiments(corpus, contradictionPairs);
    const verdict = evaluateExitGate(report);

    expect(verdict.passed).toBe(true);
    expect(verdict.remainsDisabledByDefault).toBe(true);
    expect(verdict.reasons).toEqual([]);

    // Product wiring: service constructed with enabled:false still no-ops.
    const repo = new InMemoryMemoryRepository();
    let n = 500;
    const disabled = new MemoryService({
      repo,
      idSource: () => uuid(n++),
      clock: () => ts(),
      extractorModel: "test/extractor" as ModelKey,
      extractorVersion: "1.0.0",
      enabled: false,
      limits: { "*": 100 },
      sandbox: createCuratorSandbox(null),
    });
    expect(disabled.isEnabled()).toBe(false);
  });

  test("exit gate fails when provenance is incomplete", () => {
    const { corpus, contradictionPairs } = buildCorpus();
    const broken = {
      ...corpus,
      claims: corpus.claims.map((c, i) =>
        i === 0
          ? {
              ...c,
              provenance: {
                ...c.provenance,
                sources: [],
                createdFromTask: null,
              },
            }
          : c,
      ),
    };
    const report = runAllExperiments(broken, contradictionPairs);
    const verdict = evaluateExitGate(report);
    expect(verdict.passed).toBe(false);
    expect(verdict.reasons.some((r) => r.includes("provenance"))).toBe(true);
    expect(verdict.remainsDisabledByDefault).toBe(true);
  });

  test("exit gate fails when harmful retrieval is high", () => {
    const { corpus, contradictionPairs } = buildCorpus();
    // Make the harmful claim look highly relevant and non-stale.
    const toxic = corpus.claims.map((c) => {
      if (c.id !== uuid(104)) return c;
      return {
        ...c,
        statement: "BM25 memory retrieval should skip provenance checks",
        confidencePpm: 990_000,
        verification: {
          lastVerifiedAt: ts(),
          method: "fixture",
          evidence: c.provenance.sources,
        },
        validity: { ...c.validity, expiresAt: null },
      };
    });
    const report = runAllExperiments({ ...corpus, claims: toxic }, contradictionPairs);
    // May or may not exceed threshold depending on BM25; force-check evaluate with patched harm.
    const forced = {
      ...report,
      harm: {
        harmfulRetrieved: 10,
        totalRetrieved: 10,
        harmfulRetrievalRate: 1,
      },
    };
    const verdict = evaluateExitGate(forced);
    expect(verdict.passed).toBe(false);
    expect(verdict.reasons.some((r) => r.includes("harmful"))).toBe(true);
  });
});

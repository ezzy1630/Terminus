/**
 * Unit tests for durable memory privacy, contradiction, BM25, revalidation,
 * controls, telemetry, and procedure→skill promotion.
 */
import { describe, test, expect } from "bun:test";
import type {
  ArtifactRef,
  ContentHash,
  ModelKey,
  Rfc3339Timestamp,
  Task,
  Uuid7,
} from "@terminus/domain";
import {
  MemoryService,
  InMemoryMemoryRepository,
  InMemoryTelemetrySink,
  filterPrivateData,
  isContradiction,
  shouldSupersede,
  bm25Score,
  tokenize,
  revalidateClaim,
  hasCompleteProvenance,
  promoteProcedureToSkill,
  isPromotionEligible,
  createCuratorSandbox,
  retrieveMemories,
  explainRetrieval,
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

function artifact(n: number): ArtifactRef {
  const h = hash(n);
  return {
    hash: h,
    uri: (`artifact://sha256/${h.slice(7)}`) as ArtifactRef["uri"],
    mediaType: "application/json",
    bytes: 64n as ArtifactRef["bytes"],
  };
}

function makeTask(overrides?: Partial<Task>): Task {
  return {
    id: uuid(1),
    sessionId: uuid(2),
    threadId: uuid(3),
    contract: {
      id: uuid(4),
      version: 1,
      objective: "Add BM25 memory retrieval",
      userOutcome: null,
      nonGoals: [],
      acceptanceCriteria: [
        {
          id: "ac1",
          statement: "BM25 ranks relevant claims above noise",
          verificationHint: null,
          required: true,
        },
      ],
      constraints: ["No network in curator"],
      assumptions: ["FTS table exists"],
      unknowns: ["Semantic index availability"],
      allowedScope: {
        readPaths: ["packages/memory/**"],
        writePaths: ["packages/memory/**"],
        externalSystems: [],
      },
      riskClass: "normal",
      budget: {
        modelMicros: 0n as Task["contract"]["budget"]["modelMicros"],
        computeSeconds: 60,
        wallClockSeconds: 300,
        humanApprovals: 0,
      },
      changePolicy: { mayExpandScope: false, scopeExpansionRequiresUser: true },
    },
    status: "COMPLETED",
    phase: "COMPLETE",
    scopeLedgerId: null,
    verificationPlanId: null,
    createdAt: ts(),
    completedAt: ts(),
    ...overrides,
  };
}

function makeService(enabled: boolean, telemetry?: InMemoryTelemetrySink) {
  let n = 100;
  const repo = new InMemoryMemoryRepository();
  const service = new MemoryService({
    repo,
    idSource: () => uuid(n++),
    clock: () => ts(),
    extractorModel: "test/extractor" as ModelKey,
    extractorVersion: "1.0.0",
    enabled,
    limits: { "*": 1000 },
    telemetry: telemetry ?? new InMemoryTelemetrySink(),
    sandbox: createCuratorSandbox(null),
  });
  return { service, repo };
}

describe("privacy filter", () => {
  test("rejects AWS keys", () => {
    const r = filterPrivateData("key AKIAIOSFODNN7EXAMPLE stored");
    expect(r.kind).toBe("reject");
  });

  test("rejects password assignments", () => {
    const r = filterPrivateData("password: hunter2");
    expect(r.kind).toBe("reject");
  });

  test("redacts email PII", () => {
    const r = filterPrivateData("Contact alice@example.com for review");
    expect(r.kind).toBe("redact");
    if (r.kind === "redact") {
      expect(r.statement).toContain("[REDACTED:email_address]");
      expect(r.statement).not.toContain("alice@example.com");
    }
  });

  test("allows clean convention statements", () => {
    const r = filterPrivateData("Tests use bun test in packages/*");
    expect(r.kind).toBe("allow");
  });
});

describe("contradiction and supersession", () => {
  test("detects negation contradictions", () => {
    expect(isContradiction("not use redis", "use redis")).toBe(true);
    expect(isContradiction("use redis", "use redis")).toBe(false);
  });

  test("shouldSupersede prefers higher confidence same-kind claims", () => {
    const older = {
      id: uuid(1),
      kind: "convention" as const,
      statement: "use bun test for packages",
      procedureArtifactHash: null,
      scope: { organization: null, user: null, workspaceId: null, pathPatterns: [] },
      provenance: {
        sources: [artifact(1)],
        createdFromSession: uuid(2),
        createdFromTask: uuid(3),
        extractorModel: "m" as ModelKey,
        extractorVersion: "1",
      },
      confidencePpm: 300_000,
      verification: { lastVerifiedAt: ts(), method: "x", evidence: [] },
      validity: { startsAt: ts(), expiresAt: null, invalidationRules: [] },
      usage: { count: 0, lastUsedAt: null, successfulUses: 0, harmfulUses: 0 },
      relations: { supports: [], contradicts: [], supersedes: [] },
      status: "active" as const,
      createdAt: ts(),
    };
    const newer = { ...older, id: uuid(9), confidencePpm: 600_000, statement: "use bun test for all packages" };
    expect(shouldSupersede(newer, older)).toBe(true);
  });
});

describe("BM25", () => {
  test("scores relevant docs higher", () => {
    const corpus = [
      { id: "1", tokens: tokenize("BM25 retrieval for memory claims") },
      { id: "2", tokens: tokenize("unrelated kubernetes cooking recipe") },
    ];
    const q = tokenize("memory BM25 retrieval");
    const s1 = bm25Score(q, corpus[0]!, corpus);
    const s2 = bm25Score(q, corpus[1]!, corpus);
    expect(s1).toBeGreaterThan(s2);
  });
});

describe("revalidation", () => {
  test("TTL expiry marks stale", () => {
    const claim = {
      id: uuid(1),
      kind: "fact" as const,
      statement: "old fact",
      procedureArtifactHash: null,
      scope: { organization: null, user: null, workspaceId: null, pathPatterns: [] },
      provenance: {
        sources: [artifact(1)],
        createdFromSession: uuid(2),
        createdFromTask: uuid(3),
        extractorModel: "m" as ModelKey,
        extractorVersion: "1",
      },
      confidencePpm: 300_000,
      verification: { lastVerifiedAt: null, method: null, evidence: [] },
      validity: {
        startsAt: ts("2020-01-01T00:00:00.000Z"),
        expiresAt: ts("2020-01-02T00:00:00.000Z"),
        invalidationRules: [],
      },
      usage: { count: 0, lastUsedAt: null, successfulUses: 0, harmfulUses: 0 },
      relations: { supports: [], contradicts: [], supersedes: [] },
      status: "active" as const,
      createdAt: ts("2020-01-01T00:00:00.000Z"),
    };
    const outcome = revalidateClaim(claim, {
      now: ts("2026-07-23T12:00:00.000Z"),
      fileHashes: new Map(),
      knownSymbols: new Set(),
      authorityStatements: [],
    });
    expect(outcome.status).toBe("stale");
  });

  test("authority override blocks contradicting claims", () => {
    const claim = {
      id: uuid(1),
      kind: "fact" as const,
      statement: "not route effects through the kernel",
      procedureArtifactHash: null,
      scope: { organization: null, user: null, workspaceId: null, pathPatterns: [] },
      provenance: {
        sources: [artifact(1)],
        createdFromSession: uuid(2),
        createdFromTask: uuid(3),
        extractorModel: "m" as ModelKey,
        extractorVersion: "1",
      },
      confidencePpm: 300_000,
      verification: { lastVerifiedAt: ts(), method: "x", evidence: [] },
      validity: { startsAt: ts(), expiresAt: null, invalidationRules: [] },
      usage: { count: 0, lastUsedAt: null, successfulUses: 0, harmfulUses: 0 },
      relations: { supports: [], contradicts: [], supersedes: [] },
      status: "active" as const,
      createdAt: ts(),
    };
    const outcome = revalidateClaim(claim, {
      now: ts(),
      fileHashes: new Map(),
      knownSymbols: new Set(),
      authorityStatements: ["route effects through the kernel"],
    });
    expect(outcome.status).toBe("stale");
    if (outcome.status === "stale") {
      expect(outcome.method).toBe("authority_override");
    }
  });
});

describe("MemoryService disabled by default path", () => {
  test("extract/retrieve/consolidate no-op when disabled", async () => {
    const { service } = makeService(false);
    const task = makeTask();
    const extracted = await service.extractCandidates(task, [artifact(1)]);
    expect(extracted).toEqual([]);
    const retrieved = await service.retrieve({ query: "BM25", scope: {} });
    expect(retrieved.results).toEqual([]);
    expect(retrieved.enabled).toBe(false);
    const cons = await service.consolidate();
    expect(cons.promoted).toEqual([]);
  });
});

describe("MemoryService happy path when enabled", () => {
  test("extract → consolidate → retrieve with provenance and explanation", async () => {
    const telemetry = new InMemoryTelemetrySink();
    const { service, repo } = makeService(true, telemetry);
    const task = makeTask();
    const sources = [artifact(1)];

    const candidates = await service.extractCandidates(task, sources, {
      scope: { workspaceId: uuid(50), pathPatterns: ["packages/memory/**"] },
    });
    expect(candidates.length).toBeGreaterThan(0);
    for (const c of candidates) {
      expect(c.status).toBe("candidate");
      expect(hasCompleteProvenance(c)).toBe(true);
    }

    // Reject secret-bearing extraction via privacy on a crafted path:
    const secretItems = await service.extractCandidates(task, sources, {
      userStatements: ["api_key: sk-abcdefghijklmnopqrstuvwxyz012345"],
    });
    // Secret statement is queue-rejected; may not appear as persisted candidate.
    void secretItems;

    const cons = await service.consolidate({
      now: ts(),
      fileHashes: new Map([["packages/memory/**", hash(1)]]),
      knownSymbols: new Set(),
      authorityStatements: [],
    });
    expect(cons.promoted.length).toBeGreaterThan(0);

    const retrieved = await service.retrieve({
      query: "BM25 memory retrieval",
      scope: { workspaceId: uuid(50) },
      limit: 5,
      revalidation: {
        now: ts(),
        fileHashes: new Map([["packages/memory/**", hash(1)]]),
        knownSymbols: new Set(),
        authorityStatements: [],
      },
    });
    expect(retrieved.enabled).toBe(true);
    expect(retrieved.explanations.length).toBe(retrieved.results.length);
    for (const e of retrieved.explanations) {
      expect(e.whyRetrieved.length).toBeGreaterThan(0);
      expect(e.source.complete).toBe(true);
      expect(e.confidence).toBeGreaterThan(0);
      expect(e.freshness).toBeDefined();
    }
    expect(telemetry.byKind("retrieved").length).toBeGreaterThan(0);

    // Controls
    const exported = await service.export();
    expect(exported.length).toBeGreaterThan(0);
    const first = cons.promoted[0]!;
    await service.quarantine(first, "test");
    const q = await repo.getClaim(first);
    expect(q?.status).toBe("disputed");
  });

  test("harmful-use auto-quarantines", async () => {
    const telemetry = new InMemoryTelemetrySink();
    const { service, repo } = makeService(true, telemetry);
    const task = makeTask();
    const candidates = await service.extractCandidates(task, [artifact(2)]);
    await service.consolidate();
    const id = candidates[0]!.id;
    // Force active
    const claim = await repo.getClaim(id);
    expect(claim).not.toBeNull();
    await repo.updateClaim({ ...claim!, status: "active" });

    await service.recordHarm(id, "caused wrong edit");
    await service.recordHarm(id, "caused wrong edit");
    const after = await service.recordHarm(id, "caused wrong edit");
    expect(after.usage.harmfulUses).toBe(3);
    expect(after.status).toBe("disputed");
    expect(telemetry.byKind("quarantined").length).toBeGreaterThan(0);
  });

  test("procedure promotes to skill after verified successes", async () => {
    const { service, repo } = makeService(true);
    const task = makeTask();
    const src = artifact(3);
    const candidates = await service.extractCandidates(task, [src], {
      procedureArtifactHash: src.hash,
    });
    await service.consolidate();
    const proc = candidates.find((c) => c.kind === "procedure");
    expect(proc).toBeDefined();
    let claim = (await repo.getClaim(proc!.id))!;
    claim = {
      ...claim,
      status: "active",
      procedureArtifactHash: src.hash,
      verification: {
        lastVerifiedAt: ts(),
        method: "benchmark",
        evidence: [src],
      },
      usage: { count: 3, lastUsedAt: ts(), successfulUses: 3, harmfulUses: 0 },
    };
    await repo.updateClaim(claim);
    expect(isPromotionEligible(claim)).toBe(true);

    const draft = await service.promoteToSkill({
      claimId: claim.id,
      name: "add-memory-module",
      version: "0.1.0",
      inputs: ["task"],
      outputs: ["skill draft"],
      failureBehavior: "abort and surface ValidationError",
      tests: ["packages/memory/src/exit-gate.test.ts"],
      approvedBy: "policy:memory-owner",
    });
    expect(draft.status).toBe("approved");
    expect(draft.procedureArtifactHash).toBe(src.hash);
  });

  test("disable / reset controls", async () => {
    const { service } = makeService(true);
    const task = makeTask();
    await service.extractCandidates(task, [artifact(4)]);
    await service.consolidate();
    await service.disable();
    expect(service.isEnabled()).toBe(false);
    const r = await service.retrieve({ query: "BM25", scope: {} });
    expect(r.results).toEqual([]);
    await service.reset();
    const exported = await service.export();
    expect(exported).toEqual([]);
  });

  test("consolidation lease is exclusive", async () => {
    const { service, repo } = makeService(true);
    const held = await repo.acquireLease("memory:consolidation", "other", 60);
    expect(held).toBe(true);
    await expect(service.consolidate()).rejects.toThrow(/consolidation already in progress/);
    await repo.releaseLease("memory:consolidation", "other");
  });
});

describe("optional semantic retrieval", () => {
  test("semantic scorer is opt-in", () => {
    const claim = {
      id: uuid(1),
      kind: "fact" as const,
      statement: "prefer worktree isolation for parallel writers",
      procedureArtifactHash: null,
      scope: { organization: null, user: null, workspaceId: uuid(50), pathPatterns: [] },
      provenance: {
        sources: [artifact(1)],
        createdFromSession: uuid(2),
        createdFromTask: uuid(3),
        extractorModel: "m" as ModelKey,
        extractorVersion: "1",
      },
      confidencePpm: 500_000,
      verification: { lastVerifiedAt: ts(), method: "x", evidence: [artifact(1)] },
      validity: { startsAt: ts(), expiresAt: null, invalidationRules: [] },
      usage: { count: 0, lastUsedAt: null, successfulUses: 1, harmfulUses: 0 },
      relations: { supports: [], contradicts: [], supersedes: [] },
      status: "active" as const,
      createdAt: ts(),
    };
    const without = retrieveMemories([claim], {
      query: "zzzz-no-overlap",
      scope: { workspaceId: uuid(50) },
      now: ts(),
      enableSemantic: false,
    });
    expect(without.length).toBe(0);

    const withSem = retrieveMemories([claim], {
      query: "zzzz-no-overlap",
      scope: { workspaceId: uuid(50) },
      now: ts(),
      enableSemantic: true,
      semanticScorer: {
        score: () => 0.95,
      },
    });
    expect(withSem.length).toBe(1);
    expect(withSem[0]!.semanticScore).toBe(0.95);
  });
});

describe("explanation shape", () => {
  test("includes why, source, scope, confidence, freshness", () => {
    const claim = {
      id: uuid(1),
      kind: "convention" as const,
      statement: "use just check before handoff",
      procedureArtifactHash: null,
      scope: {
        organization: null,
        user: null,
        workspaceId: uuid(50),
        pathPatterns: ["**"],
      },
      provenance: {
        sources: [artifact(1)],
        createdFromSession: uuid(2),
        createdFromTask: uuid(3),
        extractorModel: "m" as ModelKey,
        extractorVersion: "1",
      },
      confidencePpm: 400_000,
      verification: { lastVerifiedAt: ts(), method: "curator_promote", evidence: [artifact(1)] },
      validity: { startsAt: ts(), expiresAt: null, invalidationRules: [] },
      usage: { count: 1, lastUsedAt: ts(), successfulUses: 1, harmfulUses: 0 },
      relations: { supports: [], contradicts: [], supersedes: [] },
      status: "active" as const,
      createdAt: ts(),
    };
    const e = explainRetrieval({
      claim,
      query: "check",
      now: ts(),
      lexicalScore: 1.2,
      semanticScore: null,
      rankReasons: ["bm25=1.2000", "confidence_ppm=400000"],
    });
    expect(e.whyRetrieved).toContain("bm25");
    expect(e.source.complete).toBe(true);
    expect(e.scope.workspaceId).toBe(uuid(50));
    expect(e.confidence).toBeCloseTo(0.4);
    expect(e.freshness).toBe("fresh");
  });
});

describe("promoteProcedureToSkill rejects incomplete", () => {
  test("requires tests", () => {
    const claim = {
      id: uuid(1),
      kind: "procedure" as const,
      statement: "run consolidation under lease",
      procedureArtifactHash: hash(9),
      scope: { organization: null, user: null, workspaceId: null, pathPatterns: [] },
      provenance: {
        sources: [artifact(1)],
        createdFromSession: uuid(2),
        createdFromTask: uuid(3),
        extractorModel: "m" as ModelKey,
        extractorVersion: "1",
      },
      confidencePpm: 500_000,
      verification: { lastVerifiedAt: ts(), method: "benchmark", evidence: [] },
      validity: { startsAt: ts(), expiresAt: null, invalidationRules: [] },
      usage: { count: 5, lastUsedAt: ts(), successfulUses: 5, harmfulUses: 0 },
      relations: { supports: [], contradicts: [], supersedes: [] },
      status: "active" as const,
      createdAt: ts(),
    };
    expect(() =>
      promoteProcedureToSkill({
        claim,
        idSource: () => uuid(99),
        clock: () => ts(),
        name: "x",
        version: "1",
        inputs: [],
        outputs: [],
        failureBehavior: "fail",
        tests: [],
      }),
    ).toThrow(/requires tests/);
  });
});

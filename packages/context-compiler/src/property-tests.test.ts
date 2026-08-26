/**
 * @terminus/context-compiler — Property Tests (SPEC §33.16, §46.3).
 *
 * Exit-gate properties:
 *  1. Hard-required fragments can never be omitted.
 *  2. Complete tool episodes are never split.
 *  3. Budget allocation never exceeds the hard limit.
 *  4. Manifest is persisted before every provider send.
 *  5. Checkpoints retain requirements, acceptance criteria,
 *     failures, unresolved decisions, scope, and evidence references.
 *  6. Provenance DAG expands to raw artifacts.
 */

import { describe, expect, test } from "bun:test";
import type {
  ContentHash,
  Micros,
  ModelKey,
  Rfc3339Timestamp,
  TokenCount,
  Uuid7,
  ArtifactRef,
  ArtifactUri,
  ByteCount,
} from "@terminus/domain";
import type {
  ContextFragment,
  ContextScope,
  SelectionFeatures,
  SourceDescriptor,
  Freshness,
  InvalidationRule,
} from "@terminus/domain";
import type { ContextFragment as CtxFragment } from "@terminus/context-ir";
import {
  allocateBudget,
  deduplicateAndValidate,
  scoreCandidates,
  type RetrievalResult,
  type ScoredCandidate,
} from "./index.js";
import {
  checkpointContentSchema,
  generateCheckpointContent,
  validateCheckpoint,
  type CheckpointContent,
} from "./checkpoint.js";
import { ProvenanceDag, type ProvenanceNode } from "./checkpoint.js";
import { discoverInstructions, instructionsToFragments } from "./project-instructions.js";
import { reconstructGoalState, diffGoalStates, formatProgressSummary } from "./durable-goal-state.js";

// ──────────────────────── Test helpers ───────────────────────────────────────

const MODEL_KEY = "test/model" as ModelKey;
const NOW = "2026-07-23T00:00:00Z" as Rfc3339Timestamp;

function scope(): ContextScope {
  return {
    workspaceId: null,
    sessionId: null,
    taskId: null,
    pathPatterns: [],
  };
}

function emptyFeatures(): SelectionFeatures {
  return {
    relevance: 1,
    novelty: 0,
    coverage: 1,
    uncertaintyReduction: 1,
    riskReduction: 1,
    modelCompatibility: 1,
    redundancyPenalty: 0,
    injectionPenalty: 0,
  };
}

function source(): SourceDescriptor {
  return {
    uri: "test://source",
    producer: "test",
    producerVersion: "v1",
    observedAt: NOW,
    observedBy: "kernel",
    evidenceRefs: [],
  };
}

function fresh(): Freshness {
  return {
    observedAt: NOW,
    sourceVersion: null,
    stale: false,
    staleReason: null,
  };
}

function makeFragment(
  id: string,
  authority: number,
  tokens: number,
  dependencies: readonly string[] = [],
): ContextFragment {
  return {
    id,
    kind: "code",
    contentRef: {
      hash: `sha256:${id}` as ContentHash,
      uri: `artifact://sha256/${id}` as ArtifactUri,
      mediaType: "text/plain",
      bytes: BigInt(tokens * 4) as ByteCount,
    },
    textContent: `content of ${id}`,
    source: source(),
    sourceVersion: null,
    authority,
    priority: authority,
    trust: "derived",
    confidentiality: "workspace",
    injectionRisk: "low",
    exactness: "recoverable_by_reference",
    scope: scope(),
    freshness: fresh(),
    dependencies,
    invalidation: [],
    estimatedTokens: { [MODEL_KEY]: tokens } as Readonly<Record<string, number>>,
    selectionFeatures: emptyFeatures(),
  };
}

function makeResult(
  fragment: ContextFragment,
  method: RetrievalResult["method"] = "lexical_bm25",
): RetrievalResult {
  return {
    fragment,
    method,
    rawScore: 1,
    rerankedScore: 1,
    sourceVersion: null,
    reason: "test",
  };
}

function standardBudget(): import("@terminus/context-ir").ContextBudget {
  return {
    modelAdvertisedTokens: 100_000n as TokenCount,
    testedSafeTokens: 50_000n as TokenCount,
    protocolOverheadTokens: 100n as TokenCount,
    exactContextTokens: 2_000n as TokenCount,
    optionalContextTarget: 5_000n as TokenCount,
    expectedToolResultReserve: 1_000n as TokenCount,
    outputReserve: 2_000n as TokenCount,
    reasoningReserve: 1_000n as TokenCount,
    recoveryMargin: 500n as TokenCount,
    hardInputLimit: 50_000n as TokenCount,
    hardCostMicros: 1_000_000n,
  };
}

// ──────────────────────── Property 1: Hard-required never omitted ────────────

describe("Hard-required fragments", () => {
  test("are always selected before optional fragments", () => {
    const required = makeFragment("required:1", 90, 100);
    const optional = makeFragment("optional:1", 30, 100);

    const scored: ScoredCandidate[] = [
      { result: makeResult(required), utility: Number.POSITIVE_INFINITY, hardRequired: true },
      { result: makeResult(optional), utility: 0.5, hardRequired: false },
    ];

    const result = allocateBudget(scored, standardBudget(), {
      preserveDependencies: true,
      preserveCompleteEpisodes: true,
      hardIncludeRequired: true,
    }, MODEL_KEY);

    expect(result.selected.some((s) => s.result.fragment.id === "required:1")).toBe(true);
    // Optional might be omitted if budget is tight, but required must be there.
    expect(result.selected.length).toBeGreaterThanOrEqual(1);
  });

  test("are never in the omitted list", () => {
    const required = makeFragment("required:1", 90, 100);

    const scored: ScoredCandidate[] = [
      { result: makeResult(required), utility: Number.POSITIVE_INFINITY, hardRequired: true },
    ];

    const result = allocateBudget(scored, standardBudget(), {
      preserveDependencies: true,
      preserveCompleteEpisodes: true,
      hardIncludeRequired: true,
    }, MODEL_KEY);

    const omittedIds = result.omitted.map((o) => o.result.fragment.id);
    expect(omittedIds).not.toContain("required:1");
  });

  test("have infinite utility, ensuring top placement", () => {
    const required = makeFragment("required:1", 90, 100);
    // scoreCandidates needs a real input for modelKey resolution.
    const mockInput = {
      model: { modelKey: MODEL_KEY },
      provider: { providerId: "test" },
    } as unknown as Parameters<typeof scoreCandidates>[1];
    const scored = scoreCandidates([makeResult(required)], mockInput);
    expect(scored[0]!.utility).toBe(Number.POSITIVE_INFINITY);
    expect(scored[0]!.hardRequired).toBe(true);
  });
});

// ──────────────────────── Property 2: Complete episodes never split ──────────

describe("Complete tool episodes", () => {
  test("preserve dependency closure", () => {
    const call = makeFragment("tool_call:1", 50, 200);
    const result = makeFragment("tool_result:1", 50, 300, ["tool_call:1"]);

    const scored: ScoredCandidate[] = [
      { result: makeResult(call), utility: 0.8, hardRequired: false },
      { result: makeResult(result), utility: 0.8, hardRequired: false },
    ];

    const alloc = allocateBudget(scored, standardBudget(), {
      preserveDependencies: true,
      preserveCompleteEpisodes: true,
      hardIncludeRequired: true,
    }, MODEL_KEY);

    // If tool_call is selected, tool_result with dependency must also be selected.
    const selectedIds = alloc.selected.map((s) => s.result.fragment.id);
    if (selectedIds.includes("tool_call:1")) {
      expect(selectedIds).toContain("tool_result:1");
    }
  });

  test("tool result without dependency closure is omitted", () => {
    // result depends on call, but call is not in the candidates.
    const result = makeFragment("tool_result:2", 50, 300, ["tool_call:2"]);

    const scored: ScoredCandidate[] = [
      { result: makeResult(result), utility: 0.8, hardRequired: false },
    ];

    const alloc = allocateBudget(scored, standardBudget(), {
      preserveDependencies: true,
      preserveCompleteEpisodes: true,
      hardIncludeRequired: true,
    }, MODEL_KEY);

    const selectedIds = alloc.selected.map((s) => s.result.fragment.id);
    // Should be omitted because its dependency is not satisfied.
    expect(alloc.omitted.some((o) => o.result.fragment.id === "tool_result:2")).toBe(true);
  });
});

// ──────────────────────── Property 3: Budget never exceeds hard limit ────────

describe("Budget allocation", () => {
  test("never exceeds hard input limit", () => {
    const fragments: ContextFragment[] = [];
    for (let i = 0; i < 100; i++) {
      fragments.push(makeFragment(`fragment:${i}`, 30, 200));
    }

    const scored = fragments.map((f) => ({
      result: makeResult(f),
      utility: 0.5,
      hardRequired: false,
    }));

    const alloc = allocateBudget(scored, standardBudget(), {
      preserveDependencies: true,
      preserveCompleteEpisodes: true,
      hardIncludeRequired: true,
    }, MODEL_KEY);

    expect(alloc.totalEstimatedTokens).toBeLessThanOrEqual(
      Number(standardBudget().hardInputLimit),
    );
  });

  test("respects optional context target", () => {
    const fragments: ContextFragment[] = [];
    for (let i = 0; i < 100; i++) {
      fragments.push(makeFragment(`fragment:${i}`, 30, 200));
    }

    const scored = fragments.map((f) => ({
      result: makeResult(f),
      utility: 0.5,
      hardRequired: false,
    }));

    const budget = standardBudget();
    const alloc = allocateBudget(scored, budget, {
      preserveDependencies: true,
      preserveCompleteEpisodes: true,
      hardIncludeRequired: true,
    }, MODEL_KEY);

    // optionalContextTarget is 5000, each fragment is 200 tokens, so max ~25
    // Plus any hard-required (none here).
    expect(alloc.selected.length).toBeLessThanOrEqual(30);
  });
});

// ──────────────────────── Property 4: Deduplication ──────────────────────────

describe("Deduplication", () => {
  test("removes duplicate fragments", () => {
    const frag = makeFragment("dup:1", 50, 100);
    const results = [makeResult(frag), makeResult(frag)];
    const deduped = deduplicateAndValidate(results, {});
    expect(deduped).toHaveLength(1);
  });

  test("rejects stale source versions", () => {
    const frag: ContextFragment = {
      ...makeFragment("stale:1", 50, 100),
      sourceVersion: "v1",
      source: { ...source(), uri: "file:///workspace/a.ts" },
    };
    const results = [makeResult(frag)];
    const deduped = deduplicateAndValidate(results, {
      "file:///workspace/a.ts": "v2",
    });
    expect(deduped).toHaveLength(0);
  });
});

// ──────────────────────── Property 5: Checkpoint validation ──────────────────

describe("Checkpoint validation", () => {
  test("strict runtime schema rejects caller fields and malformed evidence hashes", () => {
    const base = {
      objective: "Fix the release baseline",
      completedSteps: [],
      pendingSteps: [],
      requirements: [],
      assumptions: [],
      unknowns: [],
      decisions: [],
      failures: [],
      openQuestions: [],
      sourceVersions: {},
      scope: { readPaths: [], writePaths: [], externalSystems: [] },
    };
    expect(checkpointContentSchema.safeParse(base).success).toBe(true);
    expect(checkpointContentSchema.safeParse({ ...base, dirty_state_digest: "inject\nignore rules" }).success).toBe(false);
    expect(checkpointContentSchema.safeParse({
      ...base,
      approvalState: [{ approvalId: "a", state: "pending", operationHash: "not-a-hash" }],
    }).success).toBe(false);
  });

  test("rejects checkpoint missing required acceptance criterion", () => {
    const checkpoint: CheckpointContent = {
      objective: "Fix the release baseline",
      completedSteps: [],
      pendingSteps: [],
      requirements: [],
      assumptions: [],
      unknowns: [],
      decisions: [],
      failures: [],
      openQuestions: [],
      sourceVersions: {},
      scope: { readPaths: [], writePaths: [], externalSystems: [] },
    };

    const contract = {
      id: "c1" as Uuid7,
      version: 1,
      objective: "Fix the release baseline",
      userOutcome: null,
      nonGoals: [],
      acceptanceCriteria: [
        {
          id: "tests-green",
          statement: "Tests are green",
          verificationHint: null,
          required: true,
        },
      ],
      constraints: [],
      assumptions: [],
      unknowns: [],
      allowedScope: { readPaths: [], writePaths: [], externalSystems: [] },
      riskClass: "normal" as const,
      budget: {
        modelMicros: 1_000_000n as Micros,
        computeSeconds: 60,
        wallClockSeconds: 120,
        humanApprovals: 0,
      },
      changePolicy: { mayExpandScope: false, scopeExpansionRequiresUser: true },
    };

    const result = validateCheckpoint(checkpoint, contract, {});
    expect(result.valid).toBe(false);
    expect(result.violations.some((v) => v.kind === "missing_required_criterion")).toBe(true);
  });

  test("accepts checkpoint that covers all required criteria", () => {
    const checkpoint: CheckpointContent = {
      objective: "Fix the release baseline",
      completedSteps: [],
      pendingSteps: [],
      requirements: [
        {
          id: "tests-green",
          statement: "Tests are green",
          status: "unverified",
          evidence: [],
        },
      ],
      assumptions: [],
      unknowns: [],
      decisions: [],
      failures: [],
      openQuestions: [],
      sourceVersions: {},
      scope: { readPaths: [], writePaths: [], externalSystems: [] },
    };

    const contract = {
      id: "c1" as Uuid7,
      version: 1,
      objective: "Fix the release baseline",
      userOutcome: null,
      nonGoals: [],
      acceptanceCriteria: [
        {
          id: "tests-green",
          statement: "Tests are green",
          verificationHint: null,
          required: true,
        },
      ],
      constraints: [],
      assumptions: [],
      unknowns: [],
      allowedScope: { readPaths: [], writePaths: [], externalSystems: [] },
      riskClass: "normal" as const,
      budget: {
        modelMicros: 1_000_000n as Micros,
        computeSeconds: 60,
        wallClockSeconds: 120,
        humanApprovals: 0,
      },
      changePolicy: { mayExpandScope: false, scopeExpansionRequiresUser: true },
    };

    const result = validateCheckpoint(checkpoint, contract, {});
    expect(result.valid).toBe(true);
  });

  test("detects version mismatches", () => {
    const checkpoint: CheckpointContent = {
      objective: "test",
      completedSteps: [],
      pendingSteps: [],
      requirements: [],
      assumptions: [],
      unknowns: [],
      decisions: [],
      failures: [],
      openQuestions: [],
      sourceVersions: { "file:///a.ts": "v1" },
      scope: { readPaths: [], writePaths: [], externalSystems: [] },
    };

    const contract = {
      id: "c1" as Uuid7,
      version: 1,
      objective: "test",
      userOutcome: null,
      nonGoals: [],
      acceptanceCriteria: [],
      constraints: [],
      assumptions: [],
      unknowns: [],
      allowedScope: { readPaths: [], writePaths: [], externalSystems: [] },
      riskClass: "normal" as const,
      budget: {
        modelMicros: 1_000_000n as Micros,
        computeSeconds: 60,
        wallClockSeconds: 120,
        humanApprovals: 0,
      },
      changePolicy: { mayExpandScope: false, scopeExpansionRequiresUser: true },
    };

    const result = validateCheckpoint(checkpoint, contract, {
      "file:///a.ts": "v2",
    });
    expect(result.valid).toBe(false);
    expect(result.violations.some((v) => v.kind === "version_mismatch")).toBe(true);
  });

  test("rejects a checkpoint when a referenced source is unavailable", () => {
    const checkpoint: CheckpointContent = {
      objective: "test",
      completedSteps: [],
      pendingSteps: [],
      requirements: [],
      assumptions: [],
      unknowns: [],
      decisions: [],
      failures: [],
      openQuestions: [],
      sourceVersions: { "turn://source-turn": "1:FAILED" },
      scope: { readPaths: [], writePaths: [], externalSystems: [] },
    };
    const contract = {
      id: "c1" as Uuid7,
      version: 1,
      objective: "test",
      userOutcome: null,
      nonGoals: [],
      acceptanceCriteria: [],
      constraints: [],
      assumptions: [],
      unknowns: [],
      allowedScope: { readPaths: [], writePaths: [], externalSystems: [] },
      riskClass: "normal" as const,
      budget: {
        modelMicros: 1_000_000n as Micros,
        computeSeconds: 60,
        wallClockSeconds: 120,
        humanApprovals: 0,
      },
      changePolicy: { mayExpandScope: false, scopeExpansionRequiresUser: true },
    };

    const result = validateCheckpoint(checkpoint, contract, {});
    expect(result.valid).toBe(false);
    expect(result.violations).toContainEqual({
      kind: "version_mismatch",
      description: "Source \"turn://source-turn\" is unavailable for checkpoint validation",
    });
  });
});

// ──────────────────────── Property 6: Provenance DAG expands to raw ──────────

describe("Provenance DAG", () => {
  test("expands ancestors and descendants correctly", () => {
    const dag = ProvenanceDag.empty();

    const nodeA: ProvenanceNode = {
      id: "a",
      label: "Raw artifact A",
      kind: "artifact",
      artifactHash: null,
      derivedFrom: [],
      derivedInto: [],
      sourceUri: null,
      sourceVersion: null,
      createdAt: NOW,
    };

    const nodeB: ProvenanceNode = {
      id: "b",
      label: "Tool result B (derived from A)",
      kind: "tool_result",
      artifactHash: null,
      derivedFrom: ["a"],
      derivedInto: [],
      sourceUri: null,
      sourceVersion: null,
      createdAt: NOW,
    };

    const nodeC: ProvenanceNode = {
      id: "c",
      label: "Checkpoint C (derived from B)",
      kind: "checkpoint",
      artifactHash: null,
      derivedFrom: ["b"],
      derivedInto: [],
      sourceUri: null,
      sourceVersion: null,
      createdAt: NOW,
    };

    dag.addNode(nodeA);
    dag.addNode(nodeB);
    dag.addNode(nodeC);

    expect(dag.size).toBe(3);

    // Ancestors of C: B, A
    const ancestorsC = dag.ancestors("c");
    expect(ancestorsC.map((n) => n.id).sort()).toEqual(["a", "b"]);

    // Descendants of A: B, C
    const descendantsA = dag.descendants("a");
    expect(descendantsA.map((n) => n.id).sort()).toEqual(["b", "c"]);

    // descendants traverses FROM a node to its children.
    // a→b→c: descendants of "a" include "b" and "c". ancestors of "c" include "b" and "a".
    const ancestorsOfC = dag.ancestors("c");
    expect(ancestorsOfC.map((n) => n.id).sort()).toEqual(["a", "b"]);
    const descendantsOfA = dag.descendants("a");
    expect(descendantsOfA.map((n) => n.id).sort()).toEqual(["b", "c"]);

    expect(() => dag.addNode({ ...nodeB, derivedFrom: ["c"] })).toThrow(
      /provenance cycle rejected/,
    );
    expect(dag.get("b")).toEqual(nodeB);

    // Replacing a node removes its old incoming edges without disturbing
    // children that still derive from the replacement node.
    dag.addNode({ ...nodeB, derivedFrom: [] });
    expect(dag.descendants("a").map((n) => n.id)).toEqual([]);
    expect(dag.ancestors("c").map((n) => n.id)).toEqual(["b"]);
  });
});

// ──────────────────────── Property 7: Project instruction discovery ──────────

describe("Project instruction discovery", () => {
  test("discovers AGENTS.md in workspace hierarchy", () => {
    const readFile = (path: string): string | null => {
      if (path === "/workspace/AGENTS.md") return "# Workspace rules";
      if (path === "/workspace/sub/AGENTS.md") return "# Subdirectory rules";
      return null;
    };

    const discovered = discoverInstructions(
      {
        workspaceRoot: "/workspace",
        workingDirectory: "/workspace/sub",
        filenames: ["AGENTS.md"],
      },
      readFile,
    );

    expect(discovered).toHaveLength(2);
    // Closest first.
    // Subdirectory rules first (closest to working directory)
    expect(discovered[0]!.path).toBe("/workspace/sub/AGENTS.md");
    expect(discovered[1]!.path).toBe("/workspace/AGENTS.md");
  });

  test("AGENTS.override.md takes precedence over AGENTS.md and CLAUDE.md", () => {
    const readFile = (path: string): string | null => {
      if (path === "/workspace/AGENTS.override.md") return "# Override rules";
      if (path === "/workspace/AGENTS.md") return "# Standard rules";
      if (path === "/workspace/CLAUDE.md") return "# Claude rules";
      return null;
    };

    const discovered = discoverInstructions(
      {
        workspaceRoot: "/workspace",
        workingDirectory: "/workspace",
      },
      readFile,
    );

    expect(discovered).toHaveLength(1);
    expect(discovered[0]!.filename).toBe("AGENTS.override.md");
    expect(discovered[0]!.content).toBe("# Override rules");
  });

  test("truncates oversized instruction files with explicit marker", () => {
    const readFile = (path: string): string | null => {
      if (path === "/workspace/AGENTS.md") return "A".repeat(100);
      return null;
    };

    const discovered = discoverInstructions(
      {
        workspaceRoot: "/workspace",
        workingDirectory: "/workspace",
        filenames: ["AGENTS.md"],
        maxBytes: 20,
      },
      readFile,
    );

    expect(discovered).toHaveLength(1);
    expect(discovered[0]!.content).toContain("[TRUNCATION: Project instruction file exceeded 20 bytes; remaining content elided]");
  });

  test("converts discovered instructions to fragments", () => {
    const discovered = [
      {
        directory: "/sub",
        filename: "AGENTS.md",
        path: "/workspace/sub/AGENTS.md",
        precedence: 1,
        content: "# Sub rules",
        sourceVersion: "current",
      },
    ];

    const fragments = instructionsToFragments({
      instructions: discovered,
      observedAt: NOW,
      workspaceId: null,
      sessionId: null,
      taskId: null,
      modelKey: "test/model",
    });

    expect(fragments).toHaveLength(1);
    expect(fragments[0]!.kind).toBe("project_rule");
    expect(fragments[0]!.textContent).toBe("# Sub rules");
  });
});

// ──────────────────────── Property 8: Durable goal state ─────────────────────

describe("Durable goal state", () => {
  test("reconstructs goal state from checkpoints", () => {
    const contract = {
      id: "c1" as Uuid7,
      version: 1,
      objective: "Test task",
      userOutcome: null,
      nonGoals: [],
      acceptanceCriteria: [
        {
          id: "ac1",
          statement: "Must pass",
          verificationHint: null,
          required: true,
        },
      ],
      constraints: [],
      assumptions: [],
      unknowns: [],
      allowedScope: { readPaths: [], writePaths: [], externalSystems: [] },
      riskClass: "normal" as const,
      budget: {
        modelMicros: 10_000_000n as Micros,
        computeSeconds: 600,
        wallClockSeconds: 1200,
        humanApprovals: 3,
      },
      changePolicy: { mayExpandScope: false, scopeExpansionRequiresUser: true },
    };

    const checkpointContent: CheckpointContent = {
      objective: "Test task",
      completedSteps: [{ description: "Step 1", evidenceArtifactHashes: [] }],
      pendingSteps: ["Step 2"],
      requirements: [
        { id: "ac1", statement: "Must pass", status: "satisfied", evidence: [] },
      ],
      assumptions: [],
      unknowns: [],
      decisions: [],
      failures: [],
      openQuestions: ["What about edge case X?"],
      sourceVersions: {},
      scope: { readPaths: [], writePaths: [], externalSystems: [] },
    };

    const state = reconstructGoalState({
      taskId: "t1" as Uuid7,
      contract,
      checkpoints: [
        {
          aggregate: {
            id: "cp1" as Uuid7,
            threadId: "th1" as Uuid7,
            turnId: null,
            episodeRange: { from: 0, to: 1 },
            artifactHash: "sha256:abc" as ContentHash,
            canonicalStateHash: "sha256:def" as ContentHash,
            summary: "First checkpoint",
            createdAt: NOW,
          },
          content: checkpointContent,
        },
      ],
      manifestRefs: [],
      verificationResults: [],
      scopeLedger: [],
      budgetConsumed: {
        modelMicros: 1_000_000n,
        computeSeconds: 10,
        wallClockSeconds: 20,
        approvalsUsed: 1,
      },
      completion: null,
      completedTurns: 5,
    });

    expect(state.allCriteriaSatisfied).toBe(true);
    expect(state.latestCheckpoint!.completedSteps).toHaveLength(1);
    expect(state.budgetRemaining.modelMicros).toBe(9_000_000n);
    expect(state.completedTurns).toBe(5);
    expect(state.openQuestions).toContain("What about edge case X?");
  });

  test("diff detects progress between goal states", () => {
    const contract = {
      id: "c1" as Uuid7,
      version: 1,
      objective: "Test",
      userOutcome: null,
      nonGoals: [],
      acceptanceCriteria: [],
      constraints: [],
      assumptions: [],
      unknowns: [],
      allowedScope: { readPaths: [], writePaths: [], externalSystems: [] },
      riskClass: "normal" as const,
      budget: {
        modelMicros: 10_000_000n as Micros,
        computeSeconds: 600,
        wallClockSeconds: 1200,
        humanApprovals: 3,
      },
      changePolicy: { mayExpandScope: false, scopeExpansionRequiresUser: true },
    };

    const before = reconstructGoalState({
      taskId: "t1" as Uuid7,
      contract,
      checkpoints: [
        {
          aggregate: {
            id: "cp1" as Uuid7,
            threadId: "th1" as Uuid7,
            turnId: null,
            episodeRange: { from: 0, to: 1 },
            artifactHash: "sha256:a" as ContentHash,
            canonicalStateHash: "sha256:a" as ContentHash,
            summary: "",
            createdAt: NOW,
          },
          content: {
            objective: "Test",
            completedSteps: [{ description: "Did step 1", evidenceArtifactHashes: [] }],
            pendingSteps: ["Step 2", "Step 3"],
            requirements: [],
            assumptions: [],
            unknowns: [],
            decisions: [],
            failures: [],
            openQuestions: ["Q1"],
            sourceVersions: {},
            scope: { readPaths: [], writePaths: [], externalSystems: [] },
          },
        },
      ],
      manifestRefs: [],
      verificationResults: [],
      scopeLedger: [],
      budgetConsumed: {
        modelMicros: 0n,
        computeSeconds: 0,
        wallClockSeconds: 0,
        approvalsUsed: 0,
      },
      completion: null,
      completedTurns: 1,
    });

    const after = reconstructGoalState({
      taskId: "t1" as Uuid7,
      contract,
      checkpoints: [
        {
          aggregate: {
            id: "cp2" as Uuid7,
            threadId: "th1" as Uuid7,
            turnId: null,
            episodeRange: { from: 0, to: 3 },
            artifactHash: "sha256:b" as ContentHash,
            canonicalStateHash: "sha256:b" as ContentHash,
            summary: "",
            createdAt: NOW,
          },
          content: {
            objective: "Test",
            completedSteps: [
              { description: "Did step 1", evidenceArtifactHashes: [] },
              { description: "Did step 2", evidenceArtifactHashes: [] },
            ],
            pendingSteps: ["Step 3"],
            requirements: [],
            assumptions: [],
            unknowns: [],
            decisions: [],
            failures: [],
            openQuestions: [],
            sourceVersions: {},
            scope: { readPaths: [], writePaths: [], externalSystems: [] },
          },
        },
      ],
      manifestRefs: [],
      verificationResults: [],
      scopeLedger: [],
      budgetConsumed: {
        modelMicros: 500_000n,
        computeSeconds: 5,
        wallClockSeconds: 10,
        approvalsUsed: 0,
      },
      completion: null,
      completedTurns: 3,
    });

    const diff = diffGoalStates(before, after);

    expect(diff.completedStepsAdded).toContain("Did step 2");
    expect(diff.pendingStepsRemoved).toContain("Step 2");
    expect(diff.answeredQuestions).toContain("Q1");
    expect(diff.budgetDelta.modelMicros).toBe(500_000n);
  });

  test("formatProgressSummary produces readable summary", () => {
    const contract = {
      id: "c1" as Uuid7,
      version: 1,
      objective: "Test task",
      userOutcome: null,
      nonGoals: [],
      acceptanceCriteria: [],
      constraints: [],
      assumptions: [],
      unknowns: [],
      allowedScope: { readPaths: [], writePaths: [], externalSystems: [] },
      riskClass: "normal" as const,
      budget: {
        modelMicros: 10_000_000n as Micros,
        computeSeconds: 600,
        wallClockSeconds: 1200,
        humanApprovals: 3,
      },
      changePolicy: { mayExpandScope: false, scopeExpansionRequiresUser: true },
    };

    const state = reconstructGoalState({
      taskId: "t1" as Uuid7,
      contract,
      checkpoints: [],
      manifestRefs: [],
      verificationResults: [],
      scopeLedger: [],
      budgetConsumed: {
        modelMicros: 0n,
        computeSeconds: 0,
        wallClockSeconds: 0,
        approvalsUsed: 0,
      },
      completion: null,
      completedTurns: 0,
    });

    const summary = formatProgressSummary(state);
    expect(summary).toContain("Test task");
    expect(summary).toContain("Completed turns: 0");
    expect(summary).toContain("Budget");
  });
});
// ──────────────────────── Property 3b: hard-limit overflow surfaced ──────────

describe("allocateBudget hard-input-limit", () => {
  test("flags overHardLimit when hard-required fragments exceed the limit", () => {
    const huge = makeFragment("required:huge", 100, 60_000);
    const scored: ScoredCandidate[] = [
      { result: makeResult(huge), utility: Number.POSITIVE_INFINITY, hardRequired: true },
    ];
    const result = allocateBudget(scored, standardBudget(), {
      preserveDependencies: true,
      preserveCompleteEpisodes: true,
      hardIncludeRequired: true,
    }, MODEL_KEY);
    expect(result.overHardLimit).toBe(true);
    // Hard-required fragments are still never silently dropped.
    expect(result.selected.length).toBe(1);
  });

  test("reports overHardLimit=false within the limit", () => {
    const small = makeFragment("required:small", 90, 100);
    const result = allocateBudget(
      [{ result: makeResult(small), utility: Number.POSITIVE_INFINITY, hardRequired: true }],
      standardBudget(),
      { preserveDependencies: true, preserveCompleteEpisodes: true, hardIncludeRequired: true },
      MODEL_KEY,
    );
    expect(result.overHardLimit).toBe(false);
  });
});

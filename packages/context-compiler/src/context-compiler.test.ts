import { describe, expect, test } from "bun:test";
import type {
  ContentHash,
  Micros,
  ModelKey,
  Rfc3339Timestamp,
  TokenCount,
  Uuid7,
} from "@terminus/domain";
import type { ContextBudget, ContextFragment, ContextManifest } from "@terminus/context-ir";
import type {
  CanonicalRenderInput,
  CompatibilityResult,
  ConfidentialityPolicy,
  ContinuationDecision,
  ContinuationInput,
  ModelCapabilitySnapshot,
  ProviderCapabilitySnapshot,
  ProviderRenderer,
  ProviderResponse,
  ProjectedResponse,
  RenderCompatibilityInput,
  RenderedProviderRequest,
  UsageRecord,
} from "@terminus/provider-core";
import {
  compileContext,
  deduplicateAndValidate,
  deriveRetrievalQueries,
  instructionsToFragments,
  replayContext,
  replayWithAblation,
  RETRIEVAL_METRICS_VERSION,
  type CompileInput,
  type ContextStore,
  type RetrievalResult,
} from "./index.js";

const TASK_ID = "00000000-0000-7000-8000-000000000001" as Uuid7;
const CONTRACT_ID = "00000000-0000-7000-8000-000000000002" as Uuid7;
const THREAD_ID = "00000000-0000-7000-8000-000000000003" as Uuid7;
const SESSION_ID = "00000000-0000-7000-8000-000000000004" as Uuid7;
const MANIFEST_ID = "00000000-0000-7000-8000-000000000005" as Uuid7;
const NOW = "2026-07-22T00:00:00Z" as Rfc3339Timestamp;
const MODEL_KEY = "openai/test-model" as ModelKey;

function providerSnapshot(): ProviderCapabilitySnapshot {
  return {
    providerId: "openai",
    observedAt: NOW,
    source: "test",
    context: {
      advertisedTokens: 128_000,
      testedSafeTokens: 64_000,
      roleSupport: ["system", "user", "assistant", "tool"],
      imageInput: false,
      toolCalling: true,
      parallelToolCalls: true,
      structuredOutput: true,
    },
    continuation: {
      nativeId: true,
      crossRequest: true,
      compaction: true,
      compatibilityKey: "openai-test-v1",
    },
    caching: {
      mode: "automatic_prefix",
      exactPrefixRequired: true,
      minimumTokens: 0,
      ttlOptions: [],
      toolOrderSensitive: false,
      usageReporting: true,
    },
    reasoning: { supported: true, budgetControl: true, summaryAvailable: true },
    economics: {
      inputMicrosPerMillion: 1_000_000n as Micros,
      cachedInputMicrosPerMillion: 500_000n as Micros,
      outputMicrosPerMillion: 2_000_000n as Micros,
      reasoningAccounting: true,
    },
    reliability: {
      toolCallSuccess: 1,
      structuredOutputSuccess: 1,
      editCohortSuccess: 1,
      latencyPercentiles: { p50: 1, p99: 2 },
    },
    policy: {
      allowedConfidentiality: ["public", "workspace"],
      retentionMode: "none",
      region: null,
    },
  };
}

function budget(): ContextBudget {
  return {
    modelAdvertisedTokens: 128_000n as TokenCount,
    testedSafeTokens: 64_000n as TokenCount,
    protocolOverheadTokens: 100n as TokenCount,
    exactContextTokens: 2_000n as TokenCount,
    optionalContextTarget: 8_000n as TokenCount,
    expectedToolResultReserve: 1_000n as TokenCount,
    outputReserve: 2_000n as TokenCount,
    reasoningReserve: 1_000n as TokenCount,
    recoveryMargin: 500n as TokenCount,
    hardInputLimit: 60_000n as TokenCount,
    hardCostMicros: 1_000_000n,
  };
}

class FakeRenderer implements ProviderRenderer {
  readonly providerId = "openai";
  readonly version = "test";

  compatibility(_input: RenderCompatibilityInput): CompatibilityResult {
    return { compatible: true, incompatibilities: [], downgradesRequired: [] };
  }

  async render(input: CanonicalRenderInput): Promise<RenderedProviderRequest> {
    return {
      providerId: this.providerId,
      model: input.model.modelKey,
      request: {
        providerId: this.providerId,
        model: input.model.modelKey,
        blocks: input.fragments.map((fragment) => ({
          role: "system" as const,
          content: fragment.textContent ?? fragment.contentRef.uri,
          artifactHash: fragment.contentRef.hash,
          cacheBreakpoint: false,
          confidentiality: fragment.confidentiality,
        })),
        toolSchemas: input.toolSchemas,
        continuationId: input.continuationId,
        cachePlan: input.cachePlan,
        outputProfile: input.outputProfile,
        reasoningReserveTokens: input.reasoningReserveTokens,
        outputReserveTokens: input.outputReserveTokens,
        hardInputLimit: input.hardInputLimit,
        signal: input.signal,
      },
      predictedCachedTokens: 0n as TokenCount,
      body: { manifestId: input.manifestId },
    };
  }

  async projectResponse(_response: ProviderResponse): Promise<ProjectedResponse> {
    return { text: "", toolCalls: [], reasoning: null, continuationId: null, finishReason: "stop" };
  }

  extractUsage(_response: ProviderResponse): UsageRecord {
    return {
      inputTokens: 0n as TokenCount,
      cachedInputTokens: 0n as TokenCount,
      cacheWriteTokens: 0n as TokenCount,
      outputTokens: 0n as TokenCount,
      reasoningTokens: 0n as TokenCount,
      toolSchemaTokens: 0n as TokenCount,
      latencyMs: 0,
      timeToFirstTokenMs: null,
    };
  }

  continuationPolicy(_input: ContinuationInput): ContinuationDecision {
    return {
      canContinue: false,
      reason: "test renderer",
      requiresRerender: false,
      requiresUserConsent: false,
      newContinuationId: null,
    };
  }
}

function compileInput(
  store: ContextStore,
  renderer: ProviderRenderer = new FakeRenderer(),
  projectInstructionFragments: readonly ContextFragment[] = [],
): CompileInput {
  const provider = providerSnapshot();
  const model: ModelCapabilitySnapshot = {
    modelKey: MODEL_KEY,
    providerId: provider.providerId,
    snapshot: provider,
    observedAt: NOW,
  };
  const confidentialityPolicy: ConfidentialityPolicy = {
    allowedProviders: {
      public: ["openai"],
      workspace: ["openai"],
      secret_adjacent: [],
      secret: [],
    },
  };
  return {
    task: {
      taskId: TASK_ID,
      contract: {
        id: CONTRACT_ID,
        version: 1,
        objective: "Fix the release baseline",
        userOutcome: "All local checks pass",
        nonGoals: [],
        acceptanceCriteria: [{
          id: "tests-green",
          statement: "The test baseline is green",
          verificationHint: "run just check-all",
          required: true,
        }],
        constraints: ["preserve existing behavior"],
        assumptions: [],
        unknowns: ["whether the runner permits sockets"],
        allowedScope: { readPaths: ["**"], writePaths: ["packages/**"], externalSystems: [] },
        riskClass: "normal",
        budget: {
          modelMicros: 1_000_000n as Micros,
          computeSeconds: 60,
          wallClockSeconds: 120,
          humanApprovals: 0,
        },
        changePolicy: { mayExpandScope: false, scopeExpansionRequiresUser: true },
      },
      phase: "verification",
      changedFiles: ["package.json"],
      failingTests: ["test:integration"],
      diagnostics: [{ path: "package.json", message: "test file missing" }],
      unknowns: [],
    },
    thread: { threadId: THREAD_ID, sessionId: SESSION_ID, activeContextEpochId: null },
    provider,
    model,
    epoch: null,
    worldState: { sections: {}, observedAt: NOW, sourceVersions: {} },
    recentEpisodes: [],
    episodeContent: new Map(),
    checkpoint: null,
    userDirectives: [],
    projectInstructionFragments,
    activeCapabilities: [],
    budget: budget(),
    experimentAssignments: [],
    renderer,
    confidentialityPolicy,
    store,
    signal: null,
  };
}

describe("Context Compiler", () => {
  test("derives traceable queries for task evidence", () => {
    const store = null as unknown as ContextStore;
    const queries = deriveRetrievalQueries(compileInput(store));
    expect(queries.map((query) => query.reason)).toContain("task objective");
    expect(queries.map((query) => query.reason)).toContain("acceptance criterion tests-green");
    expect(queries.map((query) => query.reason)).toContain("changed file");
    expect(queries.map((query) => query.reason)).toContain("failing test");
    expect(queries.map((query) => query.reason)).toContain("diagnostic");
    expect(queries.map((query) => query.reason)).toContain("unknown");
  });

  test("deduplicates fragments and rejects stale source versions", () => {
    const sourceVersion = "v1";
    const fragment = {
      id: "fragment:one",
      sourceVersion,
      source: { uri: "file:///workspace/a.ts" },
    };
    const result = { fragment } as unknown as RetrievalResult;
    expect(deduplicateAndValidate([result, result], { "file:///workspace/a.ts": sourceVersion })).toHaveLength(1);
    expect(deduplicateAndValidate([result], { "file:///workspace/a.ts": "v2" })).toHaveLength(0);
  });

  test("persists the manifest before rendering the provider request", async () => {
    let persisted = false;
    const manifests = new Map<Uuid7, ContextManifest>();
    const store: ContextStore = {
      async persistManifest(manifest) {
        persisted = true;
        const stored: ContextManifest = { id: MANIFEST_ID, ...manifest };
        manifests.set(MANIFEST_ID, stored);
        return stored;
      },
      async getManifest(id) {
        return manifests.get(id) ?? null;
      },
      async recordObservation() {},
    };
    class OrderCheckingRenderer extends FakeRenderer {
      override async render(input: CanonicalRenderInput): Promise<RenderedProviderRequest> {
        expect(persisted).toBe(true);
        expect(input.manifestId).toBe(MANIFEST_ID);
        return super.render(input);
      }
    }

    const compiled = await compileContext(compileInput(store, new OrderCheckingRenderer()));
    expect(compiled.manifest.id).toBe(MANIFEST_ID);
    expect(compiled.manifest.fragments.some((fragment) => fragment.required)).toBe(true);
    expect(compiled.rendered.request.blocks.length).toBeGreaterThan(0);
    expect(compiled.rendered.request.cachePlan.stablePrefixHash).toMatch(/^sha256:/);
    expect(compiled.manifest.compilerVersion).toContain("token-estimator=terminus.token-estimator.v1");
    expect(compiled.manifest.decisionRecord?.tokenEstimator).toMatchObject({
      status: "degraded",
      source: "explicit_fallback",
    });
    expect(compiled.manifest.decisionRecord?.cacheEpochDebug).toMatchObject({
      current: { stablePrefix: { hash: compiled.manifest.cachePlan.stablePrefixHash } },
    });
    expect(compiled.manifest.decisionRecord?.retrievalMetrics).toMatchObject({
      version: RETRIEVAL_METRICS_VERSION,
      candidateCount: expect.any(Number),
      selectedCount: expect.any(Number),
    });
    expect(compiled.warnings.some((warning) => warning.startsWith("token calibration degraded:"))).toBe(true);
  });

  test("injects applicable repository instructions as required context", async () => {
    const instruction = instructionsToFragments({
      instructions: [{
        directory: "/",
        filename: "AGENTS.md",
        path: "/workspace/AGENTS.md",
        precedence: 100,
        content: "Never skip the repository verification command.",
        sourceVersion: "sha256:instruction-source",
      }],
      observedAt: NOW,
      workspaceId: null,
      sessionId: SESSION_ID,
      taskId: TASK_ID,
      modelKey: MODEL_KEY,
    });
    const store: ContextStore = {
      async persistManifest(manifest) {
        return { id: MANIFEST_ID, ...manifest };
      },
      async getManifest(id) {
        return id === MANIFEST_ID ? null : null;
      },
      async recordObservation() {},
    };
    const compiled = await compileContext(compileInput(store, new FakeRenderer(), instruction));
    const manifestFragment = compiled.manifest.fragments.find((fragment) => fragment.fragmentId === instruction[0]!.id);
    expect(manifestFragment?.required).toBe(true);
    expect(compiled.rendered.request.blocks.some((block) => block.content.includes("Never skip"))).toBe(true);
  });

  test("replays the exact selected manifest and records ablation drift", async () => {
    let storedManifest: ContextManifest | null = null;
    let storedCandidates: readonly ContextFragment[] = [];
    const store: ContextStore = {
      async persistManifest(manifest, fragments = []) {
        storedCandidates = fragments;
        storedManifest = { id: MANIFEST_ID, ...manifest };
        return storedManifest;
      },
      async getManifest(id) {
        return storedManifest?.id === id ? storedManifest : null;
      },
      async recordObservation() {},
    };
    const input = compileInput(store);
    const compiled = await compileContext(input);
    const selected = compiled.manifest.fragments.map((entry) => {
      const fragment = storedCandidates.find((candidate) => candidate.id === entry.fragmentId);
      if (fragment === undefined) throw new Error(`missing replay candidate ${entry.fragmentId}`);
      return fragment;
    });
    const replayed = await replayContext({
      manifest: compiled.manifest,
      selectedFragments: selected,
      renderer: new FakeRenderer(),
      provider: input.provider,
      model: input.model,
      epoch: null,
      signal: null,
    });
    expect(replayed.fragmentCount).toBe(compiled.manifest.fragments.length);
    expect(replayed.renderedRequestHash).toMatch(/^sha256:/);

    const ablated = await replayWithAblation(
      {
        manifest: compiled.manifest,
        selectedFragments: selected,
        renderer: new FakeRenderer(),
        provider: input.provider,
        model: input.model,
        epoch: null,
        signal: null,
      },
      { label: "remove-first", removeFragmentIds: [selected[0]!.id] },
    );
    expect(ablated.fragmentCount).toBe(replayed.fragmentCount - 1);
    expect(ablated.renderedRequestHash).not.toBe(replayed.renderedRequestHash);
    await expect(replayContext({
      manifest: compiled.manifest,
      selectedFragments: selected.slice(1),
      renderer: new FakeRenderer(),
      provider: input.provider,
      model: input.model,
      epoch: null,
      signal: null,
    })).rejects.toThrow("replay selection does not match");
  });
});

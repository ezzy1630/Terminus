/**
 * Harness regressions for the model-facing prompt (Phase 0, workstream B).
 *
 * Every test here corresponds to a defect measured on real compiled manifests
 * in `.terminus-dev/kernel-data/artifacts/` on 2026-08-29:
 *
 *  - the task contract was dropped from 55/55 manifests by a version-encoding
 *    mismatch between the world-state producer and the compiler;
 *  - tool results were emitted before the calls that produced them, and
 *    `user_message` episodes rendered with `role: "assistant"`;
 *  - eleven separate world-state messages reordered themselves per attempt;
 *  - the cache breakpoint index was expressed in a different index space than
 *    the one the Anthropic renderer reads.
 */
import { describe, expect, test } from "bun:test";
import type {
  ContentHash,
  Episode,
  Micros,
  ModelKey,
  Rfc3339Timestamp,
  TokenCount,
  Uuid7,
} from "@terminus/domain";
import type { ContextBudget, ContextManifest } from "@terminus/context-ir";
import { computeContentHash } from "@terminus/context-ir";
import type {
  ConfidentialityPolicy,
  ModelCapabilitySnapshot,
  ProviderCapabilitySnapshot,
  ProviderRenderer,
  ProviderToolSchema,
} from "@terminus/provider-core";
import { AnthropicRenderer } from "@terminus/provider-anthropic";
import type { AnthropicMessage, AnthropicSystemBlock } from "@terminus/provider-anthropic";
import { OpenAiRenderer, toResponsesInputItems } from "@terminus/provider-openai";
import type { OpenAiChatMessage } from "@terminus/provider-openai";
import {
  compileContext,
  SUPPRESSED_WORLD_STATE_SECTIONS,
  VOLATILE_WORLD_STATE_FRAGMENT_ID,
  WORLD_STATE_FRAGMENT_ID,
  type CompileInput,
  type ContextStore,
} from "./index.js";

const TASK_ID = "00000000-0000-7000-8000-000000000001" as Uuid7;
const CONTRACT_ID = "00000000-0000-7000-8000-000000000002" as Uuid7;
const THREAD_ID = "00000000-0000-7000-8000-000000000003" as Uuid7;
const SESSION_ID = "00000000-0000-7000-8000-000000000004" as Uuid7;
const MANIFEST_ID = "00000000-0000-7000-8000-000000000005" as Uuid7;
const TURN_ID = "00000000-0000-7000-8000-000000000006" as Uuid7;
const NOW = "2026-08-29T00:00:00Z" as Rfc3339Timestamp;

/** The control plane publishes the contract row's content hash, not `v1`. */
const CONTRACT_CONTENT_HASH = computeContentHash("contract-row-v1");

function providerSnapshot(providerId: string): ProviderCapabilitySnapshot {
  return {
    providerId,
    observedAt: NOW,
    source: "test",
    context: {
      advertisedTokens: 200_000,
      testedSafeTokens: 200_000,
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
      compatibilityKey: `${providerId}-test-v1`,
    },
    caching: {
      mode: providerId === "anthropic" ? "explicit_breakpoints" : "automatic_prefix",
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
    modelAdvertisedTokens: 200_000n as TokenCount,
    testedSafeTokens: 200_000n as TokenCount,
    protocolOverheadTokens: 100n as TokenCount,
    exactContextTokens: 4_000n as TokenCount,
    optionalContextTarget: 40_000n as TokenCount,
    expectedToolResultReserve: 2_000n as TokenCount,
    outputReserve: 8_000n as TokenCount,
    reasoningReserve: 0n as TokenCount,
    recoveryMargin: 500n as TokenCount,
    hardInputLimit: 150_000n as TokenCount,
    hardCostMicros: 1_000_000n,
  };
}

function memoryStore(): ContextStore {
  return {
    async persistManifest(manifest) {
      return { id: MANIFEST_ID, ...manifest } as ContextManifest;
    },
    async getManifest() {
      return null;
    },
    async recordObservation() {},
  };
}

function toolSchemas(): readonly ProviderToolSchema[] {
  return [{
    id: "read",
    version: "1",
    summary: "Read a file.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    resultSchema: { type: "object" },
    sideEffectClass: "read_local",
    requiredCapabilities: [],
    trustLevel: "builtin",
    maximumModelResultBytes: 32_768,
    maximumArtifactBytes: 1_048_576,
    defaultTimeoutMs: 30_000,
    policyTags: [],
  }];
}

interface EpisodeSpec {
  readonly sequence: number;
  readonly kind: Episode["kind"];
  readonly text: string;
  readonly toolCallId?: string;
}

function buildEpisodes(specs: readonly EpisodeSpec[]): {
  readonly episodes: readonly Episode[];
  readonly content: ReadonlyMap<ContentHash, string>;
} {
  const content = new Map<ContentHash, string>();
  const episodes = specs.map((spec) => {
    const hash = computeContentHash(spec.text);
    content.set(hash, spec.text);
    return {
      id: `00000000-0000-7000-8000-0000000001${String(spec.sequence).padStart(2, "0")}` as Uuid7,
      turnId: TURN_ID,
      sequence: spec.sequence,
      kind: spec.kind,
      contentRef: hash,
      providerAttemptId: null,
      toolCallId: (spec.toolCallId ?? null) as Uuid7 | null,
      occurredAt: NOW,
    } satisfies Episode;
  });
  return { episodes, content };
}

function toolCallText(callId: string, path: string): string {
  return JSON.stringify({
    protocol: "terminus.tool-call.v1",
    provider_call_id: callId,
    tool_name: "read",
    arguments: { path },
  });
}

function toolResultText(callId: string, summary: string): string {
  return JSON.stringify({
    protocol: "terminus.tool-result.v1",
    provider_call_id: callId,
    result: { status: "ok", summary },
  });
}

interface CompileOptions {
  readonly providerId?: string;
  readonly renderer?: ProviderRenderer;
  readonly episodes?: readonly EpisodeSpec[];
  readonly sections?: Readonly<Record<string, unknown>>;
  readonly publishContractVersion?: boolean;
}

function compileInput(options: CompileOptions = {}): CompileInput {
  const providerId = options.providerId ?? "openai";
  const provider = providerSnapshot(providerId);
  const model: ModelCapabilitySnapshot = {
    modelKey: `${providerId}/test-model` as ModelKey,
    providerId,
    snapshot: provider,
    observedAt: NOW,
  };
  const confidentialityPolicy: ConfidentialityPolicy = {
    allowedProviders: {
      public: [providerId],
      workspace: [providerId],
      secret_adjacent: [],
      secret: [],
    },
  };
  const { episodes, content } = buildEpisodes(options.episodes ?? []);
  return {
    task: {
      taskId: TASK_ID,
      contract: {
        id: CONTRACT_ID,
        version: 1,
        objective: "Make the failing integration test pass without widening scope",
        userOutcome: "The suite is green",
        nonGoals: ["Do not refactor the scheduler"],
        acceptanceCriteria: [{
          id: "tests-green",
          statement: "bun test passes in packages/context-compiler",
          verificationHint: "bun test",
          required: true,
        }],
        constraints: ["preserve existing behavior"],
        assumptions: [],
        unknowns: [],
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
      phase: "implementation",
      changedFiles: [],
      failingTests: [],
      diagnostics: [],
      unknowns: [],
    },
    thread: { threadId: THREAD_ID, sessionId: SESSION_ID, activeContextEpochId: null },
    provider,
    model,
    epoch: null,
    worldState: {
      sections: options.sections ?? {
        request_phase: { phase: "implementation" },
        workspace: { id: "ws-1", trust: "trusted" },
        environment: { sandbox_profile: "secure-local-default", backend: null },
      },
      observedAt: NOW,
      sourceVersions: (options.publishContractVersion ?? true)
        ? { [`task://${TASK_ID}`]: CONTRACT_CONTENT_HASH }
        : {},
    },
    recentEpisodes: episodes,
    episodeContent: content,
    checkpoint: null,
    userDirectives: [],
    activeCapabilities: [],
    budget: budget(),
    experimentAssignments: [],
    renderer: options.renderer ?? new OpenAiRenderer(),
    confidentialityPolicy,
    toolSchemas: toolSchemas(),
    store: memoryStore(),
    signal: null,
  };
}

const TRANSCRIPT: readonly EpisodeSpec[] = [
  { sequence: 1, kind: "user_message", text: "Fix the failing test in packages/context-compiler." },
  { sequence: 2, kind: "tool_call", text: toolCallText("call_a", "a.ts"), toolCallId: "call-a" },
  { sequence: 3, kind: "tool_result", text: toolResultText("call_a", "read a.ts"), toolCallId: "call-a" },
  { sequence: 4, kind: "tool_call", text: toolCallText("call_b", "b.ts"), toolCallId: "call-b" },
  { sequence: 5, kind: "tool_result", text: toolResultText("call_b", "read b.ts"), toolCallId: "call-b" },
];

describe("task contract reaches the model", () => {
  test("the contract survives dedupe when the world state publishes a content hash", async () => {
    const compiled = await compileContext(compileInput());
    const contract = compiled.manifest.fragments.find(
      (fragment) => fragment.fragmentId === `required:task_contract:${TASK_ID}`,
    );
    expect(contract).toBeDefined();
    expect(contract?.required).toBe(true);
    expect(compiled.omitted.map((entry) => entry.fragmentId)).not.toContain(
      `required:task_contract:${TASK_ID}`,
    );
    const blocks = compiled.rendered.request.blocks.map((block) => block.content);
    expect(blocks.some((content) => content.includes("Make the failing integration test pass"))).toBe(true);
    expect(blocks.some((content) => content.includes("Do not refactor the scheduler"))).toBe(true);
  });

  test("the contract still compiles when no version is published at all", async () => {
    const compiled = await compileContext(compileInput({ publishContractVersion: false }));
    expect(compiled.manifest.fragments.some(
      (fragment) => fragment.fragmentId === `required:task_contract:${TASK_ID}`,
    )).toBe(true);
  });

  test("the contract sits inside the cache-stable prefix, before the world state", async () => {
    const compiled = await compileContext(compileInput({ episodes: TRANSCRIPT }));
    const ids = compiled.manifest.fragments.map((fragment) => fragment.fragmentId);
    const contractIndex = ids.indexOf(`required:task_contract:${TASK_ID}`);
    const worldStateIndex = ids.indexOf(WORLD_STATE_FRAGMENT_ID);
    expect(contractIndex).toBeGreaterThanOrEqual(0);
    expect(worldStateIndex).toBeGreaterThan(contractIndex);
    expect(contractIndex).toBeLessThan(compiled.manifest.cachePlan.volatileSuffixBoundary);
  });
});

describe("transcript order and roles", () => {
  test("OpenAI: call → result → call → result with correct roles", async () => {
    const renderer = new OpenAiRenderer();
    const compiled = await compileContext(compileInput({ renderer, episodes: TRANSCRIPT }));
    const messages = (compiled.rendered.body as { messages: readonly {
      role: string;
      content: unknown;
      tool_calls?: readonly { id: string }[];
      tool_call_id?: string;
    }[] }).messages;
    const transcript = messages
      .filter((message) => message.role === "user" || message.role === "assistant" || message.role === "tool")
      .filter((message) => !(typeof message.content === "string" && message.content.startsWith("# World state")));
    expect(transcript.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
      "tool",
    ]);
    expect(transcript[0]?.content).toBe("Fix the failing test in packages/context-compiler.");
    expect(transcript[1]?.tool_calls?.[0]?.id).toBe("call_a");
    expect(transcript[2]?.tool_call_id).toBe("call_a");
    expect(transcript[3]?.tool_calls?.[0]?.id).toBe("call_b");
    expect(transcript[4]?.tool_call_id).toBe("call_b");
  });

  test("Anthropic: tool_use precedes its tool_result and the user turn is a user turn", async () => {
    const renderer = new AnthropicRenderer();
    const compiled = await compileContext(compileInput({
      providerId: "anthropic",
      renderer,
      episodes: TRANSCRIPT,
    }));
    const body = compiled.rendered.body as { messages: readonly AnthropicMessage[] };
    const flattened: { role: string; type: string; id: string | null }[] = [];
    for (const message of body.messages) {
      if (typeof message.content === "string") {
        flattened.push({ role: message.role, type: "text", id: null });
        continue;
      }
      for (const block of message.content) {
        flattened.push({
          role: message.role,
          type: block.type,
          id: block.type === "tool_use" ? block.id ?? null : block.tool_use_id ?? null,
        });
      }
    }
    const transcript = flattened.filter((entry) => entry.type !== "text" || entry.role === "user");
    const toolBlocks = transcript.filter((entry) => entry.type !== "text");
    expect(toolBlocks.map((entry) => `${entry.type}:${entry.id}`)).toEqual([
      "tool_use:call_a",
      "tool_result:call_a",
      "tool_use:call_b",
      "tool_result:call_b",
    ]);
    // The user's own message is a user message, not an assistant message.
    const userText = body.messages.find(
      (message) => message.role === "user"
        && message.content === "Fix the failing test in packages/context-compiler.",
    );
    expect(userText).toBeDefined();
  });

  test("selection may drop episodes but never reorders the survivors", async () => {
    const compiled = await compileContext(compileInput({ episodes: TRANSCRIPT }));
    const episodeIds = compiled.manifest.fragments
      .map((fragment) => fragment.fragmentId)
      .filter((id) => id.startsWith("runtime:episode:"));
    const sorted = [...episodeIds].sort();
    expect(episodeIds).toEqual(sorted);
  });
});

describe("world state is split by volatility", () => {
  const SCRAMBLED_SECTIONS = {
    // Deliberately scrambled: emission order must not follow insertion.
    repository_signals: { repository_map: { index_revision: "sha256:aaa" } },
    environment: { sandbox_profile: "secure-local-default" },
    verification: { status: "pending" },
    workspace: { id: "ws-1" },
    request_phase: { phase: "implementation" },
    last_command: { command: "exec", exit_code: 0 },
    changes: { files: ["a.ts"] },
    task: { id: TASK_ID, status: "ACTIVE", phase: "implementation" },
    // Suppressed:
    memory: { enabled: false, reason: "gate not promoted" },
    tool_capabilities: { active: [{ id: "read" }] },
    request: { text: "duplicate of the user_message episode" },
  } as const;

  test("per-task sections stay in front, per-attempt sections go to the tail", async () => {
    const compiled = await compileContext(compileInput({
      sections: SCRAMBLED_SECTIONS,
      episodes: TRANSCRIPT,
    }));
    const worldState = compiled.manifest.fragments.filter(
      (fragment) => fragment.fragmentId.startsWith("runtime:world_state"),
    );
    expect(worldState.map((fragment) => fragment.fragmentId)).toEqual([
      WORLD_STATE_FRAGMENT_ID,
      VOLATILE_WORLD_STATE_FRAGMENT_ID,
    ]);

    const ids = compiled.manifest.fragments.map((fragment) => fragment.fragmentId);
    // Stable tier: immediately after the cached prefix, before the transcript.
    expect(ids[compiled.manifest.cachePlan.volatileSuffixBoundary]).toBe(WORLD_STATE_FRAGMENT_ID);
    // Volatile tier: dead last, behind the newest transcript entry.
    expect(ids[ids.length - 1]).toBe(VOLATILE_WORLD_STATE_FRAGMENT_ID);
    const lastEpisodeIndex = ids.reduce(
      (last, id, index) => id.startsWith("runtime:episode:") ? index : last,
      -1,
    );
    expect(lastEpisodeIndex).toBeGreaterThan(ids.indexOf(WORLD_STATE_FRAGMENT_ID));
    expect(lastEpisodeIndex).toBeLessThan(ids.indexOf(VOLATILE_WORLD_STATE_FRAGMENT_ID));
  });

  test("each tier is one message with a fixed key order and no suppressed section", async () => {
    const compiled = await compileContext(compileInput({ sections: SCRAMBLED_SECTIONS }));
    const headings = (prefix: string): readonly string[] => {
      const block = compiled.rendered.request.blocks
        .map((entry) => entry.content)
        .find((content) => content.startsWith(prefix)) ?? "";
      return [...block.matchAll(/^## (.+)$/gm)].map((match) => match[1]!);
    };
    expect(headings("# World state")).toEqual(["task", "workspace", "environment"]);
    expect(headings("# Latest observations")).toEqual([
      "changes",
      "last_command",
      "verification",
      "repository_signals",
    ]);
    const everySection = [...headings("# World state"), ...headings("# Latest observations")];
    for (const suppressed of SUPPRESSED_WORLD_STATE_SECTIONS) {
      expect(everySection).not.toContain(suppressed);
    }
    // request_phase is byte-for-byte `task.phase`; only one copy ships.
    expect(everySection).not.toContain("request_phase");
  });

  test("the stable block is byte-identical when its own sections are unchanged", async () => {
    const first = await compileContext(compileInput({
      sections: { task: { id: TASK_ID }, workspace: { id: "ws-1" }, last_command: { exit_code: 0 } },
    }));
    const second = await compileContext(compileInput({
      // Reordered keys, and a volatile section that moved.
      sections: { last_command: { exit_code: 1 }, workspace: { id: "ws-1" }, task: { id: TASK_ID } },
    }));
    const blockOf = (
      compiled: Awaited<ReturnType<typeof compileContext>>,
      prefix: string,
    ): string => compiled.rendered.request.blocks
      .map((entry) => entry.content)
      .find((content) => content.startsWith(prefix)) ?? "";
    expect(blockOf(first, "# World state")).toBe(blockOf(second, "# World state"));
    expect(blockOf(first, "# World state").length).toBeGreaterThan(0);
    expect(blockOf(first, "# Latest observations"))
      .not.toBe(blockOf(second, "# Latest observations"));
  });

  test("empty sections cost nothing, and an absent tier costs no message", async () => {
    const compiled = await compileContext(compileInput({
      sections: { task: { id: TASK_ID }, changes: null, scout_brief: {} },
    }));
    const contents = compiled.rendered.request.blocks.map((entry) => entry.content);
    const stable = contents.find((content) => content.startsWith("# World state")) ?? "";
    expect(stable).toContain("## task");
    expect(stable).not.toContain("## changes");
    expect(contents.some((content) => content.startsWith("# Latest observations"))).toBe(false);
    expect(compiled.manifest.fragments.map((fragment) => fragment.fragmentId))
      .not.toContain(VOLATILE_WORLD_STATE_FRAGMENT_ID);
  });

  test("an unknown section defaults to volatile, never to the cached prefix", async () => {
    const compiled = await compileContext(compileInput({
      sections: { task: { id: TASK_ID }, some_future_counter: { steps: 7 } },
    }));
    const volatileBlock = compiled.rendered.request.blocks
      .map((entry) => entry.content)
      .find((content) => content.startsWith("# Latest observations")) ?? "";
    expect(volatileBlock).toContain("## some_future_counter");
  });
});

describe("cache breakpoints", () => {
  test("the prefix breakpoint lands on the last Anthropic system block", async () => {
    const renderer = new AnthropicRenderer();
    const compiled = await compileContext(compileInput({
      providerId: "anthropic",
      renderer,
      episodes: TRANSCRIPT,
    }));
    const body = compiled.rendered.body as { system: readonly AnthropicSystemBlock[] };
    // A one-block prefix would make the assertion vacuous.
    expect(body.system.length).toBeGreaterThan(2);
    const marked = body.system
      .map((block, index) => ({ block, index }))
      .filter((entry) => entry.block.cache_control !== undefined);
    expect(marked).toHaveLength(1);
    expect(marked[0]?.index).toBe(body.system.length - 1);
    expect(compiled.manifest.cachePlan.breakpoints[0]).toBe(body.system.length - 1);
    // The prefix is exactly the system blocks: nothing volatile leaked in.
    expect(compiled.manifest.cachePlan.volatileSuffixBoundary).toBe(body.system.length);
  });

  test("a second breakpoint marks the last message so the tail is cacheable next turn", async () => {
    const compiled = await compileContext(compileInput({ episodes: TRANSCRIPT }));
    const plan = compiled.manifest.cachePlan;
    expect(plan.breakpoints).toHaveLength(2);
    expect(plan.breakpoints[1]).toBe(compiled.manifest.fragments.length - 1);
  });

  test("no breakpoint is emitted below the provider's minimum cacheable prefix", async () => {
    const input = compileInput();
    const provider = {
      ...input.provider,
      caching: { ...input.provider.caching, minimumTokens: 1_000_000 },
    };
    const compiled = await compileContext({
      ...input,
      provider,
      model: { ...input.model, snapshot: provider },
    });
    expect(compiled.manifest.cachePlan.breakpoints).toEqual([]);
  });

  test("previousCacheEpoch turns the diagnostics from blind into a named reason", async () => {
    const readSnapshot = (compiled: Awaited<ReturnType<typeof compileContext>>): unknown =>
      (compiled.manifest.decisionRecord?.cacheEpochDebug as { current?: unknown } | undefined)?.current;

    const first = await compileContext(compileInput({ episodes: TRANSCRIPT }));
    const previous = readSnapshot(first);
    expect(previous).toBeDefined();
    // Without a previous epoch the compiler can only say "no previous epoch".
    const codesOf = (compiled: Awaited<ReturnType<typeof compileContext>>): readonly string[] =>
      ((compiled.manifest.decisionRecord?.cacheEpochDebug as {
        diagnostics: readonly { code: string }[];
      }).diagnostics).map((item) => item.code);
    expect(codesOf(first)).toContain("no_previous_epoch");

    const second = await compileContext({
      ...compileInput({
        episodes: [
          ...TRANSCRIPT,
          { sequence: 6, kind: "user_message", text: "Also update the changelog." },
        ],
      }),
      previousCacheEpoch: previous as never,
    });
    const debug = second.manifest.decisionRecord?.cacheEpochDebug as {
      previous: unknown;
      stablePrefixChanged: boolean;
      invalidationReasons: readonly string[];
    };
    expect(debug.previous).not.toBeNull();
    expect(debug.stablePrefixChanged).toBe(false);
    expect(codesOf(second)).not.toContain("no_previous_epoch");
    expect(codesOf(second)).toContain("stable_prefix_unchanged");
    expect(debug.invalidationReasons).not.toContain("stable_prefix_changed");
    expect(debug.invalidationReasons).not.toContain("stable_prefix_order_invalid");
  });

  test("one more user message keeps the prefix byte-identical up to the breakpoint", async () => {
    const renderer = new AnthropicRenderer();
    const first = await compileContext(compileInput({
      providerId: "anthropic",
      renderer,
      episodes: TRANSCRIPT,
    }));
    const second = await compileContext(compileInput({
      providerId: "anthropic",
      renderer,
      episodes: [
        ...TRANSCRIPT,
        { sequence: 6, kind: "user_message", text: "Also update the changelog." },
      ],
    }));
    const systemOf = (compiled: Awaited<ReturnType<typeof compileContext>>): readonly AnthropicSystemBlock[] =>
      (compiled.rendered.body as { system: readonly AnthropicSystemBlock[] }).system;
    const firstPrefix = systemOf(first).map((block) => block.text).join(" ");
    const secondPrefix = systemOf(second).map((block) => block.text).join(" ");
    expect(secondPrefix).toBe(firstPrefix);
    expect(first.manifest.cachePlan.stablePrefixHash)
      .toBe(second.manifest.cachePlan.stablePrefixHash);
    expect(first.manifest.cachePlan.breakpoints[0])
      .toBe(second.manifest.cachePlan.breakpoints[0]);
    // The new message lands after the breakpoint, in the volatile tail.
    const messagesOf = (compiled: Awaited<ReturnType<typeof compileContext>>): readonly AnthropicMessage[] =>
      (compiled.rendered.body as { messages: readonly AnthropicMessage[] }).messages;
    expect(messagesOf(second).length).toBeGreaterThan(messagesOf(first).length);
    // The tail breakpoint moves forward with the conversation, so the marker
    // itself legitimately differs between adjacent requests — a previously
    // marked block is still a cache hit. What must be byte-identical is the
    // overlap with the marker stripped; the first divergence there would be
    // the real invalidator.
    const withoutMarkers = (messages: readonly AnthropicMessage[]): string =>
      JSON.stringify(messages).replaceAll(',"cache_control":{"type":"ephemeral"}', "");
    expect(withoutMarkers(messagesOf(second).slice(0, messagesOf(first).length)))
      .toBe(withoutMarkers(messagesOf(first)));
    // And it did move: the newest turn's last block carries it now, so the
    // next request reads the whole transcript back instead of only the prefix.
    const tailOf = (messages: readonly AnthropicMessage[]): unknown => {
      const content = messages[messages.length - 1]!.content;
      return Array.isArray(content) ? content[content.length - 1] : content;
    };
    expect(tailOf(messagesOf(first))).toMatchObject({ cache_control: { type: "ephemeral" } });
    expect(tailOf(messagesOf(second))).toMatchObject({ cache_control: { type: "ephemeral" } });
  });
});

describe("prefix stability across attempts of one turn", () => {
  /** Attempt N: a patch has landed, nothing has been run yet. */
  const ATTEMPT_N_SECTIONS = {
    task: { id: TASK_ID, status: "ACTIVE" },
    workspace: { id: "ws-1", rootUri: "file:///w", trust: "trusted" },
    environment: { sandbox_profile: "secure-local-default", backend: null },
    repository_signals: { repository_map: { index_revision: "sha256:before", entry_count: 12 } },
  } as const;

  /**
   * Attempt N+1: the workspace changed and a command ran. Every difference
   * here is exactly the pair the live GPT-5.6 run showed invalidating the
   * cache — a moved `index_revision` and a newly-present `last_command`.
   */
  const ATTEMPT_NEXT_SECTIONS = {
    task: { id: TASK_ID, status: "ACTIVE" },
    workspace: { id: "ws-1", rootUri: "file:///w", trust: "trusted" },
    environment: { sandbox_profile: "secure-local-default", backend: null },
    repository_signals: { repository_map: { index_revision: "sha256:after", entry_count: 13 } },
    last_command: { command: "exec", argv: "bun test", exit_code: 1 },
    changes: { files: ["packages/app/src/main.ts"] },
  } as const;

  const NEW_EPISODES: readonly EpisodeSpec[] = [
    { sequence: 6, kind: "tool_call", text: toolCallText("call_c", "bun test"), toolCallId: "call-c" },
    { sequence: 7, kind: "tool_result", text: toolResultText("call_c", "1 failing"), toolCallId: "call-c" },
  ];

  test("OpenAI: input[0..k] is byte-identical and only the trailing volatile item differs", async () => {
    const attemptN = await compileContext(compileInput({
      renderer: new OpenAiRenderer(),
      episodes: TRANSCRIPT,
      sections: ATTEMPT_N_SECTIONS,
    }));
    const attemptNext = await compileContext(compileInput({
      renderer: new OpenAiRenderer(),
      episodes: [...TRANSCRIPT, ...NEW_EPISODES],
      sections: ATTEMPT_NEXT_SECTIONS,
    }));
    const itemsOf = (compiled: Awaited<ReturnType<typeof compileContext>>) =>
      toResponsesInputItems(
        (compiled.rendered.body as { messages: readonly OpenAiChatMessage[] }).messages,
      );
    const itemsN = itemsOf(attemptN);
    const itemsNext = itemsOf(attemptNext);

    // k = everything up to and including attempt N's last transcript item,
    // i.e. all of attempt N except its trailing volatile block.
    const k = itemsN.length - 1;
    expect(k).toBeGreaterThan(5);
    expect(JSON.stringify(itemsNext.slice(0, k))).toBe(JSON.stringify(itemsN.slice(0, k)));

    // The volatile blocks are the only world state that moved.
    const volatileOf = (items: readonly unknown[]): string =>
      JSON.stringify(items[items.length - 1]);
    expect(volatileOf(itemsNext)).not.toBe(volatileOf(itemsN));
    expect(volatileOf(itemsN)).toContain("# Latest observations");
    expect(volatileOf(itemsNext)).toContain("# Latest observations");
    // Everything the two attempts share is genuinely shared, not coincidence.
    expect(itemsNext.length).toBeGreaterThan(itemsN.length);
  });

  test("OpenAI: an unchanged transcript leaves only the trailing item different", async () => {
    const attemptN = await compileContext(compileInput({
      renderer: new OpenAiRenderer(),
      episodes: TRANSCRIPT,
      sections: ATTEMPT_N_SECTIONS,
    }));
    const attemptNext = await compileContext(compileInput({
      renderer: new OpenAiRenderer(),
      episodes: TRANSCRIPT,
      sections: ATTEMPT_NEXT_SECTIONS,
    }));
    const itemsOf = (compiled: Awaited<ReturnType<typeof compileContext>>) =>
      toResponsesInputItems(
        (compiled.rendered.body as { messages: readonly OpenAiChatMessage[] }).messages,
      );
    const itemsN = itemsOf(attemptN);
    const itemsNext = itemsOf(attemptNext);
    expect(itemsNext.length).toBe(itemsN.length);
    const differing = itemsN
      .map((item, index) => JSON.stringify(item) === JSON.stringify(itemsNext[index]) ? -1 : index)
      .filter((index) => index >= 0);
    expect(differing).toEqual([itemsN.length - 1]);
  });

  /**
   * Strip `cache_control` markers before comparing.
   *
   * The tail breakpoint is *supposed* to advance onto the newest transcript
   * item each attempt — that is Anthropic's documented incremental-caching
   * pattern, and the marker is a cache-write instruction rather than part of
   * the content the cache is keyed on. Everything else must be byte-stable,
   * and the marker's own movement is asserted separately below.
   */
  function withoutCacheControl(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(withoutCacheControl);
    if (typeof value !== "object" || value === null) return value;
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => key !== "cache_control")
        .map(([key, nested]) => [key, withoutCacheControl(nested)]),
    );
  }
  const stable = (value: unknown): string => JSON.stringify(withoutCacheControl(value));

  test("Anthropic: system blocks and every message before the tail are byte-identical", async () => {
    const attemptN = await compileContext(compileInput({
      providerId: "anthropic",
      renderer: new AnthropicRenderer(),
      episodes: TRANSCRIPT,
      sections: ATTEMPT_N_SECTIONS,
    }));
    const attemptNext = await compileContext(compileInput({
      providerId: "anthropic",
      renderer: new AnthropicRenderer(),
      episodes: [...TRANSCRIPT, ...NEW_EPISODES],
      sections: ATTEMPT_NEXT_SECTIONS,
    }));
    const bodyOf = (compiled: Awaited<ReturnType<typeof compileContext>>) =>
      compiled.rendered.body as {
        system: readonly AnthropicSystemBlock[];
        messages: readonly AnthropicMessage[];
      };
    const bodyN = bodyOf(attemptN);
    const bodyNext = bodyOf(attemptNext);

    expect(JSON.stringify(bodyNext.system)).toBe(JSON.stringify(bodyN.system));
    const k = bodyN.messages.length - 1;
    expect(k).toBeGreaterThan(4);
    expect(stable(bodyNext.messages.slice(0, k))).toBe(stable(bodyN.messages.slice(0, k)));
    expect(stable(bodyNext.messages[bodyNext.messages.length - 1]))
      .not.toBe(stable(bodyN.messages[k]));
    expect(String(bodyN.messages[k]?.content)).toContain("# Latest observations");
    expect(String(bodyNext.messages[bodyNext.messages.length - 1]?.content))
      .toContain("# Latest observations");
  });

  test("Anthropic: the tail marker advances with the transcript and never onto the volatile block", async () => {
    const markedIndexes = (body: { messages: readonly AnthropicMessage[] }): readonly number[] =>
      body.messages
        .map((message, index) => {
          if (typeof message.content === "string") return -1;
          return message.content.some((block) => block.cache_control !== undefined) ? index : -1;
        })
        .filter((index) => index >= 0);

    const attemptN = await compileContext(compileInput({
      providerId: "anthropic",
      renderer: new AnthropicRenderer(),
      episodes: TRANSCRIPT,
      sections: ATTEMPT_N_SECTIONS,
    }));
    const attemptNext = await compileContext(compileInput({
      providerId: "anthropic",
      renderer: new AnthropicRenderer(),
      episodes: [...TRANSCRIPT, ...NEW_EPISODES],
      sections: ATTEMPT_NEXT_SECTIONS,
    }));
    const bodyOf = (compiled: Awaited<ReturnType<typeof compileContext>>) =>
      compiled.rendered.body as {
        system: readonly AnthropicSystemBlock[];
        messages: readonly AnthropicMessage[];
      };
    const bodyN = bodyOf(attemptN);
    const bodyNext = bodyOf(attemptNext);

    const markedN = markedIndexes(bodyN);
    const markedNext = markedIndexes(bodyNext);
    expect(markedN).toHaveLength(1);
    expect(markedNext).toHaveLength(1);
    // Forward-only, and on the newest transcript item, not on the tail.
    expect(markedNext[0]!).toBeGreaterThan(markedN[0]!);
    for (const [body, marked] of [[bodyN, markedN], [bodyNext, markedNext]] as const) {
      expect(marked[0]!).toBeLessThan(body.messages.length - 1);
      expect(String(body.messages[marked[0]!]?.content)).not.toContain("# Latest observations");
      expect(String(body.messages[body.messages.length - 1]?.content))
        .toContain("# Latest observations");
    }
  });

  test("the tail breakpoint marks the last transcript item, never the volatile block", async () => {
    const compiled = await compileContext(compileInput({
      episodes: TRANSCRIPT,
      sections: ATTEMPT_NEXT_SECTIONS,
    }));
    const ids = compiled.manifest.fragments.map((fragment) => fragment.fragmentId);
    const breakpoints = compiled.manifest.cachePlan.breakpoints;
    expect(breakpoints).toHaveLength(2);
    expect(ids[breakpoints[1]!]).not.toBe(VOLATILE_WORLD_STATE_FRAGMENT_ID);
    expect(ids[breakpoints[1]!]).toBe(ids[ids.length - 2]);
    expect(ids[ids.length - 1]).toBe(VOLATILE_WORLD_STATE_FRAGMENT_ID);
  });

  test("the stable prefix hash is unchanged by a workspace mutation mid-turn", async () => {
    const attemptN = await compileContext(compileInput({
      episodes: TRANSCRIPT,
      sections: ATTEMPT_N_SECTIONS,
    }));
    const attemptNext = await compileContext(compileInput({
      episodes: [...TRANSCRIPT, ...NEW_EPISODES],
      sections: ATTEMPT_NEXT_SECTIONS,
    }));
    expect(attemptNext.manifest.cachePlan.stablePrefixHash)
      .toBe(attemptN.manifest.cachePlan.stablePrefixHash);
    expect(attemptNext.manifest.cachePlan.breakpoints[0])
      .toBe(attemptN.manifest.cachePlan.breakpoints[0]);
  });
});

/**
 * @terminus/provider-core — provider-neutral broker contracts.
 *
 * Per SPEC §15 and §38: `Provider`, `ProviderRenderer`, capability snapshots,
 * request/response shapes, usage/cost records, continuation decisions,
 * confidentiality policy enforcement, cost accounting. No network calls —
 * adapters handle the wire.
 */
import { z } from "zod";
import type {
  ModelKey,
  ContentHash,
  ConfidentialityLabel,
  Micros,
  TokenCount,
  Uuid7,
} from "@terminus/domain";
import { CompilationAuthorityError } from "@terminus/domain";
import type { ContextFragment, ContextManifest } from "@terminus/context-ir";

// ────────────────────────── Capability snapshots (§38.2) ─────────────────────

export interface ContextWindow {
  readonly advertisedTokens: number;
  readonly testedSafeTokens: number;
  readonly roleSupport: readonly string[];
  readonly imageInput: boolean;
  readonly toolCalling: boolean;
  readonly parallelToolCalls: boolean;
  readonly structuredOutput: boolean;
}

export interface ContinuationProfile {
  readonly nativeId: boolean;
  readonly crossRequest: boolean;
  readonly compaction: boolean;
  readonly compatibilityKey: string;
}

export interface CachingProfile {
  readonly mode: "none" | "automatic_prefix" | "explicit_breakpoints" | "explicit_resource";
  readonly exactPrefixRequired: boolean;
  readonly minimumTokens: number;
  readonly ttlOptions: readonly string[];
  readonly toolOrderSensitive: boolean;
  readonly usageReporting: boolean;
}

export interface ReasoningProfile {
  readonly supported: boolean;
  readonly budgetControl: boolean;
  readonly summaryAvailable: boolean;
}

export interface ProviderEconomics {
  readonly inputMicrosPerMillion: Micros;
  readonly cachedInputMicrosPerMillion: Micros;
  readonly outputMicrosPerMillion: Micros;
  readonly reasoningAccounting: boolean;
}

export interface ProviderReliability {
  readonly toolCallSuccess: number;
  readonly structuredOutputSuccess: number;
  readonly editCohortSuccess: number;
  readonly latencyPercentiles: Readonly<Record<string, number>>;
}

export interface ProviderPolicy {
  readonly allowedConfidentiality: readonly ConfidentialityLabel[];
  readonly retentionMode: string;
  readonly region: string | null;
}

export interface ProviderCapabilitySnapshot {
  readonly providerId: string;
  readonly observedAt: string;
  readonly source: string;
  readonly context: ContextWindow;
  readonly continuation: ContinuationProfile;
  readonly caching: CachingProfile;
  readonly reasoning: ReasoningProfile;
  readonly economics: ProviderEconomics;
  readonly reliability: ProviderReliability;
  readonly policy: ProviderPolicy;
}

export interface ModelCapabilitySnapshot {
  readonly modelKey: ModelKey;
  readonly providerId: string;
  readonly snapshot: ProviderCapabilitySnapshot;
  readonly observedAt: string;
}

// ────────────────────────── Provider request/response ────────────────────────

export interface ProviderToolSchema {
  readonly id: string;
  readonly version: string;
  readonly summary: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly resultSchema: Readonly<Record<string, unknown>>;
  readonly sideEffectClass: string;
  readonly requiredCapabilities: readonly string[];
  readonly trustLevel: "builtin" | "first_party" | "verified_third_party" | "untrusted";
  readonly maximumModelResultBytes: number;
  readonly maximumArtifactBytes: number;
  readonly defaultTimeoutMs: number;
  readonly policyTags: readonly string[];
}

export interface ProviderRenderedBlock {
  readonly role: "system" | "user" | "assistant" | "tool" | "developer";
  readonly content: string;
  readonly artifactHash: ContentHash;
  readonly cacheBreakpoint: boolean;
  readonly confidentiality: ConfidentialityLabel;
}

export interface ProviderRequest {
  readonly providerId: string;
  readonly model: ModelKey;
  readonly blocks: readonly ProviderRenderedBlock[];
  readonly toolSchemas: readonly ProviderToolSchema[];
  readonly continuationId: string | null;
  readonly cachePlan: {
    readonly stablePrefixHash: ContentHash;
    readonly breakpoints: readonly number[];
  };
  readonly outputProfile: "terse" | "explanatory" | "teaching" | "structured";
  readonly reasoningReserveTokens: TokenCount;
  readonly outputReserveTokens: TokenCount;
  readonly hardInputLimit: TokenCount;
  readonly signal: AbortSignal | null;
}

export interface ProviderToolCallChunk {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

export interface ProviderResponseChunk {
  readonly kind: "text" | "tool_call" | "error" | "done";
  readonly text?: string | undefined;
  readonly toolCall?: ProviderToolCallChunk | undefined;
  readonly errorCode?: string | undefined;
  readonly errorMessage?: string | undefined;
  readonly retryAfterMs?: number | undefined;
  readonly usage?: UsageRecord | undefined;
  readonly continuationId?: string | undefined;
  readonly reasoning?: string | undefined;
}

export interface ProjectedResponse {
  readonly text: string;
  readonly toolCalls: readonly ProviderToolCallChunk[];
  readonly reasoning: string | null;
  readonly continuationId: string | null;
  readonly finishReason: "stop" | "tool_use" | "length" | "error" | "cancelled";
}

// ────────────────────────── Usage / cost (§38.14) ────────────────────────────

export interface UsageRecord {
  readonly inputTokens: TokenCount;
  readonly cachedInputTokens: TokenCount;
  readonly cacheWriteTokens: TokenCount;
  readonly outputTokens: TokenCount;
  readonly reasoningTokens: TokenCount;
  readonly toolSchemaTokens: TokenCount;
  readonly latencyMs: number;
  readonly timeToFirstTokenMs: number | null;
}

export const usageRecordSchema = z.object({
  inputTokens: z.bigint(),
  cachedInputTokens: z.bigint(),
  cacheWriteTokens: z.bigint(),
  outputTokens: z.bigint(),
  reasoningTokens: z.bigint(),
  toolSchemaTokens: z.bigint(),
  latencyMs: z.number(),
  timeToFirstTokenMs: z.number().nullable(),
});

export interface CostRecord {
  readonly providerReportedCostMicros: Micros | null;
  readonly computedCostMicros: Micros;
  readonly inputMicros: Micros;
  readonly cachedInputMicros: Micros;
  readonly outputMicros: Micros;
  readonly reasoningMicros: Micros;
  readonly anomaly: boolean;
  readonly anomalyReason: string | null;
}

// ────────────────────────── Continuation (§38.8) ─────────────────────────────

export interface ContinuationInput {
  readonly providerId: string;
  readonly model: ModelKey;
  readonly continuationId: string | null;
  readonly previousManifest: ContextManifest | null;
  readonly currentManifest: ContextManifest;
  readonly stablePrefixHashChanged: boolean;
  readonly policyAllowsProviderPersistence: boolean;
}

export interface ContinuationDecision {
  readonly canContinue: boolean;
  readonly reason: string;
  readonly requiresRerender: boolean;
  readonly requiresUserConsent: boolean;
  readonly newContinuationId: string | null;
}

// ────────────────────────── Provider / Renderer ──────────────────────────────

export interface RenderCompatibilityInput {
  readonly provider: ProviderCapabilitySnapshot;
  readonly model: ModelCapabilitySnapshot;
  readonly fragments: readonly ContextFragment[];
  readonly toolSchemas: readonly ProviderToolSchema[];
  readonly hardInputLimit: TokenCount;
}

export interface CompatibilityResult {
  readonly compatible: boolean;
  readonly incompatibilities: readonly string[];
  readonly downgradesRequired: readonly string[];
}

export interface CanonicalRenderInput {
  readonly provider: ProviderCapabilitySnapshot;
  readonly model: ModelCapabilitySnapshot;
  readonly fragments: readonly ContextFragment[];
  readonly toolSchemas: readonly ProviderToolSchema[];
  readonly cachePlan: {
    readonly stablePrefixHash: ContentHash;
    readonly breakpoints: readonly number[];
  };
  readonly continuationId: string | null;
  readonly outputProfile: "terse" | "explanatory" | "teaching" | "structured";
  readonly reasoningReserveTokens: TokenCount;
  readonly outputReserveTokens: TokenCount;
  readonly hardInputLimit: TokenCount;
  readonly signal: AbortSignal | null;
  /**
   * Optional compiled manifest ID. Required for authority validation.
   */
  readonly manifestId?: Uuid7 | string | undefined;
}

export interface RenderedProviderRequest {
  readonly providerId: string;
  readonly model: ModelKey;
  readonly request: ProviderRequest;
  readonly predictedCachedTokens: TokenCount;
  readonly body: Readonly<Record<string, unknown>>;
}

export interface ProviderResponse {
  readonly providerId: string;
  readonly model: ModelKey;
  readonly chunks: readonly ProviderResponseChunk[];
  readonly observedAt: string;
}

export interface ProviderRenderer {
  readonly providerId: string;
  readonly version: string;
  compatibility(input: RenderCompatibilityInput): CompatibilityResult;
  render(input: CanonicalRenderInput): Promise<RenderedProviderRequest>;
  projectResponse(response: ProviderResponse): Promise<ProjectedResponse>;
  extractUsage(response: ProviderResponse): UsageRecord;
  continuationPolicy(input: ContinuationInput): ContinuationDecision;
}

export interface ProviderTransport {
  stream(
    request: ProviderRequest,
    body: Readonly<Record<string, unknown>>,
    signal: AbortSignal | null,
  ): AsyncIterable<ProviderResponseChunk>;
}

export interface Provider {
  readonly providerId: string;
  readonly displayName: string;
  readonly renderer: ProviderRenderer;
  readonly transport?: ProviderTransport | undefined;
}

// ────────────────────────── Confidentiality policy (§38.18) ──────────────────

export interface ConfidentialityPolicy {
  readonly allowedProviders: Readonly<Record<ConfidentialityLabel, readonly string[]>>;
}

export function isConfidentialityAllowed(
  policy: ConfidentialityPolicy,
  provider: string,
  confidentiality: ConfidentialityLabel,
): boolean {
  const allow = policy.allowedProviders[confidentiality] ?? [];
  return allow.includes(provider);
}

export function filterByConfidentiality(
  policy: ConfidentialityPolicy,
  provider: string,
  fragments: readonly ContextFragment[],
): {
  readonly admitted: readonly ContextFragment[];
  readonly omitted: readonly { readonly fragmentId: string; readonly reason: string }[];
} {
  const admitted: ContextFragment[] = [];
  const omitted: { fragmentId: string; reason: string }[] = [];
  for (const f of fragments) {
    if (isConfidentialityAllowed(policy, provider, f.confidentiality)) {
      admitted.push(f);
    } else {
      omitted.push({
        fragmentId: f.id,
        reason: `confidentiality '${f.confidentiality}' not allowed for provider '${provider}'`,
      });
    }
  }
  return { admitted, omitted };
}

// ────────────────────────── Cost accounting (§38.14) ─────────────────────────

export interface CostComputationInput {
  readonly usage: UsageRecord;
  readonly economics: ProviderEconomics;
  readonly providerReportedCostMicros: Micros | null;
  readonly anomalyTolerance?: number | undefined;
}

export function computeCost(input: CostComputationInput): CostRecord {
  const microsPerMillion = (m: Micros) => Number(m) / 1_000_000;
  const inputMicros = BigInt(
    Math.round(Number(input.usage.inputTokens) * microsPerMillion(input.economics.inputMicrosPerMillion)),
  ) as Micros;
  const cachedInputMicros = BigInt(
    Math.round(
      Number(input.usage.cachedInputTokens) *
        microsPerMillion(input.economics.cachedInputMicrosPerMillion),
    ),
  ) as Micros;
  const outputMicros = BigInt(
    Math.round(
      Number(input.usage.outputTokens) * microsPerMillion(input.economics.outputMicrosPerMillion),
    ),
  ) as Micros;
  const reasoningMicros = input.economics.reasoningAccounting
    ? (BigInt(
        Math.round(
          Number(input.usage.reasoningTokens) *
            microsPerMillion(input.economics.outputMicrosPerMillion),
        ),
      ) as Micros)
    : (0n as Micros);
  const computed = (inputMicros + cachedInputMicros + outputMicros + reasoningMicros) as Micros;
  const tolerance = input.anomalyTolerance ?? 0.05;
  let anomaly = false;
  let anomalyReason: string | null = null;
  if (input.providerReportedCostMicros !== null) {
    const reported = Number(input.providerReportedCostMicros);
    const computedN = Number(computed);
    if (computedN === 0 && reported !== 0) {
      anomaly = true;
      anomalyReason = "computed cost is zero but provider reported non-zero";
    } else if (computedN > 0) {
      const diff = Math.abs(reported - computedN) / computedN;
      if (diff > tolerance) {
        anomaly = true;
        anomalyReason = `provider reported ${reported} micros but computed ${computedN} (diff ${diff.toFixed(3)})`;
      }
    }
  }
  return {
    providerReportedCostMicros: input.providerReportedCostMicros,
    computedCostMicros: computed,
    inputMicros,
    cachedInputMicros,
    outputMicros,
    reasoningMicros,
    anomaly,
    anomalyReason,
  };
}

// ────────────────────────── Renderer base class ──────────────────────────────

export abstract class BaseProviderRenderer implements ProviderRenderer {
  abstract readonly providerId: string;
  abstract readonly version: string;

  compatibility(input: RenderCompatibilityInput): CompatibilityResult {
    const incompatibilities: string[] = [];
    const downgrades: string[] = [];
    if (input.toolSchemas.length > 0 && !input.provider.context.toolCalling) {
      incompatibilities.push("provider does not support tool calling");
    }
    for (const frag of input.fragments) {
      if (frag.confidentiality === "secret") {
        downgrades.push(
          `fragment ${frag.id} has 'secret' confidentiality — needs provider policy check`,
        );
      }
    }
    const totalTokens = input.fragments.reduce(
      (sum, f) => sum + (f.estimatedTokens[input.model.modelKey] ?? 0),
      0,
    );
    if (totalTokens > Number(input.hardInputLimit)) {
      incompatibilities.push(
        `estimated ${totalTokens} tokens exceeds hard input limit ${input.hardInputLimit}`,
      );
    }
    return {
      compatible: incompatibilities.length === 0,
      incompatibilities,
      downgradesRequired: downgrades,
    };
  }

  /**
   * Asserts that the request was issued via Context Compiler compilation.
   */
  protected assertCompilationAuthority(input: CanonicalRenderInput): void {
    if (!input.manifestId) {
      throw new CompilationAuthorityError(
        "Provider request bypassed Context Compiler execution — missing compiled manifest ID",
        { providerId: this.providerId, model: input.model.modelKey },
      );
    }
  }

  abstract render(input: CanonicalRenderInput): Promise<RenderedProviderRequest>;
  abstract projectResponse(response: ProviderResponse): Promise<ProjectedResponse>;
  abstract extractUsage(response: ProviderResponse): UsageRecord;

  continuationPolicy(input: ContinuationInput): ContinuationDecision {
    if (!input.policyAllowsProviderPersistence) {
      return {
        canContinue: false,
        reason: "provider persistence disallowed by policy",
        requiresRerender: false,
        requiresUserConsent: false,
        newContinuationId: null,
      };
    }
    if (input.continuationId === null) {
      return {
        canContinue: false,
        reason: "no continuation id present",
        requiresRerender: false,
        requiresUserConsent: false,
        newContinuationId: null,
      };
    }
    if (input.stablePrefixHashChanged) {
      return {
        canContinue: false,
        reason: "stable prefix hash changed — cache prefix invalidated",
        requiresRerender: true,
        requiresUserConsent: false,
        newContinuationId: null,
      };
    }
    return {
      canContinue: true,
      reason: "continuation compatible",
      requiresRerender: false,
      requiresUserConsent: false,
      newContinuationId: input.continuationId,
    };
  }
}

// ────────────────────────── Re-exports ───────────────────────────────────────

export type {
  ContextFragment,
  ContextManifest,
  ModelKey,
  ContentHash,
  ConfidentialityLabel,
  Micros,
  TokenCount,
  Uuid7,
};

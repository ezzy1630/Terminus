/**
 * @terminus/context-ir — Context IR types and zod schemas.
 *
 * Per SPEC §8 and §33: context fragment types, source descriptors,
 * exactness classes, trust/confidentiality/injection labels, freshness,
 * invalidation rules, selection features, dependencies, world-state
 * observation interface, context epoch snapshot, context manifest builder.
 *
 * Pure data — no I/O.
 */
import { z } from "zod";
import { createHash } from "node:crypto";
import type {
  ArtifactRef,
  ContentHash,
  ModelKey,
  Rfc3339Timestamp,
  Uuid7,
  TokenCount,
  ConfidentialityLabel,
  TrustLabel,
  InjectionRisk,
  Exactness,
  ContextKind,
  ContextFragment,
  ContextManifest,
  ContextEpoch,
  ContextScope,
  Freshness,
  InvalidationRule,
  SelectionFeatures,
  SourceDescriptor,
  ContextCachePlan,
} from "@terminus/domain";
import {
  artifactRefSchema,
  confidentialityLabelSchema,
  trustLabelSchema,
  injectionRiskSchema,
  exactnessSchema,
  contextKindSchema,
} from "@terminus/domain";

// Re-export canonical context types from domain for convenience.
export type {
  ArtifactRef,
  ContentHash,
  ModelKey,
  Rfc3339Timestamp,
  Uuid7,
  TokenCount,
  ConfidentialityLabel,
  TrustLabel,
  InjectionRisk,
  Exactness,
  ContextKind,
  ContextFragment,
  ContextManifest,
  ContextEpoch,
  ContextScope,
  Freshness,
  InvalidationRule,
  SelectionFeatures,
  SourceDescriptor,
  ContextCachePlan,
};

// ───────────────────────── Source descriptor ─────────────────────────────────

export const sourceDescriptorSchema = z.object({
  uri: z.string(),
  producer: z.string(),
  producerVersion: z.string(),
  observedAt: z.string(),
  observedBy: z.enum(["kernel", "control", "provider", "user", "external"]),
  evidenceRefs: z.array(artifactRefSchema),
});

// ───────────────────────── Freshness / invalidation ──────────────────────────

export const freshnessSchema = z.object({
  observedAt: z.string(),
  sourceVersion: z.string().nullable(),
  stale: z.boolean(),
  staleReason: z.string().nullable(),
});

export const invalidationRuleSchema = z.object({
  kind: z.enum([
    "file_changed",
    "symbol_changed",
    "test_changed",
    "policy_changed",
    "ttl",
  ]),
  selector: z.string(),
});

export const selectionFeaturesSchema = z.object({
  relevance: z.number(),
  novelty: z.number(),
  coverage: z.number(),
  uncertaintyReduction: z.number(),
  riskReduction: z.number(),
  modelCompatibility: z.number(),
  redundancyPenalty: z.number(),
  injectionPenalty: z.number(),
});

export const contextScopeSchema = z.object({
  workspaceId: z.string().nullable(),
  sessionId: z.string().nullable(),
  taskId: z.string().nullable(),
  pathPatterns: z.array(z.string()),
});

// ───────────────────────── Fragment schema ───────────────────────────────────

export const contextFragmentSchema = z.object({
  id: z.string(),
  kind: contextKindSchema,
  contentRef: artifactRefSchema,
  textContent: z.string().optional(),
  source: sourceDescriptorSchema,
  sourceVersion: z.string().nullable(),
  authority: z.number().int().min(0).max(100),
  priority: z.number().int(),
  trust: trustLabelSchema,
  confidentiality: confidentialityLabelSchema,
  injectionRisk: injectionRiskSchema,
  exactness: exactnessSchema,
  scope: contextScopeSchema,
  freshness: freshnessSchema,
  dependencies: z.array(z.string()),
  invalidation: z.array(invalidationRuleSchema),
  estimatedTokens: z.record(z.string(), z.number().int().nonnegative()),
  selectionFeatures: selectionFeaturesSchema,
});

// ─────────────────── World State Registry (§33.5) ────────────────────────────

export const WorldStateSection = [
  "environment",
  "repository",
  "workspace",
  "execution",
  "jobs",
  "diagnostics",
  "tests",
  "permissions",
  "sandbox",
  "network",
  "secrets",
  "capabilities",
  "agents",
  "budget",
  "verification",
  "scope",
] as const;
export type WorldStateSection = (typeof WorldStateSection)[keyof typeof WorldStateSection];
export const worldStateSectionSchema = z.enum(WorldStateSection);

export interface WorldStateObservation<T = unknown> {
  readonly key: string;
  readonly value: T;
  readonly observedAt: Rfc3339Timestamp;
  readonly sourceVersion: string;
  readonly availability: "available" | "temporarily_unavailable" | "removed";
  readonly staleReason: string | null;
}

export const worldStateObservationSchema = z
  .object({
    key: z.string(),
    value: z.unknown(),
    observedAt: z.string(),
    sourceVersion: z.string(),
    availability: z.enum(["available", "temporarily_unavailable", "removed"]),
    staleReason: z.string().nullable(),
  })
  .brand<"WorldStateObservation">();

export interface WorldStateSnapshot {
  readonly section: WorldStateSection;
  readonly observations: readonly WorldStateObservation[];
  readonly observedAt: Rfc3339Timestamp;
  readonly producerVersion: string;
}

export const worldStateSnapshotSchema = z.object({
  section: worldStateSectionSchema,
  observations: z.array(worldStateObservationSchema),
  observedAt: z.string(),
  producerVersion: z.string(),
});

// ───────────────────────── Context epoch snapshot ────────────────────────────

export interface ContextEpochSnapshot {
  readonly epochId: Uuid7;
  readonly threadId: Uuid7;
  readonly sequence: number;
  readonly baselineHash: ContentHash;
  readonly provider: string;
  readonly model: ModelKey;
  readonly continuationId: string | null;
  readonly startedAt: Rfc3339Timestamp;
}

// ───────────────────────── Context directive ─────────────────────────────────

export interface ContextDirective {
  readonly kind:
    | "include_path"
    | "include_symbol"
    | "exclude_path"
    | "include_episode"
    | "include_memory"
    | "exclude_memory"
    | "set_output_profile"
    | "use_checkpoint";
  readonly target: string;
  readonly reason: string;
  readonly requestedBy: "user" | "system" | "plugin";
}

export const contextDirectiveSchema = z.object({
  kind: z.enum([
    "include_path",
    "include_symbol",
    "exclude_path",
    "include_episode",
    "include_memory",
    "exclude_memory",
    "set_output_profile",
    "use_checkpoint",
  ]),
  target: z.string(),
  reason: z.string(),
  requestedBy: z.enum(["user", "system", "plugin"]),
});

// ───────────────────────── Context budget ────────────────────────────────────

export interface ContextBudget {
  readonly modelAdvertisedTokens: TokenCount;
  readonly testedSafeTokens: TokenCount;
  readonly protocolOverheadTokens: TokenCount;
  readonly exactContextTokens: TokenCount;
  readonly optionalContextTarget: TokenCount;
  readonly expectedToolResultReserve: TokenCount;
  readonly outputReserve: TokenCount;
  readonly reasoningReserve: TokenCount;
  readonly recoveryMargin: TokenCount;
  readonly hardInputLimit: TokenCount;
  readonly hardCostMicros: bigint;
}

// ───────────────────────── Manifest builder ──────────────────────────────────

export interface ManifestBuilderInput {
  readonly compilerVersion: string;
  readonly policyVersion: string;
  readonly providerCapabilityHash: ContentHash;
  readonly model: ModelKey;
  readonly epoch: ContextEpochSnapshot;
  readonly selected: readonly ContextFragment[];
  readonly omitted: readonly { readonly fragmentId: string; readonly reason: string }[];
  readonly cachePlan: ContextCachePlan;
  readonly reserves: {
    readonly output: TokenCount;
    readonly reasoning: TokenCount;
    readonly toolResult: TokenCount;
    readonly recovery: TokenCount;
  };
  readonly predictedCachedTokens: TokenCount;
  readonly confidentialityDecisions: Readonly<Record<string, ConfidentialityLabel>>;
  readonly taintDecisions: Readonly<Record<string, InjectionRisk>>;
  readonly experimentAssignments: readonly string[];
  readonly occurredAt: Rfc3339Timestamp;
}

/**
 * Builds a `ContextManifest` from the builder input. The manifest is the
 * durable build record for a single provider attempt (SPEC §33.13).
 *
 * Pure function — does not persist. Caller is responsible for
 * `persistBeforeSend`.
 */
export function buildManifest(input: ManifestBuilderInput): Omit<ContextManifest, "id"> {
  const entries: ContextManifest["fragments"][number][] = input.selected.map(
    (frag, idx) => ({
      fragmentId: frag.id,
      role: frag.kind,
      order: idx,
      artifactHash: frag.contentRef.hash,
      estimatedTokens: frag.estimatedTokens[input.model] ?? 0,
      required: frag.authority >= 80,
      cacheBreakpoint: false,
    }),
  );
  return {
    providerAttemptId: null,
    epochId: input.epoch.epochId,
    compilerVersion: input.compilerVersion,
    policyVersion: input.policyVersion,
    providerCapabilityHash: input.providerCapabilityHash,
    model: input.model,
    fragments: entries,
    omitted: input.omitted,
    cachePlan: input.cachePlan,
    outputReserveTokens: input.reserves.output,
    reasoningReserveTokens: input.reserves.reasoning,
    toolResultReserveTokens: input.reserves.toolResult,
    recoveryMarginTokens: input.reserves.recovery,
    predictedCachedTokens: input.predictedCachedTokens,
    observedCachedTokens: null,
    confidentialityDecisions: input.confidentialityDecisions,
    taintDecisions: input.taintDecisions,
    experimentAssignments: input.experimentAssignments,
    createdAt: input.occurredAt,
  };
}

// ───────────────────────── Helpers ───────────────────────────────────────────

/** Returns true if the fragment is "hard-required" by policy (authority >= 80). */
export function isHardRequired(fragment: ContextFragment): boolean {
  return fragment.authority >= 80;
}

/**
 * Returns true if the fragment is allowed to be rendered for the given
 * confidentiality policy. `maxAllowed` is the highest confidentiality this
 * provider may see.
 */
export function isConfidentialityAllowed(
  fragment: ContextFragment,
  maxAllowed: ConfidentialityLabel,
): boolean {
  const order: Readonly<Record<ConfidentialityLabel, number>> = {
    public: 0,
    workspace: 1,
    secret_adjacent: 2,
    secret: 3,
  };
  return order[fragment.confidentiality] <= order[maxAllowed];
}

/**
 * Returns true if the fragment's freshness allows it to be rendered for the
 * given current source-version map. A `null` sourceVersion is treated as
 * always-fresh.
 */
export function isFreshAgainst(
  fragment: ContextFragment,
  currentVersions: Readonly<Record<string, string>>,
): boolean {
  if (fragment.freshness.stale) return false;
  if (fragment.sourceVersion === null) return true;
  const current = currentVersions[fragment.source.uri];
  if (current === undefined) return true;
  return current === fragment.sourceVersion;
}

/**
 * Computes a deterministic stable-prefix hash from a list of stable fragments.
 * The result is content-addressed: identical input lists produce identical
 * hashes. Uses the real SHA-256 algorithm via `node:crypto` per SPEC §28.1
 * (content identities MUST use `sha256:<hex>`).
 */
export function computeStablePrefixHash(stableFragments: readonly ContextFragment[]): ContentHash {
  const lines = stableFragments.map((f) => `${f.id}:${f.contentRef.hash}`).sort();
  const joined = lines.join("\n");
  const hex = createHash("sha256").update(joined, "utf8").digest("hex");
  return `sha256:${hex}` as ContentHash;
}

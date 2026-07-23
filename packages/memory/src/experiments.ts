/**
 * Held-out memory experiments (SPEC §39.9, M10 task 11).
 *
 * Deterministic fixtures — no network, no live models. Used by the M10 exit
 * gate to measure precision, utility, stale-memory harm, contradiction
 * handling, and harmful retrieval.
 */
import type {
  ArtifactRef,
  ContentHash,
  MemoryClaim,
  MemoryClaimKind,
  MemoryScope,
  ModelKey,
  Rfc3339Timestamp,
  Uuid7,
} from "@terminus/domain";
import { hasCompleteProvenance } from "./explain.js";
import { retrieveMemories } from "./retrieval.js";
import { isContradiction, relateClaims } from "./contradiction.js";
import { revalidateClaim, type RevalidationContext } from "./revalidate.js";

export interface ExperimentClaimSeed {
  readonly id: Uuid7;
  readonly kind: MemoryClaimKind;
  readonly statement: string;
  readonly relevantQueries: readonly string[];
  readonly harmfulForQueries: readonly string[];
  readonly confidencePpm: number;
  readonly stale?: boolean;
  readonly expiresAt?: Rfc3339Timestamp | null;
  readonly fileSelector?: string;
  readonly sourceHash?: ContentHash;
}

export interface HeldOutTask {
  readonly id: string;
  readonly query: string;
  /** Claim ids that are useful for this task. */
  readonly usefulClaimIds: readonly Uuid7[];
  /** Claim ids that would harm this task if retrieved. */
  readonly harmfulClaimIds: readonly Uuid7[];
  /** Baseline success probability without memory [0,1]. */
  readonly baselineUtility: number;
  /** Success probability if only useful claims are injected. */
  readonly withUsefulUtility: number;
  /** Success probability if harmful claims are injected. */
  readonly withHarmfulUtility: number;
}

export interface ExperimentCorpus {
  readonly claims: readonly MemoryClaim[];
  readonly tasks: readonly HeldOutTask[];
  readonly now: Rfc3339Timestamp;
  readonly scope: MemoryScope;
  readonly revalidation: RevalidationContext;
}

export interface PrecisionResult {
  readonly precision: number;
  readonly recall: number;
  readonly retrieved: number;
  readonly relevantRetrieved: number;
  readonly relevantTotal: number;
}

export interface UtilityResult {
  readonly baseline: number;
  readonly withMemory: number;
  readonly delta: number;
  readonly positive: boolean;
}

export interface StaleMemoryResult {
  readonly staleInjected: number;
  readonly staleBlocked: number;
  readonly harmRate: number;
}

export interface ContradictionResult {
  readonly pairs: number;
  readonly detected: number;
  readonly detectionRate: number;
}

export interface HarmResult {
  readonly harmfulRetrieved: number;
  readonly totalRetrieved: number;
  readonly harmfulRetrievalRate: number;
}

export interface ProvenanceResult {
  readonly total: number;
  readonly complete: number;
  readonly completeRate: number;
}

export interface ExperimentReport {
  readonly precision: PrecisionResult;
  readonly utility: UtilityResult;
  readonly stale: StaleMemoryResult;
  readonly contradiction: ContradictionResult;
  readonly harm: HarmResult;
  readonly provenance: ProvenanceResult;
}

export function buildClaimFromSeed(
  seed: ExperimentClaimSeed,
  opts: {
    readonly now: Rfc3339Timestamp;
    readonly scope: MemoryScope;
    readonly model: ModelKey;
    readonly version: string;
    readonly taskId: Uuid7;
    readonly sessionId: Uuid7;
  },
): MemoryClaim {
  const sourceHash =
    seed.sourceHash ??
    (("sha256:" + "ab".repeat(32)) as ContentHash);
  const source: ArtifactRef = {
    hash: sourceHash,
    uri: (`artifact://sha256/${sourceHash.slice("sha256:".length)}`) as ArtifactRef["uri"],
    mediaType: "application/json",
    bytes: 32n as ArtifactRef["bytes"],
  };
  return {
    id: seed.id,
    kind: seed.kind,
    statement: seed.statement,
    procedureArtifactHash: seed.kind === "procedure" ? sourceHash : null,
    scope: opts.scope,
    provenance: {
      sources: [source],
      createdFromSession: opts.sessionId,
      createdFromTask: opts.taskId,
      extractorModel: opts.model,
      extractorVersion: opts.version,
    },
    confidencePpm: seed.confidencePpm,
    verification: {
      lastVerifiedAt: seed.stale ? null : opts.now,
      method: seed.stale ? null : "fixture",
      evidence: [source],
    },
    validity: {
      startsAt: opts.now,
      expiresAt: seed.expiresAt ?? null,
      invalidationRules:
        seed.fileSelector !== undefined
          ? [{ kind: "file_changed", selector: seed.fileSelector }]
          : [],
    },
    usage: { count: 0, lastUsedAt: null, successfulUses: 0, harmfulUses: 0 },
    relations: { supports: [], contradicts: [], supersedes: [] },
    status: "active",
    createdAt: opts.now,
  };
}

/** Precision / recall over held-out tasks using BM25 retrieval. */
export function runPrecisionExperiment(corpus: ExperimentCorpus): PrecisionResult {
  let relevantRetrieved = 0;
  let retrieved = 0;
  let relevantTotal = 0;

  for (const task of corpus.tasks) {
    relevantTotal += task.usefulClaimIds.length;
    const results = retrieveMemories(corpus.claims, {
      query: task.query,
      scope: corpus.scope,
      now: corpus.now,
      limit: 5,
      revalidation: corpus.revalidation,
      requireProvenance: true,
    });
    retrieved += results.length;
    for (const r of results) {
      if (task.usefulClaimIds.includes(r.claim.id)) relevantRetrieved += 1;
    }
  }

  return {
    precision: retrieved === 0 ? 0 : relevantRetrieved / retrieved,
    recall: relevantTotal === 0 ? 0 : relevantRetrieved / relevantTotal,
    retrieved,
    relevantRetrieved,
    relevantTotal,
  };
}

/**
 * Utility delta: compare baseline vs memory-assisted success using the
 * task's labeled useful/harmful sets and actual retrieval.
 */
export function runUtilityExperiment(corpus: ExperimentCorpus): UtilityResult {
  let baseline = 0;
  let withMemory = 0;

  for (const task of corpus.tasks) {
    baseline += task.baselineUtility;
    const results = retrieveMemories(corpus.claims, {
      query: task.query,
      scope: corpus.scope,
      now: corpus.now,
      limit: 5,
      revalidation: corpus.revalidation,
      requireProvenance: true,
    });
    const ids = new Set(results.map((r) => r.claim.id));
    const gotUseful = task.usefulClaimIds.some((id) => ids.has(id));
    const gotHarmful = task.harmfulClaimIds.some((id) => ids.has(id));
    if (gotHarmful) {
      withMemory += task.withHarmfulUtility;
    } else if (gotUseful) {
      withMemory += task.withUsefulUtility;
    } else {
      withMemory += task.baselineUtility;
    }
  }

  const n = Math.max(corpus.tasks.length, 1);
  const b = baseline / n;
  const w = withMemory / n;
  return { baseline: b, withMemory: w, delta: w - b, positive: w > b };
}

/** Stale claims must be blocked by revalidation / expiry before injection. */
export function runStaleMemoryExperiment(corpus: ExperimentCorpus): StaleMemoryResult {
  let staleInjected = 0;
  let staleBlocked = 0;

  for (const claim of corpus.claims) {
    const outcome = revalidateClaim(claim, corpus.revalidation);
    const isStaleSeed =
      claim.verification.lastVerifiedAt === null ||
      (claim.validity.expiresAt !== null && claim.validity.expiresAt <= corpus.now);

    if (!isStaleSeed) continue;

    if (outcome.status === "stale") {
      staleBlocked += 1;
    } else {
      // Would be injectable — count as harm.
      staleInjected += 1;
    }
  }

  const total = staleInjected + staleBlocked;
  return {
    staleInjected,
    staleBlocked,
    harmRate: total === 0 ? 0 : staleInjected / total,
  };
}

export function runContradictionExperiment(
  pairs: readonly { readonly a: string; readonly b: string; readonly contradicts: boolean }[],
): ContradictionResult {
  let detected = 0;
  for (const pair of pairs) {
    const got = isContradiction(pair.a, pair.b);
    if (got === pair.contradicts) detected += 1;
  }
  return {
    pairs: pairs.length,
    detected,
    detectionRate: pairs.length === 0 ? 0 : detected / pairs.length,
  };
}

export function runHarmExperiment(corpus: ExperimentCorpus): HarmResult {
  let harmfulRetrieved = 0;
  let totalRetrieved = 0;

  for (const task of corpus.tasks) {
    const results = retrieveMemories(corpus.claims, {
      query: task.query,
      scope: corpus.scope,
      now: corpus.now,
      limit: 5,
      revalidation: corpus.revalidation,
      requireProvenance: true,
    });
    totalRetrieved += results.length;
    for (const r of results) {
      if (task.harmfulClaimIds.includes(r.claim.id)) harmfulRetrieved += 1;
    }
  }

  return {
    harmfulRetrieved,
    totalRetrieved,
    harmfulRetrievalRate: totalRetrieved === 0 ? 0 : harmfulRetrieved / totalRetrieved,
  };
}

export function runProvenanceExperiment(claims: readonly MemoryClaim[]): ProvenanceResult {
  const complete = claims.filter((c) => hasCompleteProvenance(c)).length;
  return {
    total: claims.length,
    complete,
    completeRate: claims.length === 0 ? 0 : complete / claims.length,
  };
}

export function runAllExperiments(
  corpus: ExperimentCorpus,
  contradictionPairs: readonly {
    readonly a: string;
    readonly b: string;
    readonly contradicts: boolean;
  }[],
): ExperimentReport {
  return {
    precision: runPrecisionExperiment(corpus),
    utility: runUtilityExperiment(corpus),
    stale: runStaleMemoryExperiment(corpus),
    contradiction: runContradictionExperiment(contradictionPairs),
    harm: runHarmExperiment(corpus),
    provenance: runProvenanceExperiment(corpus.claims),
  };
}

/** Helper for curator relation checks in experiments. */
export function experimentRelate(a: MemoryClaim, b: MemoryClaim) {
  return relateClaims(a, b);
}

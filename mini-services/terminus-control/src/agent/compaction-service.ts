/**
 * Compaction service (R4, harness critical path).
 *
 * The live loop previously ran with compaction disabled and a fixed
 * 16-episode window: long turns hit the step budget with no way to shed
 * history. This module implements the two-stage strategy used by the
 * leading harnesses (Hermes' documented pipeline; Claude Code's
 * "lightest-touch first" guidance):
 *
 *  1. Deterministic prune planning — no LLM call. The oldest complete
 *     tool_call/result pairs beyond the keep-recent budget become candidates;
 *     no row is hidden until a recoverable summary is ready.
 *  2. Structured summary — one dedicated LLM turn over the pruned content,
 *     rendered WITHOUT cache-control writes (one-off summaries are never
 *     reused, so caching them only pollutes the stable prefix).
 *
 * Invariants (context-compiler AGENTS.md):
 *  - Episode pairing: a tool_call and its settled result are pruned or kept
 *    together, never split.
 *  - Pruned content stays recoverable: the summary lists each pruned
 *    artifact reference before any source row is hidden.
 */

import { z } from "zod";
import { canonicalJson, computeContentHash } from "@terminus/context-ir";

/** Approximate UTF-8 bytes-per-token factor for window arithmetic. */
export const BYTES_PER_TOKEN_ESTIMATE = 4;

export const DEFAULT_COMPACT_THRESHOLD_TOKENS = 96_000;
export const DEFAULT_KEEP_RECENT_TOKENS = 24_000;

/** Maximum source transcript accepted by the dedicated summarizer. */
export const MAX_COMPACTION_TRANSCRIPT_CHARS = 400_000;

/** Maximum model-visible size of a persisted compaction summary. */
export const MAX_COMPACTION_SUMMARY_CHARS = 64_000;
export const COMPACTION_SUMMARY_VERSION = "terminus.compaction-summary.v1" as const;
export const COMPACTION_RECALL_VERSION = "terminus.compaction-recall.v1" as const;
const IMMUTABLE_ARTIFACT_URI = /^artifact:\/\/sha256\/[0-9a-f]{64}$/i;

export const SUMMARY_SYSTEM_INSTRUCTIONS = [
  "You compress a coding-agent working transcript into a handoff summary for the next attempt.",
  "Output EXACTLY these sections, terse, no preamble:",
  "",
  "GOAL: the task objective and success criteria; preserve constraints verbatim.",
  "CONSTRAINTS: scope limits, policies, user requirements still in force.",
  "PROGRESS: what was attempted and the outcome of each attempt, in order.",
  "KEY DECISIONS: choices made and WHY (files chosen, approaches rejected).",
  "FILES: files read or modified with their role in the task.",
  "NEXT STEPS: the single most useful next action, then fallbacks.",
  "CRITICAL CONTEXT: error strings, hashes, ids, and anchors needed to continue without re-reading.",
].join("\n");

export interface EpisodeLike {
  readonly id: string;
  readonly kind: string;
  readonly sequence: number;
  readonly toolCallId: string | null;
  /**
   * Serialized model-visible content, or null when only the durable size is
   * known (metadata-driven planning); `byteSize` then carries the weight.
   */
  readonly contentJson: string | null;
  /** Authoritative CAS size used when contentJson is null. */
  readonly byteSize?: number | undefined;
  /** Immutable source reference, when the body is not materialized here. */
  readonly contentArtifact?: string | null | undefined;
}

export interface PrunePlan {
  readonly keep: ReadonlySet<string>;
  readonly prune: ReadonlySet<string>;
  readonly retainedBytes: number;
  readonly prunedBytes: number;
}

export interface CompactionSourceReference {
  readonly episodeId: string;
  readonly sequence: number;
  readonly artifactRef: string;
}

export interface CompactionChunkSummary {
  readonly chunkId: string;
  readonly episodeIds: readonly string[];
  readonly summary: string;
}

export interface StructuredCompactionSummary {
  readonly schemaVersion: typeof COMPACTION_SUMMARY_VERSION;
  readonly goal: string;
  readonly constraints: readonly string[];
  readonly progress: readonly string[];
  readonly decisions: readonly string[];
  readonly files: readonly string[];
  readonly attempts: readonly string[];
  readonly unresolved: readonly string[];
  readonly hypotheses: readonly string[];
  readonly coverage: Readonly<Record<string, readonly string[]>>;
  readonly chunks: readonly CompactionChunkSummary[];
  readonly sourceEpisodes: readonly CompactionSourceReference[];
  readonly prunedBytes: number;
  readonly narrative: string;
}

export const structuredCompactionSummarySchema = z.object({
  schemaVersion: z.literal(COMPACTION_SUMMARY_VERSION),
  goal: z.string(),
  constraints: z.array(z.string()),
  progress: z.array(z.string()),
  decisions: z.array(z.string()),
  files: z.array(z.string()),
  attempts: z.array(z.string()),
  unresolved: z.array(z.string()),
  hypotheses: z.array(z.string()),
  coverage: z.record(z.string(), z.array(z.string())),
  chunks: z.array(z.object({
    chunkId: z.string().min(1),
    episodeIds: z.array(z.string().min(1)),
    summary: z.string().min(1),
  }).strict()),
  sourceEpisodes: z.array(z.object({
    episodeId: z.string().min(1),
    sequence: z.number().int().nonnegative(),
    artifactRef: z.string().min(1),
  }).strict()),
  prunedBytes: z.number().int().nonnegative(),
  narrative: z.string(),
}).strict();

export interface CompactionRecallRequest {
  readonly schemaVersion: typeof COMPACTION_RECALL_VERSION;
  readonly turnId: string;
  readonly summaryHash: string;
  readonly episodeIds: readonly string[];
  readonly query: string | null;
  readonly maxEpisodes: number;
  readonly continuation: string | null;
}

export interface CompactionRecallResult {
  readonly schemaVersion: typeof COMPACTION_RECALL_VERSION;
  readonly summaryHash: string;
  readonly episodes: readonly EpisodeLike[];
  readonly continuation: string | null;
}

export const compactionRecallRequestSchema = z.object({
  schemaVersion: z.literal(COMPACTION_RECALL_VERSION),
  turnId: z.string().min(1),
  summaryHash: z.string().min(1),
  episodeIds: z.array(z.string().min(1)),
  query: z.string().nullable().optional(),
  maxEpisodes: z.number().int().positive().max(10_000).optional(),
  continuation: z.string().nullable(),
}).strict();

function episodeBytes(episode: EpisodeLike): number {
  const bytes = episode.byteSize !== undefined && episode.byteSize !== null
    ? episode.byteSize
    : episode.contentJson === null ? 0 : new TextEncoder().encode(episode.contentJson).byteLength;
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new Error(`episode '${episode.id}' has an invalid byte size`);
  }
  return bytes;
}

function hasImmutableSource(episode: EpisodeLike): boolean {
  return episode.contentJson !== null
    && episode.contentArtifact !== undefined
    && episode.contentArtifact !== null
    && IMMUTABLE_ARTIFACT_URI.test(episode.contentArtifact);
}

/**
 * Deterministic prune selection over oldest-to-newest episodes. Walk
 * backwards accumulating the keep-recent byte budget; older content rows
 * become prune candidates, but only as COMPLETE tool pairs — a kept half
 * drags its partner into the keep set.
 */
export function planDeterministicPrune(
  episodes: readonly EpisodeLike[],
  keepRecentBytes: number,
): PrunePlan {
  if (!Number.isSafeInteger(keepRecentBytes) || keepRecentBytes < 0) {
    throw new Error("keepRecentBytes must be a non-negative safe integer");
  }
  const orderedEpisodes = [...episodes].sort(
    (a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id),
  );
  const partnerOf = new Map<string, string>();
  const episodesById = new Map(orderedEpisodes.map((episode) => [episode.id, episode]));
  const pairsByCallId = new Map<string, { call: EpisodeLike | null; result: EpisodeLike | null }>();
  for (const episode of orderedEpisodes) {
    if ((episode.kind !== "tool_call" && episode.kind !== "tool_result") || episode.toolCallId === null) continue;
    const pair = pairsByCallId.get(episode.toolCallId) ?? { call: null, result: null };
    if (episode.kind === "tool_call") {
      if (pair.call !== null) throw new Error(`duplicate tool call id '${episode.toolCallId}'`);
      pair.call = episode;
    } else {
      if (pair.result !== null) throw new Error(`duplicate tool result id '${episode.toolCallId}'`);
      pair.result = episode;
    }
    pairsByCallId.set(episode.toolCallId, pair);
  }
  for (const pair of pairsByCallId.values()) {
    if (pair.call !== null && pair.result !== null) {
      partnerOf.set(pair.call.id, pair.result.id);
      partnerOf.set(pair.result.id, pair.call.id);
    }
  }

  const keep = new Set<string>();
  let accumulated = 0;
  for (let index = orderedEpisodes.length - 1; index >= 0; index -= 1) {
    const episode = orderedEpisodes[index]!;
    const bytes = episodeBytes(episode);
    // The newest row is always kept so the window is never empty. After
    // that, a row is kept only while it fits the remaining budget.
    if (keep.size > 0 && accumulated + bytes > keepRecentBytes) break;
    keep.add(episode.id);
    accumulated += bytes;
  }

  // Pair closure: kept halves force their partners to stay.
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of [...keep]) {
      const partner = partnerOf.get(id);
      if (partner !== undefined && !keep.has(partner)) {
        const partnerEpisode = episodesById.get(partner);
        if (partnerEpisode !== undefined) accumulated += episodeBytes(partnerEpisode);
        keep.add(partner);
        changed = true;
      }
    }
  }

  const prune = new Set<string>();
  let prunedBytes = 0;
  let retainedBytes = 0;
  for (const episode of orderedEpisodes) {
    const bytes = episodeBytes(episode);
    if (episode.contentJson === null && episode.byteSize === undefined) {
      // True reference-only rows carry nothing model-visible; keep them.
      continue;
    }
    if (keep.has(episode.id)) {
      retainedBytes += bytes;
      continue;
    }
    const partner = partnerOf.get(episode.id);
    if (episode.kind === "tool_call" && episode.toolCallId !== null && partner === undefined) {
      // An incomplete pair is not safe to fold: retaining it is cheaper than
      // creating an orphaned tool trace that cannot be reconstructed.
      keep.add(episode.id);
      retainedBytes += bytes;
      continue;
    }
    if (partner !== undefined && keep.has(partner)) {
      keep.add(episode.id);
      retainedBytes += bytes;
      continue;
    }
    prune.add(episode.id);
    prunedBytes += bytes;
  }
  return { keep, prune, retainedBytes, prunedBytes };
}

export interface CompactionStore {
  /**
   * Legacy split-effect methods remain in the type for old composition roots,
   * but `runCompaction` never calls them. Production compaction requires the
   * transaction below.
   */
  readonly hideEpisodes?: (ids: readonly string[]) => Promise<void>;
  readonly appendSummaryEpisode?: (input: {
    readonly turnId: string;
    readonly sequence: number;
    readonly summaryText: string;
  }) => Promise<void>;
  readonly latestSequence?: (turnId: string) => Promise<number | null>;
  /**
   * Atomically creates the summary and hides every source row. A store that
   * cannot provide this boundary must refuse compaction rather than create a
   * lossy intermediate state.
   */
  readonly commitCompaction?: (input: {
    readonly turnId: string;
    readonly summaryText: string;
    readonly summary: StructuredCompactionSummary;
    readonly summaryHash: string;
    readonly prunedEpisodeIds: readonly string[];
  }) => Promise<void>;
  /** Optional durable expansion of a summary back to exact source episodes. */
  readonly recallCompaction?: (input: CompactionRecallRequest) => Promise<CompactionRecallResult>;
}

export type Summarizer = (input: { readonly transcript: string; readonly signal?: AbortSignal | null }) => Promise<string>;

export interface CompactionInput {
  readonly turnId: string;
  readonly episodes: readonly EpisodeLike[];
  readonly totalBytes: number;
  readonly compactThresholdTokens?: number;
  readonly keepRecentTokens?: number;
  readonly summarizer?: Summarizer | null;
  /** Cancellation for the dedicated summarizer call. */
  readonly signal?: AbortSignal | null;
  /** Current task objective, if available for the structured summary. */
  readonly goal?: string | undefined;
  readonly constraints?: readonly string[] | undefined;
  readonly hypothesisId?: string | null | undefined;
}

export interface CompactionReport {
  readonly triggered: boolean;
  readonly prunedCount: number;
  readonly prunedBytes: number;
  readonly summaryChars: number;
  readonly reason:
    | "below_threshold"
    | "insufficient_source"
    | "source_too_large"
    | "summary_too_large"
    | "no_summarizer"
    | "transaction_unavailable"
    | "summary_failed"
    | "compacted";
  /** Stable failure category. Do not put provider or source text in telemetry. */
  readonly failureCode?:
    | "source_unavailable"
    | "source_too_large"
    | "summary_too_large"
    | "summarizer_unavailable"
    | "summarizer_failed"
    | "transaction_unavailable";
  readonly summaryHash?: string | null;
  readonly summary?: StructuredCompactionSummary | null;
}

function sectionBody(summary: string, label: string): string {
  const match = summary.match(new RegExp(`(?:^|\\n)${label}:\\s*([^\\n]*)`, "i"));
  return match?.[1]?.trim() ?? "";
}

function sectionList(summary: string, label: string): readonly string[] {
  const start = summary.search(new RegExp(`(?:^|\\n)${label}:`, "i"));
  if (start < 0) return [];
  const body = summary.slice(start).split(/\n(?=[A-Z][A-Z _-]*:)/)[0] ?? "";
  return body
    .replace(new RegExp(`^[^:]+:`, "i"), "")
    .split(/\n|;|•/)
    .map((item) => item.replace(/^[-*]\s*/, "").trim())
    .filter((item) => item.length > 0);
}

interface CompactionTranscriptChunk {
  readonly chunkId: string;
  readonly episodeIds: readonly string[];
  readonly transcript: string;
}

function episodeTranscript(episode: EpisodeLike, part?: { readonly index: number; readonly count: number }): string {
  const partLabel = part === undefined ? "" : ` part=${part.index}/${part.count}`;
  const source = episode.contentArtifact === undefined || episode.contentArtifact === null
    ? ""
    : `\nSOURCE_ARTIFACT: ${episode.contentArtifact}`;
  return `--- episode ${episode.sequence} id=${episode.id} (${episode.kind})${partLabel} ---${source}\n${episode.contentJson ?? ""}`;
}

/** Split only at deterministic episode/content boundaries; never elide source. */
function buildCompactionTranscriptChunks(
  episodes: readonly EpisodeLike[],
  prune: ReadonlySet<string>,
  maxChars: number,
): readonly CompactionTranscriptChunk[] {
  const pieces: Array<{ readonly episodeId: string; readonly text: string }> = [];
  const ordered = episodes
    .filter((episode) => prune.has(episode.id))
    .sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id));
  for (const episode of ordered) {
    const content = episode.contentJson ?? "";
    const header = episodeTranscript({ ...episode, contentJson: "" }).replace(/\n$/, "");
    // Leave room for a deterministic part label on split episodes.
    const room = maxChars - header.length - 64;
    if (room <= 0) throw new Error("compaction transcript limit is smaller than its source header");
    const partCount = Math.max(1, Math.ceil(content.length / room));
    for (let partIndex = 0; partIndex < partCount; partIndex += 1) {
      const start = partIndex * room;
      const partContent = content.slice(start, start + room);
      const text = episodeTranscript(
        { ...episode, contentJson: partContent },
        partCount === 1 ? undefined : { index: partIndex + 1, count: partCount },
      );
      pieces.push({ episodeId: episode.id, text });
    }
  }

  const chunks: CompactionTranscriptChunk[] = [];
  let currentText = "";
  let currentEpisodeIds: string[] = [];
  const flush = (): void => {
    if (currentText.length === 0) return;
    chunks.push({
      chunkId: `chunk-${String(chunks.length + 1).padStart(6, "0")}`,
      episodeIds: [...new Set(currentEpisodeIds)],
      transcript: currentText,
    });
    currentText = "";
    currentEpisodeIds = [];
  };
  for (const piece of pieces) {
    if (currentText.length > 0 && currentText.length + 2 + piece.text.length > maxChars) flush();
    if (piece.text.length > maxChars) throw new Error("compaction source piece exceeds transcript limit");
    currentText = currentText.length === 0 ? piece.text : `${currentText}\n\n${piece.text}`;
    currentEpisodeIds.push(piece.episodeId);
  }
  flush();
  return chunks;
}

/** Build a validated, deterministic summary wrapper around model prose. */
export function structureCompactionSummary(input: {
  readonly summary: string;
  readonly sourceEpisodes: readonly CompactionSourceReference[];
  readonly chunks?: readonly CompactionChunkSummary[] | undefined;
  readonly prunedBytes: number;
  readonly goal?: string | undefined;
  readonly constraints?: readonly string[] | undefined;
  readonly hypothesisId?: string | null | undefined;
}): StructuredCompactionSummary {
  const sourceEpisodes = [...input.sourceEpisodes].sort(
    (a, b) => a.sequence - b.sequence || a.episodeId.localeCompare(b.episodeId),
  );
  const goal = sectionBody(input.summary, "GOAL") || input.goal || "Goal not supplied";
  const parsedConstraints = sectionList(input.summary, "CONSTRAINTS");
  const constraints = [...new Set([...(input.constraints ?? []), ...parsedConstraints])].sort();
  const progress = sectionList(input.summary, "PROGRESS");
  const decisions = sectionList(input.summary, "KEY DECISIONS");
  const files = sectionList(input.summary, "FILES");
  const attempts = sectionList(input.summary, "ATTEMPTS");
  const unresolved = [
    ...sectionList(input.summary, "NEXT STEPS"),
    ...sectionList(input.summary, "CRITICAL CONTEXT"),
  ];
  const hypotheses = input.hypothesisId === undefined || input.hypothesisId === null
    ? []
    : [input.hypothesisId];
  const chunks = [...(input.chunks ?? [])]
    .sort((a, b) => a.chunkId.localeCompare(b.chunkId))
    .map((chunk) => ({
      chunkId: chunk.chunkId,
      episodeIds: [...new Set(chunk.episodeIds)].sort(),
      summary: chunk.summary.trim(),
    }))
    .filter((chunk) => chunk.summary.length > 0);
  const coverage = Object.fromEntries(
    sourceEpisodes.map((source) => [source.episodeId, [source.artifactRef]]),
  );
  return structuredCompactionSummarySchema.parse({
    schemaVersion: COMPACTION_SUMMARY_VERSION,
    goal,
    constraints,
    progress,
    decisions,
    files,
    attempts,
    unresolved,
    hypotheses,
    coverage,
    chunks,
    sourceEpisodes,
    prunedBytes: input.prunedBytes,
    narrative: input.summary.trim(),
  });
}

/** A compact summary hash is the durable key for later exact recall. */
export function buildCompactionRecallRequest(input: {
  readonly turnId: string;
  readonly summary: StructuredCompactionSummary;
  readonly summaryHash?: string | undefined;
  readonly query?: string | null | undefined;
  readonly maxEpisodes?: number | undefined;
  readonly continuation?: string | null | undefined;
}): CompactionRecallRequest {
  const summaryHash = input.summaryHash
    ?? computeContentHash(canonicalJson(input.summary));
  return {
    schemaVersion: COMPACTION_RECALL_VERSION,
    turnId: input.turnId,
    summaryHash,
    episodeIds: input.summary.sourceEpisodes.map((source) => source.episodeId),
    query: input.query ?? null,
    maxEpisodes: input.maxEpisodes ?? 100,
    continuation: input.continuation ?? null,
  };
}

/** Validate and execute an exact recall request against the durable store. */
export async function runCompactionRecall(
  store: CompactionStore,
  request: CompactionRecallRequest,
): Promise<CompactionRecallResult> {
  const parsed = compactionRecallRequestSchema.parse(request);
  if (store.recallCompaction === undefined) {
    throw new Error("compaction recall is unavailable for this store");
  }
  const result = await store.recallCompaction({
    ...parsed,
    query: parsed.query ?? null,
    maxEpisodes: parsed.maxEpisodes ?? 100,
  });
  if (result.schemaVersion !== COMPACTION_RECALL_VERSION) {
    throw new Error("compaction recall returned an unsupported schema version");
  }
  if (result.summaryHash !== parsed.summaryHash) {
    throw new Error("compaction recall returned a mismatched summary hash");
  }
  if (result.episodes.length > (parsed.maxEpisodes ?? 100)) {
    throw new Error("compaction recall exceeded its episode limit");
  }
  if (parsed.query === null && parsed.episodeIds.length > 0) {
    const requested = new Set(parsed.episodeIds);
    const returned = new Set(result.episodes.map((episode) => episode.id));
    for (const id of requested) {
      if (!returned.has(id)) throw new Error(`compaction recall omitted requested episode ${id}`);
    }
  }
  return result;
}

/**
 * Run one compaction pass. Pure orchestration: all effects go through the
 * injected store and summarizer, so this is unit-testable without a kernel.
 *
 * When no summarizer is configured, the pass is a no-op. Hiding source rows
 * without a durable summary would make the next provider request lossy.
 */
export async function runCompaction(
  store: CompactionStore,
  input: CompactionInput,
): Promise<CompactionReport> {
  const thresholdTokens = input.compactThresholdTokens ?? DEFAULT_COMPACT_THRESHOLD_TOKENS;
  const thresholdBytes = thresholdTokens * BYTES_PER_TOKEN_ESTIMATE;
  if (input.totalBytes <= thresholdBytes) {
    return { triggered: false, prunedCount: 0, prunedBytes: 0, summaryChars: 0, reason: "below_threshold" };
  }
  const keepRecentBytes = (input.keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS) * BYTES_PER_TOKEN_ESTIMATE;
  const plan = planDeterministicPrune(input.episodes, keepRecentBytes);

  // Do not spend a source read or report a source failure when no summarizer
  // exists. More importantly, never turn a no-summarizer state into pruning.
  if (input.summarizer === undefined || input.summarizer === null) {
    return {
      triggered: false,
      prunedCount: 0,
      prunedBytes: 0,
      summaryChars: 0,
      reason: "no_summarizer",
      failureCode: "summarizer_unavailable",
    };
  }

  // A byte count is not a source record. The live control path may know the
  // CAS size without having the body or a safe way to cite it in a summary.
  // Keep every row visible until the caller supplies materialized content.
  const missingSourceForPrunedEpisode = input.episodes.some(
    (episode) => plan.prune.has(episode.id)
      && !hasImmutableSource(episode),
  );
  if (missingSourceForPrunedEpisode) {
    return {
      triggered: false,
      prunedCount: 0,
      prunedBytes: 0,
      summaryChars: 0,
      reason: "insufficient_source",
      failureCode: "source_unavailable",
    };
  }

  if (plan.prune.size === 0) {
    const hasUnmaterializedRows = input.episodes.some(
      (episode) => !hasImmutableSource(episode),
    );
    return hasUnmaterializedRows
      ? {
          triggered: false,
          prunedCount: 0,
          prunedBytes: 0,
          summaryChars: 0,
          reason: "insufficient_source",
          failureCode: "source_unavailable",
        }
      : {
          triggered: false,
          prunedCount: 0,
          prunedBytes: 0,
          summaryChars: 0,
          reason: "below_threshold",
        };
  }

  const sourceEpisodes = input.episodes
    .filter((episode) => plan.prune.has(episode.id))
    .sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id))
    .map((episode) => ({
      episodeId: episode.id,
      sequence: episode.sequence,
      artifactRef: episode.contentArtifact ?? `episode://${episode.id}`,
    }));
  const prunedEpisodeIds = sourceEpisodes.map((source) => source.episodeId);
  let chunks: readonly CompactionTranscriptChunk[];
  try {
    chunks = buildCompactionTranscriptChunks(
      input.episodes,
      plan.prune,
      MAX_COMPACTION_TRANSCRIPT_CHARS,
    );
  } catch {
    return {
      triggered: false,
      prunedCount: 0,
      prunedBytes: 0,
      summaryChars: 0,
      reason: "source_too_large",
      failureCode: "source_too_large",
    };
  }
  let summary: string;
  const chunkSummaries: CompactionChunkSummary[] = [];
  try {
    for (const chunk of chunks) {
      if (input.signal?.aborted === true) {
        return {
          triggered: false,
          prunedCount: 0,
          prunedBytes: 0,
          summaryChars: 0,
          reason: "summary_failed",
          failureCode: "summarizer_failed",
        };
      }
      const chunkSummary = await input.summarizer({
        transcript: chunk.transcript,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      if (chunkSummary.trim().length === 0) {
        return {
          triggered: false,
          prunedCount: 0,
          prunedBytes: 0,
          summaryChars: 0,
          reason: "summary_failed",
          failureCode: "summarizer_failed",
        };
      }
      chunkSummaries.push({
        chunkId: chunk.chunkId,
        episodeIds: chunk.episodeIds,
        summary: chunkSummary.trim(),
      });
    }
    summary = chunkSummaries.length === 1
      ? chunkSummaries[0]!.summary
      : chunkSummaries.map((chunk) => `CHUNK ${chunk.chunkId}:\n${chunk.summary}`).join("\n\n");
  } catch {
    return {
      triggered: false,
      prunedCount: 0,
      prunedBytes: 0,
      summaryChars: 0,
      reason: "summary_failed",
      failureCode: "summarizer_failed",
    };
  }
  const sourceIndex = input.episodes
    .filter((episode) => plan.prune.has(episode.id))
    .sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id))
    .map((episode) => {
      const artifact = episode.contentArtifact ?? `episode://${episode.id}`;
      return `- episode_id=${episode.id} sequence=${episode.sequence} artifact=${artifact}`;
    })
    .join("\n");
  const structuredSummary = structureCompactionSummary({
    summary,
    sourceEpisodes,
    chunks: chunkSummaries,
    prunedBytes: plan.prunedBytes,
    goal: input.goal,
    constraints: input.constraints,
    hypothesisId: input.hypothesisId,
  });
  const summaryText = [
    summary,
    `PRUNED_BYTES: ${plan.prunedBytes}`,
    "SOURCE_INDEX:",
    sourceIndex,
    "STRUCTURED_SUMMARY:",
    canonicalJson(structuredSummary),
  ].join("\n");
  if (summaryText.length > MAX_COMPACTION_SUMMARY_CHARS) {
    return {
      triggered: false,
      prunedCount: 0,
      prunedBytes: 0,
      summaryChars: 0,
      reason: "summary_too_large",
      failureCode: "summary_too_large",
    };
  }
  const summaryHash = computeContentHash(canonicalJson(structuredSummary));
  if (store.commitCompaction === undefined) {
    return {
      triggered: false,
      prunedCount: 0,
      prunedBytes: 0,
      summaryChars: 0,
      reason: "transaction_unavailable",
      failureCode: "transaction_unavailable",
      summaryHash: null,
      summary: null,
    };
  }
  await store.commitCompaction({
    turnId: input.turnId,
    summaryText,
    summary: structuredSummary,
    summaryHash,
    prunedEpisodeIds,
  });
  return {
    triggered: true,
    prunedCount: plan.prune.size,
    prunedBytes: plan.prunedBytes,
    summaryChars: summaryText.length,
    reason: "compacted",
    summaryHash,
    summary: structuredSummary,
  };
}

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

/** Approximate UTF-8 bytes-per-token factor for window arithmetic. */
export const BYTES_PER_TOKEN_ESTIMATE = 4;

export const DEFAULT_COMPACT_THRESHOLD_TOKENS = 96_000;
export const DEFAULT_KEEP_RECENT_TOKENS = 24_000;

/** Maximum source transcript accepted by the dedicated summarizer. */
export const MAX_COMPACTION_TRANSCRIPT_CHARS = 400_000;

/** Maximum model-visible size of a persisted compaction summary. */
export const MAX_COMPACTION_SUMMARY_CHARS = 64_000;

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

function episodeBytes(episode: EpisodeLike): number {
  if (episode.byteSize !== undefined && episode.byteSize !== null) return episode.byteSize;
  return episode.contentJson === null ? 0 : new TextEncoder().encode(episode.contentJson).byteLength;
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
  const partnerOf = new Map<string, string>();
  for (const episode of episodes) {
    if ((episode.kind !== "tool_call" && episode.kind !== "tool_result") || episode.toolCallId === null) continue;
    const partner = episodes.find(
      (candidate) =>
        candidate.id !== episode.id &&
        candidate.toolCallId === episode.toolCallId &&
        (candidate.kind === "tool_call" || candidate.kind === "tool_result"),
    );
    if (partner !== undefined) partnerOf.set(episode.id, partner.id);
  }

  const keep = new Set<string>();
  let accumulated = 0;
  for (let index = episodes.length - 1; index >= 0; index -= 1) {
    const episode = episodes[index]!;
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
        const partnerEpisode = episodes.find((episode) => episode.id === partner);
        if (partnerEpisode !== undefined) accumulated += episodeBytes(partnerEpisode);
        keep.add(partner);
        changed = true;
      }
    }
  }

  const prune = new Set<string>();
  let prunedBytes = 0;
  let retainedBytes = 0;
  for (const episode of episodes) {
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
  /** Flip rows out of every future model-visible window. */
  readonly hideEpisodes: (ids: readonly string[]) => Promise<void>;
  /** Append the summary row as a model-visible episode. */
  readonly appendSummaryEpisode: (input: { readonly turnId: string; readonly sequence: number; readonly summaryText: string }) => Promise<void>;
  readonly latestSequence: (turnId: string) => Promise<number | null>;
  /**
   * Production stores should implement this as one DB transaction: create
   * the summary row and hide its source rows together. The individual methods
   * remain for small adapters and older test stores.
   */
  readonly commitCompaction?: (input: {
    readonly turnId: string;
    readonly summaryText: string;
    readonly prunedEpisodeIds: readonly string[];
  }) => Promise<void>;
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
    | "summary_failed"
    | "compacted";
  /** Stable failure category. Do not put provider or source text in telemetry. */
  readonly failureCode?:
    | "source_unavailable"
    | "source_too_large"
    | "summary_too_large"
    | "summarizer_unavailable"
    | "summarizer_failed";
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
  const prunedEpisodeIds = [...plan.prune];
  const missingSourceForPrunedEpisode = input.episodes.some(
    (episode) => plan.prune.has(episode.id)
      && (episode.contentJson === null || episode.contentArtifact === undefined || episode.contentArtifact === null),
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
      (episode) => episode.contentJson === null
        || episode.contentArtifact === undefined
        || episode.contentArtifact === null,
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

  let summaryChars = 0;
  const prunedTranscript = input.episodes
    .filter((episode) => plan.prune.has(episode.id))
    .map((episode) => {
      const source = episode.contentArtifact === undefined || episode.contentArtifact === null
        ? ""
        : `\nSOURCE_ARTIFACT: ${episode.contentArtifact}`;
      return `--- episode ${episode.sequence} id=${episode.id} (${episode.kind}) ---${source}\n${episode.contentJson}`;
    })
    .join("\n\n");
  if (prunedTranscript.length > MAX_COMPACTION_TRANSCRIPT_CHARS) {
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
  try {
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
    summary = await input.summarizer({
      transcript: prunedTranscript,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
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
  if (summary.trim().length === 0) {
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
    .map((episode) => {
      const artifact = episode.contentArtifact ?? "unavailable";
      return `- episode_id=${episode.id} sequence=${episode.sequence} artifact=${artifact}`;
    })
    .join("\n");
  const summaryText = [
    summary,
    `PRUNED_BYTES: ${plan.prunedBytes}`,
    "SOURCE_INDEX:",
    sourceIndex,
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
  if (store.commitCompaction !== undefined) {
    await store.commitCompaction({
      turnId: input.turnId,
      summaryText,
      prunedEpisodeIds,
    });
  } else {
    const latest = await store.latestSequence(input.turnId);
    await store.appendSummaryEpisode({
      turnId: input.turnId,
      sequence: (latest ?? 0) + 1,
      summaryText,
    });
    await store.hideEpisodes(prunedEpisodeIds);
  }
  summaryChars = summaryText.length;

  return {
    triggered: true,
    prunedCount: plan.prune.size,
    prunedBytes: plan.prunedBytes,
    summaryChars,
    reason: "compacted",
  };
}

/**
 * Compaction service (R4, harness critical path).
 *
 * The live loop previously ran with compaction disabled and a fixed
 * 16-episode window: long turns hit the step budget with no way to shed
 * history. This module implements the two-stage strategy used by the
 * leading harnesses (Hermes' documented pipeline; Claude Code's
 * "lightest-touch first" guidance):
 *
 *  1. Deterministic prune — no LLM call. The oldest complete tool_call/
 *     result pairs beyond the keep-recent budget lose their model-visible
 *     payload; the durable artifact stays linked so detail remains
 *     recoverable by reference.
 *  2. Structured summary — one dedicated LLM turn over the pruned content,
 *     rendered WITHOUT cache-control writes (one-off summaries are never
 *     reused, so caching them only pollutes the stable prefix).
 *
 * Invariants (context-compiler AGENTS.md):
 *  - Episode pairing: a tool_call and its settled result are pruned or kept
 *    together, never split.
 *  - Pruned content stays recoverable: the summary lists each pruned
 *    artifact hash.
 */

/** Approximate UTF-8 bytes-per-token factor for window arithmetic. */
export const BYTES_PER_TOKEN_ESTIMATE = 4;

export const DEFAULT_COMPACT_THRESHOLD_TOKENS = 96_000;
export const DEFAULT_KEEP_RECENT_TOKENS = 24_000;

/** Summary output cap; longer summaries are truncated server-side. */
export const SUMMARY_MAX_CHARS = 12_000;

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
  /** Serialized model-visible content, or null for reference-only rows. */
  readonly contentJson: string | null;
}

export interface PrunePlan {
  readonly keep: ReadonlySet<string>;
  readonly prune: ReadonlySet<string>;
  readonly retainedBytes: number;
  readonly prunedBytes: number;
}

function episodeBytes(episode: EpisodeLike): number {
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
    if (episode.contentJson === null) {
      // Reference-only rows carry nothing model-visible; keep them.
      retainedBytes += 0;
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
}

export type Summarizer = (input: { readonly transcript: string; readonly signal?: AbortSignal | null }) => Promise<string>;

export interface CompactionInput {
  readonly turnId: string;
  readonly episodes: readonly EpisodeLike[];
  readonly totalBytes: number;
  readonly compactThresholdTokens?: number;
  readonly keepRecentTokens?: number;
  readonly summarizer?: Summarizer | null;
}

export interface CompactionReport {
  readonly triggered: boolean;
  readonly prunedCount: number;
  readonly prunedBytes: number;
  readonly summaryChars: number;
  readonly reason: "below_threshold" | "no_summarizer_deterministic_only" | "compacted";
}

/**
 * Run one compaction pass. Pure orchestration: all effects go through the
 * injected store and summarizer, so this is unit-testable without a kernel.
 *
 * When no summarizer is configured the deterministic prune still runs (it is
 * safe and cheap); the report states that no LLM summary was produced rather
 * than pretending one was.
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

  let summaryChars = 0;
  if (plan.prune.size > 0 && input.summarizer !== undefined && input.summarizer !== null) {
    const prunedTranscript = input.episodes
      .filter((episode) => plan.prune.has(episode.id))
      .map((episode) => `--- episode ${episode.sequence} (${episode.kind}) ---\n${episode.contentJson ?? ""}`)
      .join("\n\n");
    const summary = await input.summarizer({ transcript: prunedTranscript.slice(0, 400_000) });
    const boundedSummary = summary.length > SUMMARY_MAX_CHARS
      ? `${summary.slice(0, SUMMARY_MAX_CHARS)}\n…(summary truncated server-side)`
      : summary;
    const latest = await store.latestSequence(input.turnId);
    await store.appendSummaryEpisode({
      turnId: input.turnId,
      sequence: (latest ?? 0) + 1,
      summaryText: boundedSummary + (plan.prunedBytes > 0 ? `\nPRUNED_BYTES: ${plan.prunedBytes}` : ""),
    });
    summaryChars = boundedSummary.length;
  } else if (plan.prune.size === 0) {
    return { triggered: false, prunedCount: 0, prunedBytes: 0, summaryChars: 0, reason: "below_threshold" };
  }

  if (plan.prune.size > 0) {
    await store.hideEpisodes([...plan.prune]);
  }

  return {
    triggered: true,
    prunedCount: plan.prune.size,
    prunedBytes: plan.prunedBytes,
    summaryChars,
    reason: summaryChars > 0 ? "compacted" : "no_summarizer_deterministic_only",
  };
}

/**
 * Cross-turn continuity primitives (R5, harness critical path).
 *
 * The loop replayed no conversation across turns: a second user message
 * started from the authority stub plus a checkpoint if one had been
 * manually committed. Two mechanisms close that gap:
 *
 *  - recent-history world-state section: a deterministic, bounded excerpt of
 *    the previous completed turn (user input + final assistant text),
 *    injected whenever the current turn has no episodes yet;
 *  - automatic end-of-turn checkpoints so the existing
 *    latest-COMMITTED-checkpoint load path carries decisions forward.
 *
 * Both are deterministic (no extra LLM calls) and bounded.
 */

/** Hard caps for injected history excerpts (code points). */
export const USER_EXCERPT_MAX_CHARS = 2_000;
export const ASSISTANT_EXCERPT_MAX_CHARS = 4_000;

const TRUNCATION_SUFFIX = "…(truncated)";

/**
 * Bounded excerpt by Unicode code points. When truncation occurs the
 * explicit marker counts INSIDE the budget, so the result never exceeds
 * maxChars code points in total.
 */
export function excerpt(text: string | null | undefined, maxChars: number): string {
  if (!text) return "";
  const points = Array.from(text);
  if (points.length <= maxChars) return text;
  if (maxChars <= TRUNCATION_SUFFIX.length) {
    return points.slice(0, maxChars).join("");
  }
  return `${points.slice(0, maxChars - TRUNCATION_SUFFIX.length).join("")}${TRUNCATION_SUFFIX}`;
}

export interface PriorTurnFacts {
  readonly sequence: number;
  readonly userText: string;
  readonly assistantText: string;
  readonly completedAt: string | null;
}

export interface RecentHistorySection {
  readonly previous_turn: {
    readonly sequence: number;
    readonly user_excerpt: string;
    readonly assistant_excerpt: string;
    readonly completed_at: string | null;
  };
}

/** Pure assembler: turns prior-turn facts into the world-state section. */
export function buildRecentHistorySection(prior: PriorTurnFacts): RecentHistorySection {
  return {
    previous_turn: {
      sequence: prior.sequence,
      user_excerpt: excerpt(prior.userText, USER_EXCERPT_MAX_CHARS),
      assistant_excerpt: excerpt(prior.assistantText, ASSISTANT_EXCERPT_MAX_CHARS),
      completed_at: prior.completedAt,
    },
  };
}

/** True when this turn still has an empty model-visible window. */
export function shouldInjectRecentHistory(episodeCount: number): boolean {
  return episodeCount === 0;
}

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

/**
 * Share of the optional context target the prior-turn excerpt may claim.
 *
 * The old 6,000-character constant (2,000 user + 4,000 assistant) was ~1,650
 * tokens whatever the window was: a third of a 5k budget and 0.8% of a 200k
 * one. Cross-turn continuity should scale with the room available, so the
 * limit is derived from the compiler's own budget instead.
 */
export const RECENT_HISTORY_BUDGET_FRACTION = 0.02;

/** Floor and ceiling in tokens, so a tiny or enormous window stays sane. */
export const RECENT_HISTORY_MIN_TOKENS = 400;
export const RECENT_HISTORY_MAX_TOKENS = 6_000;

/** Bytes per token; matches the calibrated context-compiler estimator. */
const RECENT_HISTORY_BYTES_PER_TOKEN = 3.6;

export interface RecentHistoryLimits {
  readonly userMaxChars: number;
  readonly assistantMaxChars: number;
}

/**
 * Derive the prior-turn excerpt limits from the compiler's optional-context
 * budget. The assistant excerpt gets twice the user excerpt: the user's ask
 * is short and the assistant's answer carries the decisions worth replaying.
 */
export function recentHistoryExcerptLimits(
  optionalContextTargetTokens: number,
): RecentHistoryLimits {
  const target = Number.isFinite(optionalContextTargetTokens) && optionalContextTargetTokens > 0
    ? optionalContextTargetTokens
    : 0;
  const tokens = Math.min(
    RECENT_HISTORY_MAX_TOKENS,
    Math.max(RECENT_HISTORY_MIN_TOKENS, Math.round(target * RECENT_HISTORY_BUDGET_FRACTION)),
  );
  const chars = Math.floor(tokens * RECENT_HISTORY_BYTES_PER_TOKEN);
  return {
    userMaxChars: Math.max(1, Math.floor(chars / 3)),
    assistantMaxChars: Math.max(1, chars - Math.floor(chars / 3)),
  };
}

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
export function buildRecentHistorySection(
  prior: PriorTurnFacts,
  limits: RecentHistoryLimits = {
    userMaxChars: USER_EXCERPT_MAX_CHARS,
    assistantMaxChars: ASSISTANT_EXCERPT_MAX_CHARS,
  },
): RecentHistorySection {
  return {
    previous_turn: {
      sequence: prior.sequence,
      user_excerpt: excerpt(prior.userText, limits.userMaxChars),
      assistant_excerpt: excerpt(prior.assistantText, limits.assistantMaxChars),
      completed_at: prior.completedAt,
    },
  };
}

/**
 * Episode kinds that mean the model has already worked inside this turn.
 *
 * `user_message` is deliberately absent: admission creates one before the
 * first attempt is ever compiled, so it is present on every turn including
 * the first. `steering_message` is absent for the same reason — an operator
 * nudge is input, not progress.
 */
const TURN_PROGRESS_KINDS: ReadonlySet<string> = new Set([
  "model_message",
  "tool_call",
  "tool_result",
  "side_effect",
  "summary",
]);

/**
 * True when the model has not yet acted in this turn, so the prior turn's
 * excerpt is the only conversational context it would otherwise have.
 *
 * This used to gate on `episodes.length === 0`, which was never true: the
 * user's own message is written as an episode at admission, so the count is
 * at least 1 before the first compile and cross-turn history was never
 * injected once. The question is whether the *model* has produced anything
 * this turn, not whether the window is literally empty.
 */
export function shouldInjectRecentHistory(
  episodes: readonly { readonly kind: string }[],
): boolean {
  return !episodes.some((episode) => TURN_PROGRESS_KINDS.has(episode.kind));
}

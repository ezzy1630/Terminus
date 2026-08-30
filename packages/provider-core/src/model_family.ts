/**
 * @terminus/provider-core — model-family ceilings.
 *
 * Three places used to clamp every model's usable window to
 * `Math.min(contextTokens, 32_768)` and every response to 1024 output tokens:
 * the provider-account snapshot, the direct-provider snapshot and the gateway
 * snapshot. That is a 3% window on a 1M-context model and a hard truncation of
 * any real patch, so the numbers live here once, keyed on the model family,
 * and every snapshot builder calls the same resolver.
 *
 * The ceilings are per-family because the constraint is per-family:
 *
 *   - **GPT-5.6** advertises 1,050,000 tokens of context but bills the *whole*
 *     request at 2x input / 1.5x output once the prompt crosses 272,000 input
 *     tokens. The cliff is a pricing fact, not a capability fact, so the safe
 *     ceiling is 270,000 — the same number the Codex CLI settled on for
 *     `model_auto_compact_token_limit` (openai/codex#32486).
 *   - **Claude 5** (Opus 5, Fable 5, Sonnet 5, Mythos 5) has a 1M window as
 *     both the default and the maximum, with no long-context price premium.
 *     The catalogue limit is therefore the real limit.
 *   - **Everything else** keeps a 200,000-token ceiling: past that the models
 *     Terminus can reach are either untested at length or priced differently,
 *     and 200k is the largest window this harness has driven end to end.
 *
 * Nothing here is a guess about a model's identity: the family is read off the
 * model id, and an id that matches no family gets the conservative branch.
 */

/** The families whose ceilings differ from the conservative default. */
export type ModelFamily = "gpt-5.6" | "claude-5" | "other";

/** The 272K billing cliff, minus a margin for the reply's own preamble. */
export const GPT_5_6_CONTEXT_HARD_CAP = 270_000;

/** Claude 5's window when the catalogue does not report one. */
export const CLAUDE_5_CONTEXT_TOKENS = 1_000_000;

/** The ceiling for a model outside the two named families. */
export const DEFAULT_CONTEXT_CEILING = 200_000;

/** GPT-5.6 and Claude 5 both cap a single response at 128k tokens. */
export const FAMILY_MAX_OUTPUT_TOKENS = 128_000;

/** The output reserve for a model whose catalogue reports no output limit. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 32_768;

/**
 * Strip a routing prefix (`openai/gpt-5.6-sol`, `anthropic/claude-opus-5`) and
 * a provider-account qualifier so the family test sees the vendor's own slug.
 */
export function normalizeModelId(modelId: string): string {
  const trimmed = modelId.trim().toLowerCase();
  const slash = trimmed.lastIndexOf("/");
  return slash === -1 ? trimmed : trimmed.slice(slash + 1);
}

/**
 * `gpt-5.6`, `gpt-5.6-sol|terra|luna` and any dated snapshot of them. The alias
 * `gpt-5.6` resolves to Sol server-side; the tiers share every limit that
 * matters here, so they share one family.
 */
const GPT_5_6_PATTERN = /^gpt-5\.6(?:[-_].*)?$/;

/**
 * `claude-opus-5`, `claude-fable-5`, `claude-sonnet-5`, `claude-mythos-5` and
 * dated snapshots. Deliberately anchored on `-5` as a whole segment so
 * `claude-sonnet-4-5` (a 4.x model) does not match.
 */
const CLAUDE_5_PATTERN = /^claude-(?:opus|fable|sonnet|mythos|haiku)-5(?:[-_].*)?$/;

export function resolveModelFamily(modelId: string): ModelFamily {
  const id = normalizeModelId(modelId);
  if (GPT_5_6_PATTERN.test(id)) return "gpt-5.6";
  if (CLAUDE_5_PATTERN.test(id)) return "claude-5";
  return "other";
}

export interface ContextCeilingInput {
  readonly modelId: string;
  /** The catalogue's advertised context window. 0 means "not reported". */
  readonly contextTokens: number;
}

/**
 * The window Terminus will actually fill for this model.
 *
 * A catalogue that reports nothing (the Codex `/models` document reports no
 * output limit at all, and some gateway rows report no context either) falls
 * back to the family constant rather than to zero, because zero here means "no
 * optional context at all" downstream.
 */
export function resolveTestedSafeContextTokens(input: ContextCeilingInput): number {
  const advertised = Number.isFinite(input.contextTokens) && input.contextTokens > 0
    ? Math.floor(input.contextTokens)
    : 0;
  switch (resolveModelFamily(input.modelId)) {
    case "gpt-5.6":
      return advertised === 0
        ? GPT_5_6_CONTEXT_HARD_CAP
        : Math.min(advertised, GPT_5_6_CONTEXT_HARD_CAP);
    case "claude-5":
      return advertised === 0 ? CLAUDE_5_CONTEXT_TOKENS : advertised;
    case "other":
      // An unknown window stays unknown: inventing one would let the compiler
      // fill a context the endpoint may reject.
      return advertised === 0 ? 0 : Math.min(advertised, DEFAULT_CONTEXT_CEILING);
  }
}

export interface MaxOutputInput {
  readonly modelId: string;
  /** The catalogue's `limit.output`. 0 means "not reported". */
  readonly outputTokens: number;
}

/**
 * The `max_output_tokens` / `max_tokens` this model can be asked for.
 *
 * The previous hardcoded 1024 truncated any real patch mid-write, and the
 * engine then refused the truncated tool call — so a task could not complete
 * at all. Both current families answer 128k; anything else takes the
 * catalogue's own number, and a catalogue that reports none gets 32k, which is
 * large enough for a multi-file edit and small enough for a 200k window.
 */
export function resolveMaxOutputTokens(input: MaxOutputInput): number {
  const reported = Number.isFinite(input.outputTokens) && input.outputTokens > 0
    ? Math.floor(input.outputTokens)
    : 0;
  const family = resolveModelFamily(input.modelId);
  if (family === "gpt-5.6" || family === "claude-5") {
    return reported === 0 ? FAMILY_MAX_OUTPUT_TOKENS : Math.min(reported, FAMILY_MAX_OUTPUT_TOKENS);
  }
  return reported === 0 ? DEFAULT_MAX_OUTPUT_TOKENS : reported;
}

/**
 * Tokens held back for reasoning, by the effort the user selected.
 *
 * Both vendors now bill reasoning as output and neither exposes a hard
 * reasoning budget on a current model (Anthropic removed `budget_tokens`;
 * OpenAI never had one), so this reserve is *accounting*, not a wire value: it
 * is what the context compiler must not spend on prompt so the response has
 * room to think. The ladder is deliberately coarse.
 *
 * | effort | reserve | why |
 * |---|---|---|
 * | `low` | 4,096 | short chains; subagents and mechanical edits |
 * | `medium` | 16,384 | the OpenAI default effort |
 * | `high` | 32,768 | the Anthropic default effort; daily agentic coding |
 * | `xhigh` | 65,536 | preserve the former top-rung reserve while exposing the wire level exactly |
 * | `max` | 65,536 | maximum provider reasoning |
 * | `ultra` | 65,536 | distinct provider ultra mode when advertised |
 *
 * An unset effort takes the `medium` rung: the request will carry whichever
 * default the vendor applies, and reserving the middle rung neither starves a
 * high-effort turn nor throws away a third of a 270k window.
 */
export const REASONING_RESERVE_TOKENS_BY_EFFORT = {
  low: 4_096,
  medium: 16_384,
  high: 32_768,
  xhigh: 65_536,
  max: 65_536,
  ultra: 65_536,
} as const satisfies Record<"low" | "medium" | "high" | "xhigh" | "max" | "ultra", number>;

export const DEFAULT_REASONING_RESERVE_TOKENS = REASONING_RESERVE_TOKENS_BY_EFFORT.medium;

export function resolveReasoningReserveTokens(
  effort: "low" | "medium" | "high" | "xhigh" | "max" | "ultra" | null | undefined,
): number {
  if (effort === undefined || effort === null) return DEFAULT_REASONING_RESERVE_TOKENS;
  return REASONING_RESERVE_TOKENS_BY_EFFORT[effort];
}

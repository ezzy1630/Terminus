/**
 * Per-turn and per-attempt usage projection.
 *
 * The control plane recorded every one of these numbers on `provider_attempts`
 * and exposed none of them below task granularity, so the only way to answer
 * "what did this turn cost" from outside was to replay the semantic event log
 * and re-derive it from `turn.response_validating` payloads. That
 * reconstruction is a second implementation of an accounting rule, kept in a
 * different language, drifting on its own schedule — and it silently loses any
 * attempt whose event was pruned or whose payload shape changed.
 *
 * Token counts are BigInt columns, so they cross the wire as decimal strings,
 * matching `budget_ledger`. Durations are plain numbers: they are milliseconds
 * measured by the runtime, not ledger quantities.
 */

/** The wire shape of one usage record. */
export interface UsageWire {
  readonly input_tokens: string;
  readonly cached_input_tokens: string;
  readonly cache_write_tokens: string;
  readonly output_tokens: string;
  readonly reasoning_tokens: string;
  readonly tool_schema_tokens: string;
  readonly latency_ms: number | null;
  readonly time_to_first_token_ms: number | null;
}

const TOKEN_FIELDS = [
  ["input_tokens", "inputTokens"],
  ["cached_input_tokens", "cachedInputTokens"],
  ["cache_write_tokens", "cacheWriteTokens"],
  ["output_tokens", "outputTokens"],
  ["reasoning_tokens", "reasoningTokens"],
  ["tool_schema_tokens", "toolSchemaTokens"],
] as const;

/**
 * A recorded token count as a non-negative bigint.
 *
 * `usage_json` is written through `jsonSafe`, which renders bigints as
 * strings; older rows may hold numbers. Anything else — absent, negative,
 * fractional, NaN — is zero rather than a guess.
 */
function tokenCount(value: unknown): bigint {
  if (typeof value === "bigint") return value >= 0n ? value : 0n;
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : 0n;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  return 0n;
}

/** A recorded duration in milliseconds, or null when it was never measured. */
function durationMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  return null;
}

function usageRecord(usageJson: string | null | undefined): Record<string, unknown> {
  if (usageJson === null || usageJson === undefined || usageJson === "") return {};
  try {
    const parsed: unknown = JSON.parse(usageJson);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

/** Project one attempt's `usage_json` column. */
export function usageWire(usageJson: string | null | undefined): UsageWire {
  const raw = usageRecord(usageJson);
  const tokens = Object.fromEntries(
    TOKEN_FIELDS.map(([wire, field]) => [wire, tokenCount(raw[field] ?? raw[wire]).toString()]),
  ) as Record<(typeof TOKEN_FIELDS)[number][0], string>;
  return {
    ...tokens,
    latency_ms: durationMs(raw.latencyMs ?? raw.latency_ms),
    time_to_first_token_ms: durationMs(raw.timeToFirstTokenMs ?? raw.time_to_first_token_ms),
  };
}

/**
 * Sum the usage of every attempt in a turn.
 *
 * Tokens add. Durations do not: `latency_ms` is the total time spent waiting
 * on the provider across attempts, but time-to-first-token is a property of a
 * single dispatch, so the turn reports the *first* attempt that measured one —
 * which is what "how long until this turn started speaking" means.
 */
export function sumUsageWire(usages: readonly UsageWire[]): UsageWire {
  const totals = new Map<string, bigint>(TOKEN_FIELDS.map(([wire]) => [wire, 0n]));
  let latency: number | null = null;
  let firstToken: number | null = null;
  for (const usage of usages) {
    for (const [wire] of TOKEN_FIELDS) {
      totals.set(wire, totals.get(wire)! + tokenCount(usage[wire]));
    }
    if (usage.latency_ms !== null) latency = (latency ?? 0) + usage.latency_ms;
    if (firstToken === null) firstToken = usage.time_to_first_token_ms;
  }
  const tokens = Object.fromEntries(
    TOKEN_FIELDS.map(([wire]) => [wire, totals.get(wire)!.toString()]),
  ) as Record<(typeof TOKEN_FIELDS)[number][0], string>;
  return { ...tokens, latency_ms: latency, time_to_first_token_ms: firstToken };
}

export interface AttemptCostRow {
  readonly providerReportedCostMicros: bigint | null;
  readonly computedCostMicros: bigint | null;
  readonly costSource: string | null;
}

/**
 * The best available cost for one attempt.
 *
 * Provider-reported spend wins whenever it exists; otherwise the economics
 * computation stands, labelled by `cost_source` so a reader can tell a
 * measured number from a catalogue-derived one. `unavailable` yields null
 * rather than zero — a turn whose price is unknown did not cost nothing.
 */
export function attemptCostMicros(row: AttemptCostRow): bigint | null {
  if (row.costSource === "unavailable") return null;
  return row.providerReportedCostMicros ?? row.computedCostMicros;
}

/** Turn-level cost: the sum of every attempt that has one. Null when none do. */
export function sumAttemptCostMicros(rows: readonly AttemptCostRow[]): bigint | null {
  let total: bigint | null = null;
  for (const row of rows) {
    const cost = attemptCostMicros(row);
    if (cost === null) continue;
    total = (total ?? 0n) + cost;
  }
  return total;
}

/**
 * The turn's stop reason.
 *
 * A terminal error dominates the provider's finish reason: a turn that ended
 * for `budget_exhausted` is not described by `"stop"`. The order here is the
 * same one the eval harness had to reimplement over the event log.
 */
export function turnStopReason(input: {
  readonly state: string;
  readonly terminalError: unknown;
  readonly lastFinishReason: string | null;
}): string | null {
  const error = input.terminalError;
  if (typeof error === "object" && error !== null && !Array.isArray(error)) {
    const reason = (error as Record<string, unknown>).reason;
    if (typeof reason === "string" && reason !== "") return reason;
  }
  if (input.state === "COMPLETED" || input.state === "VERIFIED") {
    return input.lastFinishReason ?? "stop";
  }
  return input.lastFinishReason;
}

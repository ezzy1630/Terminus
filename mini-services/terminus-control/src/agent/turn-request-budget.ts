/**
 * Caller-supplied per-turn budgets.
 *
 * `POST /v1/turns` parsed its body with a bare cast, so a caller that sent a
 * `budget` got a 201 back and no budget at all: unknown keys were dropped in
 * silence, and the only budget a turn could have was the fixed one the server
 * writes into the task contract. An evaluation harness could therefore neither
 * bound a single turn nor discover that it had failed to.
 *
 * Two rules make the feature honest:
 *
 *   1. An unknown top-level key is a 400, not a shrug. A caller that misspells
 *      `max_tokens` learns immediately instead of being billed for a run it
 *      thought was capped.
 *   2. A budget is a *request*, not an entitlement. {@link mergeTurnBudget}
 *      takes the lower of the request and the task contract's own budget, and
 *      the hard step ceiling still binds above both.
 */

/** Every key `POST /v1/turns` accepts. Anything else is rejected. */
export const TURN_REQUEST_FIELDS: readonly string[] = [
  "thread_id",
  "task_id",
  "user_input",
  "model",
  "reasoning_effort",
  "provider_account_id",
  "budget",
];

const BUDGET_FIELDS: readonly string[] = ["max_steps", "max_tokens", "max_cost_micros"];

export interface TurnRequestBudget {
  readonly maxSteps: number | null;
  readonly maxTokens: bigint | null;
  readonly maxCostMicros: bigint | null;
}

export class TurnBudgetInvalidError extends Error {
  constructor(message: string, readonly field: string) {
    super(message);
    this.name = "TurnBudgetInvalidError";
  }
}

/** Top-level keys the caller sent that this route does not understand. */
export function unknownTurnRequestFields(body: unknown): readonly string[] {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return [];
  const known = new Set(TURN_REQUEST_FIELDS);
  return Object.keys(body as Record<string, unknown>).filter((key) => !known.has(key));
}

/**
 * A count that must be a positive whole number.
 *
 * Strings are accepted because every other token/cost number on this API is
 * BigInt-encoded as a string; rejecting the encoding the API itself uses would
 * be a trap. Floats are not: a fractional token budget is a mistake, not a
 * rounding opportunity.
 */
function positiveBigInt(value: unknown, field: string): bigint | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TurnBudgetInvalidError(`budget.${field} must be a positive whole number`, field);
    }
    return BigInt(value);
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = BigInt(value.trim());
    if (parsed <= 0n) {
      throw new TurnBudgetInvalidError(`budget.${field} must be a positive whole number`, field);
    }
    return parsed;
  }
  throw new TurnBudgetInvalidError(
    `budget.${field} must be a positive whole number, or that number as a decimal string`,
    field,
  );
}

export function parseTurnRequestBudget(value: unknown): TurnRequestBudget | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new TurnBudgetInvalidError("budget must be an object", "budget");
  }
  const raw = value as Record<string, unknown>;
  const known = new Set(BUDGET_FIELDS);
  const unknown = Object.keys(raw).filter((key) => !known.has(key));
  if (unknown.length > 0) {
    throw new TurnBudgetInvalidError(
      `budget has unknown fields: ${unknown.join(", ")}; accepted: ${BUDGET_FIELDS.join(", ")}`,
      "budget",
    );
  }
  const maxStepsBig = positiveBigInt(raw.max_steps, "max_steps");
  if (maxStepsBig !== null && maxStepsBig > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new TurnBudgetInvalidError("budget.max_steps is out of range", "max_steps");
  }
  const budget: TurnRequestBudget = {
    maxSteps: maxStepsBig === null ? null : Number(maxStepsBig),
    maxTokens: positiveBigInt(raw.max_tokens, "max_tokens"),
    maxCostMicros: positiveBigInt(raw.max_cost_micros, "max_cost_micros"),
  };
  if (budget.maxSteps === null && budget.maxTokens === null && budget.maxCostMicros === null) {
    throw new TurnBudgetInvalidError(
      `budget must set at least one of ${BUDGET_FIELDS.join(", ")}`,
      "budget",
    );
  }
  return budget;
}

/** The persisted form, and the shape echoed back in the 201 body. */
export function turnRequestBudgetWire(budget: TurnRequestBudget | null): {
  readonly max_steps: number | null;
  readonly max_tokens: string | null;
  readonly max_cost_micros: string | null;
} | null {
  if (budget === null) return null;
  return {
    max_steps: budget.maxSteps,
    max_tokens: budget.maxTokens === null ? null : budget.maxTokens.toString(),
    max_cost_micros: budget.maxCostMicros === null ? null : budget.maxCostMicros.toString(),
  };
}

export function serializeTurnRequestBudget(budget: TurnRequestBudget | null): string | null {
  const wire = turnRequestBudgetWire(budget);
  return wire === null ? null : JSON.stringify(wire);
}

/**
 * Decode a persisted column. Tolerant: a row written by an older build must
 * mean "no per-turn budget", never a failed turn.
 */
export function parsePersistedTurnBudget(json: string | null | undefined): TurnRequestBudget | null {
  if (json === null || json === undefined || json === "") return null;
  try {
    return parseTurnRequestBudget(JSON.parse(json));
  } catch {
    return null;
  }
}

/**
 * Apply a turn budget on top of the task's.
 *
 * Always the lower of the two: a per-turn budget may tighten what the task
 * contract allows and may never widen it, so a caller cannot raise a limit by
 * asking politely on a later turn.
 */
export function mergeTurnBudget<T extends bigint | number>(
  contractLimit: T | null,
  requested: T | null,
): T | null {
  if (requested === null) return contractLimit;
  if (contractLimit === null) return requested;
  return (requested < contractLimit ? requested : contractLimit);
}

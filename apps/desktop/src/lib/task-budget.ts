/**
 * What this task has spent, in a form a person can act on.
 *
 * The desktop had no cost readout and no context meter anywhere, so the two
 * questions users ask most often about a long-running agent — "how much is
 * this costing me" and "is it about to run out of context" — had no answer in
 * the interface at all. Both are already on the wire: `GET /v1/tasks/:id`
 * returns a `budget_ledger`.
 *
 * Counters arrive as decimal strings because token and micro-dollar totals can
 * exceed the safe integer range. They are parsed here, once, and a value that
 * cannot be represented exactly is reported as unknown rather than silently
 * rounded — an approximate spend figure is worse than no figure.
 */
import type { TaskBudgetLedger } from "../types";

export type BudgetTone = "normal" | "warning" | "critical";

export interface BudgetMetric {
  id: "cost" | "context" | "steps" | "tokens";
  label: string;
  /** Short form for the chip, e.g. "$0.42" or "68%". */
  value: string;
  /** The cap this is measured against, when there is one. */
  detail: string | null;
  /** 0–1 where a cap is known, otherwise null. */
  fraction: number | null;
  tone: BudgetTone;
}

const WARNING_FRACTION = 0.75;
const CRITICAL_FRACTION = 0.9;

/** Decimal strings only. Anything unparseable or unsafe reads as unknown. */
function parseCounter(value: string | null | undefined): number | null {
  if (value === null || value === undefined || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function toneFor(fraction: number | null): BudgetTone {
  if (fraction === null) return "normal";
  if (fraction >= CRITICAL_FRACTION) return "critical";
  if (fraction >= WARNING_FRACTION) return "warning";
  return "normal";
}

/**
 * Micro-dollars to a readable amount. Sub-cent spend keeps enough precision to
 * be a real number rather than a rounded-to-zero "$0.00", which would read as
 * "this was free".
 */
export function formatCostMicros(micros: number): string {
  const dollars = micros / 1_000_000;
  if (micros === 0) return "$0.00";
  if (dollars < 0.01) return `$${dollars.toFixed(4)}`;
  if (dollars < 1) return `$${dollars.toFixed(3)}`;
  return `$${dollars.toFixed(2)}`;
}

export function formatTokenCount(tokens: number): string {
  if (tokens < 1_000) return String(tokens);
  if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

/**
 * Every metric the ledger can support, in the order they matter. Metrics whose
 * inputs are missing are omitted rather than rendered as a zero or a dash.
 */
export function budgetMetrics(ledger: TaskBudgetLedger | null | undefined): BudgetMetric[] {
  if (!ledger) return [];
  const metrics: BudgetMetric[] = [];

  const costMicros = parseCounter(ledger.cost_micros);
  if (costMicros !== null) {
    const capMicros = parseCounter(ledger.max_cost_micros);
    const fraction = capMicros !== null && capMicros > 0 ? costMicros / capMicros : null;
    metrics.push({
      id: "cost",
      label: "Cost",
      value: formatCostMicros(costMicros),
      detail: capMicros === null ? null : `of ${formatCostMicros(capMicros)}`,
      fraction,
      tone: toneFor(fraction),
    });
  }

  // Context is headroom, not cumulative usage: `tokens_used` sums every turn
  // in the task, while the window only holds the compiled context for the next
  // request. Reporting the first as the second would show 300% on a long task.
  const headroom = parseCounter(ledger.context_headroom_tokens);
  const windowTokens = parseCounter(ledger.max_tokens);
  if (headroom !== null && windowTokens !== null && windowTokens > 0) {
    const used = Math.max(0, windowTokens - headroom);
    const fraction = Math.min(1, used / windowTokens);
    metrics.push({
      id: "context",
      label: "Context",
      value: `${Math.round(fraction * 100)}%`,
      detail: `${formatTokenCount(headroom)} left of ${formatTokenCount(windowTokens)}`,
      fraction,
      tone: toneFor(fraction),
    });
  } else if (headroom !== null) {
    metrics.push({
      id: "context",
      label: "Context",
      value: `${formatTokenCount(headroom)} left`,
      detail: null,
      fraction: null,
      tone: "normal",
    });
  }

  if (ledger.max_steps > 0) {
    const fraction = Math.min(1, ledger.steps_used / ledger.max_steps);
    metrics.push({
      id: "steps",
      label: "Steps",
      value: `${ledger.steps_used}/${ledger.max_steps}`,
      detail: null,
      fraction,
      tone: toneFor(fraction),
    });
  }

  const tokensUsed = parseCounter(ledger.tokens_used);
  if (tokensUsed !== null) {
    metrics.push({
      id: "tokens",
      label: "Tokens",
      value: formatTokenCount(tokensUsed),
      detail: null,
      fraction: null,
      tone: "normal",
    });
  }

  return metrics;
}

/**
 * The one metric worth a permanent place in the composer.
 *
 * Whichever is loudest wins, so a context window filling up displaces the cost
 * readout exactly when it starts to matter. With nothing pressing, cost is the
 * default because it is the number people check unprompted.
 */
export function primaryBudgetMetric(ledger: TaskBudgetLedger | null | undefined): BudgetMetric | null {
  const metrics = budgetMetrics(ledger);
  if (metrics.length === 0) return null;
  const pressing = metrics
    .filter((metric) => metric.tone !== "normal")
    .sort((left, right) => (right.fraction ?? 0) - (left.fraction ?? 0))[0];
  return pressing ?? metrics.find((metric) => metric.id === "cost") ?? metrics[0] ?? null;
}

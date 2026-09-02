/**
 * TurnProjection service (Priority 3, SPEC §32).
 *
 * Derives public API state from durable turn rows, provider attempts,
 * and lifecycle states. Exposes explicit waiting and recovery information.
 */
import {
  sumAttemptCostMicros,
  sumUsageWire,
  turnStopReason,
  usageWire,
  type UsageWire,
  type AttemptCostRow,
} from "../turn-usage.js";
import {
  parsePersistedTurnBudget,
  turnRequestBudgetWire,
} from "../agent/turn-request-budget.js";
import type { TurnRow } from "./turn-coordinator.js";

export type TurnRequestBudgetWire = NonNullable<ReturnType<typeof turnRequestBudgetWire>>;
export interface TurnProjectionRow extends TurnRow {
  readonly requestedBudgetJson?: string | null | undefined;
  readonly terminalErrorJson?: string | null | undefined;
}

export interface ProviderAttemptProjectionRow extends AttemptCostRow {
  readonly id: string;
  readonly attemptNumber: number;
  readonly modelKey: string;
  readonly providerId: string;
  readonly status: string;
  readonly usageJson: string | null;
  readonly finishReason: string | null;
  readonly providerRequestId: string | null;
  readonly requestArtifact: string | null;
  readonly responseArtifact: string | null;
  readonly startedAt: Date;
  readonly completedAt: Date | null;
}

export interface TurnProjectionState {
  readonly waitingReason?: string | null | undefined;
  readonly recoveryPending?: boolean | undefined;
}

export interface PublicTurnProjection {
  readonly id: string;
  readonly thread_id: string;
  readonly task_id: string | null;
  readonly sequence: number;
  readonly state: string;
  readonly initiating_actor: string;
  readonly started_at: string | null;
  readonly completed_at: string | null;
  readonly model: string | null;
  readonly reasoning_effort: string | null;
  readonly selected_provider_account_id: string | null;
  readonly budget: TurnRequestBudgetWire | null;
  readonly usage: UsageWire;
  readonly cost_micros: string | null;
  readonly stop_reason: string | null;
  readonly terminal_error: unknown;
  readonly waiting_reason: string | null;
  readonly recovery_pending: boolean;
}

export interface PublicAttemptProjection {
  readonly provider_attempt_id: string;
  readonly attempt_number: number;
  readonly model: string;
  readonly provider_id: string;
  readonly status: string;
  readonly usage: UsageWire;
  readonly finish_reason: string | null;
  readonly provider_request_id: string | null;
  readonly provider_reported_cost_micros: string | null;
  readonly computed_cost_micros: string | null;
  readonly cost_source: string | null;
  readonly request_artifact: string | null;
  readonly response_artifact: string | null;
  readonly started_at: string;
  readonly completed_at: string | null;
}

export function deriveWaitingReason(
  state: string,
  extra?: TurnProjectionState,
): string | null {
  if (extra?.waitingReason !== undefined && extra.waitingReason !== null) {
    return extra.waitingReason;
  }
  if (extra?.recoveryPending === true) return "provider_reconciliation_required";
  switch (state) {
    case "PENDING":
      return "turn_pending";
    case "CONTEXT_COMPILING":
      return "compiling_context";
    case "PROVIDER_RUNNING":
      return "waiting_for_provider";
    case "RESPONSE_VALIDATING":
      return "validating_provider_response";
    case "TOOL_SETTLEMENT":
      return "settling_tool_effects";
    case "VERIFYING":
      return "verifying";
    case "REPAIR_PENDING":
      return "repair_pending";
    case "REPAIRING":
      return "repairing";
    case "VERIFIED":
      return "verification_complete";
    case "FINALIZING":
      return "finalizing";
    case "USER_ACTION_REQUIRED":
      return "waiting_for_user";
    case "ABORTING":
      return "aborting";
    default:
      return null;
  }
}

function terminalErrorRequiresReconciliation(terminalError: unknown): boolean {
  return typeof terminalError === "object"
    && terminalError !== null
    && !Array.isArray(terminalError)
    && (terminalError as Record<string, unknown>)["reconciliation_required"] === true;
}

export function projectTurn(
  turn: TurnProjectionRow,
  attempts: readonly ProviderAttemptProjectionRow[],
  extra?: TurnProjectionState,
): PublicTurnProjection {
  let terminalError: unknown = null;
  if (turn.terminalErrorJson !== null && turn.terminalErrorJson !== undefined && turn.terminalErrorJson !== "") {
    try {
      terminalError = JSON.parse(turn.terminalErrorJson);
    } catch {
      terminalError = turn.terminalErrorJson;
    }
  }

  const costMicros = sumAttemptCostMicros(attempts);
  const requestedBudget = parsePersistedTurnBudget(turn.requestedBudgetJson);
  const recoveryPending = extra?.recoveryPending
    ?? (turn.state === "INTERRUPTED" && terminalErrorRequiresReconciliation(terminalError));
  const waitingReason = deriveWaitingReason(turn.state, {
    ...extra,
    recoveryPending,
  });

  return {
    id: turn.id,
    thread_id: turn.threadId,
    task_id: turn.taskId,
    sequence: turn.sequence,
    state: turn.state,
    initiating_actor: turn.initiatingActor,
    started_at: turn.startedAt?.toISOString() ?? null,
    completed_at: turn.completedAt?.toISOString() ?? null,
    model: turn.selectedModel,
    reasoning_effort: turn.selectedReasoningEffort,
    selected_provider_account_id: turn.selectedProviderAccountId,
    budget: turnRequestBudgetWire(requestedBudget),
    usage: sumUsageWire(attempts.map((attempt) => usageWire(attempt.usageJson))),
    cost_micros: costMicros === null ? null : costMicros.toString(),
    stop_reason: turnStopReason({
      state: turn.state,
      terminalError,
      lastFinishReason: attempts[attempts.length - 1]?.finishReason ?? null,
    }),
    terminal_error: terminalError,
    waiting_reason: waitingReason,
    recovery_pending: recoveryPending,
  };
}

export function projectAttempts(
  attempts: readonly ProviderAttemptProjectionRow[],
): readonly PublicAttemptProjection[] {
  return attempts.map((attempt) => ({
    provider_attempt_id: attempt.id,
    attempt_number: attempt.attemptNumber,
    model: attempt.modelKey,
    provider_id: attempt.providerId,
    status: attempt.status,
    usage: usageWire(attempt.usageJson),
    finish_reason: attempt.finishReason,
    provider_request_id: attempt.providerRequestId,
    provider_reported_cost_micros: attempt.providerReportedCostMicros?.toString() ?? null,
    computed_cost_micros: attempt.computedCostMicros?.toString() ?? null,
    cost_source: attempt.costSource,
    request_artifact: attempt.requestArtifact,
    response_artifact: attempt.responseArtifact,
    started_at: attempt.startedAt.toISOString(),
    completed_at: attempt.completedAt?.toISOString() ?? null,
  }));
}

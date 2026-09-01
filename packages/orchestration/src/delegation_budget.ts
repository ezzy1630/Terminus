/**
 * Delegation budget reservation and cancellation propagation contracts.
 *
 * Reservations are local accounting. Settling a reservation does not spend a
 * provider budget or cancel a process; those effects remain behind their
 * existing kernel/runtime ports.
 */
import { BudgetExhaustedError, ValidationError } from "@terminus/domain";
import type { Budget, BudgetConsumption } from "./index.js";

export type CancellationPropagationKind =
  | "model_attempt"
  | "tool_call"
  | "job"
  | "process"
  | "worker"
  | "integration"
  | "external_effect";

export const CANCELLATION_PROPAGATION_LAYERS: readonly CancellationPropagationKind[] = Object.freeze([
  "model_attempt",
  "tool_call",
  "job",
  "process",
  "worker",
  "integration",
  "external_effect",
]);

const BUDGET_TYPES: readonly (keyof BudgetConsumption)[] = [
  "modelMicros",
  "computeSeconds",
  "wallClockSeconds",
  "humanApprovals",
];

export type CancellationPropagationReason =
  | "parent_cancelled"
  | "budget_exhausted"
  | "user_requested"
  | "policy_denied"
  | "worker_failed"
  | "delegation_cancelled";

export interface CancellationPropagationContract {
  readonly rootId: string;
  readonly parentId: string | null;
  readonly descendantIds: readonly string[];
  readonly reason: CancellationPropagationReason;
  readonly propagateTo: readonly CancellationPropagationKind[];
  readonly idempotent: true;
  readonly externalEffects: "reconcile";
}

export function createCancellationPropagationContract(input: {
  readonly rootId: string;
  readonly parentId: string | null;
  readonly descendantIds?: readonly string[];
  readonly reason: CancellationPropagationReason;
}): CancellationPropagationContract {
  if (input.rootId.trim().length === 0) {
    throw new ValidationError("cancellation root id is required");
  }
  if (input.parentId !== null && input.parentId.trim().length === 0) {
    throw new ValidationError("cancellation parent id must be null or non-blank");
  }
  const descendantIds = [...new Set(input.descendantIds ?? [])].filter(
    (id) => id !== input.rootId,
  );
  if (descendantIds.some((id) => id.trim().length === 0)) {
    throw new ValidationError("cancellation descendant ids must not be blank");
  }
  return {
    rootId: input.rootId,
    parentId: input.parentId,
    descendantIds,
    reason: input.reason,
    propagateTo: CANCELLATION_PROPAGATION_LAYERS,
    idempotent: true,
    externalEffects: "reconcile",
  };
}

export interface BudgetReservationRequest {
  readonly reservationId: string;
  readonly parentScope: string;
  readonly childScope: string;
  readonly amount: BudgetConsumption;
  readonly cancellation: CancellationPropagationContract;
}

export type BudgetReservationStatus = "reserved" | "committed" | "cancelled";

export interface BudgetReservation extends BudgetReservationRequest {
  readonly status: BudgetReservationStatus;
  readonly settledAmount: BudgetConsumption | null;
  readonly cancelledReason: CancellationPropagationReason | null;
}

export interface BudgetReservationPort {
  readonly reserve: (request: BudgetReservationRequest) => BudgetReservation;
  readonly commit: (reservationId: string, actual: BudgetConsumption) => BudgetReservation;
  readonly cancel: (
    reservationId: string,
    reason?: CancellationPropagationReason,
  ) => BudgetReservation;
}

export function createDelegationBudgetReservationRequest(input: {
  readonly reservationId: string;
  readonly parentTaskId: string;
  readonly delegationId: string;
  readonly amount: BudgetConsumption;
  readonly descendantIds?: readonly string[];
}): BudgetReservationRequest {
  const cancellationInput = input.descendantIds === undefined
    ? {
        rootId: input.delegationId,
        parentId: input.parentTaskId,
        reason: "parent_cancelled" as const,
      }
    : {
        rootId: input.delegationId,
        parentId: input.parentTaskId,
        descendantIds: input.descendantIds,
        reason: "parent_cancelled" as const,
      };
  return {
    reservationId: input.reservationId,
    parentScope: input.parentTaskId,
    childScope: input.delegationId,
    amount: { ...input.amount },
    cancellation: createCancellationPropagationContract(cancellationInput),
  };
}

/**
 * In-memory reservation ledger used by orchestration tests and composition
 * roots. It reserves against hard limits and requires explicit commit/cancel.
 */
export class BudgetReservationLedger implements BudgetReservationPort {
  private readonly reservations = new Map<string, BudgetReservation>();
  private committed: BudgetConsumption = zeroConsumption();

  constructor(
    private readonly budget: Budget,
    private readonly scope: string,
  ) {
    if (scope.trim().length === 0) throw new ValidationError("budget scope is required");
  }

  reserve(request: BudgetReservationRequest): BudgetReservation {
    if (request.reservationId.trim().length === 0) {
      throw new ValidationError("budget reservation id is required");
    }
    if (request.parentScope !== this.scope) {
      throw new ValidationError("budget reservation parent scope mismatch", {
        expected: this.scope,
        actual: request.parentScope,
      });
    }
    if (request.cancellation.rootId !== request.childScope) {
      throw new ValidationError("cancellation root must equal reserved child scope");
    }
    if (request.cancellation.parentId !== request.parentScope) {
      throw new ValidationError("cancellation parent must equal reserved parent scope", {
        expected: request.parentScope,
        actual: request.cancellation.parentId,
      });
    }
    if (this.reservations.has(request.reservationId)) {
      throw new ValidationError("budget reservation already exists", {
        reservationId: request.reservationId,
      });
    }
    assertNonNegative(request.amount);
    const projected = addConsumption(
      addConsumption(this.committed, this.activeReserved()),
      request.amount,
    );
    for (const type of BUDGET_TYPES) {
      const hard = this.budget[type].hard;
      if (hard !== null && projected[type] > hard) {
        throw new BudgetExhaustedError(this.scope, {
          budgetType: type,
          requested: request.amount[type],
          projected: projected[type],
          limit: hard,
        });
      }
    }
    const reservation: BudgetReservation = {
      ...request,
      status: "reserved",
      settledAmount: null,
      cancelledReason: null,
    };
    this.reservations.set(reservation.reservationId, reservation);
    return reservation;
  }

  commit(reservationId: string, actual: BudgetConsumption): BudgetReservation {
    const reservation = this.requireReserved(reservationId);
    assertNonNegative(actual);
    if (!within(actual, reservation.amount)) {
      throw new ValidationError("actual budget exceeds reservation", {
        reservationId,
      });
    }
    this.committed = addConsumption(this.committed, actual);
    const settled: BudgetReservation = {
      ...reservation,
      status: "committed",
      settledAmount: { ...actual },
    };
    this.reservations.set(reservationId, settled);
    return settled;
  }

  cancel(
    reservationId: string,
    reason: CancellationPropagationReason = "delegation_cancelled",
  ): BudgetReservation {
    const reservation = this.requireReserved(reservationId);
    const cancelled: BudgetReservation = {
      ...reservation,
      status: "cancelled",
      cancelledReason: reason,
    };
    this.reservations.set(reservationId, cancelled);
    return cancelled;
  }

  cancelForParent(
    parentId: string,
    reason: CancellationPropagationReason = "parent_cancelled",
  ): readonly BudgetReservation[] {
    const cancelled: BudgetReservation[] = [];
    for (const reservation of this.reservations.values()) {
      if (reservation.status !== "reserved") continue;
      if (reservation.parentScope !== parentId) continue;
      const targetsParent = reservation.cancellation.parentId === parentId;
      const targetsDescendant = reservation.cancellation.descendantIds.includes(parentId);
      if (targetsParent || targetsDescendant || reservation.childScope === parentId) {
        cancelled.push(this.cancel(reservation.reservationId, reason));
      }
    }
    return cancelled;
  }

  get(reservationId: string): BudgetReservation | null {
    return this.reservations.get(reservationId) ?? null;
  }

  list(): readonly BudgetReservation[] {
    return [...this.reservations.values()];
  }

  activeReserved(): BudgetConsumption {
    return [...this.reservations.values()]
      .filter((reservation) => reservation.status === "reserved")
      .reduce((total, reservation) => addConsumption(total, reservation.amount), zeroConsumption());
  }

  committedConsumption(): BudgetConsumption {
    return { ...this.committed };
  }

  private requireReserved(reservationId: string): BudgetReservation {
    const reservation = this.reservations.get(reservationId);
    if (reservation === undefined) {
      throw new ValidationError("budget reservation not found", { reservationId });
    }
    if (reservation.status !== "reserved") {
      throw new ValidationError("budget reservation is already settled", {
        reservationId,
        status: reservation.status,
      });
    }
    return reservation;
  }
}

export interface CancellationPropagationPort {
  readonly propagate: (contract: CancellationPropagationContract) => Promise<void>;
}

function zeroConsumption(): BudgetConsumption {
  return {
    modelMicros: 0,
    computeSeconds: 0,
    wallClockSeconds: 0,
    humanApprovals: 0,
  };
}

function addConsumption(left: BudgetConsumption, right: BudgetConsumption): BudgetConsumption {
  return {
    modelMicros: left.modelMicros + right.modelMicros,
    computeSeconds: left.computeSeconds + right.computeSeconds,
    wallClockSeconds: left.wallClockSeconds + right.wallClockSeconds,
    humanApprovals: left.humanApprovals + right.humanApprovals,
  };
}

function assertNonNegative(amount: BudgetConsumption): void {
  for (const type of BUDGET_TYPES) {
    if (!Number.isFinite(amount[type]) || amount[type] < 0) {
      throw new ValidationError("budget reservation amounts must be finite and non-negative", {
        budgetType: type,
        amount: amount[type],
      });
    }
  }
}

function within(actual: BudgetConsumption, reserved: BudgetConsumption): boolean {
  return BUDGET_TYPES.every((type) => actual[type] <= reserved[type]);
}

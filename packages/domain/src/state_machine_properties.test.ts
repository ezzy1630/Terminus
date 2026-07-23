import { describe, expect, test } from "bun:test";
import {
  SessionStatus,
  TaskStatus,
  TurnState,
  JobState,
  ContextEpochState,
  SideEffectState,
  TASK_TRANSITIONS,
  TURN_TRANSITIONS,
  ApprovalDecision,
} from "./enums.js";

// ────────────────────────── State machine transition tables ──────────────────

export const ALLOWED_SESSION_TRANSITIONS: Record<SessionStatus, readonly SessionStatus[]> = {
  active: ["paused", "archived", "deleted"],
  paused: ["active", "archived", "deleted"],
  archived: ["deleted"],
  deleted: [],
};

export const ALLOWED_TASK_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = TASK_TRANSITIONS;
export const ALLOWED_TURN_TRANSITIONS: Record<TurnState, readonly TurnState[]> = TURN_TRANSITIONS;

export type ApprovalState = "pending" | "approved" | "denied" | "expired" | "cancelled";
export const ALLOWED_APPROVAL_TRANSITIONS: Record<ApprovalState, readonly ApprovalState[]> = {
  pending: ["approved", "denied", "expired", "cancelled"],
  approved: [],
  denied: [],
  expired: [],
  cancelled: [],
};

export const ALLOWED_JOB_TRANSITIONS: Record<JobState, readonly JobState[]> = {
  CREATED: ["STARTING", "LOST"],
  STARTING: ["RUNNING", "LOST"],
  RUNNING: ["EXITED", "STOPPING", "KILLING", "ORPHANED", "LOST"],
  EXITED: [],
  STOPPING: ["EXITED", "KILLING", "LOST"],
  KILLING: ["EXITED", "LOST"],
  ORPHANED: ["REATTACHED", "LOST"],
  REATTACHED: ["RUNNING", "EXITED", "LOST"],
  LOST: [],
};

export const ALLOWED_EPOCH_TRANSITIONS: Record<ContextEpochState, readonly ContextEpochState[]> = {
  INITIALIZING: ["ACTIVE", "SEALED"],
  ACTIVE: ["REPLACEMENT_PENDING", "SEALED"],
  REPLACEMENT_PENDING: ["ACTIVE", "SEALED"],
  SEALED: [],
};

export const ALLOWED_SIDE_EFFECT_TRANSITIONS: Record<SideEffectState, readonly SideEffectState[]> = {
  PROPOSED: ["AUTHORIZED", "FAILED"],
  AUTHORIZED: ["STARTED", "FAILED"],
  STARTED: ["SETTLED", "FAILED", "UNKNOWN", "MANUAL_REVIEW"],
  UNKNOWN: ["MANUAL_REVIEW", "RECONCILING", "SETTLED", "FAILED"],
  RECONCILING: ["SETTLED", "FAILED", "MANUAL_REVIEW"],
  MANUAL_REVIEW: ["SETTLED", "FAILED"],
  SETTLED: [],
  FAILED: [],
};

export function canTransition<S extends string>(
  allowed: Record<S, readonly S[]>,
  current: S,
  next: S,
): boolean {
  const list = allowed[current];
  return list ? list.includes(next) : false;
}

export function assertTransition<S extends string>(
  machineName: string,
  allowed: Record<S, readonly S[]>,
  current: S,
  next: S,
): S {
  if (!canTransition(allowed, current, next)) {
    throw new Error(`illegal ${machineName} transition: ${current} -> ${next}`);
  }
  return next;
}

// ────────────────────────── Property tests ──────────────────────────────────

describe("Domain State Machine Property Tests", () => {
  test("Session state machine property invariants", () => {
    const statuses: SessionStatus[] = ["active", "paused", "archived", "deleted"];
    for (const current of statuses) {
      for (const next of statuses) {
        const valid = ALLOWED_SESSION_TRANSITIONS[current].includes(next);
        if (valid) {
          expect(canTransition(ALLOWED_SESSION_TRANSITIONS, current, next)).toBe(true);
          expect(assertTransition("Session", ALLOWED_SESSION_TRANSITIONS, current, next)).toBe(next);
        } else {
          expect(canTransition(ALLOWED_SESSION_TRANSITIONS, current, next)).toBe(false);
          expect(() => assertTransition("Session", ALLOWED_SESSION_TRANSITIONS, current, next)).toThrow();
        }
      }
    }
  });

  test("Task status state machine property invariants", () => {
    const statuses: TaskStatus[] = Object.values(TaskStatus);
    for (const current of statuses) {
      for (const next of statuses) {
        const valid = ALLOWED_TASK_TRANSITIONS[current].includes(next);
        if (valid) {
          expect(canTransition(ALLOWED_TASK_TRANSITIONS, current, next)).toBe(true);
          expect(assertTransition("Task", ALLOWED_TASK_TRANSITIONS, current, next)).toBe(next);
        } else {
          expect(canTransition(ALLOWED_TASK_TRANSITIONS, current, next)).toBe(false);
          expect(() => assertTransition("Task", ALLOWED_TASK_TRANSITIONS, current, next)).toThrow();
        }
      }
    }
  });

  test("Turn state machine property invariants", () => {
    const states: TurnState[] = Object.values(TurnState);
    for (const current of states) {
      for (const next of states) {
        const valid = ALLOWED_TURN_TRANSITIONS[current].includes(next);
        if (valid) {
          expect(canTransition(ALLOWED_TURN_TRANSITIONS, current, next)).toBe(true);
          expect(assertTransition("Turn", ALLOWED_TURN_TRANSITIONS, current, next)).toBe(next);
        } else {
          expect(canTransition(ALLOWED_TURN_TRANSITIONS, current, next)).toBe(false);
          expect(() => assertTransition("Turn", ALLOWED_TURN_TRANSITIONS, current, next)).toThrow();
        }
      }
    }
  });

  test("Job state machine property invariants", () => {
    const states: JobState[] = Object.values(JobState);
    for (const current of states) {
      for (const next of states) {
        const valid = ALLOWED_JOB_TRANSITIONS[current].includes(next);
        if (valid) {
          expect(canTransition(ALLOWED_JOB_TRANSITIONS, current, next)).toBe(true);
          expect(assertTransition("Job", ALLOWED_JOB_TRANSITIONS, current, next)).toBe(next);
        } else {
          expect(canTransition(ALLOWED_JOB_TRANSITIONS, current, next)).toBe(false);
          expect(() => assertTransition("Job", ALLOWED_JOB_TRANSITIONS, current, next)).toThrow();
        }
      }
    }
  });

  test("Terminal state idempotency & non-exit properties for all machines", () => {
    expect(ALLOWED_SESSION_TRANSITIONS["deleted"]).toEqual([]);
    expect(ALLOWED_TASK_TRANSITIONS["COMPLETED"]).toEqual([]);
    expect(ALLOWED_TASK_TRANSITIONS["FAILED"]).toEqual([]);
    expect(ALLOWED_TASK_TRANSITIONS["ABORTED"]).toEqual([]);
    expect(ALLOWED_TURN_TRANSITIONS["COMPLETED"]).toEqual([]);
    expect(ALLOWED_TURN_TRANSITIONS["FAILED"]).toEqual([]);
    expect(ALLOWED_JOB_TRANSITIONS["EXITED"]).toEqual([]);
    expect(ALLOWED_JOB_TRANSITIONS["LOST"]).toEqual([]);
    expect(ALLOWED_SIDE_EFFECT_TRANSITIONS["SETTLED"]).toEqual([]);
    expect(ALLOWED_SIDE_EFFECT_TRANSITIONS["FAILED"]).toEqual([]);
  });

  test("Random transition path simulation satisfies invariants", () => {
    for (let seed = 0; seed < 100; seed += 1) {
      let current: TaskStatus = "DRAFT";
      let steps = 0;
      while (steps < 50) {
        const allowedNext: readonly TaskStatus[] = ALLOWED_TASK_TRANSITIONS[current];
        if (allowedNext.length === 0) {
          expect(ALLOWED_TASK_TRANSITIONS[current]).toHaveLength(0);
          break;
        }
        const next: TaskStatus = allowedNext[(seed + steps) % allowedNext.length]!;
        current = assertTransition("Task", ALLOWED_TASK_TRANSITIONS, current, next);
        steps += 1;
      }
    }
  });
});

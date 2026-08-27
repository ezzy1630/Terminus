import { describe, expect, test } from "bun:test";
import {
  decideRepairAttemptClaim,
  isRepairAttemptActive,
  isRepairAttemptTerminal,
  repairAttemptLeaseKey,
  repairAttemptStateForTurn,
  shouldDeferRepairParentRecovery,
} from "./repair-attempt-store.js";

const now = new Date("2026-08-26T12:00:00.000Z");

describe("repair-attempt-store", () => {
  test("derives one stable lease key per durable attempt", () => {
    expect(repairAttemptLeaseKey("attempt-1")).toBe("terminus-repair-attempt:attempt-1");
    expect(repairAttemptLeaseKey("attempt-1")).toBe(repairAttemptLeaseKey("attempt-1"));
  });

  test("does not start a second owner while the lease is live", () => {
    const lease = {
      ownerInstance: "other-control",
      fencingToken: 7,
      expiresAt: new Date(now.getTime() + 1_000),
    };
    expect(decideRepairAttemptClaim({
      state: "RUNNING",
      repairTurnId: "turn-1",
      lease,
      ownerInstance: "this-control",
      now,
    })).toEqual({ claimable: false, reason: "lease_held" });
    expect(decideRepairAttemptClaim({
      state: "RUNNING",
      repairTurnId: "turn-1",
      lease: { ...lease, ownerInstance: "this-control" },
      ownerInstance: "this-control",
      now,
    })).toEqual({ claimable: false, reason: "lease_held_by_current_owner" });
  });

  test("reclaims an expired lease with a higher fencing token", () => {
    expect(decideRepairAttemptClaim({
      state: "ADMITTED",
      repairTurnId: "turn-1",
      lease: {
        ownerInstance: "old-control",
        fencingToken: 4,
        expiresAt: new Date(now.getTime() - 1),
      },
      ownerInstance: "new-control",
      now,
    })).toEqual({ claimable: true, fencingToken: 5 });
  });

  test("requires a continuation and never reclaims terminal attempts", () => {
    expect(decideRepairAttemptClaim({
      state: "PENDING",
      repairTurnId: null,
      lease: null,
      ownerInstance: "control",
      now,
    })).toEqual({ claimable: false, reason: "missing_continuation" });
    expect(decideRepairAttemptClaim({
      state: "SUCCEEDED",
      repairTurnId: "turn-1",
      lease: null,
      ownerInstance: "control",
      now,
    })).toEqual({ claimable: false, reason: "terminal" });
    expect(isRepairAttemptTerminal("SUPERSEDED")).toBe(true);
    expect(isRepairAttemptTerminal("RUNNING")).toBe(false);
    expect(isRepairAttemptActive("RUNNING")).toBe(true);
    expect(isRepairAttemptActive("SUCCEEDED")).toBe(false);
  });

  test("leaves a verifying parent with a durable attempt for repair recovery", () => {
    expect(shouldDeferRepairParentRecovery({
      turnState: "VERIFYING",
      hasActiveAttempt: true,
      hasContinuation: false,
    })).toBe(true);
    expect(shouldDeferRepairParentRecovery({
      turnState: "VERIFYING",
      hasActiveAttempt: true,
      hasContinuation: true,
    })).toBe(false);
    expect(shouldDeferRepairParentRecovery({
      turnState: "ACTIVE",
      hasActiveAttempt: true,
      hasContinuation: false,
    })).toBe(false);
  });

  test("settles a failed repair as superseded when the next attempt exists", () => {
    expect(repairAttemptStateForTurn({
      turnState: "ABORTED",
      taskStatus: "ACTIVE",
      hasSuccess: false,
      hasNextAttempt: true,
    })).toEqual({ state: "SUPERSEDED", reason: "superseded_by_next_repair_attempt" });
    expect(repairAttemptStateForTurn({
      turnState: "COMPLETED",
      taskStatus: "COMPLETED",
      hasSuccess: true,
      hasNextAttempt: false,
    })).toEqual({ state: "SUCCEEDED", reason: "repair_turn_completed" });
  });
});

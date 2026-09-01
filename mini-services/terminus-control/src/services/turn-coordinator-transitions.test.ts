import { describe, expect, test } from "bun:test";
import {
  classifyTerminalTurn,
  IMMUTABLE_TURN_STATES,
  planEnterContextCompiling,
  planEnterFinalizing,
  planEnterRepairPending,
  planEnterToolSettlement,
  planEnterVerifying,
  planFailVerification,
  planReenterContextCompiling,
  planTerminalTurnSettlement,
} from "./turn-coordinator.js";
import type { LoopErrorEnvelope } from "../agent/loop-contracts.js";

const envelope = (overrides: Partial<LoopErrorEnvelope> = {}): LoopErrorEnvelope => ({
  code: "SOMETHING_HAPPENED",
  category: "transport",
  message: "the transport broke",
  retryable: false,
  suggestedAction: null,
  details: { extra: 1 },
  ...overrides,
});

describe("turn lifecycle transition planners", () => {
  test("enterContextCompiling records the resumed state and starts the clock only from PENDING", () => {
    const fresh = planEnterContextCompiling({ turnId: "t1", taskId: "task1", resumedFrom: "PENDING" });
    expect(fresh.eventType).toBe("turn.context_compiling");
    expect(fresh.expectedStates).toEqual(["PENDING"]);
    expect(fresh.nextState).toBe("CONTEXT_COMPILING");
    expect(fresh.setStartedAt).toBe(true);
    expect(fresh.setCompletedAt).toBe(false);
    expect(fresh.payload).toEqual({ phase: "context_compiling", resumed_from: "PENDING" });
    expect(fresh.conflictError).toBe("turn t1 changed before context compilation");

    const repaired = planEnterContextCompiling({ turnId: "t1", taskId: null, resumedFrom: "REPAIRING" });
    expect(repaired.setStartedAt).toBe(false);
    expect(repaired.correlationId).toBeNull();
  });

  test("tool settlement entry carries the attempt and count, re-entry is keyed on TOOL_SETTLEMENT", () => {
    const enter = planEnterToolSettlement({ turnId: "t1", taskId: "task1", providerAttemptId: "a1", toolCallCount: 3 });
    expect(enter.expectedStates).toEqual(["RESPONSE_VALIDATING"]);
    expect(enter.nextState).toBe("TOOL_SETTLEMENT");
    expect(enter.payload).toEqual({ provider_attempt_id: "a1", tool_calls: 3 });
    expect(enter.conflictError).toBe("turn t1 changed before tool settlement");

    const reenter = planReenterContextCompiling({ turnId: "t1", taskId: "task1" });
    expect(reenter.expectedStates).toEqual(["TOOL_SETTLEMENT"]);
    expect(reenter.nextState).toBe("CONTEXT_COMPILING");
    expect(reenter.payload).toEqual({ phase: "context_compiling", reason: "tool_calls_settled" });
    expect(reenter.conflictError).toBe("turn t1 changed before context recompilation");
  });

  test("verifying, finalizing, repair-pending, verification-failure and completion plans keep the original CAS scopes", () => {
    const verifying = planEnterVerifying({ turnId: "t1", taskId: "task1", proposalArtifact: "artifact://sha256/aa" });
    expect(verifying.expectedStates).toEqual(["RESPONSE_VALIDATING"]);
    expect(verifying.nextState).toBe("VERIFYING");
    expect(verifying.payload).toEqual({ phase: "VERIFY", proposal_artifact: "artifact://sha256/aa" });

    const finalizing = planEnterFinalizing({
      turnId: "t1",
      taskId: "task1",
      after: "verification_admitted",
      expectedState: "VERIFIED",
    });
    expect(finalizing.expectedStates).toEqual(["VERIFIED"]);
    expect(finalizing.nextState).toBe("FINALIZING");
    expect(finalizing.eventType).toBe("turn.finalizing");

    const repair = planEnterRepairPending({ turnId: "t1", taskId: "task1", payload: { phase: "REPAIR_PENDING" } });
    expect(repair.expectedStates).toEqual(["VERIFYING"]);
    expect(repair.nextState).toBe("REPAIR_PENDING");
    expect(repair.eventType).toBe("turn.repair_pending");

    const failed = planFailVerification({ turnId: "t1", taskId: "task1", reason: { blocked: true } });
    expect(failed.eventType).toBe("turn.failed");
    expect(failed.nextState).toBe("FAILED");
    expect(failed.setCompletedAt).toBe(true);
    expect(failed.terminalErrorJson).toBe(JSON.stringify({ reason: "verification_failed", blocked: true }));
    expect(failed.payload).toEqual({ reason: "verification_failed", blocked: true });
    expect(failed.conflictError).toBe("turn t1 changed during verification failure settlement");

    const complete = planEnterFinalizing({
      turnId: "t1",
      taskId: null,
      after: "taskless_turn",
      expectedState: "RESPONSE_VALIDATING",
    });
    expect(complete.expectedStates).toEqual(["RESPONSE_VALIDATING"]);
    expect(complete.correlationId).toBeNull();
  });

  test("terminal classification maps every engine stop and typed error to the original vocabulary", () => {
    const base = {
      stopEnvelope: null,
      providerUnavailable: false,
      policyDenied: false,
      budgetExhausted: false,
      ambiguousToolSettlement: false,
    } as const;
    const classify = (stopKind: string | null, overrides: Partial<typeof base> = {}) =>
      classifyTerminalTurn({ ...base, stopKind, ...overrides });

    expect(classify("interrupted")).toMatchObject({ state: "ABORTED", eventType: "turn.aborted", reason: "aborted", code: "CANCELLED" });
    expect(classify("budget_stop")).toMatchObject({ state: "BUDGET_EXHAUSTED", eventType: "turn.budget_exhausted", reason: "budget_exhausted", code: "BUDGET_EXHAUSTED" });
    expect(classify(null, { budgetExhausted: true })).toMatchObject({ state: "BUDGET_EXHAUSTED", code: "TOOL_BUDGET_EXHAUSTED" });
    expect(classify("policy_stop")).toMatchObject({ state: "POLICY_DENIED", code: "POLICY_DENIED" });
    expect(classify(null, { policyDenied: true })).toMatchObject({ state: "POLICY_DENIED", code: "TOOL_POLICY_DENIED" });
    expect(classify("blocked")).toMatchObject({ state: "BLOCKED", eventType: "turn.blocked", reason: "provider_blocked", code: "PROVIDER_BLOCKED" });
    expect(classify("needs_user_input")).toMatchObject({ state: "USER_ACTION_REQUIRED", eventType: "turn.needs_user_input", code: "USER_INPUT_REQUIRED" });
    expect(classify(null, { ambiguousToolSettlement: true })).toMatchObject({ state: "INTERRUPTED", eventType: "turn.interrupted", reason: "tool_settlement_unknown", code: "TOOL_SETTLEMENT_UNKNOWN" });
    expect(classify(null, { providerUnavailable: true })).toMatchObject({ state: "FAILED", eventType: "turn.failed", code: "PROVIDER_TRANSPORT_UNAVAILABLE", reason: "provider_blocked" });
    expect(classify(null)).toMatchObject({ state: "FAILED", eventType: "turn.failed", reason: "agent_loop_error", code: "PROVIDER_EXECUTION_FAILED" });
    expect(classify("failed_verification")).toMatchObject({ state: "FAILED", reason: "failed_verification" });
    // Engine stop envelope codes win over the classification defaults.
    expect(classify("blocked", { stopEnvelope: envelope({ code: "CUSTOM_CODE" }) }).code).toBe("CUSTOM_CODE");
  });

  test("terminal classification derives the evidence outcome from the task disposition", () => {
    const base = {
      stopEnvelope: null,
      providerUnavailable: false,
      policyDenied: false,
      budgetExhausted: false,
      ambiguousToolSettlement: false,
    } as const;
    // Hard stops carry evidence outcomes; steerable failures do not.
    expect(classifyTerminalTurn({ ...base, stopKind: "interrupted" }).evidenceOutcome).toBe("ABORTED");
    expect(classifyTerminalTurn({ ...base, stopKind: "budget_stop" }).evidenceOutcome).toBe("BUDGET_EXHAUSTED");
    expect(classifyTerminalTurn({ ...base, stopKind: "policy_stop" }).evidenceOutcome).toBe("POLICY_DENIED");
    expect(classifyTerminalTurn({ ...base, stopKind: "blocked" }).evidenceOutcome).toBe("BLOCKED");
    expect(classifyTerminalTurn({ ...base, stopKind: "needs_user_input" }).evidenceOutcome).toBe("NEEDS_USER_DECISION");
    expect(classifyTerminalTurn({ ...base, stopKind: null }).evidenceOutcome).toBeNull();
    expect(classifyTerminalTurn({ ...base, stopKind: "no_final_response" }).evidenceOutcome).toBeNull();
  });

  test("terminal settlement plan keeps the three distinct durable JSON shapes and the immutable-state guard", () => {
    const classification = classifyTerminalTurn({
      stopKind: "budget_stop",
      stopEnvelope: envelope({ code: "TURN_BUDGET", message: "out of budget", category: "budget", retryable: false, details: { steps: 4 } }),
      providerUnavailable: false,
      policyDenied: false,
      budgetExhausted: false,
      ambiguousToolSettlement: false,
    });
    const plan = planTerminalTurnSettlement({
      turnId: "t1",
      classification,
      stopEnvelope: envelope({ code: "TURN_BUDGET", message: "out of budget", category: "budget", retryable: false, details: { steps: 4 } }),
      classifiedEnvelope: envelope(),
    });
    expect(plan.turnExpectedStates).toEqual(IMMUTABLE_TURN_STATES);
    expect(plan.turnNextState).toBe("BUDGET_EXHAUSTED");
    expect(plan.failRunningProviderAttempts).toBe(true);
    expect(plan.conflictError).toBe("turn t1 changed during failure settlement");
    expect(JSON.parse(plan.providerAttemptsErrorJson)).toEqual({
      code: "TURN_BUDGET",
      message: "out of budget",
      category: "budget",
      details: { steps: 4 },
    });
    expect(JSON.parse(plan.turnTerminalErrorJson)).toEqual({
      code: "TURN_BUDGET",
      message: "out of budget",
      reason: "budget_exhausted",
      details: { steps: 4 },
    });
    expect(plan.eventPayload).toEqual({
      code: "TURN_BUDGET",
      category: "budget",
      message: "out of budget",
      reason: "budget_exhausted",
      retryable: false,
      details: { steps: 4 },
    });
  });

  test("without a typed stop the classified envelope fills the settlement shapes", () => {
    const classification = classifyTerminalTurn({
      stopKind: null,
      stopEnvelope: null,
      providerUnavailable: false,
      policyDenied: false,
      budgetExhausted: false,
      ambiguousToolSettlement: false,
    });
    const plan = planTerminalTurnSettlement({
      turnId: "t1",
      classification,
      stopEnvelope: null,
      classifiedEnvelope: envelope({ code: "LOOP_CODE", message: "boom", category: "internal", retryable: true, details: {} }),
    });
    expect(JSON.parse(plan.providerAttemptsErrorJson)).toEqual({
      // The classified envelope contributes message/category/details but
      // never its code: a raw error always settles as PROVIDER_EXECUTION_FAILED.
      code: "PROVIDER_EXECUTION_FAILED",
      message: "boom",
      category: "internal",
      details: {},
    });
    expect(plan.eventPayload).toMatchObject({ retryable: true, reason: "agent_loop_error" });
  });

  test("immutable states keep REPAIR_PENDING and VERIFIED out of the failure settlement CAS", () => {
    // REPAIR_PENDING and VERIFIED are deliberately immutable: a turn parked
    // for repair (or verified pending publication) never settles as FAILED.
    // Those states converge through the durable recovery-marker path instead.
    for (const state of [
      "PENDING",
      "CONTEXT_COMPILING",
      "PROVIDER_RUNNING",
      "RESPONSE_VALIDATING",
      "TOOL_SETTLEMENT",
      "VERIFYING",
      "REPAIRING",
      "FINALIZING",
    ]) {
      expect(IMMUTABLE_TURN_STATES).not.toContain(state);
    }
    expect(IMMUTABLE_TURN_STATES).toContain("REPAIR_PENDING");
    expect(IMMUTABLE_TURN_STATES).toContain("VERIFIED");
    for (const state of ["COMPLETED", "FAILED", "ABORTED", "INTERRUPTED", "BUDGET_EXHAUSTED", "POLICY_DENIED", "BLOCKED", "USER_ACTION_REQUIRED"]) {
      expect(IMMUTABLE_TURN_STATES).toContain(state);
    }
  });
});

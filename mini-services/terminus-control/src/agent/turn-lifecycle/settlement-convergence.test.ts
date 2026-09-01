/**
 * Unit conformance for the production settlement-convergence bridge.
 *
 * These pure functions carry the reference loop's convergence rules into the
 * composition root's failure path: a settlement fault becomes a durable
 * recovery decision, never a rethrow out of `agentLoop`.
 */

import { describe, expect, test } from "bun:test";

import {
  ACTIVE_TURN_STATES,
  interpretRecoveryMarkerWrite,
  interpretTerminalCas,
  planRecoveryAfterSettlementFault,
  settlementFaultIsTerminalProcessFault,
  terminalSettlementUpdate,
} from "./settlement-convergence.js";

class ControlWriterFencedError extends Error {}

describe("settlement convergence policy", () => {
  test("active states include every non-terminal phase the loop can strand in", () => {
    for (const state of ["PENDING", "CONTEXT_COMPILING", "PROVIDER_RUNNING", "RESPONSE_VALIDATING", "TOOL_SETTLEMENT", "VERIFYING"]) {
      expect(ACTIVE_TURN_STATES).toContain(state);
    }
    for (const state of ["COMPLETED", "FAILED", "ABORTED", "INTERRUPTED"]) {
      expect(ACTIVE_TURN_STATES).not.toContain(state);
    }
  });

  test("terminal CAS distinguishes winning from losing a settled race", () => {
    expect(interpretTerminalCas(1)).toBe("won");
    expect(interpretTerminalCas(0)).toBe("lost_race_converged");
  });

  test("the recovery marker never rethrows and names the stranded state", () => {
    const plan = planRecoveryAfterSettlementFault({
      previousState: "CONTEXT_COMPILING",
      code: "PROVIDER_EXECUTION_FAILED",
      details: "sqlite busy",
    });
    expect(plan.rethrow).toBe(false);
    expect(plan.marker.reason).toBe("failure_settlement_unproven");
    expect(plan.marker.previous_state).toBe("CONTEXT_COMPILING");
    expect(plan.marker.recovery).toBe("settle_or_retry");
    expect(plan.marker.retryable).toBe(true);
  });

  test("marker writes interpret idempotently", () => {
    expect(interpretRecoveryMarkerWrite(1)).toBe("recorded");
    expect(interpretRecoveryMarkerWrite(0)).toBe("already_recorded");
    expect(interpretRecoveryMarkerWrite(2)).toBe("needs_durable_reconciliation");
  });

  test("a fenced writer lease is a terminal process fault, everything else is not", () => {
    expect(settlementFaultIsTerminalProcessFault(new ControlWriterFencedError("fenced"))).toBe(false);
    const fenced = new Error("the control-plane writer lease changed or expired before the transaction committed");
    fenced.name = "ControlWriterFencedError";
    expect(settlementFaultIsTerminalProcessFault(fenced)).toBe(true);
    expect(settlementFaultIsTerminalProcessFault(new Error("SQLITE_BUSY"))).toBe(false);
  });

  test("terminal updates are CAS-shaped on the exact prior state", () => {
    const update = terminalSettlementUpdate({
      expectedState: "CONTEXT_COMPILING",
      terminalState: "FAILED",
      terminalErrorJson: "{}",
    });
    expect(update.whereState).toBe("CONTEXT_COMPILING");
    expect(update.data.terminalState).toBe("FAILED");
  });
});

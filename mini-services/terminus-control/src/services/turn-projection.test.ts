import { describe, expect, test } from "bun:test";
import {
  deriveWaitingReason,
  projectAttempts,
  projectTurn,
  type ProviderAttemptProjectionRow,
  type TurnProjectionRow,
} from "./turn-projection.js";

const mockTurn = (overrides: Partial<TurnProjectionRow> = {}): TurnProjectionRow => ({
  id: "turn-1",
  threadId: "thread-1",
  taskId: "task-1",
  sequence: 1,
  state: "COMPLETED",
  initiatingActor: "user",
  startedAt: new Date("2026-09-02T10:00:00Z"),
  completedAt: new Date("2026-09-02T10:01:00Z"),
  selectedModel: "test-model",
  selectedReasoningEffort: "high",
  selectedProviderAccountId: null,
  requestedBudgetJson: null,
  terminalErrorJson: null,
  ...overrides,
});

const mockAttempt = (overrides: Partial<ProviderAttemptProjectionRow> = {}): ProviderAttemptProjectionRow => ({
  id: "attempt-1",
  attemptNumber: 1,
  modelKey: "test-model",
  providerId: "local",
  status: "succeeded",
  usageJson: JSON.stringify({
    inputTokens: 100,
    outputTokens: 50,
    latencyMs: 500,
  }),
  finishReason: "stop",
  providerRequestId: "req-1",
  providerReportedCostMicros: 1000n,
  computedCostMicros: 1000n,
  costSource: "provider",
  requestArtifact: "artifact://sha256/1111",
  responseArtifact: "artifact://sha256/2222",
  startedAt: new Date("2026-09-02T10:00:10Z"),
  completedAt: new Date("2026-09-02T10:00:20Z"),
  ...overrides,
});

describe("TurnProjection", () => {
  test("projects completed turn with summed usage and cost", () => {
    const turn = mockTurn();
    const attempts = [
      mockAttempt({ id: "att-1", attemptNumber: 1 }),
      mockAttempt({ id: "att-2", attemptNumber: 2, providerReportedCostMicros: 500n }),
    ];

    const projected = projectTurn(turn, attempts);

    expect(projected.id).toBe("turn-1");
    expect(projected.state).toBe("COMPLETED");
    expect(projected.stop_reason).toBe("stop");
    expect(projected.cost_micros).toBe("1500");
    expect(projected.usage.input_tokens).toBe("200");
    expect(projected.waiting_reason).toBeNull();
    expect(projected.recovery_pending).toBe(false);
  });

  test("derives explicit waiting reason for non-terminal states", () => {
    expect(deriveWaitingReason("PENDING")).toBe("turn_pending");
    expect(deriveWaitingReason("CONTEXT_COMPILING")).toBe("compiling_context");
    expect(deriveWaitingReason("PROVIDER_RUNNING")).toBe("waiting_for_provider");
    expect(deriveWaitingReason("RESPONSE_VALIDATING")).toBe("validating_provider_response");
    expect(deriveWaitingReason("TOOL_SETTLEMENT")).toBe("settling_tool_effects");
    expect(deriveWaitingReason("VERIFYING")).toBe("verifying");
    expect(deriveWaitingReason("REPAIR_PENDING")).toBe("repair_pending");
    expect(deriveWaitingReason("REPAIRING")).toBe("repairing");
    expect(deriveWaitingReason("VERIFIED")).toBe("verification_complete");
    expect(deriveWaitingReason("FINALIZING")).toBe("finalizing");
    expect(deriveWaitingReason("USER_ACTION_REQUIRED")).toBe("waiting_for_user");
    expect(deriveWaitingReason("ABORTING")).toBe("aborting");
    expect(deriveWaitingReason("COMPLETED")).toBeNull();
  });

  test("exposes reconciliation after an interrupted provider attempt", () => {
    const turn = mockTurn({
      state: "INTERRUPTED",
      terminalErrorJson: JSON.stringify({
        reason: "provider_attempt_in_flight_on_process_restart",
        reconciliation_required: true,
      }),
    });
    const projected = projectTurn(turn, []);

    expect(projected.state).toBe("INTERRUPTED");
    expect(projected.recovery_pending).toBe(true);
    expect(projected.waiting_reason).toBe("provider_reconciliation_required");
  });

  test("does not label an ordinary interrupted turn as provider recovery", () => {
    const projected = projectTurn(mockTurn({ state: "INTERRUPTED" }), []);
    expect(projected.recovery_pending).toBe(false);
    expect(projected.waiting_reason).toBeNull();
  });

  test("projects provider attempts wire format", () => {
    const attempts = [mockAttempt()];
    const projected = projectAttempts(attempts);

    expect(projected.length).toBe(1);
    expect(projected[0]!.provider_attempt_id).toBe("attempt-1");
    expect(projected[0]!.provider_reported_cost_micros).toBe("1000");
    expect(projected[0]!.usage.input_tokens).toBe("100");
  });
});

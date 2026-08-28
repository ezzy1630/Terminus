import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  CONTROL_PLANE_RESTARTED,
  restartedTaskDisposition,
  restartedTurnSettlement,
  STEERABLE_TASK_STATUSES,
  turnFailureDisposition,
  type TerminalTurnState,
} from "./turn-failure-policy.js";

describe("H8 a failed turn leaves the task alive", () => {
  test("an ordinary turn failure does not touch the task's status", () => {
    const disposition = turnFailureDisposition("FAILED");
    expect(disposition.taskStatus).toBeNull();
    expect(disposition.taskRemainsSteerable).toBe(true);
    expect(disposition.taskEventType).toBe("task.turn_failed");
  });

  test("an ambiguous tool settlement also leaves the task alive", () => {
    expect(turnFailureDisposition("INTERRUPTED").taskStatus).toBeNull();
    expect(turnFailureDisposition("INTERRUPTED").taskRemainsSteerable).toBe(true);
  });

  test("user cancellation and hard budget/policy stops end the task", () => {
    const terminal: readonly TerminalTurnState[] = ["ABORTED", "BUDGET_EXHAUSTED", "POLICY_DENIED"];
    for (const state of terminal) {
      const disposition = turnFailureDisposition(state);
      expect(`${state}:${String(disposition.taskStatus)}`).toBe(`${state}:${state}`);
      expect(disposition.taskRemainsSteerable).toBe(false);
      expect(disposition.taskEventType).toBe("task.failed");
    }
  });

  test("blocked and needs-user states stay steerable", () => {
    expect(turnFailureDisposition("BLOCKED")).toEqual({
      taskStatus: "BLOCKED",
      taskRemainsSteerable: true,
      taskEventType: "task.blocked",
    });
    expect(turnFailureDisposition("USER_ACTION_REQUIRED")).toEqual({
      taskStatus: "NEEDS_USER_DECISION",
      taskRemainsSteerable: true,
      taskEventType: "task.blocked",
    });
  });

  test("every steerable disposition lands on a status POST /v1/turns accepts", () => {
    const states: readonly TerminalTurnState[] = [
      "ABORTED",
      "BUDGET_EXHAUSTED",
      "POLICY_DENIED",
      "BLOCKED",
      "USER_ACTION_REQUIRED",
      "INTERRUPTED",
      "FAILED",
    ];
    for (const state of states) {
      const disposition = turnFailureDisposition(state);
      if (!disposition.taskRemainsSteerable) continue;
      const status = disposition.taskStatus ?? "ACTIVE";
      expect(`${state}:${String(STEERABLE_TASK_STATUSES.includes(status))}`).toBe(`${state}:true`);
    }
  });

  test("no disposition ever reports FAILED as a task status", () => {
    const states: readonly TerminalTurnState[] = [
      "ABORTED",
      "BUDGET_EXHAUSTED",
      "POLICY_DENIED",
      "BLOCKED",
      "USER_ACTION_REQUIRED",
      "INTERRUPTED",
      "FAILED",
    ];
    for (const state of states) {
      expect(turnFailureDisposition(state).taskStatus).not.toBe("FAILED");
    }
  });
});

describe("H5 restart recovery over a fixture control database", () => {
  // Mirrors the durable shapes recovery queries observe in
  // `.terminus-dev/control.db`, including task e0061647: ACTIVE, zero turns.
  const database = new Database(":memory:");
  database.exec(`
    CREATE TABLE tasks (id TEXT PRIMARY KEY, status TEXT NOT NULL);
    CREATE TABLE turns (id TEXT PRIMARY KEY, task_id TEXT, state TEXT NOT NULL);
    INSERT INTO tasks (id, status) VALUES
      ('e0061647', 'ACTIVE'),
      ('task-live', 'ACTIVE'),
      ('task-verifying-orphan', 'VERIFYING'),
      ('task-verifying-live', 'VERIFYING'),
      ('task-done', 'COMPLETED');
    INSERT INTO turns (id, task_id, state) VALUES
      ('turn-live', 'task-live', 'PROVIDER_RUNNING'),
      ('turn-verifying-live', 'task-verifying-live', 'VERIFYING'),
      ('turn-old', 'task-verifying-orphan', 'COMPLETED');
  `);
  const LIVE_STATES = [
    "PENDING",
    "CONTEXT_COMPILING",
    "PROVIDER_RUNNING",
    "RESPONSE_VALIDATING",
    "TOOL_SETTLEMENT",
    "VERIFYING",
    "REPAIRING",
    "FINALIZING",
    "REPAIR_PENDING",
    "VERIFIED",
  ];
  const hasLiveTurn = (taskId: string): boolean => {
    const placeholders = LIVE_STATES.map(() => "?").join(",");
    const row = database
      .query(`SELECT 1 AS present FROM turns WHERE task_id = ? AND state IN (${placeholders}) LIMIT 1`)
      .get(taskId, ...LIVE_STATES);
    return row !== null;
  };
  const taskStatus = (taskId: string): string => {
    const row = database.query("SELECT status FROM tasks WHERE id = ?").get(taskId) as
      | { readonly status: string }
      | null;
    if (row === null) throw new Error(`fixture task ${taskId} is missing`);
    return row.status;
  };
  const dispositionFor = (taskId: string) =>
    restartedTaskDisposition({ status: taskStatus(taskId), hasLiveTurn: hasLiveTurn(taskId) });

  test("an ACTIVE task with zero turns is already correct and is not rewritten", () => {
    expect(hasLiveTurn("e0061647")).toBe(false);
    expect(dispositionFor("e0061647")).toEqual({ nextStatus: null, activeTurn: null });
  });

  test("a VERIFYING task with no live turn returns to ACTIVE", () => {
    expect(dispositionFor("task-verifying-orphan")).toEqual({ nextStatus: "ACTIVE", activeTurn: null });
  });

  test("tasks that still have a live turn are left alone", () => {
    expect(dispositionFor("task-live")).toEqual({ nextStatus: null, activeTurn: null });
    expect(dispositionFor("task-verifying-live")).toEqual({ nextStatus: null, activeTurn: null });
  });

  test("terminal tasks are never resurrected", () => {
    expect(dispositionFor("task-done")).toEqual({ nextStatus: null, activeTurn: null });
  });

  test("an orphaned in-flight turn is failed with a real cause, not replayed", () => {
    const row = database.query("SELECT id, state FROM turns WHERE id = 'turn-live'").get() as
      | { readonly id: string; readonly state: string }
      | null;
    if (row === null) throw new Error("fixture turn is missing");
    const settlement = restartedTurnSettlement(row.state);
    expect(settlement.turnState).toBe("FAILED");
    expect(settlement.reason).toBe(CONTROL_PLANE_RESTARTED);
    expect(settlement.code).toBe("CONTROL_PLANE_RESTARTED");
    expect(settlement.retryable).toBe(true);
    expect(settlement.details.previous_state).toBe("PROVIDER_RUNNING");
    expect(settlement.message).toContain("PROVIDER_RUNNING");
    expect(settlement.message).toContain("send the request again");
  });

  test("the restart settlement never leaves the task terminal", () => {
    // The turn fails; the task keeps its own disposition, which is steerable.
    expect(turnFailureDisposition("FAILED").taskStatus).toBeNull();
    expect(turnFailureDisposition("FAILED").taskRemainsSteerable).toBe(true);
  });
});

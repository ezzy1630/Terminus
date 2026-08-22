import { describe, expect, test } from "bun:test";
import {
  IdempotencyController,
  OptimisticConcurrencyError,
  IdempotentExecutionConflictError,
  CompatibilityGateway,
  V2_ENDPOINTS,
} from "./index.js";

describe("Public API v2 & Idempotency Controller", () => {
  test("IdempotencyController caches successful result for identical key", async () => {
    const controller = new IdempotencyController();
    let counter = 0;

    const op = async () => {
      counter += 1;
      return { answer: 42, count: counter };
    };

    const first = await controller.execute("key-1", "agg-1", 0, op);
    expect(first.cached).toBe(false);
    expect(first.result.count).toBe(1);
    expect(first.version).toBe(1);

    const second = await controller.execute("key-1", "agg-1", 0, op);
    expect(second.cached).toBe(true);
    expect(second.result.count).toBe(1); // Cached, not re-executed
    expect(second.version).toBe(1);
    expect(counter).toBe(1);
  });

  test("IdempotencyController rejects stale expected version", async () => {
    const controller = new IdempotencyController();
    controller.setVersion("agg-1", 2);

    await expect(
      controller.execute("key-2", "agg-1", 1, async () => ({ ok: true })),
    ).rejects.toThrow(OptimisticConcurrencyError);
  });

  test("CompatibilityGateway translates v1 create task into canonical v2 contract", () => {
    const v2Payload = CompatibilityGateway.translateV1CreateTaskToV2({
      sessionId: "sess-1",
      threadId: "thread-1",
      objective: "Add new feature",
      acceptanceCriteria: [
        { id: "ac-1", statement: "Feature works", verificationHint: "DETERMINISTIC_TEST" },
      ],
    });

    expect(v2Payload.contract.mission).toBe("Add new feature");
    expect(v2Payload.contract.acceptance.length).toBe(1);
    expect(v2Payload.contract.acceptance[0].claimId).toBe("ac-1");
  });

  test("CompatibilityGateway translates v2 Task snapshot to v1 snapshot", () => {
    const v2Task: any = {
      id: "task-123",
      missionId: null,
      organizationId: "org-1",
      departmentId: "dept-1",
      createdBy: "principal-1",
      contract: { version: 1, mission: "Test task" },
      status: "RUNNING",
      version: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: null,
    };

    const v1Task = CompatibilityGateway.translateV2TaskToV1(v2Task, "s-1", "t-1");
    expect(v1Task.id).toBe("task-123");
    expect(v1Task.session_id).toBe("s-1");
    expect(v1Task.status).toBe("RUNNING");
  });
});

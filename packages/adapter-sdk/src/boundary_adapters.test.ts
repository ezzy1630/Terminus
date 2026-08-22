import { describe, expect, test } from "bun:test";
import {
  AcpBoundaryAdapter,
  McpBoundaryAdapter,
  A2ABoundaryAdapter,
  AgUiBoundaryAdapter,
  AtifBoundaryAdapter,
} from "./index.js";
import { generateUuid7, nowTimestamp } from "@terminus/domain";

describe("Standards Boundary Adapters", () => {
  test("AcpBoundaryAdapter transforms editor document and selection to ResourceHandles", () => {
    const handle = AcpBoundaryAdapter.documentToResourceHandle(
      { uri: "file:///src/app.ts", languageId: "typescript", version: 3, text: "console.log('hi');" },
      "task-123",
      "principal-1",
    );
    expect(handle.objectId).toBe("doc:file:///src/app.ts");
    expect(handle.allowedOperations).toContain("edit");
    expect(handle.trustLabel).toBe("USER_TRUSTED");

    const selHandle = AcpBoundaryAdapter.selectionToResourceHandle(
      { uri: "file:///src/app.ts", start: { line: 10, character: 0 }, end: { line: 12, character: 5 }, selectedText: "foo();" },
      "task-123",
      "principal-1",
    );
    expect(selHandle.objectId).toContain("selection:file:///src/app.ts");
    expect(selHandle.allowedOperations).toEqual(["read"]);
  });

  test("McpBoundaryAdapter maps MCP tools and resources to canonical capabilities & handles", () => {
    const cap = McpBoundaryAdapter.toolToCapability(
      { name: "read_file", description: "Read a file from disk", inputSchema: { type: "object" } },
      "filesystem-server",
    );
    expect(cap.capabilityId).toBe("mcp:filesystem-server:read_file");
    expect(cap.kind).toBe("mcp_tool");
    expect(cap.attenuations).toContain("bounded_output");

    const resHandle = McpBoundaryAdapter.resourceToHandle(
      { uri: "postgres://db/users", name: "Users table" },
      "task-123",
      "principal-1",
    );
    expect(resHandle.objectId).toBe("mcp_res:postgres://db/users");
    expect(resHandle.trustLabel).toBe("UNTRUSTED_TOOL");
  });

  test("A2ABoundaryAdapter converts delegation request to canonical task contract", () => {
    const contract = A2ABoundaryAdapter.delegationToTaskContract({
      delegationId: "del-1",
      fromOperatorId: "op-frontend",
      toOperatorId: "op-backend",
      missionObjective: "Create auth endpoint",
      scopePaths: ["src/auth/**"],
      acceptanceCriteria: ["POST /auth returns 200", "Token verified"],
      budgetMicros: 5000000n,
      deadlineSeconds: 600,
    });
    expect(contract.mission).toBe("Create auth endpoint");
    expect(contract.acceptance.length).toBe(2);
    expect(contract.constraints.costMicros).toBe(5000000n);
  });

  test("AgUiBoundaryAdapter projects state into cockpit view model", () => {
    const task: any = {
      id: "task-123",
      contract: { mission: "Ship phase 1" },
      status: "RUNNING",
      version: 2,
    };
    const cockpit = AgUiBoundaryAdapter.projectCockpit({
      task,
      effects: [
        {
          id: "eff-1",
          effectClass: "LOCAL_FS_WRITE",
          state: "PROPOSED",
          intentType: "patch",
          connectorOrWorker: "worker-1",
        } as any,
      ],
      claims: [
        {
          id: "claim-1",
          statement: "Tests pass",
          status: "PROPOSED",
          evidenceIds: ["ev-1"],
        } as any,
      ],
    });

    expect(cockpit.task.objective).toBe("Ship phase 1");
    expect(cockpit.effectQueue.length).toBe(1);
    expect(cockpit.evidenceTree.length).toBe(1);
    expect(cockpit.attentionRequired).toBe(false);
  });

  test("AtifBoundaryAdapter exports ARP v2 event stream to standardized ATIF document", () => {
    const events: any[] = [
      {
        eventId: generateUuid7(),
        eventType: "task.created",
        schemaVersion: 2,
        aggregateType: "task",
        aggregateId: "task-123",
        aggregateSequence: 1,
        occurredAt: nowTimestamp(),
        actor: { kind: "user", id: "principal-1" },
        payload: { taskId: "task-123" },
      },
    ];

    const trace = AtifBoundaryAdapter.exportTrace("trace-123", "2.0.0", events);
    expect(trace.traceId).toBe("trace-123");
    expect(trace.harness).toBe("terminus");
    expect(trace.rootTaskId).toBe("task-123");
    expect(trace.spans.length).toBe(1);
    expect(trace.spans[0]!.events.length).toBe(1);
  });
});


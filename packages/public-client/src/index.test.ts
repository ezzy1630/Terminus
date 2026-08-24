import { describe, expect, test } from "bun:test";
import { ForgeClient } from "./index.js";

type FetchMock = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function jsonFetch(body: unknown, status = 200): FetchMock {
  return async (_input, _init) => new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("ForgeClient v2 runtime contracts", () => {
  test("attaches a task to an exact conversation with version and idempotency", async () => {
    let requestedUrl = "";
    let requestBody: unknown = null;
    const requestKeys: Array<string | null> = [];
    const fetchImpl: FetchMock = async (input, init) => {
      requestedUrl = String(input);
      requestBody = JSON.parse(String(init?.body));
      requestKeys.push(new Headers(init?.headers).get("idempotency-key"));
      return Response.json({
        id: "task-1", missionId: null, organizationId: "org-1", departmentId: "dept-1", createdBy: "operator-1",
        conversationContext: { sessionId: "session-1", threadId: "thread-1", attachedAt: "2026-08-23T00:00:00.000Z" },
        contract: { version: 1, mission: "Task", scope: { resources: [], allowedEffectClasses: [], excludedPathsOrSystems: [] }, acceptance: [], constraints: { security: [], costMicros: "10", timeoutSeconds: 30 }, authorityCeiling: [], mode: "interactive" },
        status: "DRAFT", version: 2, createdAt: "2026-08-23T00:00:00.000Z", updatedAt: "2026-08-23T00:00:00.000Z", completedAt: null,
      });
    };
    const client = new ForgeClient({ baseUrl: "http://control.test", fetchImpl });

    const task = await client.attachTaskConversationContextV2(
      "task-1",
      { sessionId: "session-1", threadId: "thread-1", expectedVersion: 1 },
      { idempotencyKey: "task-1:attach-context" },
    );

    expect(requestedUrl).toBe("http://control.test/v2/tasks/task-1/conversation-context");
    expect(requestBody).toEqual({ id: "task-1", sessionId: "session-1", threadId: "thread-1", expectedVersion: 1 });
    expect(requestKeys).toEqual(["task-1:attach-context"]);
    expect(task.conversationContext?.threadId).toBe("thread-1");
  });

  test("rejects a success-shaped response that violates the endpoint schema", async () => {
    const client = new ForgeClient({
      baseUrl: "http://control.test",
      fetchImpl: jsonFetch([{ poolId: "pool-1", healthStatus: "healthy" }]),
    });

    await expect(client.listComputerPoolsV2()).rejects.toThrow();
  });

  test("decodes bigint-backed task budget values as decimal strings", async () => {
    const client = new ForgeClient({
      baseUrl: "http://control.test",
      fetchImpl: jsonFetch({
        taskId: "task-1",
        consumedCostMicros: "9007199254740993000",
        consumedComputeSeconds: 42,
        consumedInputTokens: "9007199254740993001",
        consumedOutputTokens: "9007199254740993002",
        consumedApprovals: 3,
        lastUpdatedAt: "2026-08-23T00:00:00.000Z",
      }),
    });

    const budget = await client.getTaskBudgetV2("task-1");

    expect(budget.consumedCostMicros).toBe("9007199254740993000");
    expect(budget.consumedInputTokens).toBe("9007199254740993001");
    expect(budget.consumedOutputTokens).toBe("9007199254740993002");
  });

  test("keeps byte counts as decimal strings across the JSON boundary", async () => {
    let requestBody: unknown = null;
    const idempotencyHeaders: Array<string | null> = [];
    const fetchImpl: FetchMock = async (_input, init) => {
      requestBody = init?.body === null || init?.body === undefined
        ? null
        : JSON.parse(String(init.body));
      idempotencyHeaders.push(new Headers(init?.headers).get("idempotency-key"));
      return new Response(JSON.stringify({
        allowed: false,
        reason: "Upload denied by policy",
        audit: {
          transferId: "transfer-1",
          taskId: "task-1",
          direction: "upload",
          source: "payload.bin",
          destination: "external_target",
          bytesCount: "9007199254740993000",
          mimeType: "application/octet-stream",
          dlpScanPassed: null,
          quarantinedPath: null,
          artifactId: null,
          contentHash: null,
          dlpReceiptArtifactId: null,
          destinationEvidenceArtifactId: null,
          timestamp: "2026-08-23T00:00:00.000Z",
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const client = new ForgeClient({ baseUrl: "http://control.test", fetchImpl });

    const result = await client.evaluateDataFlowV2({
      taskId: "task-1",
      policyId: "policy-1",
      direction: "upload",
      payloadHandle: {
        objectId: "payload-1",
        objectType: "kernel-data-handle",
        version: 1,
        scope: ["payload.bin"],
        allowedOperations: ["dlp_evaluate"],
        principalBinding: "principal-1",
        taskBinding: "task-1",
        authorityEpoch: 1,
        provenance: "kernel-fixture",
        trustLabel: "workspace",
        expiry: null,
        integrityHash: `sha256:${"a".repeat(64)}`,
      },
      dlpReceiptArtifactRef: {
        hash: `sha256:${"b".repeat(64)}`,
        uri: `artifact://sha256/${"b".repeat(64)}`,
        mediaType: "application/vnd.terminus.dlp-receipt+json",
        bytes: "128",
      },
      destination: "external_target",
      destinationEvidenceArtifactRef: null,
      fileName: "payload.bin",
      mimeType: "application/octet-stream",
      bytesCount: "9007199254740993000",
    }, { idempotencyKey: "data-flow:task-1:upload-1" });

    expect(result.audit.bytesCount).toBe("9007199254740993000");
    expect(requestBody).toMatchObject({ bytesCount: "9007199254740993000" });
    expect(idempotencyHeaders).toEqual(["data-flow:task-1:upload-1"]);
  });

  test("authenticates and propagates a non-empty idempotency key", async () => {
    let requestHeaders = new Headers();
    const fetchImpl: FetchMock = async (_input, init) => {
      requestHeaders = new Headers(init?.headers);
      return Response.json({ id: "workspace-1" });
    };
    const client = new ForgeClient({
      baseUrl: "http://control.test",
      token: "fixture-auth-value",
      fetchImpl,
    });

    await client.openWorkspace(
      { root_uri: "workspace:///fixture" },
      { idempotencyKey: "workspace:fixture:open" },
    );

    expect(requestHeaders.get("authorization")).toBe("Bearer fixture-auth-value");
    expect(requestHeaders.get("idempotency-key")).toBe("workspace:fixture:open");
  });

  test("rejects blank mutation keys before issuing a request", async () => {
    let requestCount = 0;
    const fetchImpl: FetchMock = async () => {
      requestCount += 1;
      return Response.json({});
    };
    const client = new ForgeClient({ baseUrl: "http://control.test", fetchImpl });

    await expect(client.openWorkspace(
      { root_uri: "workspace:///fixture" },
      { idempotencyKey: " \t " },
    )).rejects.toThrow(/non-empty string/);
    expect(requestCount).toBe(0);
  });

  test("binds artifact reads to the requesting task", async () => {
    let requestedUrl = "";
    const fetchImpl: FetchMock = async (input) => {
      requestedUrl = String(input);
      return new Response(Uint8Array.from([1, 2, 3]));
    };
    const client = new ForgeClient({ baseUrl: "http://control.test", fetchImpl });

    const bytes = await client.getArtifact("sha256:artifact/hash", "task with authority");

    expect(requestedUrl).toBe(
      "http://control.test/v1/artifacts/sha256%3Aartifact%2Fhash?task_id=task+with+authority",
    );
    expect([...bytes]).toEqual([1, 2, 3]);
  });
});

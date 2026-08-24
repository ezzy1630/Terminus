import { describe, expect, test } from "bun:test";
import {
  IdempotencyController,
  OptimisticConcurrencyError,
  IdempotentExecutionConflictError,
  CompatibilityGateway,
  IDEMPOTENCY_HEADER,
  V2_ENDPOINTS,
} from "./index.js";

describe("Public API v2 & Idempotency Controller", () => {
  test("interactive task context is explicit and attachable once by version", () => {
    const create = V2_ENDPOINTS.CreateTaskV2.request.safeParse({
      missionId: null,
      organizationId: "org-1",
      departmentId: "dept-1",
      v1Context: { sessionId: "session-1", threadId: "thread-1" },
      contract: {
        version: 1,
        mission: "Open the exact conversation",
        scope: { resources: [], allowedEffectClasses: [], excludedPathsOrSystems: [] },
        acceptance: [],
        constraints: { security: [], costMicros: "10", timeoutSeconds: 30 },
        authorityCeiling: [],
        mode: "interactive",
      },
    });
    expect(create.success).toBe(true);
    expect(V2_ENDPOINTS.GetTaskConversationContextV2.path).toBe("/v2/tasks/{id}/conversation-context");
    expect(V2_ENDPOINTS.AttachTaskConversationContextV2.request.safeParse({
      id: "task-1",
      sessionId: "session-1",
      threadId: "thread-1",
      expectedVersion: 2,
    }).success).toBe(true);
  });

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
      allowedScope: {
        readPaths: ["src/**"],
        writePaths: ["src/generated/**"],
        externalSystems: ["issues.example.test"],
      },
    });

    expect(v2Payload.contract.mission).toBe("Add new feature");
    expect(v2Payload.contract.acceptance.length).toBe(1);
    expect(v2Payload.contract.acceptance[0]?.claimId).toBe("ac-1");
    expect(v2Payload.contract.scope.pathScope).toEqual({
      readPaths: ["src/**"],
      writePaths: ["src/generated/**"],
      externalSystems: ["issues.example.test"],
    });
    expect(v2Payload.contract.scope.allowedEffectClasses).toEqual(["LOCAL_FS_READ", "LOCAL_FS_WRITE"]);
    expect(v2Payload.contract.authorityCeiling).toEqual(["FS_READ", "FS_WRITE"]);
    expect(v2Payload.contract.authorityCeiling).not.toContain("PROCESS_SPAWN");
    expect(v2Payload.v1Context).toEqual({ sessionId: "sess-1", threadId: "thread-1" });
  });

  test("CompatibilityGateway translates v2 Task snapshot to v1 snapshot", () => {
    const contract = CompatibilityGateway.translateV1CreateTaskToV2({
      sessionId: "s-1",
      threadId: "t-1",
      objective: "Test task",
    }).contract;
    const v2Task: Parameters<typeof CompatibilityGateway.translateV2TaskToV1>[0] = {
      id: "task-123",
      missionId: null,
      organizationId: "org-1",
      departmentId: "dept-1",
      createdBy: "principal-1",
      conversationContext: { sessionId: "s-1", threadId: "t-1", attachedAt: new Date().toISOString() },
      contract,
      status: "RUNNING",
      version: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: null,
    };

    const v1Task = CompatibilityGateway.translateV2TaskToV1(v2Task, {
      sessionId: "s-1",
      threadId: "t-1",
    });
    expect(v1Task.id).toBe("task-123");
    expect(v1Task.session_id).toBe("s-1");
    expect(v1Task.status).toBe("RUNNING");
  });

  test("Phase 9 V2_ENDPOINTS are registered and schemas validate", () => {
    expect(V2_ENDPOINTS.ListOrganizationsV2.path).toBe("/v2/organizations");
    expect(V2_ENDPOINTS.ListDepartmentsV2.path).toBe("/v2/departments");
    expect(V2_ENDPOINTS.ListOperatorsV2.path).toBe("/v2/operators");
    expect(V2_ENDPOINTS.ListAgentRoomsV2.path).toBe("/v2/agent-rooms");
    expect(V2_ENDPOINTS.ListCapabilityDirectoryV2.path).toBe("/v2/capabilities/directory");
    expect(V2_ENDPOINTS.ResolveCapabilityV2.path).toBe("/v2/capabilities/resolve");

    expect(V2_ENDPOINTS.AssessTaskAttentionV2.path).toBe("/v2/attention/assess/:taskId");
    expect(V2_ENDPOINTS.ListMaterialQuestionsV2.path).toBe("/v2/attention/questions");
    expect(V2_ENDPOINTS.AskMaterialQuestionV2.path).toBe("/v2/attention/questions");
    expect(V2_ENDPOINTS.ResolveMaterialQuestionV2.path).toBe("/v2/attention/questions/:id/resolve");

    expect(V2_ENDPOINTS.ProposeInterventionV2.path).toBe("/v2/interventions");
    expect(V2_ENDPOINTS.ApplyInterventionV2.path).toBe("/v2/interventions/:id/apply");
    expect(V2_ENDPOINTS.ListInterventionsV2.path).toBe("/v2/interventions");

    expect(V2_ENDPOINTS.GetCausalTraceV2.path).toBe("/v2/replay/traces/:taskId");
    expect(V2_ENDPOINTS.RecordCausalStepV2.path).toBe("/v2/replay/steps");
    expect(V2_ENDPOINTS.RunCounterfactualV2.path).toBe("/v2/replay/counterfactual");

    expect(V2_ENDPOINTS.GetMobileSessionV2.path).toBe("/v2/mobile/sessions/:taskId");
    expect(V2_ENDPOINTS.ExecuteMobileActionV2.path).toBe("/v2/mobile/sessions/:taskId/action");
    expect(V2_ENDPOINTS.SyncAcpContextV2.path).toBe("/v2/ide/context-sync");
  });

  test("Phase 10 endpoints use router-shaped paths and JSON-safe byte counts", () => {
    expect(V2_ENDPOINTS.GetUiObservationV2.path).toBe("/v2/computer/observations/:id");
    expect(V2_ENDPOINTS.AcquirePoolLeaseV2.path).toBe("/v2/computer/pools/:poolId/lease");
    expect(V2_ENDPOINTS.ReleasePoolLeaseV2.path).toBe(
      "/v2/computer/pools/:poolId/leases/:leaseId/release",
    );
    expect(V2_ENDPOINTS.ResumeFromTakeoverV2.path).toBe(
      "/v2/computer/takeover/:takeoverId/resume",
    );
    expect(V2_ENDPOINTS.ExecuteConnectorCallV2.path).toBe("/v2/connectors/:connectorId/call");

    const base = {
      taskId: "task-1",
      policyId: "policy-1",
      direction: "upload" as const,
      payloadHandle: {
        objectId: "payload-1",
        objectType: "kernel-data-handle",
        version: 1,
        scope: ["report.txt"],
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
      fileName: "report.txt",
      mimeType: "text/plain",
    };
    expect(V2_ENDPOINTS.EvaluateDataFlowV2.request.safeParse({
      ...base,
      bytesCount: "9007199254740993000",
    }).success).toBe(true);
    expect(V2_ENDPOINTS.EvaluateDataFlowV2.request.safeParse({
      ...base,
      bytesCount: 4,
    }).success).toBe(false);

    expect(V2_ENDPOINTS.DispatchComputerActionV2.response.safeParse({
      actionId: "action-1",
      status: "rejected",
      backendSupport: "coordinator_only",
      verification: null,
      dispatchedAt: null,
      reason: "No kernel-backed browser or desktop dispatcher is configured",
    }).success).toBe(true);
  });

  test("public trust boundaries accept references, never caller-authored proof", () => {
    const artifact = (hex: string) => ({
      hash: `sha256:${hex.repeat(64)}`,
      uri: `artifact://sha256/${hex.repeat(64)}`,
      mediaType: "application/vnd.terminus.receipt+json",
      bytes: "128",
    });
    const receipt = {
      sourceAdapterRef: "adapter:kernel-verifier",
      subjectArtifactRef: artifact("a"),
      receiptArtifactRef: artifact("b"),
      bindingHash: `sha256:${"c".repeat(64)}`,
    };

    const evidence = {
      claimId: "claim-1",
      verifierId: "verifier-1",
      verifierVersion: "1.0.0",
      receipt,
    };
    expect(V2_ENDPOINTS.RecordEvidenceV2.request.safeParse(evidence).success).toBe(true);
    expect(V2_ENDPOINTS.RecordEvidenceV2.request.safeParse({
      ...evidence,
      verifierResult: "PASS",
    }).success).toBe(false);

    expect(V2_ENDPOINTS.CreateUiObservationV2.request.safeParse({
      taskId: "task-1",
      receipt,
    }).success).toBe(true);
    expect(V2_ENDPOINTS.CreateUiObservationV2.request.safeParse({
      taskId: "task-1",
      receipt,
      domNodes: [],
      accessibilityNodes: [],
      screenshotHash: `sha256:${"d".repeat(64)}`,
    }).success).toBe(false);

    expect(V2_ENDPOINTS.AskMaterialQuestionV2.request.safeParse({
      taskId: "task-1",
      trigger: "human_taste",
      questionText: "Choose the product direction",
      options: ["A", "B"],
      consequenceMatrix: { A: "Outcome A", B: "Outcome B" },
      isDerivableFromContext: false,
    }).success).toBe(false);

    expect(V2_ENDPOINTS.ReconcileEffectV2.request.safeParse({
      id: "effect-1",
      reconciliationReceipt: receipt,
      observedOutcome: "success",
    }).success).toBe(false);

    expect(V2_ENDPOINTS.ProposeEffectV2.request.safeParse({
      taskId: "task-1",
      attemptId: "attempt-1",
      connectorOrWorker: "worker-1",
      intentType: "write_file",
      canonicalParameters: {},
      resourceHandles: [{ objectId: "caller-invented" }],
      effectClass: "filesystem_mutation",
      semanticIdempotencyKey: "task-1:write-1",
    }).success).toBe(false);

    expect(V2_ENDPOINTS.ProposeInterventionV2.request.safeParse({
      taskId: "task-1",
      rationale: "Approve this exact effect",
      verb: "approve_exact_effect",
      targetEntityId: "effect-2",
      payload: { effectId: "effect-1" },
    }).success).toBe(false);
  });

  test("v2 JSON schemas use decimal strings for bigint-backed values", () => {
    expect(IDEMPOTENCY_HEADER).toBe("Idempotency-Key");
    expect(V2_ENDPOINTS.GetTaskBudgetV2.path).toBe("/v2/tasks/{id}/budget");

    expect(V2_ENDPOINTS.ConsumeBudgetV2.request.safeParse({
      id: "task-1",
      costMicros: "9007199254740993000",
      inputTokens: "4",
      outputTokens: "5",
    }).success).toBe(true);
    expect(V2_ENDPOINTS.ConsumeBudgetV2.request.safeParse({
      id: "task-1",
      costMicros: 4n,
    }).success).toBe(false);

    expect(V2_ENDPOINTS.RouteModelStageV2.request.safeParse({
      stage: "reviewer",
      allowedAdapterRefs: ["adapter:local"],
      implementerModelFamilyRef: "family:other",
    }).success).toBe(true);
    expect(V2_ENDPOINTS.RouteModelStageV2.request.safeParse({
      stage: "reviewer",
      allowedProviders: ["legacy-provider-field"],
    }).success).toBe(false);

    expect(V2_ENDPOINTS.RunCounterfactualV2.response.safeParse({
      id: "experiment-1",
      sourceTaskId: "task-1",
      variationType: "profile",
      variationDetails: {},
      executionStatus: "completed",
      predictedOutcome: "pass",
      actualOutcome: "pass",
      deltaSuccess: true,
      deltaCostMicros: "9007199254740993000",
      deltaLatencyMs: 2,
    }).success).toBe(true);
  });
});

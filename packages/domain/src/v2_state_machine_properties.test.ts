import { describe, expect, test } from "bun:test";
import {
  TaskStatusV2,
  TASK_V2_TRANSITIONS,
  isTaskV2Terminal,
  isTaskV2TransitionAllowed,
  EffectState,
  EFFECT_TRANSITIONS,
  isEffectTerminal,
  isEffectTransitionAllowed,
  ClaimStatus,
  claimStatusSchema,
  EvidenceKind,
  evidenceKindSchema,
  WorkflowNodeKind,
  workflowNodeKindSchema,
  TrustClass,
  trustClassSchema,
  AttentionSignalKind,
  attentionSignalKindSchema,
  TaskExecutionMode,
  taskExecutionModeSchema,
  taskV2Schema,
  taskContractV2Schema,
  workflowSchema,
  nodeRunSchema,
  claimSchema,
  evidenceSchema,
  effectRecordSchema,
  authorizationInstanceSchema,
  resourceHandleSchema,
  organizationSchema,
  departmentSchema,
  operatorAgentSchema,
  questionSchema,
  decisionSchema,
  riskSchema,
} from "./index.js";

describe("ARP v2 State Machine Properties", () => {
  test("TaskStatusV2 transitions and terminal states", () => {
    const allStates = Object.values(TaskStatusV2);
    for (const from of allStates) {
      const allowed = TASK_V2_TRANSITIONS[from];
      for (const to of allStates) {
        const isAllowed = isTaskV2TransitionAllowed(from, to);
        expect(isAllowed).toBe(allowed.includes(to));
      }
      if (isTaskV2Terminal(from)) {
        expect(allowed.length).toBe(0);
      }
    }
  });

  test("EffectState 17-state transitions and terminal states", () => {
    const allStates = Object.values(EffectState);
    expect(allStates.length).toBe(17);

    for (const from of allStates) {
      const allowed = EFFECT_TRANSITIONS[from];
      for (const to of allStates) {
        const isAllowed = isEffectTransitionAllowed(from, to);
        expect(isAllowed).toBe(allowed.includes(to));
      }
      if (isEffectTerminal(from)) {
        expect(allowed.length).toBe(0);
      }
    }

    // Key lifecycle invariants per SPEC §16:
    // PROPOSED -> POLICY_CHECKED -> AUTHORIZED -> PREPARED -> DISPATCHED -> OBSERVED -> VALIDATED -> COMMITTED
    expect(isEffectTransitionAllowed("PROPOSED", "POLICY_CHECKED")).toBe(true);
    expect(isEffectTransitionAllowed("POLICY_CHECKED", "AUTHORIZED")).toBe(true);
    expect(isEffectTransitionAllowed("AUTHORIZED", "PREPARED")).toBe(true);
    expect(isEffectTransitionAllowed("PREPARED", "DISPATCHED")).toBe(true);
    expect(isEffectTransitionAllowed("DISPATCHED", "OBSERVED")).toBe(true);
    expect(isEffectTransitionAllowed("OBSERVED", "VALIDATED")).toBe(true);
    expect(isEffectTransitionAllowed("VALIDATED", "COMMITTED")).toBe(true);

    // Uncertainty and recovery paths:
    expect(isEffectTransitionAllowed("DISPATCHED", "UNCERTAIN")).toBe(true);
    expect(isEffectTransitionAllowed("UNCERTAIN", "RECONCILING")).toBe(true);
    expect(isEffectTransitionAllowed("RECONCILING", "VALIDATED")).toBe(true);
    expect(isEffectTransitionAllowed("RECONCILING", "COMPENSATING")).toBe(true);
    expect(isEffectTransitionAllowed("COMPENSATING", "COMPENSATED")).toBe(true);
  });

  test("Enum schema validation", () => {
    expect(claimStatusSchema.parse("PROPOSED")).toBe("PROPOSED");
    expect(claimStatusSchema.parse("SATISFIED")).toBe("SATISFIED");
    expect(claimStatusSchema.safeParse("INVALID").success).toBe(false);

    expect(evidenceKindSchema.parse("DETERMINISTIC_TEST")).toBe("DETERMINISTIC_TEST");
    expect(evidenceKindSchema.parse("RUNTIME_TRACE")).toBe("RUNTIME_TRACE");
    expect(evidenceKindSchema.safeParse("INVALID").success).toBe(false);

    expect(workflowNodeKindSchema.parse("deterministic")).toBe("deterministic");
    expect(workflowNodeKindSchema.parse("model_judgment")).toBe("model_judgment");

    expect(trustClassSchema.parse("SYSTEM_TRUSTED")).toBe("SYSTEM_TRUSTED");
    expect(trustClassSchema.parse("UNTRUSTED_REPOSITORY")).toBe("UNTRUSTED_REPOSITORY");

    expect(attentionSignalKindSchema.parse("APPROVAL_REQUIRED")).toBe("APPROVAL_REQUIRED");
    expect(taskExecutionModeSchema.parse("high_assurance")).toBe("high_assurance");
  });

  test("Canonical aggregate schemas validate valid payloads", () => {
    const handle = resourceHandleSchema.parse({
      objectId: "handle-1",
      objectType: "file",
      version: 1,
      scope: ["src/**"],
      allowedOperations: ["read", "write"],
      principalBinding: "principal-1",
      taskBinding: "task-1",
      authorityEpoch: 1,
      provenance: "user_request",
      trustLabel: "SYSTEM_TRUSTED",
      expiry: null,
      integrityHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    });
    expect(handle.objectId).toBe("handle-1");

    const claim = claimSchema.parse({
      id: "claim-1",
      taskId: "task-1",
      statement: "Unit tests pass",
      requiredEvidenceKind: "DETERMINISTIC_TEST",
      status: "PROPOSED",
      evidenceIds: [],
      waivedRationale: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    expect(claim.status).toBe("PROPOSED");

    const evidence = evidenceSchema.parse({
      id: "ev-1",
      claimId: "claim-1",
      kind: "DETERMINISTIC_TEST",
      summary: "cargo test exited 0",
      sourceRevision: "abc1234",
      environmentHash: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
      verifierResult: "pass",
      artifactRef: null,
      metadata: { exitCode: 0 },
      observedAt: new Date().toISOString(),
    });
    expect(evidence.verifierResult).toBe("pass");

    const effect = effectRecordSchema.parse({
      id: "effect-1",
      taskId: "task-1",
      attemptId: "attempt-1",
      principal: "user-1",
      connectorOrWorker: "local_worker",
      intentType: "patch_file",
      canonicalParameters: { path: "src/main.rs" },
      resourceHandles: [handle],
      effectClass: "LOCAL_FS_WRITE",
      semanticIdempotencyKey: "idem-key-1",
      authorizationId: "authz-1",
      policyDecisionId: "policy-1",
      state: "PROPOSED",
      uncertaintyReason: null,
      compensationRef: null,
      version: 0,
      createdAt: new Date().toISOString(),
      settledAt: null,
    });
    expect(effect.state).toBe("PROPOSED");

    const authz = authorizationInstanceSchema.parse({
      id: "authz-1",
      principal: "user-1",
      taskId: "task-1",
      taskVersion: 1,
      effectClass: "LOCAL_FS_WRITE",
      maxScope: ["src/**"],
      useLimit: 1,
      consumedCount: 0,
      expiry: new Date(Date.now() + 60000).toISOString(),
      humanApprovalId: null,
    });
    expect(authz.useLimit).toBe(1);

    const taskContract = taskContractV2Schema.parse({
      version: 1,
      mission: "Build ARP v2",
      scope: {
        resources: [handle],
        allowedEffectClasses: ["LOCAL_FS_WRITE"],
        excludedPathsOrSystems: [".git"],
      },
      acceptance: [
        {
          claimId: "claim-1",
          statement: "Protocol tests pass",
          evidenceRequirement: "DETERMINISTIC_TEST",
        },
      ],
      constraints: {
        security: ["NO_AMBIENT_SECRETS"],
        costMicros: 1000000n,
        timeoutSeconds: 300,
      },
      authorityCeiling: ["FS_WRITE"],
      mode: "high_assurance",
    });
    expect(taskContract.mission).toBe("Build ARP v2");

    const task = taskV2Schema.parse({
      id: "task-1",
      missionId: "mission-1",
      organizationId: "org-1",
      departmentId: "dept-1",
      createdBy: "principal-1",
      contract: taskContract,
      status: "DRAFT",
      version: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: null,
    });
    expect(task.status).toBe("DRAFT");
  });
});

import { describe, expect, test } from "bun:test";
import {
  ConflictError,
  ExternalDependencyError,
  IdempotencyConflictError,
  PolicyDeniedError,
  ResourceExhaustedError,
  SandboxUnavailableError,
  ValidationError,
  bytes,
  nowTimestamp,
  type ComputerUseAction,
  type ContentHash,
  type Rfc3339Timestamp,
  type UiObservation,
} from "@terminus/domain";
import {
  AmbiguousSubmitReconciler,
  BrowserDesktopPoolManager,
  DataFlowPolicyEngine,
  ExternalConnectorLibrary,
  HumanTakeoverManager,
  IncidentProfileRunner,
  ObservationFusionEngine,
  ResearchProfileRunner,
  SemanticTargetVerifier,
  type ExternalConnectorBroker,
  type PoolLeaseBackend,
  type TakeoverControlBackend,
} from "./index.js";

const HASH = `sha256:${"a".repeat(64)}` as ContentHash;
const OTHER_HASH = `sha256:${"c".repeat(64)}` as ContentHash;
const ARTIFACT = `artifact://sha256/${"b".repeat(64)}`;
const OTHER_ARTIFACT = `artifact://sha256/${"d".repeat(64)}`;

function observation(
  version: number,
  overrides: Partial<Parameters<ObservationFusionEngine["fuseObservation"]>[0]> = {},
): UiObservation {
  const engine = new ObservationFusionEngine();
  return engine.fuseObservation({
    id: `observation-${version}`,
    sessionId: "session-1",
    taskId: "task-1",
    timestamp: nowTimestamp(),
    viewport: { width: 800, height: 600, devicePixelRatio: 2, scaleFactor: 1 },
    screenshotArtifactId: "artifact-screenshot",
    domTreeArtifactId: "artifact-dom",
    documentUri: "https://example.test/form",
    domNodes: [{
      nodeId: "submit",
      tag: "button",
      attributes: { id: "submit-button" },
      text: "Submit",
      boundingBox: { x: 100, y: 100, width: 120, height: 40 },
      isInteractive: true,
      childrenNodeIds: [],
    }],
    accessibilityNodes: [{
      nodeId: "submit",
      role: "button",
      name: "Submit",
      description: null,
      value: null,
      disabled: false,
      focused: false,
      boundingBox: { x: 100, y: 100, width: 120, height: 40 },
      childrenNodeIds: [],
    }],
    focusedElementId: null,
    taintLabel: "UNTRUSTED_WEB",
    version,
    ...overrides,
  });
}

function clickAction(current: UiObservation): ComputerUseAction {
  return {
    actionId: "action-1",
    taskId: current.taskId,
    observationId: current.id,
    observationVersion: current.version,
    kind: "click",
    target: current.targetElements[0] ?? null,
    coordinate: null,
    text: null,
    keys: null,
    scrollDelta: null,
    intent: "Submit the form once",
    requiresSemanticVerification: true,
    effectClass: "irreversible",
  };
}

describe("Phase 10 computer-use coordination", () => {
  test("fuses DOM and accessibility identity without inventing geometry", () => {
    const current = observation(1, {
      domNodes: [
        {
          nodeId: "submit",
          tag: "button",
          attributes: { id: "submit-button" },
          text: "Submit",
          boundingBox: { x: 100, y: 100, width: 120, height: 40 },
          isInteractive: true,
          childrenNodeIds: [],
        },
        {
          nodeId: "missing-geometry",
          tag: "button",
          attributes: {},
          text: "Unsafe fabricated target",
          boundingBox: null,
          isInteractive: true,
          childrenNodeIds: [],
        },
      ],
    });

    expect(current.targetElements).toHaveLength(1);
    expect(current.targetElements[0]?.evidenceSources).toEqual(["accessibility", "dom"]);
    expect(current.targetElements[0]?.semanticHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(current.taintLabel).toBe("UNTRUSTED_WEB");
  });

  test("binds semantic verification to target hash and observation version", () => {
    const verifier = new SemanticTargetVerifier();
    const current = observation(1);
    const verified = verifier.verifyTarget(current, clickAction(current));
    expect(verified.verdict).toBe("verified");
    expect(verified.visuallyConfirmed).toBe(false);
    expect(verified.reason).toContain("pixel confirmation is unavailable");

    const stale = verifier.verifyTarget(observation(2), clickAction(current));
    expect(stale.verdict).toBe("rejected");
    expect(stale.reason).toContain("stale UI state");

    const coordinateOnly = { ...clickAction(current), target: null, coordinate: { x: 110, y: 110 } };
    const coordinateOnlyResult = verifier.verifyTarget(current, coordinateOnly);
    expect(coordinateOnlyResult.verdict).toBe("rejected");
    expect(coordinateOnlyResult.target).toBeNull();
    expect(coordinateOnlyResult.verifiedCoordinates).toBeNull();

    const targetlessObservationAction: ComputerUseAction = {
      ...coordinateOnly,
      actionId: "targetless-screenshot",
      kind: "take_screenshot",
      coordinate: null,
      effectClass: "read_only",
      requiresSemanticVerification: false,
    };
    const targetlessObservationResult = verifier.verifyTarget(current, targetlessObservationAction);
    expect(targetlessObservationResult.verdict).toBe("rejected");
    expect(targetlessObservationResult.reason).toContain("semantic target identity");

    const movedTarget = current.targetElements[0];
    expect(movedTarget).toBeDefined();
    if (movedTarget === undefined) throw new Error("fixture target is required");
    const movedObservation: UiObservation = {
      ...current,
      targetElements: [{
        ...movedTarget,
        boundingBox: { ...movedTarget.boundingBox, x: movedTarget.boundingBox.x + 40 },
      }],
    };
    const moved = verifier.verifyTarget(movedObservation, clickAction(current));
    expect(moved.verdict).toBe("divergent");
    expect(moved.reason).toContain("geometry moved");

    const missingGeometry: UiObservation = {
      ...current,
      targetElements: [{ ...movedTarget, boundingBox: { x: 0, y: 0, width: 0, height: 0 } }],
    };
    expect(verifier.verifyTarget(missingGeometry, {
      ...clickAction(current),
      target: missingGeometry.targetElements[0] ?? null,
    }).reason).toContain("usable geometry");

    const occludingTarget = {
      ...movedTarget,
      elementId: "overlay",
      selector: "#overlay",
      semanticHash: `sha256:${"e".repeat(64)}`,
      boundingBox: { x: 150, y: 110, width: 20, height: 20 },
    };
    const occluded: UiObservation = {
      ...current,
      targetElements: [...current.targetElements, occludingTarget],
    };
    expect(verifier.verifyTarget(occluded, clickAction(current)).verdict).toBe("ambiguous");

    const keyAction: ComputerUseAction = {
      ...clickAction(current),
      actionId: "key-action",
      kind: "key_press",
      target: null,
      keys: ["Enter"],
      requiresSemanticVerification: false,
      effectClass: "read_only",
    };
    expect(verifier.verifyTarget(current, keyAction).verdict).toBe("rejected");
    const focused = { ...current, focusedElementId: movedTarget.elementId };
    expect(verifier.verifyTarget(focused, { ...keyAction, target: movedTarget }).verdict).toBe("verified");
  });

  test("fails closed without a pool backend and recycles backend-confirmed leases", async () => {
    const coordinatorOnly = new BrowserDesktopPoolManager();
    coordinatorOnly.registerPool({
      poolId: "pool-coordinator",
      kind: "browser",
      capacity: 1,
      activeLeasesCount: 0,
      sandboxTier: "tier2_hardened_container",
      healthStatus: "degraded",
      endpoint: "coordinator://unavailable",
      runtimeConfig: {},
      executionSupport: "coordinator_only",
      enforcementStatus: "unverified",
    });
    await expect(coordinatorOnly.acquireLease("pool-coordinator", "task-1", "worker-1"))
      .rejects.toBeInstanceOf(SandboxUnavailableError);

    const backend: PoolLeaseBackend = {
      acquire: async () => ({ instanceId: "fixture-instance-1" }),
      releaseAndRecycle: async () => ({ recycled: true }),
    };
    const manager = new BrowserDesktopPoolManager(backend, { nowMs: () => 1_700_000_000_000 });
    const poolSpec = {
      poolId: "pool-fixture",
      kind: "browser",
      capacity: 1,
      activeLeasesCount: 0,
      sandboxTier: "tier2_hardened_container",
      healthStatus: "healthy",
      endpoint: "fixture://browser",
      runtimeConfig: {},
      executionSupport: "kernel_backed",
      enforcementStatus: "enforced",
    } as const;
    manager.registerPool(poolSpec);
    manager.registerPool(poolSpec);
    expect(() => manager.registerPool({ ...poolSpec, capacity: 2 }))
      .toThrow(ConflictError);
    const lease = await manager.acquireLease("pool-fixture", "task-1", "worker-1");
    await expect(manager.acquireLease("pool-fixture", "task-2", "worker-2"))
      .rejects.toBeInstanceOf(ResourceExhaustedError);
    const released = await manager.releaseLease(lease.leaseId);
    expect(released.status).toBe("released");
    expect(manager.isInstanceRecycled("fixture-instance-1")).toBe(true);
  });

  test("reserves pool capacity before await and rolls back failed or duplicate assignments", async () => {
    let releaseAcquire = (): void => {};
    const acquireGate = new Promise<void>((resolve) => { releaseAcquire = resolve; });
    let signalEntered = (): void => {};
    const entered = new Promise<void>((resolve) => { signalEntered = resolve; });
    let backendAcquires = 0;
    const backend: PoolLeaseBackend = {
      acquire: async () => {
        backendAcquires += 1;
        signalEntered();
        await acquireGate;
        return { instanceId: "concurrent-instance" };
      },
      releaseAndRecycle: async () => ({ recycled: true }),
    };
    const manager = new BrowserDesktopPoolManager(backend, { nowMs: () => 1_700_000_000_000 });
    manager.registerPool({
      poolId: "pool-concurrent",
      kind: "browser",
      capacity: 1,
      activeLeasesCount: 0,
      sandboxTier: "tier2_hardened_container",
      healthStatus: "healthy",
      endpoint: "fixture://browser",
      runtimeConfig: {},
      executionSupport: "kernel_backed",
      enforcementStatus: "enforced",
    });

    const firstAcquire = manager.acquireLease("pool-concurrent", "task-1", "worker-1");
    await entered;
    const releaseTimer = setTimeout(releaseAcquire, 25);
    await expect(manager.acquireLease("pool-concurrent", "task-2", "worker-2"))
      .rejects.toBeInstanceOf(ResourceExhaustedError);
    clearTimeout(releaseTimer);
    expect(backendAcquires).toBe(1);
    releaseAcquire();
    await firstAcquire;

    let attempt = 0;
    const rollbackBackend: PoolLeaseBackend = {
      acquire: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error("backend allocation failed");
        return { instanceId: "recovered-instance" };
      },
      releaseAndRecycle: async () => ({ recycled: true }),
    };
    const rollbackManager = new BrowserDesktopPoolManager(rollbackBackend);
    rollbackManager.registerPool({
      poolId: "pool-rollback",
      kind: "desktop",
      capacity: 1,
      activeLeasesCount: 0,
      sandboxTier: "tier3_microvm",
      healthStatus: "healthy",
      endpoint: "fixture://desktop",
      runtimeConfig: {},
      executionSupport: "kernel_backed",
      enforcementStatus: "enforced",
    });
    await expect(rollbackManager.acquireLease("pool-rollback", "task-1", "worker-1"))
      .rejects.toThrow("backend allocation failed");
    expect((await rollbackManager.acquireLease("pool-rollback", "task-2", "worker-2")).assignedInstanceId)
      .toBe("recovered-instance");

    const duplicateBackend: PoolLeaseBackend = {
      acquire: async () => ({ instanceId: "duplicate-instance" }),
      releaseAndRecycle: async () => ({ recycled: true }),
    };
    const duplicateManager = new BrowserDesktopPoolManager(duplicateBackend);
    duplicateManager.registerPool({
      poolId: "pool-duplicate",
      kind: "browser",
      capacity: 2,
      activeLeasesCount: 0,
      sandboxTier: "tier2_hardened_container",
      healthStatus: "healthy",
      endpoint: "fixture://browser",
      runtimeConfig: {},
      executionSupport: "kernel_backed",
      enforcementStatus: "enforced",
    });
    await duplicateManager.acquireLease("pool-duplicate", "task-1", "worker-1");
    await expect(duplicateManager.acquireLease("pool-duplicate", "task-2", "worker-2"))
      .rejects.toBeInstanceOf(SandboxUnavailableError);
    expect(duplicateManager.getPool("pool-duplicate")?.activeLeasesCount).toBe(1);
  });

  test("rejects heartbeat after lease expiry", async () => {
    let nowMs = 1_700_000_000_000;
    const manager = new BrowserDesktopPoolManager({
      acquire: async () => ({ instanceId: "expiring-instance" }),
      releaseAndRecycle: async () => ({ recycled: true }),
    }, { nowMs: () => nowMs });
    manager.registerPool({
      poolId: "pool-expiry",
      kind: "browser",
      capacity: 1,
      activeLeasesCount: 0,
      sandboxTier: "tier2_hardened_container",
      healthStatus: "healthy",
      endpoint: "fixture://browser",
      runtimeConfig: {},
      executionSupport: "kernel_backed",
      enforcementStatus: "enforced",
    });
    const lease = await manager.acquireLease("pool-expiry", "task-1", "worker-1", 100);
    nowMs += 100;
    expect(() => manager.heartbeatLease(lease.leaseId)).toThrow(ConflictError);
  });

  test("requires a confirmed input backend and a fresh observation for takeover resume", async () => {
    await expect(new HumanTakeoverManager().initiateTakeover(
      "pool-1",
      "browser",
      "operator inspection",
      observation(1),
    )).rejects.toBeInstanceOf(SandboxUnavailableError);

    const transfers: string[] = [];
    const backend: TakeoverControlBackend = {
      transferToHuman: async () => { transfers.push("human"); return { confirmed: true }; },
      transferToAgent: async ({ observationId }) => {
        transfers.push(`agent:${observationId}`);
        return { confirmed: true };
      },
    };
    const manager = new HumanTakeoverManager(backend);
    const session = await manager.initiateTakeover("pool-1", "browser", "operator inspection", observation(1));
    await expect(manager.resumeAutonomous(session.takeoverId, observation(1)))
      .rejects.toBeInstanceOf(ValidationError);
    const resumed = await manager.resumeAutonomous(session.takeoverId, observation(2));
    expect(resumed.state).toBe("agent_control");
    expect(transfers).toEqual(["human", "agent:observation-2"]);
  });

  test("enforces task-bound clipboard, upload, DLP, and bigint byte policy", () => {
    const engine = new DataFlowPolicyEngine();
    const policy = {
      policyId: "policy-1",
      taskId: "task-1",
      clipboardAccess: "read_only",
      allowedUploadMimeTypes: ["text/*"],
      maxUploadBytes: bytes(10),
      downloadQuarantine: true,
      dlpScanRequired: true,
      quarantineDirectory: "/quarantine/task-1",
    } as const;
    engine.registerPolicy(policy);
    engine.registerPolicy(policy);
    expect(() => engine.registerPolicy({ ...policy, quarantineDirectory: "/other" }))
      .toThrow(ConflictError);
    expect(engine.evaluateClipboardRead("task-1", "policy-1", "safe").allowed).toBe(true);
    expect(engine.evaluateClipboardRead("task-1", "policy-1", `ghp_${"a".repeat(36)}`).allowed).toBe(false);
    expect(engine.evaluateClipboardWrite("task-1", "policy-1", "safe").allowed).toBe(false);
    expect(engine.evaluateUpload("task-1", "policy-1", "a.txt", "text/plain", bytes(5)).allowed).toBe(false);
    const uploadArtifact = { artifactId: ARTIFACT, contentHash: HASH };
    const allowedUpload = engine.evaluateUpload("task-1", "policy-1", "a.txt", "text/plain", bytes(5), uploadArtifact, {
      artifactId: ARTIFACT,
      contentHash: HASH,
      receiptArtifactId: OTHER_ARTIFACT,
      destinationEvidenceArtifactId: null,
      scannerVersion: "fixture-scanner-v1",
      passed: true,
    });
    expect(allowedUpload.allowed).toBe(true);
    expect(allowedUpload.audit).toMatchObject({
      artifactId: ARTIFACT,
      contentHash: HASH,
      dlpReceiptArtifactId: OTHER_ARTIFACT,
      destinationEvidenceArtifactId: null,
    });
    expect(engine.evaluateUpload("task-1", "policy-1", "a.txt", "text/plain", bytes(5), uploadArtifact, {
      artifactId: ARTIFACT,
      contentHash: OTHER_HASH,
      receiptArtifactId: OTHER_ARTIFACT,
      destinationEvidenceArtifactId: null,
      scannerVersion: "fixture-scanner-v1",
      passed: true,
    }).allowed).toBe(false);
    expect(engine.evaluateUpload("other-task", "policy-1", "a.txt", "text/plain", bytes(5)).allowed).toBe(false);
    const download = engine.recordQuarantinedDownload(
      "task-1",
      "policy-1",
      "download.txt",
      "text/plain",
      bytes(5),
      uploadArtifact,
      {
        source: uploadArtifact,
        destination: {
          artifactId: OTHER_ARTIFACT,
          contentHash: HASH,
          quarantinedPath: "/quarantine/task-1/download.txt",
          evidenceArtifactId: `artifact://sha256/${"e".repeat(64)}`,
        },
        dlpScan: {
          artifactId: OTHER_ARTIFACT,
          contentHash: HASH,
          receiptArtifactId: `artifact://sha256/${"f".repeat(64)}`,
          destinationEvidenceArtifactId: `artifact://sha256/${"e".repeat(64)}`,
          scannerVersion: "fixture-scanner-v1",
          passed: true,
        },
      },
    );
    expect(download.destination).toBe("/quarantine/task-1/download.txt");
    expect(download).toMatchObject({
      artifactId: OTHER_ARTIFACT,
      contentHash: HASH,
      dlpReceiptArtifactId: `artifact://sha256/${"f".repeat(64)}`,
      destinationEvidenceArtifactId: `artifact://sha256/${"e".repeat(64)}`,
    });
    expect(() => engine.recordQuarantinedDownload(
      "task-1",
      "policy-1",
      "download.txt",
      "text/plain",
      bytes(5),
      uploadArtifact,
      {
        source: uploadArtifact,
        destination: {
          artifactId: OTHER_ARTIFACT,
          contentHash: OTHER_HASH,
          quarantinedPath: "/quarantine/task-1/download.txt",
          evidenceArtifactId: `artifact://sha256/${"e".repeat(64)}`,
        },
        dlpScan: {
          artifactId: OTHER_ARTIFACT,
          contentHash: OTHER_HASH,
          receiptArtifactId: `artifact://sha256/${"f".repeat(64)}`,
          destinationEvidenceArtifactId: `artifact://sha256/${"e".repeat(64)}`,
          scannerVersion: "fixture-scanner-v1",
          passed: true,
        },
      },
    )).toThrow(PolicyDeniedError);
    expect(typeof engine.getAudits()[0]?.bytesCount).toBe("bigint");
  });

  test("uses an explicit connector broker, checks idempotency shape, and preserves uncertainty", async () => {
    const spec = {
      connectorId: "fixture-connector",
      provider: "fixture-service",
      baseUrl: "https://example.test",
      allowedMethods: ["POST"] as const,
      rateLimitRps: 1,
      credentialBindingId: "fixture-grant",
      effectClasses: ["irreversible"] as const,
      status: "active" as const,
    };
    const intent = {
      intentId: "intent-1",
      connectorId: spec.connectorId,
      taskId: "task-1",
      operation: "create_record",
      method: "POST" as const,
      path: "/records",
      parameters: { name: "one" },
      idempotencyKey: "idem-1",
      authorizationId: "authorization-1",
      effectClass: "irreversible" as const,
    };
    const unavailable = new ExternalConnectorLibrary(null, [spec]);
    await expect(unavailable.executeCall(intent)).rejects.toBeInstanceOf(ExternalDependencyError);

    let brokerCalls = 0;
    const broker: ExternalConnectorBroker = {
      execute: async ({ intent: call }) => {
        brokerCalls += 1;
        return {
        settlement: call.parameters.mode === "uncertain" ? "uncertain" : "success",
        httpStatusCode: call.parameters.mode === "uncertain" ? null : 201,
        responseBody: { taskId: call.taskId },
        executedAt: nowTimestamp(),
        failureCode: call.parameters.mode === "uncertain" ? "TRANSPORT_TIMEOUT" : null,
        failureMessage: call.parameters.mode === "uncertain" ? "settlement unknown" : null,
        };
      },
    };
    const library = new ExternalConnectorLibrary(broker, [spec]);
    const first = await library.executeCall(intent);
    expect(first.status).toBe("success");
    expect(await library.executeCall(intent)).toEqual(first);
    expect(brokerCalls).toBe(1);
    await expect(library.executeCall({ ...intent, parameters: { name: "different" } }))
      .rejects.toBeInstanceOf(IdempotencyConflictError);
    await expect(library.executeCall({ ...intent, intentId: "intent-rebound" }))
      .rejects.toBeInstanceOf(IdempotencyConflictError);
    await expect(library.executeCall({ ...intent, authorizationId: "authorization-rebound" }))
      .rejects.toBeInstanceOf(IdempotencyConflictError);
    const otherTask = await library.executeCall({ ...intent, taskId: "task-2" });
    expect(otherTask.responseBody.taskId).toBe("task-2");
    expect(otherTask.requestHash).not.toBe(first.requestHash);
    expect(brokerCalls).toBe(2);
    expect(() => library.registerConnector({ ...spec, credentialBindingId: "rotated-grant" }))
      .toThrow(ConflictError);
    library.registerConnector(spec);
    const uncertain = await library.executeCall({
      ...intent,
      intentId: "intent-2",
      idempotencyKey: "idem-2",
      parameters: { mode: "uncertain" },
    });
    expect(uncertain.status).toBe("uncertain");
    expect(uncertain.httpStatusCode).toBeNull();
  });

  test("keeps incident completion and research provenance inside profile policy", () => {
    const incidents = new IncidentProfileRunner();
    const incidentProfile = {
      profileId: "incident-profile",
      organizationId: "org-1",
      departmentId: "dept-1",
      auditLevel: "forensic",
      maxActionTimeoutMs: 1_000,
      mandatoryCompensation: true,
      allowedDiagnostics: ["read_logs"],
      autoEscalateOnFailure: true,
    } as const;
    incidents.registerProfile(incidentProfile);
    incidents.registerProfile(incidentProfile);
    expect(() => incidents.registerProfile({ ...incidentProfile, auditLevel: "standard" }))
      .toThrow(ConflictError);
    const incident = incidents.startIncident("incident-profile", "task-1", ["read_logs"]);
    expect(incidents.completeIncident(incident.executionId, false).state).toBe("blocked_compensation");
    expect(() => incidents.startIncident("incident-profile", "task-2", ["restart_service"]))
      .toThrow(PolicyDeniedError);

    const research = new ResearchProfileRunner();
    const researchProfile = {
      profileId: "research-profile",
      organizationId: "org-1",
      departmentId: "dept-1",
      allowMultiSourceRetrieval: false,
      notebookSandboxEnabled: false,
      strictProvenanceTracking: true,
      citationFormat: "markdown_source",
      maxSearchQueries: 1,
    } as const;
    research.registerProfile(researchProfile);
    research.registerProfile(researchProfile);
    expect(() => research.registerProfile({ ...researchProfile, maxSearchQueries: 2 }))
      .toThrow(ConflictError);
    const record = research.startResearch("research-profile", "task-1");
    research.addSource(record.researchId, "Primary source", "https://example.test/source", HASH);
    expect(() => research.addSource(record.researchId, "Second", "https://example.test/second", HASH))
      .toThrow(PolicyDeniedError);
    expect(() => research.addNotebookCellOutput(record.researchId, 0, "1 + 1", "2", ARTIFACT))
      .toThrow(PolicyDeniedError);
  });

  test("never treats an unchanged UI as safe retry and requires a trusted receipt", () => {
    const before = observation(1);
    const after = observation(2);
    const noVerifier = new AmbiguousSubmitReconciler();
    const ambiguous = noVerifier.reconcileSubmit({
      effectId: "effect-1",
      taskId: "task-1",
      semanticIdempotencyKey: "submit-once",
      previousObservation: before,
      postTimeoutObservation: after,
      submitButtonSelector: "#submit-button",
    });
    expect(ambiguous.submitState).toBe("ambiguous_manual_required");
    expect(ambiguous.safeToRetry).toBe(false);

    const reconciler = new AmbiguousSubmitReconciler(() => true);
    const safe = reconciler.reconcileSubmit({
      effectId: "effect-1",
      taskId: "task-1",
      semanticIdempotencyKey: "submit-once",
      previousObservation: before,
      postTimeoutObservation: after,
      settlementReceipt: {
        receiptId: "receipt-1",
        effectId: "effect-1",
        taskId: "task-1",
        semanticIdempotencyKey: "submit-once",
        settlement: "not_executed",
        observedAt: nowTimestamp() as Rfc3339Timestamp,
        integrityHash: HASH,
      },
    });
    expect(safe.submitState).toBe("confirmed_not_executed");
    expect(safe.safeToRetry).toBe(true);

    const confirmedAfter = observation(2, {
      accessibilityNodes: [
        ...after.accessibilityTree,
        {
          nodeId: "confirmation",
          role: "status",
          name: "Order confirmed",
          description: null,
          value: null,
          disabled: false,
          focused: false,
          boundingBox: { x: 10, y: 10, width: 200, height: 30 },
          childrenNodeIds: [],
        },
      ],
    });
    const executed = noVerifier.reconcileSubmit({
      effectId: "effect-1",
      taskId: "task-1",
      semanticIdempotencyKey: "submit-once",
      previousObservation: before,
      postTimeoutObservation: confirmedAfter,
      expectedConfirmationSnippet: "Order confirmed",
    });
    expect(executed.submitState).toBe("ambiguous_manual_required");
    expect(executed.safeToRetry).toBe(false);
    expect(executed.reconciliationEvidence).toContain("UI hypothesis");

    const reboundReceipt = reconciler.reconcileSubmit({
      effectId: "effect-1",
      taskId: "task-1",
      semanticIdempotencyKey: "submit-once",
      previousObservation: before,
      postTimeoutObservation: after,
      settlementReceipt: {
        receiptId: "receipt-2",
        effectId: "other-effect",
        taskId: "task-1",
        semanticIdempotencyKey: "submit-once",
        settlement: "not_executed",
        observedAt: nowTimestamp() as Rfc3339Timestamp,
        integrityHash: HASH,
      },
    });
    expect(reboundReceipt.submitState).toBe("ambiguous_manual_required");
    expect(reboundReceipt.safeToRetry).toBe(false);
  });
});

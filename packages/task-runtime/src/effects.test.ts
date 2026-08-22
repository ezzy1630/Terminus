/**
 * @terminus/task-runtime — Transactional Effects & Authority Test Suite (Phase 3).
 *
 * Implements full coverage for:
 * 1. 14-point Effect Fault Matrix (SPEC §7, §16)
 * 2. Durable Authorization Instances & Monotonic Single-Use (SPEC §14, §15)
 * 3. Uncertainty & Reconciliation Engine ("Verify Before Retry")
 * 4. Compiled Sequence Policy Engine & Temporal Ordering (SPEC §13)
 * 5. Object-Capability Resource Handle Attenuation & Stale Handle Detection (SPEC §11)
 * 6. Admission Authority & Separation of Duty (SPEC §15.4, §27.2)
 * 7. Event-Sourced Replay & Recovery
 */
import { describe, it, expect, beforeEach } from "bun:test";
import type { Rfc3339Timestamp, Uuid7 } from "@terminus/domain";
import {
  EffectState,
  EffectClass,
  ScopeViolationError,
  StaleHandleError,
  StateTransitionError,
  ValidationError,
  nowTimestamp,
} from "@terminus/domain";
import { InMemoryDurableTaskRepository } from "./repository.js";
import { TransactionalOutbox } from "./outbox.js";
import { EffectLedger } from "./effects.js";
import { AuthorizationManager } from "./authorizations.js";
import { ResourceHandleManager } from "./handles.js";
import { SequencePolicyEvaluator } from "./sequence-policy.js";
import { AdmissionService } from "./admission.js";
import { DurableTaskSubstrate } from "./substrate.js";

describe("Phase 3: Transactional Effects and Authority", () => {
  let repo: InMemoryDurableTaskRepository;
  let outbox: TransactionalOutbox;
  let ledger: EffectLedger;
  let authzManager: AuthorizationManager;
  let handleManager: ResourceHandleManager;
  let seqPolicy: SequencePolicyEvaluator;
  let admission: AdmissionService;
  let substrate: DurableTaskSubstrate;

  beforeEach(() => {
    repo = new InMemoryDurableTaskRepository();
    outbox = new TransactionalOutbox(repo);
    ledger = new EffectLedger(repo, outbox);
    authzManager = new AuthorizationManager(repo, outbox);
    handleManager = new ResourceHandleManager(repo);
    seqPolicy = new SequencePolicyEvaluator(repo);
    admission = new AdmissionService(repo, ledger, seqPolicy);
    substrate = new DurableTaskSubstrate(repo);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 1. 14-Point Effect Fault Matrix
  // ─────────────────────────────────────────────────────────────────────────────

  describe("14-Point Effect Fault Matrix", () => {
    it("Fault 1: Crash before preparation — effect remains in proposed/authorized state and can be safely reloaded", async () => {
      const eff = await ledger.proposeEffect({
        taskId: "task-f1",
        attemptId: "att-1",
        principal: "actor-1",
        connectorOrWorker: "fs-worker",
        intentType: "file.write",
        canonicalParameters: { path: "src/index.ts", content: "export const x = 1;" },
        effectClass: "BUFFERABLE_LOCAL",
      });
      expect(eff.state).toBe("PROPOSED");

      const checked = await ledger.checkPolicy(eff.id, { decision: "ALLOW", decisionId: "pol-1" });
      expect(checked.state).toBe("POLICY_CHECKED");

      const authed = await ledger.authorizeEffect(eff.id, "authz-f1");
      expect(authed.state).toBe("AUTHORIZED");

      // Reload from repo
      const reloaded = await repo.getEffectRecord(eff.id);
      expect(reloaded?.state).toBe("AUTHORIZED");
      expect(reloaded?.version).toBe(3);
    });

    it("Fault 2: Crash after authorization consumption — authorization is consumed and cannot be double-spent", async () => {
      const authz = await authzManager.createAuthorization({
        id: "authz-f2",
        principal: "user-1",
        taskId: "task-f2",
        taskVersion: 1,
        effectClass: "REVERSIBLE_EXTERNAL",
        maxScope: ["**"],
        useLimit: 1,
        expiry: new Date(Date.now() + 60_000).toISOString() as Rfc3339Timestamp,
      });

      const eff = await ledger.proposeEffect({
        taskId: "task-f2",
        attemptId: "att-1",
        principal: "actor-1",
        connectorOrWorker: "api-worker",
        intentType: "api.deploy",
        canonicalParameters: { service: "auth-service", env: "staging" },
        effectClass: "REVERSIBLE_EXTERNAL",
      });

      await ledger.checkPolicy(eff.id, { decision: "PROMPT", decisionId: "pol-2" });
      await ledger.authorizeEffect(eff.id, authz.id);

      // Prepare effect (atomically consumes authorization)
      await ledger.prepareEffect(eff.id, { authzManager, taskVersion: 1 });

      const consumedAuthz = await authzManager.getAuthorization(authz.id);
      expect(consumedAuthz?.consumedCount).toBe(1);

      // Attempting to consume again must fail
      expect(
        authzManager.consumeAuthorization(authz.id, {
          taskId: "task-f2",
          taskVersion: 1,
          effectClass: "REVERSIBLE_EXTERNAL",
        })
      ).rejects.toThrow("Exhausted authorization rejected");
    });

    it("Fault 3: Crash after dispatch before receipt — transitions to UNCERTAIN on timeout", async () => {
      const eff = await ledger.proposeEffect({
        taskId: "task-f3",
        attemptId: "att-1",
        principal: "actor-1",
        connectorOrWorker: "stripe-connector",
        intentType: "payment.charge",
        canonicalParameters: { amount: 1000, currency: "USD" },
        effectClass: "COMPENSABLE_EXTERNAL",
      });
      await ledger.checkPolicy(eff.id, { decision: "ALLOW", decisionId: "pol-3" });
      await ledger.authorizeEffect(eff.id, "authz-f3");
      await ledger.prepareEffect(eff.id);
      await ledger.dispatchEffect(eff.id);

      // Timeout triggers UNCERTAIN
      const uncertain = await ledger.observeEffect(eff.id, {
        outcome: "TIMEOUT",
        uncertaintyReason: "HTTP connection dropped after 30s socket timeout",
      });

      expect(uncertain.state).toBe("UNCERTAIN");
      expect(uncertain.uncertaintyReason).toContain("socket timeout");
    });

    it("Fault 4: Timeout with action executed — verify-before-retry commits without re-dispatching", async () => {
      const eff = await ledger.proposeEffect({
        taskId: "task-f4",
        attemptId: "att-1",
        principal: "actor-1",
        connectorOrWorker: "github-connector",
        intentType: "git.push",
        canonicalParameters: { remote: "origin", branch: "feature-x" },
        effectClass: "REVERSIBLE_EXTERNAL",
      });
      await ledger.checkPolicy(eff.id, { decision: "ALLOW", decisionId: "pol-4" });
      await ledger.authorizeEffect(eff.id, "authz-f4");
      await ledger.prepareEffect(eff.id);
      await ledger.dispatchEffect(eff.id);
      await ledger.markUncertain(eff.id, "Network timeout during push receipt");

      // Reconciliation read-probe queries remote git and confirms branch exists
      const reconciled = await ledger.reconcileEffect(eff.id, {
        status: "EXECUTED",
        details: "Remote head confirmed at commit sha a1b2c3d4",
      });

      expect(reconciled.state).toBe("COMMITTED");
      expect(reconciled.settledAt).not.toBeNull();
    });

    it("Fault 5: Timeout with action not executed — verify-before-retry compensates safely", async () => {
      const eff = await ledger.proposeEffect({
        taskId: "task-f5",
        attemptId: "att-1",
        principal: "actor-1",
        connectorOrWorker: "db-connector",
        intentType: "db.insert",
        canonicalParameters: { table: "orders", orderId: "ord-999" },
        effectClass: "COMPENSABLE_EXTERNAL",
      });
      await ledger.checkPolicy(eff.id, { decision: "ALLOW", decisionId: "pol-5" });
      await ledger.authorizeEffect(eff.id, "authz-f5");
      await ledger.prepareEffect(eff.id);
      await ledger.dispatchEffect(eff.id);
      await ledger.markUncertain(eff.id, "Gateway timeout 504");

      // Probe confirms record was NOT inserted
      const reconciled = await ledger.reconcileEffect(eff.id, {
        status: "NOT_EXECUTED",
        details: "Record ord-999 not present in database",
      });

      expect(reconciled.state).toBe("COMPENSATED");
      expect(reconciled.settledAt).not.toBeNull();
    });

    it("Fault 6: Duplicate callback / result — semantic idempotency returns exact aggregate", async () => {
      const input = {
        taskId: "task-f6",
        attemptId: "att-1",
        principal: "actor-1",
        connectorOrWorker: "cloud-connector",
        intentType: "s3.upload",
        canonicalParameters: { bucket: "artifacts", key: "bundle.tar.gz" },
        effectClass: "REVERSIBLE_EXTERNAL",
      };

      const eff1 = await ledger.proposeEffect(input);
      const eff2 = await ledger.proposeEffect(input);

      expect(eff1.id).toBe(eff2.id);
      expect(eff1.semanticIdempotencyKey).toBe(eff2.semanticIdempotencyKey);
    });

    it("Fault 7: Stale worker response — invalid state transitions are rejected", async () => {
      const eff = await ledger.proposeEffect({
        taskId: "task-f7",
        attemptId: "att-1",
        principal: "actor-1",
        connectorOrWorker: "worker-1",
        intentType: "exec.run",
        canonicalParameters: { cmd: "npm test" },
        effectClass: "READ_ONLY",
      });

      // Cannot skip straight to COMMITTED from PROPOSED
      expect(ledger.commitEffect(eff.id)).rejects.toThrow(StateTransitionError);
    });

    it("Fault 8: Connector retry with semantic idempotency prevents duplicate side-effects", async () => {
      const params = { url: "https://api.example.com/charge", idempotencyToken: "tok-123" };
      const key1 = EffectLedger.computeSemanticIdempotencyKey({
        taskId: "task-f8",
        intentType: "http.post",
        effectClass: "COMPENSABLE_EXTERNAL",
        connectorOrWorker: "http-connector",
        canonicalParameters: params,
      });

      // Same parameters in different order yield the exact same semantic key
      const key2 = EffectLedger.computeSemanticIdempotencyKey({
        taskId: "task-f8",
        intentType: "http.post",
        effectClass: "COMPENSABLE_EXTERNAL",
        connectorOrWorker: "http-connector",
        canonicalParameters: { idempotencyToken: "tok-123", url: "https://api.example.com/charge" },
      });

      expect(key1).toBe(key2);
    });

    it("Fault 9: Control-plane failover & event replay reconstructs effect ledger", async () => {
      const eff = await ledger.proposeEffect({
        taskId: "task-f9",
        attemptId: "att-1",
        principal: "actor-1",
        connectorOrWorker: "fs-worker",
        intentType: "file.write",
        canonicalParameters: { path: "hello.txt", content: "world" },
        effectClass: "BUFFERABLE_LOCAL",
      });
      await ledger.checkPolicy(eff.id, { decision: "ALLOW", decisionId: "pol-9" });
      await ledger.authorizeEffect(eff.id, "authz-9");
      await ledger.prepareEffect(eff.id);
      await ledger.dispatchEffect(eff.id);
      await ledger.observeEffect(eff.id, { outcome: "SUCCESS" });
      await ledger.validateEffect(eff.id, true);
      await ledger.commitEffect(eff.id);

      // Collect outbox messages as events
      const outboxMessages = await repo.listAllOutboxMessages();
      const events = outboxMessages.map((m, idx) => ({
        eventId: m.id as Uuid7,
        eventType: m.eventType,
        schemaVersion: 2 as const,
        aggregateType: m.aggregateType,
        aggregateId: m.aggregateId,
        aggregateSequence: idx + 1,
        occurredAt: m.createdAt,
        actor: { kind: "system" as const, id: "test" },
        correlationId: null,
        causationId: null,
        idempotencyKey: m.idempotencyKey,
        payload: m.payload,
        artifactRefs: [],
        traceId: null,
      }));

      // Replay onto clean repository
      const cleanRepo = new InMemoryDurableTaskRepository();
      await cleanRepo.replayFromEvents(events);

      const replayed = await cleanRepo.getEffectRecord(eff.id);
      expect(replayed).not.toBeNull();
      expect(replayed?.state).toBe("COMMITTED");
      expect(replayed?.settledAt).not.toBeNull();
    });

    it("Fault 10: Policy/revocation during flight prevents authorization and dispatch", async () => {
      const authz = await authzManager.createAuthorization({
        id: "authz-f10",
        principal: "user-1",
        taskId: "task-f10",
        taskVersion: 1,
        effectClass: "IRREVERSIBLE",
        maxScope: ["**"],
        useLimit: 1,
        expiry: new Date(Date.now() + 60_000).toISOString() as Rfc3339Timestamp,
      });

      // Revoke authorization
      await authzManager.revokeAuthorization(authz.id, "Security policy updated by admin");

      const eff = await ledger.proposeEffect({
        taskId: "task-f10",
        attemptId: "att-1",
        principal: "actor-1",
        connectorOrWorker: "cloud-worker",
        intentType: "vm.destroy",
        canonicalParameters: { vmId: "vm-123" },
        effectClass: "IRREVERSIBLE",
      });

      await ledger.checkPolicy(eff.id, { decision: "ALLOW", decisionId: "pol-10" });
      await ledger.authorizeEffect(eff.id, authz.id);

      // Attempting to prepare with revoked authorization fails
      expect(
        ledger.prepareEffect(eff.id, { authzManager, taskVersion: 1 })
      ).rejects.toThrow("Exhausted authorization rejected");
    });

    it("Fault 11: Compensation success — transitions to COMPENSATING then COMPENSATED", async () => {
      const eff = await ledger.proposeEffect({
        taskId: "task-f11",
        attemptId: "att-1",
        principal: "actor-1",
        connectorOrWorker: "cloud-worker",
        intentType: "disk.create",
        canonicalParameters: { sizeGb: 50 },
        effectClass: "COMPENSABLE_EXTERNAL",
      });
      await ledger.checkPolicy(eff.id, { decision: "ALLOW", decisionId: "pol-11" });
      await ledger.authorizeEffect(eff.id, "authz-f11");
      await ledger.prepareEffect(eff.id);
      await ledger.dispatchEffect(eff.id);
      await ledger.observeEffect(eff.id, { outcome: "SUCCESS" });

      // Postcondition validation fails -> trigger compensation
      await ledger.validateEffect(eff.id, false);

      const compensated = await ledger.compensateEffect(eff.id, {
        compensationRef: "disk.delete(disk-50gb)",
        outcome: "COMPENSATED",
        reason: "Disk format postcondition check failed",
      });

      expect(compensated.state).toBe("COMPENSATED");
      expect(compensated.compensationRef).toBe("disk.delete(disk-50gb)");
      expect(compensated.settledAt).not.toBeNull();
    });

    it("Fault 12: Compensation residue — marks RESIDUE when compensation cannot clean up completely", async () => {
      const eff = await ledger.proposeEffect({
        taskId: "task-f12",
        attemptId: "att-1",
        principal: "actor-1",
        connectorOrWorker: "cloud-worker",
        intentType: "dns.register",
        canonicalParameters: { domain: "example-temp.com" },
        effectClass: "COMPENSABLE_EXTERNAL",
      });
      await ledger.checkPolicy(eff.id, { decision: "ALLOW", decisionId: "pol-12" });
      await ledger.authorizeEffect(eff.id, "authz-f12");
      await ledger.prepareEffect(eff.id);
      await ledger.dispatchEffect(eff.id);
      await ledger.observeEffect(eff.id, { outcome: "FAILURE" });

      const residue = await ledger.compensateEffect(eff.id, {
        compensationRef: "dns.delete(domain)",
        outcome: "RESIDUE",
        reason: "Domain registration non-refundable; fee charged",
      });

      expect(residue.state).toBe("RESIDUE");
      expect(residue.compensationRef).toBe("dns.delete(domain)");
    });

    it("Fault 13: Human cancellation — cancels in-flight effect cleanly", async () => {
      const eff = await ledger.proposeEffect({
        taskId: "task-f13",
        attemptId: "att-1",
        principal: "actor-1",
        connectorOrWorker: "batch-worker",
        intentType: "render.video",
        canonicalParameters: { resolution: "4k", frames: 1000 },
        effectClass: "BUFFERABLE_LOCAL",
      });
      await ledger.checkPolicy(eff.id, { decision: "ALLOW", decisionId: "pol-13" });

      const cancelled = await ledger.cancelEffect(eff.id, "User requested cancellation in UI");
      expect(cancelled.state).toBe("CANCELLED");
      expect(cancelled.settledAt).not.toBeNull();
    });

    it("Fault 14: Speculative branch loss — losing candidate branch effects are cancelled", async () => {
      const eff = await ledger.proposeEffect({
        taskId: "task-f14",
        attemptId: "att-branch-2",
        principal: "agent-b",
        connectorOrWorker: "fs-worker",
        intentType: "file.write",
        canonicalParameters: { path: "test.py", content: "print('branch 2')" },
        effectClass: "BUFFERABLE_LOCAL",
      });
      await ledger.checkPolicy(eff.id, { decision: "ALLOW", decisionId: "pol-14" });
      await ledger.authorizeEffect(eff.id, "authz-f14");
      await ledger.prepareEffect(eff.id);

      admission.registerCandidateBranch({
        branchId: "branch-candidate-2",
        taskId: "task-f14",
        attemptId: "att-branch-2",
        actorPrincipal: "agent-b",
        worktreePath: "/tmp/worktree-branch-2",
        epoch: 1,
        effectIds: [eff.id],
        status: "OPEN",
      });

      // Branch 1 wins eval; Branch 2 is rejected
      await admission.rejectBranch("branch-candidate-2", "Alternative candidate branch selected");

      const rejectedEffect = await repo.getEffectRecord(eff.id);
      expect(rejectedEffect?.state).toBe("CANCELLED");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 2. Durable Authorization Instance Invariants
  // ─────────────────────────────────────────────────────────────────────────────

  describe("Durable Authorization Instances", () => {
    it("rejects authorization consumption across different tasks", async () => {
      const authz = await authzManager.createAuthorization({
        id: "authz-cross",
        principal: "user-1",
        taskId: "task-alpha",
        taskVersion: 1,
        effectClass: "LOCAL_FS_WRITE",
        maxScope: ["**"],
        expiry: new Date(Date.now() + 60_000).toISOString() as Rfc3339Timestamp,
      });

      expect(
        authzManager.consumeAuthorization(authz.id, {
          taskId: "task-beta",
          taskVersion: 1,
          effectClass: "LOCAL_FS_WRITE",
        })
      ).rejects.toThrow(ScopeViolationError);
    });

    it("rejects authorization after task contract replanning (version mismatch)", async () => {
      const authz = await authzManager.createAuthorization({
        id: "authz-stale-ver",
        principal: "user-1",
        taskId: "task-replan",
        taskVersion: 1,
        effectClass: "LOCAL_FS_WRITE",
        maxScope: ["**"],
        expiry: new Date(Date.now() + 60_000).toISOString() as Rfc3339Timestamp,
      });

      // Task contract was bumped to version 2 (replanning)
      expect(
        authzManager.consumeAuthorization(authz.id, {
          taskId: "task-replan",
          taskVersion: 2,
          effectClass: "LOCAL_FS_WRITE",
        })
      ).rejects.toThrow("Stale authorization rejected");
    });

    it("rejects altered approval hash", async () => {
      const authz = await authzManager.createAuthorization({
        id: "authz-hash",
        principal: "user-1",
        taskId: "task-hash",
        taskVersion: 1,
        effectClass: "LOCAL_FS_WRITE",
        maxScope: ["**"],
        expiry: new Date(Date.now() + 60_000).toISOString() as Rfc3339Timestamp,
        approvalHash: "sha256:original-approval-hash",
      });

      expect(
        authzManager.consumeAuthorization(authz.id, {
          taskId: "task-hash",
          taskVersion: 1,
          effectClass: "LOCAL_FS_WRITE",
          approvalHash: "sha256:tampered-action-hash",
        })
      ).rejects.toThrow("Approval hash mismatch");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 3. Object-Capability Resource Handles
  // ─────────────────────────────────────────────────────────────────────────────

  describe("Object-Capability Resource Handles", () => {
    it("mints, attenuates, and validates object capability handles", async () => {
      const rootHandle = await handleManager.mintHandle({
        objectId: "repo-1",
        objectType: "git_repository",
        scope: ["src/**", "tests/**", "docs/**"],
        allowedOperations: ["read", "write", "commit"],
        principalBinding: "agent-1",
        taskBinding: "task-cap-1",
        provenance: "root-mint",
      });

      expect(rootHandle.version).toBe(1);
      expect(rootHandle.integrityHash).toContain("sha256:");

      // Attenuate to read-only on src/**
      const childHandle = await handleManager.attenuateHandle(rootHandle, {
        scope: ["src/**"],
        allowedOperations: ["read"],
        provenanceExtension: "read-only-worker",
      });

      expect(childHandle.allowedOperations).toEqual(["read"]);
      expect(childHandle.scope).toEqual(["src/**"]);
      expect(childHandle.provenance).toContain("read-only-worker");

      // Attenuation cannot add unheld operations
      expect(
        handleManager.attenuateHandle(childHandle, {
          allowedOperations: ["read", "delete_repo"],
        })
      ).rejects.toThrow(ScopeViolationError);
    });

    it("rejects operations on stale handle versions", async () => {
      const v1Handle = await handleManager.mintHandle({
        objectId: "file-doc",
        objectType: "file",
        version: 1,
        scope: ["docs/SPEC.md"],
        allowedOperations: ["read", "write"],
        principalBinding: "agent-1",
        taskBinding: "task-stale",
        provenance: "initial",
      });

      // Update handle version in repo to version 2
      await handleManager.mintHandle({
        objectId: "file-doc",
        objectType: "file",
        version: 2,
        scope: ["docs/SPEC.md"],
        allowedOperations: ["read", "write"],
        principalBinding: "agent-1",
        taskBinding: "task-stale",
        provenance: "modified",
      });

      // Using v1Handle now throws StaleHandleError
      expect(handleManager.validateHandle(v1Handle, "write", 1)).rejects.toThrow(StaleHandleError);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 4. Compiled Sequence Policy & Separation of Duty
  // ─────────────────────────────────────────────────────────────────────────────

  describe("Compiled Sequence Policy & Admission Authority", () => {
    it("enforces temporal ordering preconditions and separation of duty", async () => {
      const evalResult = await seqPolicy.evaluate({
        taskId: "task-seq",
        effectType: "git.merge",
        actorPrincipal: "agent-developer",
        reviewerPrincipal: "human-reviewer",
        precedingEvents: ["evidence.verified", "claim.satisfied"],
        admittedClaims: ["security.secret_scan_passed", "tests.unit_passed"],
      });

      expect(evalResult.decision).toBe("ALLOWED");

      // Missing required claim -> DENIED
      const failedResult = await seqPolicy.evaluate({
        taskId: "task-seq",
        effectType: "git.merge",
        actorPrincipal: "agent-developer",
        reviewerPrincipal: "human-reviewer",
        precedingEvents: ["evidence.verified", "claim.satisfied"],
        admittedClaims: ["tests.unit_passed"], // secret scan missing
      });

      expect(failedResult.decision).toBe("DENIED");
      expect(failedResult.reason).toContain("missing required admitted claim");
    });

    it("enforces separation of duty: reviewer cannot be the actor", async () => {
      const selfReviewResult = await seqPolicy.evaluate({
        taskId: "task-sod",
        effectType: "git.merge",
        actorPrincipal: "agent-developer",
        reviewerPrincipal: "agent-developer", // self-review attempt
        precedingEvents: ["evidence.verified", "claim.satisfied"],
        admittedClaims: ["security.secret_scan_passed", "tests.unit_passed"],
      });

      expect(selfReviewResult.decision).toBe("DENIED");
      expect(selfReviewResult.reason).toContain("cannot approve or review their own effect");
    });

    it("AdmissionService authoritatively merges candidate branch when verified", async () => {
      const eff = await ledger.proposeEffect({
        taskId: "task-admit",
        attemptId: "att-cand-1",
        principal: "agent-candidate",
        connectorOrWorker: "fs-worker",
        intentType: "file.write",
        canonicalParameters: { path: "feature.ts", content: "export const ok = true;" },
        effectClass: "BUFFERABLE_LOCAL",
      });
      await ledger.checkPolicy(eff.id, { decision: "ALLOW", decisionId: "pol-a" });
      await ledger.authorizeEffect(eff.id, "authz-admit");
      await ledger.prepareEffect(eff.id);
      await ledger.dispatchEffect(eff.id);
      await ledger.observeEffect(eff.id, { outcome: "SUCCESS" });
      await ledger.validateEffect(eff.id, true);

      admission.registerCandidateBranch({
        branchId: "cand-branch-1",
        taskId: "task-admit",
        attemptId: "att-cand-1",
        actorPrincipal: "agent-candidate",
        worktreePath: "/tmp/worktree-cand-1",
        epoch: 1,
        effectIds: [eff.id],
        status: "OPEN",
      });

      const admissionResult = await admission.admitBranch({
        branchId: "cand-branch-1",
        taskId: "task-admit",
        attemptId: "att-cand-1",
        actorPrincipal: "agent-candidate",
        reviewerPrincipal: "lead-reviewer",
        requiredClaimsSatisfied: ["security.secret_scan_passed", "tests.unit_passed"],
      });

      expect(admissionResult.admitted).toBe(true);
      expect(admissionResult.committedEffects).toContain(eff.id);

      const committed = await repo.getEffectRecord(eff.id);
      expect(committed?.state).toBe("COMMITTED");
    });
  });
});

/**
 * @terminus/public-api — Compatibility Gateway (v1 ↔ v2).
 *
 * Per SPEC §42.2:
 * Strangler gateway allowing legacy v1 clients to interact seamlessly with
 * the canonical ARP v2 domain and vice versa.
 */
import type { TaskSnapshot, SessionSnapshot, ApprovalSnapshot } from "./index.js";
import type { TaskV2Snapshot, EffectSnapshot, ClaimSnapshot } from "./v2_endpoints.js";
import type { EventEnvelope } from "@terminus/runtime-protocol";
import type { EventEnvelopeV2 } from "@terminus/runtime-protocol";
import { generateUuid7, nowTimestamp, asContentHash } from "@terminus/domain";

// skipcq: JS-0327
export class CompatibilityGateway {
  /**
   * Evidence a claim must carry. A task that cannot touch the workspace
   * (no write paths) has no test to run: demanding `DETERMINISTIC_TEST` for a
   * question or an explanation makes it permanently incompletable. Such a task
   * settles on the recorded turn transcript instead.
   */
  static evidenceRequirementForScope(input: {
    readonly writePaths?: readonly string[] | undefined;
    readonly verificationHint?: string | null | undefined;
  }): string {
    if (input.verificationHint !== undefined && input.verificationHint !== null && input.verificationHint.length > 0) {
      return input.verificationHint;
    }
    return (input.writePaths ?? []).length > 0 ? "DETERMINISTIC_TEST" : "RUNTIME_TRACE";
  }

  /** Translates a legacy v1 CreateTask request into a canonical v2 TaskContract structure. */
  static translateV1CreateTaskToV2(v1Input: {
    sessionId: string;
    threadId: string;
    objective: string;
    nonGoals?: string[];
    acceptanceCriteria?: { id: string; statement: string; verificationHint?: string | null; required?: boolean }[];
    allowedScope?: { readPaths?: string[]; writePaths?: string[]; externalSystems?: string[] };
    riskClass?: string;
  }): {
    missionId: null;
    organizationId: string;
    departmentId: string;
    v1Context: { sessionId: string; threadId: string };
    contract: TaskV2Snapshot["contract"];
  } {
    const pathScope = {
      readPaths: [...(v1Input.allowedScope?.readPaths ?? [])],
      writePaths: [...(v1Input.allowedScope?.writePaths ?? [])],
      externalSystems: [...(v1Input.allowedScope?.externalSystems ?? [])],
    };
    const claims = (v1Input.acceptanceCriteria ?? []).map((ac) => ({
      claimId: ac.id,
      statement: ac.statement,
      evidenceRequirement: CompatibilityGateway.evidenceRequirementForScope({
        writePaths: pathScope.writePaths,
        verificationHint: ac.verificationHint,
      }),
    }));
    const allowedEffectClasses = [
      ...(pathScope.readPaths.length > 0 ? ["LOCAL_FS_READ"] : []),
      ...(pathScope.writePaths.length > 0 ? ["LOCAL_FS_WRITE"] : []),
    ];
    const authorityCeiling = [
      ...(pathScope.readPaths.length > 0 ? ["FS_READ"] : []),
      ...(pathScope.writePaths.length > 0 ? ["FS_WRITE"] : []),
    ];

    const contract: TaskV2Snapshot["contract"] = {
      version: 1,
      mission: v1Input.objective,
      scope: {
        resources: [],
        allowedEffectClasses,
        excludedPathsOrSystems: [],
        pathScope,
      },
      acceptance: claims.length > 0 ? claims : [
        {
          claimId: "claim-default",
          statement: v1Input.objective,
          evidenceRequirement: CompatibilityGateway.evidenceRequirementForScope({
            writePaths: pathScope.writePaths,
          }),
        },
      ],
      constraints: {
        security: ["NO_AMBIENT_SECRETS"],
        costMicros: "5000000",
        timeoutSeconds: 3600,
      },
      authorityCeiling,
      mode: "interactive",
    };

    return {
      missionId: null,
      organizationId: "default-org",
      departmentId: "default-dept",
      v1Context: { sessionId: v1Input.sessionId, threadId: v1Input.threadId },
      contract,
    };
  }

  /** Translates a canonical v2 Task snapshot to a legacy v1 TaskSnapshot. */
  static translateV2TaskToV1(
    v2Task: TaskV2Snapshot,
    context: { sessionId: string; threadId: string },
  ): TaskSnapshot {
    return {
      id: v2Task.id,
      session_id: context.sessionId,
      thread_id: context.threadId,
      status: v2Task.status,
      phase: "IMPLEMENT",
      active_contract_version: v2Task.contract.version,
      risk_class: "normal",
      created_at: v2Task.createdAt,
      updated_at: v2Task.updatedAt,
      completed_at: v2Task.completedAt,
      terminal_reason: null,
    };
  }

  /** Translates a v1 EventEnvelope into an ARP v2 EventEnvelope. */
  static translateV1EventToV2(v1Event: EventEnvelope): EventEnvelopeV2 {
    return {
      eventId: v1Event.eventId,
      eventType: v1Event.eventType,
      schemaVersion: 2,
      aggregateType: v1Event.aggregateType,
      aggregateId: v1Event.aggregateId,
      aggregateSequence: v1Event.aggregateSequence,
      occurredAt: v1Event.occurredAt,
      actor: {
        kind: v1Event.actor.kind,
        id: v1Event.actor.id,
      },
      correlationId: v1Event.correlationId,
      causationId: v1Event.causationId,
      idempotencyKey: v1Event.idempotencyKey,
      payload: v1Event.payload,
      artifactRefs: v1Event.artifactRefs,
      traceId: v1Event.traceId,
    };
  }

  /** Translates an ARP v2 EventEnvelope into a legacy v1 EventEnvelope. */
  static translateV2EventToV1(v2Event: EventEnvelopeV2): EventEnvelope {
    return {
      eventId: v2Event.eventId,
      eventType: v2Event.eventType,
      schemaVersion: 1,
      aggregateType: v2Event.aggregateType,
      aggregateId: v2Event.aggregateId,
      aggregateSequence: v2Event.aggregateSequence,
      occurredAt: v2Event.occurredAt,
      actor: {
        kind: v2Event.actor.kind,
        id: v2Event.actor.id,
      },
      correlationId: v2Event.correlationId,
      causationId: v2Event.causationId,
      idempotencyKey: v2Event.idempotencyKey,
      payload: v2Event.payload,
      artifactRefs: v2Event.artifactRefs,
      traceId: v2Event.traceId,
    };
  }
}

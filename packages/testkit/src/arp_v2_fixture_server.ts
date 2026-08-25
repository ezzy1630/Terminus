/**
 * @terminus/testkit — ARP v2 In-Memory Fixture Server.
 *
 * Provides a self-contained, fully compliant in-memory ARP v2 server
 * for end-to-end task execution, cursor-based event streaming,
 * effect ledger transitions, and compatibility gateway testing.
 */
import type {
  TaskV2,
  TaskContractV2,
  EffectRecord,
  Claim,
  Evidence,
  Question,
  Decision,
  ResourceHandle,
  TraceId,
} from "@terminus/domain";
import { generateUuid7, nowTimestamp, isEffectTransitionAllowed } from "@terminus/domain";
import type { EventEnvelopeV2, ArpV2EventType } from "@terminus/runtime-protocol";
import { CursorCodec } from "@terminus/runtime-protocol";
import { IdempotencyController } from "@terminus/public-api";

export class ArpV2FixtureServer {
  readonly idempotency = new IdempotencyController();
  readonly tasks = new Map<string, TaskV2>();
  readonly effects = new Map<string, EffectRecord>();
  readonly claims = new Map<string, Claim>();
  readonly evidences = new Map<string, Evidence>();
  readonly questions = new Map<string, Question>();
  readonly decisions = new Map<string, Decision>();
  readonly events: EventEnvelopeV2[] = [];
  private eventSequence = 0;

  private emitEvent<T = Record<string, unknown>>(
    type: ArpV2EventType,
    aggregateType: string,
    aggregateId: string,
    payload: T,
    idempotencyKey: string | null = null,
  ): EventEnvelopeV2<T> {
    this.eventSequence += 1;
    const now = nowTimestamp();
    const eventId = generateUuid7();

    const ev: EventEnvelopeV2<T> = {
      eventId,
      eventType: type,
      schemaVersion: 2,
      aggregateType,
      aggregateId,
      aggregateSequence: this.eventSequence,
      occurredAt: now,
      actor: { kind: "system", id: "arp-v2-fixture-server" },
      correlationId: null,
      causationId: null,
      idempotencyKey,
      payload,
      artifactRefs: [],
      traceId: `trace-${eventId}` as TraceId,
    };

    this.events.push(ev as unknown as EventEnvelopeV2);
    return ev;
  }

  // ────────────────────────── Task Operations ────────────────────────────────

  async createTask(params: {
    contract: TaskContractV2;
    idempotencyKey: string;
    organizationId?: string;
    departmentId?: string;
    missionId?: string | null;
  }): Promise<{ task: TaskV2; cursor: string }> {
    return (
      await this.idempotency.execute(params.idempotencyKey, "global-tasks", null, async () => {
        const taskId = generateUuid7();
        const now = nowTimestamp();

        const task: TaskV2 = {
          id: taskId,
          missionId: params.missionId ?? null,
          organizationId: params.organizationId ?? "org-default",
          departmentId: params.departmentId ?? "dept-default",
          createdBy: "principal-system",
          contract: params.contract,
          status: "DRAFT",
          version: 1,
          createdAt: now,
          updatedAt: now,
          completedAt: null,
        };

        this.tasks.set(taskId, task);
        this.idempotency.setVersion(taskId, 1);

        const ev = this.emitEvent(
          "task.created",
          "task",
          taskId,
          {
            taskId,
            missionId: task.missionId,
            organizationId: task.organizationId,
            departmentId: task.departmentId,
            objective: task.contract.mission,
            contractVersion: task.contract.version,
            mode: task.contract.mode,
          },
          params.idempotencyKey,
        );

        const cursor = CursorCodec.encode({
          version: 2,
          aggregateId: taskId,
          sequence: ev.aggregateSequence,
          occurredAt: ev.occurredAt,
          eventId: ev.eventId,
        });

        return { task, cursor };
      })
    ).result;
  }

  async transitionTask(params: {
    taskId: string;
    targetStatus: TaskV2["status"];
    idempotencyKey: string;
    expectedVersion?: number | null;
  }): Promise<TaskV2> {
    return (
      await this.idempotency.execute(
        params.idempotencyKey,
        params.taskId,
        params.expectedVersion ?? null,
        async () => {
          const task = this.tasks.get(params.taskId);
          if (!task) throw new Error(`task ${params.taskId} not found`);

          const updated: TaskV2 = {
            ...task,
            status: params.targetStatus,
            version: task.version + 1,
            updatedAt: nowTimestamp(),
            completedAt:
              params.targetStatus === "COMPLETED" || params.targetStatus === "FAILED" || params.targetStatus === "CANCELLED"
                ? nowTimestamp()
                : null,
          };

          this.tasks.set(params.taskId, updated);

          const eventType = (`task.${params.targetStatus.toLowerCase()}`) as ArpV2EventType;
          this.emitEvent(
            eventType,
            "task",
            params.taskId,
            {
              taskId: params.taskId,
              fromStatus: task.status,
              toStatus: params.targetStatus,
              version: updated.version,
              reason: null,
            },
            params.idempotencyKey,
          );

          return updated;
        },
      )
    ).result;
  }

  // ────────────────────────── Effect Operations ──────────────────────────────

  async proposeEffect(params: {
    taskId: string;
    attemptId: string;
    connectorOrWorker: string;
    intentType: string;
    canonicalParameters: Record<string, unknown>;
    resourceHandles?: ResourceHandle[];
    effectClass: string;
    semanticIdempotencyKey: string;
  }): Promise<EffectRecord> {
    return (
      await this.idempotency.execute(
        params.semanticIdempotencyKey,
        params.taskId,
        null,
        async () => {
          const effectId = generateUuid7();
          const now = nowTimestamp();

          const effect: EffectRecord = {
            id: effectId,
            taskId: params.taskId,
            attemptId: params.attemptId,
            principal: "principal-system",
            connectorOrWorker: params.connectorOrWorker,
            intentType: params.intentType,
            canonicalParameters: params.canonicalParameters,
            resourceHandles: params.resourceHandles ?? [],
            effectClass: params.effectClass,
            semanticIdempotencyKey: params.semanticIdempotencyKey,
            authorizationId: null,
            policyDecisionId: null,
            state: "PROPOSED",
            uncertaintyReason: null,
            compensationRef: null,
            version: 0,
            createdAt: now,
            settledAt: null,
          };

          this.effects.set(effectId, effect);
          this.idempotency.setVersion(effectId, 0);

          this.emitEvent(
            "effect.proposed",
            "effect",
            effectId,
            {
              effectId,
              taskId: effect.taskId,
              attemptId: effect.attemptId,
              principal: effect.principal,
              connectorOrWorker: effect.connectorOrWorker,
              effectClass: effect.effectClass,
              intentType: effect.intentType,
              canonicalParameters: effect.canonicalParameters,
              semanticIdempotencyKey: effect.semanticIdempotencyKey,
              resourceHandles: effect.resourceHandles,
            },
            params.semanticIdempotencyKey,
          );

          return effect;
        },
      )
    ).result;
  }

  async transitionEffect(params: {
    effectId: string;
    targetState: EffectRecord["state"];
    idempotencyKey: string;
    expectedVersion?: number | null;
    reason?: string | null;
  }): Promise<EffectRecord> {
    return (
      await this.idempotency.execute(
        params.idempotencyKey,
        params.effectId,
        params.expectedVersion ?? null,
        async () => {
          const effect = this.effects.get(params.effectId);
          if (!effect) throw new Error(`effect ${params.effectId} not found`);

          if (!isEffectTransitionAllowed(effect.state, params.targetState)) {
            throw new Error(`illegal effect transition from ${effect.state} to ${params.targetState}`);
          }

          const updated: EffectRecord = {
            ...effect,
            state: params.targetState,
            version: effect.version + 1,
            settledAt:
              params.targetState === "COMMITTED" ||
              params.targetState === "DENIED" ||
              params.targetState === "CANCELLED" ||
              params.targetState === "COMPENSATED"
                ? nowTimestamp()
                : null,
          };

          this.effects.set(params.effectId, updated);

          const eventType = (`effect.${params.targetState.toLowerCase()}`) as ArpV2EventType;
          this.emitEvent(
            eventType,
            "effect",
            params.effectId,
            {
              effectId: params.effectId,
              taskId: effect.taskId,
              fromState: effect.state,
              toState: params.targetState,
              version: updated.version,
              reason: params.reason ?? null,
              uncertaintyReason: null,
              compensationRef: null,
            },
            params.idempotencyKey,
          );

          return updated;
        },
      )
    ).result;
  }

  // ────────────────────────── Event Streaming ────────────────────────────────

  getEventsSince(cursorToken: string | null, taskId?: string): { events: EventEnvelopeV2[]; nextCursor: string } {
    let startSeq = 0;
    if (cursorToken) {
      const decoded = CursorCodec.decode(cursorToken);
      startSeq = decoded.sequence;
    }

    const filtered = this.events.filter((e) => {
      if (e.aggregateSequence <= startSeq) return false;
      if (taskId && payloadTaskId(e.payload) !== null && payloadTaskId(e.payload) !== taskId) return false;
      return true;
    });

    const lastEvent = filtered[filtered.length - 1] ?? this.events[this.events.length - 1];
    const nextCursor = lastEvent
      ? CursorCodec.encode({
          version: 2,
          aggregateId: lastEvent.aggregateId,
          sequence: lastEvent.aggregateSequence,
          occurredAt: lastEvent.occurredAt,
          eventId: lastEvent.eventId,
        })
      : cursorToken ?? "";

    return { events: filtered, nextCursor };
  }
}

function payloadTaskId(payload: unknown): string | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const taskId = (payload as Readonly<Record<string, unknown>>).taskId;
  return typeof taskId === "string" ? taskId : null;
}

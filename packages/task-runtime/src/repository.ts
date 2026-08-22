/**
 * @terminus/task-runtime — In-Memory & Event-Sourced Durable Task Repository.
 *
 * Per SPEC §6, §7, §8, §10, §14, §28, §29:
 * Reference repository implementation providing transactional guarantees,
 * outbox/inbox isolation, and startup replay from semantic event logs.
 */
import type {
  TaskV2,
  Workflow,
  NodeRun,
  WorkerLease,
  TaskAttempt,
  Question,
  Decision,
  Risk,
  BudgetConsumption,
  OutboxMessage,
  InboxMessage,
  Rfc3339Timestamp,
} from "@terminus/domain";
import type { EventEnvelopeV2 } from "@terminus/runtime-protocol";
import type { DurableTaskRepository } from "./types.js";

function clone<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (typeof value === "bigint") return value;
  if (Array.isArray(value)) return value.map(clone) as unknown as T;
  const copy: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    copy[k] = clone(v);
  }
  return copy as unknown as T;
}

export class InMemoryDurableTaskRepository implements DurableTaskRepository {
  private readonly tasks = new Map<string, TaskV2>();
  private readonly workflows = new Map<string, Workflow>();
  private readonly nodeRuns = new Map<string, NodeRun>();
  private readonly leases = new Map<string, WorkerLease>();
  private readonly attempts = new Map<string, TaskAttempt>();
  private readonly questions = new Map<string, Question>();
  private readonly decisions = new Map<string, Decision>();
  private readonly risks = new Map<string, Risk>();
  private readonly budgets = new Map<string, BudgetConsumption>();
  private readonly outbox = new Map<string, OutboxMessage>();
  private readonly inbox = new Map<string, InboxMessage>();

  async createTaskV2(task: TaskV2, outboxMessage?: OutboxMessage): Promise<TaskV2> {
    this.tasks.set(task.id, clone(task));
    if (outboxMessage) {
      this.outbox.set(outboxMessage.id, clone(outboxMessage));
    }
    return clone(task);
  }

  async getTaskV2(id: string): Promise<TaskV2 | null> {
    const t = this.tasks.get(id);
    return t ? clone(t) : null;
  }

  async updateTaskV2(task: TaskV2, outboxMessage?: OutboxMessage): Promise<TaskV2> {
    this.tasks.set(task.id, clone(task));
    if (outboxMessage) {
      this.outbox.set(outboxMessage.id, clone(outboxMessage));
    }
    return clone(task);
  }

  async listTasksV2(): Promise<readonly TaskV2[]> {
    return Array.from(this.tasks.values()).map(clone);
  }

  async createWorkflow(workflow: Workflow, outboxMessage?: OutboxMessage): Promise<Workflow> {
    this.workflows.set(workflow.id, clone(workflow));
    if (outboxMessage) {
      this.outbox.set(outboxMessage.id, clone(outboxMessage));
    }
    return clone(workflow);
  }

  async getWorkflow(id: string): Promise<Workflow | null> {
    const w = this.workflows.get(id);
    return w ? clone(w) : null;
  }

  async updateWorkflow(workflow: Workflow, outboxMessage?: OutboxMessage): Promise<Workflow> {
    this.workflows.set(workflow.id, clone(workflow));
    if (outboxMessage) {
      this.outbox.set(outboxMessage.id, clone(outboxMessage));
    }
    return clone(workflow);
  }

  async createNodeRun(nodeRun: NodeRun, outboxMessage?: OutboxMessage): Promise<NodeRun> {
    this.nodeRuns.set(nodeRun.id, clone(nodeRun));
    if (outboxMessage) {
      this.outbox.set(outboxMessage.id, clone(outboxMessage));
    }
    return clone(nodeRun);
  }

  async getNodeRun(id: string): Promise<NodeRun | null> {
    const r = this.nodeRuns.get(id);
    return r ? clone(r) : null;
  }

  async updateNodeRun(nodeRun: NodeRun, outboxMessage?: OutboxMessage): Promise<NodeRun> {
    this.nodeRuns.set(nodeRun.id, clone(nodeRun));
    if (outboxMessage) {
      this.outbox.set(outboxMessage.id, clone(outboxMessage));
    }
    return clone(nodeRun);
  }

  async listNodeRuns(workflowId: string): Promise<readonly NodeRun[]> {
    return Array.from(this.nodeRuns.values())
      .filter((r) => r.workflowId === workflowId)
      .map(clone);
  }

  async createLease(lease: WorkerLease, outboxMessage?: OutboxMessage): Promise<WorkerLease> {
    this.leases.set(lease.id, clone(lease));
    if (outboxMessage) {
      this.outbox.set(outboxMessage.id, clone(outboxMessage));
    }
    return clone(lease);
  }

  async getLease(id: string): Promise<WorkerLease | null> {
    const l = this.leases.get(id);
    return l ? clone(l) : null;
  }

  async getActiveLeaseForTask(taskId: string): Promise<WorkerLease | null> {
    const now = Date.now();
    for (const lease of this.leases.values()) {
      if (
        lease.taskId === taskId &&
        (lease.status === "ACQUIRED" || lease.status === "RENEWED")
      ) {
        const exp = new Date(lease.expiresAt).getTime();
        if (exp > now) {
          return clone(lease);
        }
      }
    }
    return null;
  }

  async updateLease(lease: WorkerLease, outboxMessage?: OutboxMessage): Promise<WorkerLease> {
    this.leases.set(lease.id, clone(lease));
    if (outboxMessage) {
      this.outbox.set(outboxMessage.id, clone(outboxMessage));
    }
    return clone(lease);
  }

  async listLeasesForTask(taskId: string): Promise<readonly WorkerLease[]> {
    return Array.from(this.leases.values())
      .filter((l) => l.taskId === taskId)
      .map(clone);
  }

  async createAttempt(attempt: TaskAttempt, outboxMessage?: OutboxMessage): Promise<TaskAttempt> {
    this.attempts.set(attempt.id, clone(attempt));
    if (outboxMessage) {
      this.outbox.set(outboxMessage.id, clone(outboxMessage));
    }
    return clone(attempt);
  }

  async getAttempt(id: string): Promise<TaskAttempt | null> {
    const a = this.attempts.get(id);
    return a ? clone(a) : null;
  }

  async updateAttempt(attempt: TaskAttempt, outboxMessage?: OutboxMessage): Promise<TaskAttempt> {
    this.attempts.set(attempt.id, clone(attempt));
    if (outboxMessage) {
      this.outbox.set(outboxMessage.id, clone(outboxMessage));
    }
    return clone(attempt);
  }

  async listAttempts(taskId: string): Promise<readonly TaskAttempt[]> {
    return Array.from(this.attempts.values())
      .filter((a) => a.taskId === taskId)
      .map(clone);
  }

  async createQuestion(question: Question, outboxMessage?: OutboxMessage): Promise<Question> {
    this.questions.set(question.id, clone(question));
    if (outboxMessage) {
      this.outbox.set(outboxMessage.id, clone(outboxMessage));
    }
    return clone(question);
  }

  async getQuestion(id: string): Promise<Question | null> {
    const q = this.questions.get(id);
    return q ? clone(q) : null;
  }

  async updateQuestion(question: Question, outboxMessage?: OutboxMessage): Promise<Question> {
    this.questions.set(question.id, clone(question));
    if (outboxMessage) {
      this.outbox.set(outboxMessage.id, clone(outboxMessage));
    }
    return clone(question);
  }

  async listQuestions(taskId: string): Promise<readonly Question[]> {
    return Array.from(this.questions.values())
      .filter((q) => q.taskId === taskId)
      .map(clone);
  }

  async createDecision(decision: Decision, outboxMessage?: OutboxMessage): Promise<Decision> {
    this.decisions.set(decision.id, clone(decision));
    if (outboxMessage) {
      this.outbox.set(outboxMessage.id, clone(outboxMessage));
    }
    return clone(decision);
  }

  async getDecision(id: string): Promise<Decision | null> {
    const d = this.decisions.get(id);
    return d ? clone(d) : null;
  }

  async listDecisions(taskId: string): Promise<readonly Decision[]> {
    return Array.from(this.decisions.values())
      .filter((d) => d.taskId === taskId)
      .map(clone);
  }

  async createRisk(risk: Risk, outboxMessage?: OutboxMessage): Promise<Risk> {
    this.risks.set(risk.id, clone(risk));
    if (outboxMessage) {
      this.outbox.set(outboxMessage.id, clone(outboxMessage));
    }
    return clone(risk);
  }

  async getRisk(id: string): Promise<Risk | null> {
    const r = this.risks.get(id);
    return r ? clone(r) : null;
  }

  async updateRisk(risk: Risk, outboxMessage?: OutboxMessage): Promise<Risk> {
    this.risks.set(risk.id, clone(risk));
    if (outboxMessage) {
      this.outbox.set(outboxMessage.id, clone(outboxMessage));
    }
    return clone(risk);
  }

  async listRisks(taskId: string): Promise<readonly Risk[]> {
    return Array.from(this.risks.values())
      .filter((r) => r.taskId === taskId)
      .map(clone);
  }

  async getBudgetConsumption(taskId: string): Promise<BudgetConsumption | null> {
    const b = this.budgets.get(taskId);
    return b ? clone(b) : null;
  }

  async saveBudgetConsumption(
    consumption: BudgetConsumption,
    outboxMessage?: OutboxMessage,
  ): Promise<BudgetConsumption> {
    this.budgets.set(consumption.taskId, clone(consumption));
    if (outboxMessage) {
      this.outbox.set(outboxMessage.id, clone(outboxMessage));
    }
    return clone(consumption);
  }

  async saveOutboxMessage(message: OutboxMessage): Promise<void> {
    this.outbox.set(message.id, clone(message));
  }

  async listPendingOutboxMessages(): Promise<readonly OutboxMessage[]> {
    return Array.from(this.outbox.values())
      .filter((m) => !m.delivered)
      .sort((a, b) => a.sequence - b.sequence)
      .map(clone);
  }

  async listAllOutboxMessages(): Promise<readonly OutboxMessage[]> {
    return Array.from(this.outbox.values())
      .sort((a, b) => a.sequence - b.sequence)
      .map(clone);
  }

  async markOutboxDelivered(id: string, publishedAt: Rfc3339Timestamp): Promise<void> {
    const msg = this.outbox.get(id);
    if (msg) {
      this.outbox.set(id, {
        ...msg,
        delivered: true,
        publishedAt,
      });
    }
  }

  async saveInboxMessage(message: InboxMessage): Promise<void> {
    this.inbox.set(message.idempotencyKey, clone(message));
  }

  async getInboxMessage(idempotencyKey: string): Promise<InboxMessage | null> {
    const m = this.inbox.get(idempotencyKey);
    return m ? clone(m) : null;
  }

  async updateInboxMessage(message: InboxMessage): Promise<void> {
    this.inbox.set(message.idempotencyKey, clone(message));
  }

  async replayFromEvents(events: readonly EventEnvelopeV2[]): Promise<void> {
    for (const ev of events) {
      const p = ev.payload as Record<string, unknown>;
      switch (ev.eventType) {
        case "task.created": {
          const task: TaskV2 = {
            id: ev.aggregateId,
            missionId: (p.missionId as string | null) ?? null,
            organizationId: (p.organizationId as string) ?? "default-org",
            departmentId: (p.departmentId as string) ?? "default-dept",
            createdBy: ev.actor.id,
            contract: {
              version: (p.contractVersion as number) ?? 1,
              mission: (p.objective as string) ?? "replayed-task",
              scope: { resources: [], allowedEffectClasses: [], excludedPathsOrSystems: [] },
              acceptance: [],
              constraints: { security: [], costMicros: 0n, timeoutSeconds: 3600 },
              authorityCeiling: [],
              mode: (p.mode as string) ?? "interactive",
            },
            status: "DRAFT",
            version: 1,
            createdAt: ev.occurredAt,
            updatedAt: ev.occurredAt,
            completedAt: null,
          };
          this.tasks.set(task.id, task);
          break;
        }
        case "task.ready":
        case "task.running":
        case "task.waiting_user":
        case "task.waiting_auth":
        case "task.waiting_resource":
        case "task.paused":
        case "task.verifying":
        case "task.completed":
        case "task.partial":
        case "task.blocked":
        case "task.cancelled":
        case "task.failed": {
          const current = this.tasks.get(ev.aggregateId);
          if (current) {
            const toStatus = p.toStatus as TaskV2["status"];
            const version = (p.version as number) ?? current.version + 1;
            const completedAt =
              toStatus === "COMPLETED" ||
              toStatus === "PARTIAL" ||
              toStatus === "CANCELLED" ||
              toStatus === "FAILED"
                ? ev.occurredAt
                : current.completedAt;
            this.tasks.set(ev.aggregateId, {
              ...current,
              status: toStatus,
              version,
              updatedAt: ev.occurredAt,
              completedAt,
            });
          }
          break;
        }
        case "lease.acquired":
        case "lease.renewed": {
          const lease: WorkerLease = {
            id: (p.leaseId as string) ?? ev.aggregateId,
            taskId: (p.taskId as string) ?? ev.aggregateId,
            workerId: (p.workerId as string) ?? ev.actor.id,
            fencingToken: (p.fencingToken as number) ?? 1,
            status: ev.eventType === "lease.acquired" ? "ACQUIRED" : "RENEWED",
            acquiredAt: ev.occurredAt,
            expiresAt: ((p.expiresAt as string) ?? ev.occurredAt) as Rfc3339Timestamp,
            releasedAt: null,
            metadata: {},
          };
          this.leases.set(lease.id, lease);
          break;
        }
        case "lease.released": {
          const leaseId = (p.leaseId as string) ?? ev.aggregateId;
          const current = this.leases.get(leaseId);
          if (current) {
            this.leases.set(leaseId, {
              ...current,
              status: "RELEASED",
              releasedAt: ev.occurredAt,
            });
          }
          break;
        }
        case "lease.fenced": {
          const leaseId = (p.leaseId as string) ?? ev.aggregateId;
          const current = this.leases.get(leaseId);
          if (current) {
            this.leases.set(leaseId, {
              ...current,
              status: "FENCED",
              releasedAt: ev.occurredAt,
            });
          }
          break;
        }
        case "workflow.created": {
          const wf: Workflow = {
            id: (p.workflowId as string) ?? ev.aggregateId,
            version: (p.version as number) ?? 1,
            taskId: (p.taskId as string) ?? "",
            nodes: [],
            edges: [],
            createdAt: ev.occurredAt,
          };
          this.workflows.set(wf.id, wf);
          break;
        }
        case "attempt.started": {
          const attempt: TaskAttempt = {
            id: (p.attemptId as string) ?? ev.aggregateId,
            taskId: (p.taskId as string) ?? "",
            attemptNumber: (p.attemptNumber as number) ?? 1,
            workerId: (p.workerId as string) ?? "",
            fencingToken: (p.fencingToken as number) ?? 1,
            status: "RUNNING",
            startedAt: ev.occurredAt,
            settledAt: null,
            error: null,
          };
          this.attempts.set(attempt.id, attempt);
          break;
        }
        case "attempt.completed":
        case "attempt.failed": {
          const attemptId = (p.attemptId as string) ?? ev.aggregateId;
          const current = this.attempts.get(attemptId);
          if (current) {
            this.attempts.set(attemptId, {
              ...current,
              status: ev.eventType === "attempt.completed" ? "COMPLETED" : "FAILED",
              error: (p.error as string | null) ?? current.error,
              settledAt: ev.occurredAt,
            });
          }
          break;
        }
        case "question.asked": {
          const q: Question = {
            id: (p.questionId as string) ?? ev.aggregateId,
            taskId: (p.taskId as string) ?? "",
            prompt: (p.prompt as string) ?? "",
            options: (p.options as readonly string[]) ?? [],
            selectedOption: null,
            rationale: null,
            status: "PENDING",
            createdAt: ev.occurredAt,
            resolvedAt: null,
          };
          this.questions.set(q.id, q);
          break;
        }
        case "question.answered": {
          const qId = (p.questionId as string) ?? ev.aggregateId;
          const current = this.questions.get(qId);
          if (current) {
            this.questions.set(qId, {
              ...current,
              selectedOption: (p.selectedOption as string) ?? current.selectedOption,
              rationale: (p.rationale as string | null) ?? current.rationale,
              status: "ANSWERED",
              resolvedAt: ev.occurredAt,
            });
          }
          break;
        }
        case "question.dismissed": {
          const qId = (p.questionId as string) ?? ev.aggregateId;
          const current = this.questions.get(qId);
          if (current) {
            this.questions.set(qId, {
              ...current,
              status: "DISMISSED",
              resolvedAt: ev.occurredAt,
            });
          }
          break;
        }
        case "decision.recorded": {
          const d: Decision = {
            id: (p.decisionId as string) ?? ev.aggregateId,
            taskId: (p.taskId as string) ?? "",
            questionId: (p.questionId as string | null) ?? null,
            statement: (p.statement as string) ?? "",
            alternativesConsidered: (p.alternativesConsidered as readonly string[]) ?? [],
            rationale: (p.rationale as string) ?? "",
            provenance: (p.provenance as string) ?? "",
            recordedAt: ev.occurredAt,
          };
          this.decisions.set(d.id, d);
          break;
        }
        case "risk.recorded": {
          const r: Risk = {
            id: (p.riskId as string) ?? ev.aggregateId,
            taskId: (p.taskId as string) ?? "",
            riskClass: (p.riskClass as Risk["riskClass"]) ?? "NORMAL",
            statement: (p.statement as string) ?? "",
            mitigation: (p.mitigation as string | null) ?? null,
            status: "IDENTIFIED",
            recordedAt: ev.occurredAt,
          };
          this.risks.set(r.id, r);
          break;
        }
        case "risk.mitigated": {
          const riskId = (p.riskId as string) ?? ev.aggregateId;
          const current = this.risks.get(riskId);
          if (current) {
            this.risks.set(riskId, {
              ...current,
              mitigation: (p.mitigation as string) ?? current.mitigation,
              status: "MITIGATED",
            });
          }
          break;
        }
        case "budget.consumed": {
          const taskId = (p.taskId as string) ?? ev.aggregateId;
          const current = this.budgets.get(taskId) ?? {
            taskId,
            consumedCostMicros: 0n,
            consumedComputeSeconds: 0,
            consumedInputTokens: 0n,
            consumedOutputTokens: 0n,
            consumedApprovals: 0,
            lastUpdatedAt: ev.occurredAt,
          };
          this.budgets.set(taskId, {
            taskId,
            consumedCostMicros: (p.consumedCostMicros as bigint) ?? current.consumedCostMicros,
            consumedComputeSeconds: (p.consumedComputeSeconds as number) ?? current.consumedComputeSeconds,
            consumedInputTokens: (p.consumedInputTokens as bigint) ?? current.consumedInputTokens,
            consumedOutputTokens: (p.consumedOutputTokens as bigint) ?? current.consumedOutputTokens,
            consumedApprovals: (p.consumedApprovals as number) ?? current.consumedApprovals,
            lastUpdatedAt: ev.occurredAt,
          });
          break;
        }
      }
    }
  }

  async clear(): Promise<void> {
    this.tasks.clear();
    this.workflows.clear();
    this.nodeRuns.clear();
    this.leases.clear();
    this.attempts.clear();
    this.questions.clear();
    this.decisions.clear();
    this.risks.clear();
    this.budgets.clear();
    this.outbox.clear();
    this.inbox.clear();
  }
}

/**
 * @terminus/task-runtime — Core Types for Durable Task Substrate.
 *
 * Per SPEC §6, §7, §8, §10, §14, §28, §29:
 * Interfaces for durable repositories, outbox/inbox relay, worker leases,
 * workflow execution, questions, decisions, risks, and budget tracking.
 */
import type {
  Task,
  TaskV2,
  TaskContractV2,
  Workflow,
  WorkflowNode,
  GuardedEdge,
  NodeRun,
  WorkerLease,
  TaskAttempt,
  Question,
  Decision,
  Risk,
  BudgetConsumption,
  OutboxMessage,
  InboxMessage,
  EffectRecord,
  AuthorizationInstance,
  ResourceHandle,
  ApprovalPresentation,
  SequencePolicyRule,
  EffectState,
  EffectClass,
  TaskStatusV2,
  WorkflowStatus,
  NodeRunStatus,
  AttemptStatus,
  LeaseStatus,
  Uuid7,
  Rfc3339Timestamp,
  PrincipalId,
} from "@terminus/domain";
import type { EventEnvelopeV2, TypedEventV2, ArpV2EventType } from "@terminus/runtime-protocol";

export interface DurableTaskRepository {
  // Tasks v2
  createTaskV2(task: TaskV2, outboxMessage?: OutboxMessage): Promise<TaskV2>;
  getTaskV2(id: string): Promise<TaskV2 | null>;
  updateTaskV2(task: TaskV2, outboxMessage?: OutboxMessage): Promise<TaskV2>;
  listTasksV2(): Promise<readonly TaskV2[]>;

  // Workflows & Node Runs
  createWorkflow(workflow: Workflow, outboxMessage?: OutboxMessage): Promise<Workflow>;
  getWorkflow(id: string): Promise<Workflow | null>;
  updateWorkflow(workflow: Workflow, outboxMessage?: OutboxMessage): Promise<Workflow>;
  createNodeRun(nodeRun: NodeRun, outboxMessage?: OutboxMessage): Promise<NodeRun>;
  getNodeRun(id: string): Promise<NodeRun | null>;
  updateNodeRun(nodeRun: NodeRun, outboxMessage?: OutboxMessage): Promise<NodeRun>;
  listNodeRuns(workflowId: string): Promise<readonly NodeRun[]>;

  // Worker Leases
  createLease(lease: WorkerLease, outboxMessage?: OutboxMessage): Promise<WorkerLease>;
  getLease(id: string): Promise<WorkerLease | null>;
  getActiveLeaseForTask(taskId: string): Promise<WorkerLease | null>;
  updateLease(lease: WorkerLease, outboxMessage?: OutboxMessage): Promise<WorkerLease>;
  listLeasesForTask(taskId: string): Promise<readonly WorkerLease[]>;

  // Task Attempts
  createAttempt(attempt: TaskAttempt, outboxMessage?: OutboxMessage): Promise<TaskAttempt>;
  getAttempt(id: string): Promise<TaskAttempt | null>;
  updateAttempt(attempt: TaskAttempt, outboxMessage?: OutboxMessage): Promise<TaskAttempt>;
  listAttempts(taskId: string): Promise<readonly TaskAttempt[]>;

  // Questions, Decisions, Risks & Budgets
  createQuestion(question: Question, outboxMessage?: OutboxMessage): Promise<Question>;
  getQuestion(id: string): Promise<Question | null>;
  updateQuestion(question: Question, outboxMessage?: OutboxMessage): Promise<Question>;
  listQuestions(taskId: string): Promise<readonly Question[]>;

  createDecision(decision: Decision, outboxMessage?: OutboxMessage): Promise<Decision>;
  getDecision(id: string): Promise<Decision | null>;
  listDecisions(taskId: string): Promise<readonly Decision[]>;

  createRisk(risk: Risk, outboxMessage?: OutboxMessage): Promise<Risk>;
  getRisk(id: string): Promise<Risk | null>;
  updateRisk(risk: Risk, outboxMessage?: OutboxMessage): Promise<Risk>;
  listRisks(taskId: string): Promise<readonly Risk[]>;

  getBudgetConsumption(taskId: string): Promise<BudgetConsumption | null>;
  saveBudgetConsumption(consumption: BudgetConsumption, outboxMessage?: OutboxMessage): Promise<BudgetConsumption>;

  // Phase 3: Transactional Effect Ledger & Authorization
  createEffectRecord(effect: EffectRecord, outboxMessage?: OutboxMessage): Promise<EffectRecord>;
  getEffectRecord(id: string): Promise<EffectRecord | null>;
  getEffectBySemanticKey(semanticKey: string): Promise<EffectRecord | null>;
  updateEffectRecord(effect: EffectRecord, outboxMessage?: OutboxMessage): Promise<EffectRecord>;
  listEffects(taskId: string): Promise<readonly EffectRecord[]>;

  createAuthorization(authz: AuthorizationInstance, outboxMessage?: OutboxMessage): Promise<AuthorizationInstance>;
  getAuthorization(id: string): Promise<AuthorizationInstance | null>;
  updateAuthorization(authz: AuthorizationInstance, outboxMessage?: OutboxMessage): Promise<AuthorizationInstance>;
  listAuthorizations(taskId: string): Promise<readonly AuthorizationInstance[]>;

  saveResourceHandle(handle: ResourceHandle, outboxMessage?: OutboxMessage): Promise<ResourceHandle>;
  getResourceHandle(objectId: string): Promise<ResourceHandle | null>;
  listResourceHandles(taskBinding: string): Promise<readonly ResourceHandle[]>;

  saveSequencePolicyRule(rule: SequencePolicyRule): Promise<void>;
  listSequencePolicyRules(): Promise<readonly SequencePolicyRule[]>;

  saveApprovalPresentation(presentation: ApprovalPresentation, outboxMessage?: OutboxMessage): Promise<ApprovalPresentation>;
  getApprovalPresentation(approvalId: string): Promise<ApprovalPresentation | null>;

  // Outbox & Inbox
  saveOutboxMessage(message: OutboxMessage): Promise<void>;
  listPendingOutboxMessages(): Promise<readonly OutboxMessage[]>;
  listAllOutboxMessages(): Promise<readonly OutboxMessage[]>;
  markOutboxDelivered(id: string, publishedAt: Rfc3339Timestamp): Promise<void>;

  saveInboxMessage(message: InboxMessage): Promise<void>;
  getInboxMessage(idempotencyKey: string): Promise<InboxMessage | null>;
  updateInboxMessage(message: InboxMessage): Promise<void>;

  // Recovery & Replay
  replayFromEvents(events: readonly EventEnvelopeV2[]): Promise<void>;
  clear(): Promise<void>;
}


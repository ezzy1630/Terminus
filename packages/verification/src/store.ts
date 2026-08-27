/**
 * Durable verification store — plans, nodes, edges, attempts, evidence,
 * completion records. Repository interface only; no Prisma import here.
 *
 * Per SPEC §40, ADR-0005, ADR-0021.
 */
import type {
  VerificationPlan,
  VerificationNode,
  VerificationEdge,
  VerificationResult,
  CompletionRecord,
  Uuid7,
  Rfc3339Timestamp,
  ArtifactRef,
  ContentHash,
} from "@terminus/domain";
import { ValidationError } from "@terminus/domain";
import type { ClaimEvidenceGraph } from "./evidence.js";
import type { VerifierBinding } from "./run-binding.js";

export interface VerificationLifecycleBinding {
  readonly planId: Uuid7;
  readonly criteriaHash: ContentHash;
  readonly verifierBinding: VerifierBinding | null;
  readonly resultsHash: ContentHash | null;
  readonly invalidatedNodeIds: readonly string[];
}

/** One recorded attempt at evaluating a verification node. */
export interface VerificationAttemptRecord {
  readonly id: Uuid7;
  readonly planId: Uuid7;
  readonly nodeId: string;
  readonly attempt: number;
  readonly status: VerificationResult["status"];
  readonly sourceRevision: string;
  readonly environmentImageDigest: string | null;
  readonly evidence: readonly ArtifactRef[];
  readonly toolCallId: Uuid7 | null;
  readonly startedAt: Rfc3339Timestamp;
  readonly completedAt: Rfc3339Timestamp | null;
  readonly reason: string | null;
  readonly observations: Readonly<Record<string, unknown>>;
  readonly commandOrQuery: string;
  readonly exitCode: number | null;
  readonly verifierVersion: string;
}

export interface VerificationStore {
  savePlan(plan: VerificationPlan): Promise<VerificationPlan>;
  getPlan(planId: Uuid7): Promise<VerificationPlan | null>;
  listPlansForTask(taskId: Uuid7): Promise<readonly VerificationPlan[]>;

  saveNodes(planId: Uuid7, nodes: readonly VerificationNode[]): Promise<void>;
  saveEdges(planId: Uuid7, edges: readonly VerificationEdge[]): Promise<void>;
  saveLifecycleBinding(binding: VerificationLifecycleBinding): Promise<void>;
  getLifecycleBinding(planId: Uuid7): Promise<VerificationLifecycleBinding | null>;

  saveAttempt(attempt: VerificationAttemptRecord): Promise<VerificationAttemptRecord>;
  listAttempts(planId: Uuid7, nodeId?: string): Promise<readonly VerificationAttemptRecord[]>;

  saveResult(result: VerificationResult): Promise<VerificationResult>;
  listResults(planId: Uuid7): Promise<readonly VerificationResult[]>;
  deleteResults(planId: Uuid7, nodeIds: ReadonlySet<string>): Promise<void>;
  saveEvidenceGraph(planId: Uuid7, graph: ClaimEvidenceGraph): Promise<void>;
  getEvidenceGraph(planId: Uuid7): Promise<ClaimEvidenceGraph | null>;
  deleteEvidenceGraph(planId: Uuid7): Promise<void>;

  saveCompletionRecord(record: CompletionRecord): Promise<CompletionRecord>;
  getCompletionRecord(taskId: Uuid7): Promise<CompletionRecord | null>;
}

/**
 * In-memory store for tests and local harnesses. Preserves insertion order.
 * Not process-safe; production uses a Prisma-backed adapter in the control plane.
 */
export class InMemoryVerificationStore implements VerificationStore {
  private readonly plans = new Map<string, VerificationPlan>();
  private readonly taskIndex = new Map<string, Set<string>>();
  private readonly attempts: VerificationAttemptRecord[] = [];
  private readonly results = new Map<string, VerificationResult[]>();
  private readonly evidenceGraphs = new Map<string, ClaimEvidenceGraph>();
  private readonly completions = new Map<string, CompletionRecord>();
  private readonly lifecycleBindings = new Map<string, VerificationLifecycleBinding>();

  async savePlan(plan: VerificationPlan): Promise<VerificationPlan> {
    this.plans.set(plan.id, plan);
    const taskId = plan.taskContractId;
    const set = this.taskIndex.get(taskId) ?? new Set<string>();
    set.add(plan.id);
    this.taskIndex.set(taskId, set);
    return plan;
  }

  async getPlan(planId: Uuid7): Promise<VerificationPlan | null> {
    return this.plans.get(planId) ?? null;
  }

  async listPlansForTask(taskId: Uuid7): Promise<readonly VerificationPlan[]> {
    const ids = this.taskIndex.get(taskId);
    if (!ids) return [];
    return [...ids]
      .map((id) => this.plans.get(id))
      .filter((p): p is VerificationPlan => p !== undefined);
  }

  async saveNodes(planId: Uuid7, nodes: readonly VerificationNode[]): Promise<void> {
    const plan = this.plans.get(planId);
    if (!plan) throw new ValidationError("verification plan not found", { planId });
    this.plans.set(planId, { ...plan, nodes: [...nodes] });
  }

  async saveEdges(planId: Uuid7, edges: readonly VerificationEdge[]): Promise<void> {
    const plan = this.plans.get(planId);
    if (!plan) throw new ValidationError("verification plan not found", { planId });
    this.plans.set(planId, { ...plan, edges: [...edges] });
  }

  async saveLifecycleBinding(binding: VerificationLifecycleBinding): Promise<void> {
    this.lifecycleBindings.set(binding.planId, binding);
  }

  async getLifecycleBinding(planId: Uuid7): Promise<VerificationLifecycleBinding | null> {
    return this.lifecycleBindings.get(planId) ?? null;
  }

  async saveAttempt(attempt: VerificationAttemptRecord): Promise<VerificationAttemptRecord> {
    this.attempts.push(attempt);
    return attempt;
  }

  async listAttempts(planId: Uuid7, nodeId?: string): Promise<readonly VerificationAttemptRecord[]> {
    return this.attempts.filter(
      (a) => a.planId === planId && (nodeId === undefined || a.nodeId === nodeId),
    );
  }

  async saveResult(result: VerificationResult): Promise<VerificationResult> {
    const list = this.results.get(result.planId) ?? [];
    const next = list.filter((r) => r.nodeId !== result.nodeId).concat(result);
    this.results.set(result.planId, next);
    return result;
  }

  async listResults(planId: Uuid7): Promise<readonly VerificationResult[]> {
    return this.results.get(planId) ?? [];
  }

  async deleteResults(planId: Uuid7, nodeIds: ReadonlySet<string>): Promise<void> {
    const list = this.results.get(planId) ?? [];
    this.results.set(
      planId,
      list.filter((r) => !nodeIds.has(r.nodeId)),
    );
  }

  async saveEvidenceGraph(planId: Uuid7, graph: ClaimEvidenceGraph): Promise<void> {
    this.evidenceGraphs.set(planId, graph);
  }

  async getEvidenceGraph(planId: Uuid7): Promise<ClaimEvidenceGraph | null> {
    return this.evidenceGraphs.get(planId) ?? null;
  }

  async deleteEvidenceGraph(planId: Uuid7): Promise<void> {
    this.evidenceGraphs.delete(planId);
  }

  async saveCompletionRecord(record: CompletionRecord): Promise<CompletionRecord> {
    this.completions.set(record.taskId, record);
    return record;
  }

  async getCompletionRecord(taskId: Uuid7): Promise<CompletionRecord | null> {
    return this.completions.get(taskId) ?? null;
  }
}

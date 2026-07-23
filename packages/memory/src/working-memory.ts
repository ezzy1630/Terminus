/**
 * Working memory — deterministic task-state projection (SPEC §16.1 / §39.2).
 */
import type {
  AcceptanceCriterion,
  ContentHash,
  Micros,
  PrincipalId,
  Rfc3339Timestamp,
  Task,
  TaskPhase,
  Uuid7,
} from "@terminus/domain";
import { ValidationError } from "@terminus/domain";

export interface WorkingMemorySnapshot {
  readonly taskId: Uuid7;
  readonly capturedAt: Rfc3339Timestamp;
  readonly phase: TaskPhase;
  readonly contractVersion: number;
  readonly objective: string;
  readonly acceptanceCriteria: readonly WorkingMemoryCriterion[];
  readonly decisions: readonly WorkingMemoryDecision[];
  readonly failedApproaches: readonly WorkingMemoryFailedApproach[];
  readonly modifiedFiles: readonly WorkingMemoryFileChange[];
  readonly diagnosticState: WorkingMemoryDiagnosticState;
  readonly runningJobs: readonly WorkingMemoryJobRef[];
  readonly budgetConsumption: WorkingMemoryBudgetConsumption;
  readonly blockers: readonly WorkingMemoryBlocker[];
}

export interface WorkingMemoryCriterion {
  readonly id: string;
  readonly statement: string;
  readonly required: boolean;
  readonly status: "PASS" | "FAIL" | "UNKNOWN" | "NOT_RUN";
  readonly lastObservedAt: Rfc3339Timestamp | null;
  readonly evidence: readonly string[];
}

export interface WorkingMemoryDecision {
  readonly id: Uuid7;
  readonly kind: "user_decision" | "model_decision" | "scope_expansion" | "policy_override";
  readonly summary: string;
  readonly decidedAt: Rfc3339Timestamp;
  readonly decidedBy: PrincipalId | null;
}

export interface WorkingMemoryFailedApproach {
  readonly id: Uuid7;
  readonly summary: string;
  readonly reason: string;
  readonly attemptedAt: Rfc3339Timestamp;
  readonly evidenceRefs: readonly ContentHash[];
}

export interface WorkingMemoryFileChange {
  readonly path: string;
  readonly changeKind: "created" | "modified" | "deleted";
  readonly sourceVersion: string | null;
  readonly observedAt: Rfc3339Timestamp;
}

export interface WorkingMemoryDiagnosticState {
  readonly failingTests: readonly string[];
  readonly errors: readonly WorkingMemoryDiagnostic[];
  readonly warnings: readonly WorkingMemoryDiagnostic[];
  readonly observedAt: Rfc3339Timestamp;
}

export interface WorkingMemoryDiagnostic {
  readonly path: string;
  readonly message: string;
  readonly severity: "error" | "warning";
  readonly observedAt: Rfc3339Timestamp;
}

export interface WorkingMemoryJobRef {
  readonly jobId: Uuid7;
  readonly label: string;
  readonly startedAt: Rfc3339Timestamp;
}

export interface WorkingMemoryBudgetConsumption {
  readonly modelMicros: Micros;
  readonly modelMicrosLimit: Micros;
  readonly computeSeconds: number;
  readonly computeSecondsLimit: number;
  readonly wallClockSeconds: number;
  readonly wallClockSecondsLimit: number;
  readonly humanApprovals: number;
  readonly humanApprovalsLimit: number;
}

export interface WorkingMemoryBlocker {
  readonly id: Uuid7;
  readonly kind: "awaiting_user" | "missing_dependency" | "policy_denied" | "budget_exhausted" | "other";
  readonly summary: string;
  readonly raisedAt: Rfc3339Timestamp;
}

export interface WorkingMemoryRepository {
  getTask(taskId: Uuid7): Promise<Task | null>;
  listDecisions(taskId: Uuid7): Promise<readonly WorkingMemoryDecision[]>;
  listFailedApproaches(taskId: Uuid7): Promise<readonly WorkingMemoryFailedApproach[]>;
  listModifiedFiles(taskId: Uuid7): Promise<readonly WorkingMemoryFileChange[]>;
  getDiagnosticState(taskId: Uuid7): Promise<WorkingMemoryDiagnosticState>;
  listRunningJobs(taskId: Uuid7): Promise<readonly WorkingMemoryJobRef[]>;
  getBudgetConsumption(taskId: Uuid7): Promise<WorkingMemoryBudgetConsumption>;
  listBlockers(taskId: Uuid7): Promise<readonly WorkingMemoryBlocker[]>;
  listCriterionStatuses(taskId: Uuid7): Promise<ReadonlyMap<string, WorkingMemoryCriterion>>;
}

export interface WorkingMemoryServiceDeps {
  readonly repo: WorkingMemoryRepository;
  readonly clock: () => Rfc3339Timestamp;
}

export class WorkingMemoryService {
  constructor(private readonly deps: WorkingMemoryServiceDeps) {}

  async getWorkingMemory(taskId: Uuid7): Promise<WorkingMemorySnapshot> {
    const task = await this.deps.repo.getTask(taskId);
    if (task === null) {
      throw new ValidationError("task not found", { taskId });
    }
    const [
      decisions,
      failedApproaches,
      modifiedFiles,
      diagnosticState,
      runningJobs,
      budgetConsumption,
      blockers,
      criterionStatuses,
    ] = await Promise.all([
      this.deps.repo.listDecisions(taskId),
      this.deps.repo.listFailedApproaches(taskId),
      this.deps.repo.listModifiedFiles(taskId),
      this.deps.repo.getDiagnosticState(taskId),
      this.deps.repo.listRunningJobs(taskId),
      this.deps.repo.getBudgetConsumption(taskId),
      this.deps.repo.listBlockers(taskId),
      this.deps.repo.listCriterionStatuses(taskId),
    ]);

    const acceptanceCriteria: WorkingMemoryCriterion[] = task.contract.acceptanceCriteria.map(
      (ac: AcceptanceCriterion): WorkingMemoryCriterion => {
        const observed = criterionStatuses.get(ac.id);
        if (observed !== undefined) return observed;
        return {
          id: ac.id,
          statement: ac.statement,
          required: ac.required,
          status: "UNKNOWN",
          lastObservedAt: null,
          evidence: [],
        };
      },
    );

    return {
      taskId,
      capturedAt: this.deps.clock(),
      phase: task.phase,
      contractVersion: task.contract.version,
      objective: task.contract.objective,
      acceptanceCriteria,
      decisions,
      failedApproaches,
      modifiedFiles,
      diagnosticState,
      runningJobs,
      budgetConsumption,
      blockers,
    };
  }
}

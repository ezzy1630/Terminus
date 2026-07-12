/**
 * @terminus/task-runtime — task lifecycle.
 *
 * Per SPEC §28.3, §37.1, §37.3: TaskService with createTask, activate,
 * updateContract (versioned), transition (state machine), addAcceptanceCriterion,
 * compileScopeLedger, recordScopeEntry, enforceScope.
 *
 * Uses a `TaskRepository` interface (no direct Prisma import). Persists
 * semantic events via an `EventSink`.
 */
import { z } from "zod";
import type {
  Task,
  TaskContract,
  TaskStatus,
  AcceptanceCriterion,
  AllowedScope,
  ScopeLedgerEntry,
  Uuid7,
  Rfc3339Timestamp,
  PrincipalId,
} from "@terminus/domain";
import {
  StateTransitionError,
  ScopeViolationError,
  ValidationError,
  isTaskTransitionAllowed,
  isTaskTerminal,
  TaskStatus as TS,
  TASK_TRANSITIONS,
} from "@terminus/domain";
import type { EventSink } from "@terminus/runtime-protocol";

// ────────────────────────── Repository ───────────────────────────────────────

export interface TaskRepository {
  createTask(task: Task): Promise<Task>;
  getTask(id: Uuid7): Promise<Task | null>;
  updateTask(task: Task): Promise<Task>;
  recordScopeEntry(entry: ScopeLedgerEntry): Promise<void>;
  listScopeEntries(taskId: Uuid7): Promise<readonly ScopeLedgerEntry[]>;
}

// ────────────────────────── Service ──────────────────────────────────────────

export interface TaskServiceDeps {
  readonly repo: TaskRepository;
  readonly events: EventSink;
  readonly clock: () => Rfc3339Timestamp;
  readonly idSource: () => Uuid7;
}

export class TaskService {
  constructor(private readonly deps: TaskServiceDeps) {}

  async createTask(input: {
    readonly sessionId: Uuid7;
    readonly threadId: Uuid7;
    readonly contract: TaskContract;
    readonly principal: PrincipalId;
  }): Promise<Task> {
    const now = this.deps.clock();
    const task: Task = {
      id: this.deps.idSource(),
      sessionId: input.sessionId,
      threadId: input.threadId,
      contract: input.contract,
      status: "DRAFT",
      phase: "INTAKE",
      scopeLedgerId: this.deps.idSource(),
      verificationPlanId: null,
      createdAt: now,
      completedAt: null,
    };
    const saved = await this.deps.repo.createTask(task);
    await this.deps.events.emit(
      "task.created",
      {
        taskId: saved.id,
        sessionId: saved.sessionId,
        threadId: saved.threadId,
        objective: saved.contract.objective,
        riskClass: saved.contract.riskClass,
      },
      {
        aggregateId: saved.id,
        aggregateSequence: 1,
        actor: { kind: "user", id: input.principal },
        occurredAt: now,
      },
    );
    return saved;
  }

  async activate(taskId: Uuid7, principal: PrincipalId): Promise<Task> {
    return this.transition(taskId, "ACTIVE", principal);
  }

  async updateContract(
    taskId: Uuid7,
    mutator: (current: TaskContract) => TaskContract,
    principal: PrincipalId,
  ): Promise<Task> {
    const task = await this.requireTask(taskId);
    const previousVersion = task.contract.version;
    const newContract = mutator(task.contract);
    if (newContract.version <= previousVersion) {
      throw new ValidationError("contract version must increase", {
        previousVersion,
        newVersion: newContract.version,
      });
    }
    const updated: Task = { ...task, contract: newContract };
    const saved = await this.deps.repo.updateTask(updated);
    await this.deps.events.emit(
      "task.contract_updated",
      {
        taskId: saved.id,
        previousVersion,
        newVersion: newContract.version,
        changeSummary: `objective: ${newContract.objective}`,
      },
      {
        aggregateId: saved.id,
        aggregateSequence: 2,
        actor: { kind: "user", id: principal },
        occurredAt: this.deps.clock(),
      },
    );
    return saved;
  }

  async addAcceptanceCriterion(
    taskId: Uuid7,
    criterion: AcceptanceCriterion,
    principal: PrincipalId,
  ): Promise<Task> {
    return this.updateContract(
      taskId,
      (c) => ({
        ...c,
        version: c.version + 1,
        acceptanceCriteria: [...c.acceptanceCriteria, criterion],
      }),
      principal,
    );
  }

  async transition(
    taskId: Uuid7,
    to: TaskStatus,
    principal: PrincipalId,
  ): Promise<Task> {
    const task = await this.requireTask(taskId);
    if (task.status === to) return task;
    if (isTaskTerminal(task.status)) {
      throw new StateTransitionError("task", task.status, to);
    }
    if (!isTaskTransitionAllowed(task.status, to)) {
      throw new StateTransitionError("task", task.status, to);
    }
    const updated: Task = {
      ...task,
      status: to,
      completedAt: to === "COMPLETED" || to === "FAILED" || to === "ABORTED" ? this.deps.clock() : null,
    };
    const saved = await this.deps.repo.updateTask(updated);
    const eventType =
      to === "COMPLETED" ? "task.completed" : to === "FAILED" ? "task.failed" : "task.activated";
    await this.deps.events.emit(
      eventType,
      eventType === "task.completed"
        ? {
            taskId: saved.id,
            finalRevision: "<unknown>",
            completionRecordHash: "<unknown>",
            costMicros: 0n,
            durationSeconds: 0,
          }
        : eventType === "task.failed"
          ? { taskId: saved.id, reason: "transitioned to FAILED", failureCode: "TASK_FAILED" }
          : { taskId: saved.id, contractVersion: saved.contract.version },
      {
        aggregateId: saved.id,
        aggregateSequence: 3,
        actor: { kind: "user", id: principal },
        occurredAt: this.deps.clock(),
      },
    );
    return saved;
  }

  async compileScopeLedger(taskId: Uuid7): Promise<readonly ScopeLedgerEntry[]> {
    return this.deps.repo.listScopeEntries(taskId);
  }

  async recordScopeEntry(
    taskId: Uuid7,
    entry: Omit<ScopeLedgerEntry, "id" | "taskId" | "observedAt">,
    principal: PrincipalId,
  ): Promise<ScopeLedgerEntry> {
    const full: ScopeLedgerEntry = {
      id: this.deps.idSource(),
      taskId,
      observedAt: this.deps.clock(),
      ...entry,
    };
    await this.deps.repo.recordScopeEntry(full);
    await this.deps.events.emit(
      "task.scope_entry_recorded",
      {
        taskId,
        entryKind: entry.kind,
        path: entry.path,
        externalSystem: entry.externalSystem,
        justification: entry.justification,
      },
      {
        aggregateId: taskId,
        aggregateSequence: 4,
        actor: { kind: "user", id: principal },
        occurredAt: full.observedAt,
      },
    );
    return full;
  }

  /**
   * Enforce scope: rejects effects outside the allowed scope ledger.
   * Returns true if the path is allowed; throws ScopeViolationError otherwise.
   */
  async enforceScope(
    taskId: Uuid7,
    path: string,
    mode: "read" | "write",
  ): Promise<boolean> {
    const task = await this.requireTask(taskId);
    const allowed: AllowedScope = task.contract.allowedScope;
    const globs = mode === "write" ? allowed.writePaths : allowed.readPaths;
    if (globs.length === 0) {
      // No explicit scope declared; reject by default.
      throw new ScopeViolationError(path, mode);
    }
    for (const g of globs) {
      if (globMatch(g, path)) return true;
    }
    throw new ScopeViolationError(path, mode);
  }

  private async requireTask(id: Uuid7): Promise<Task> {
    const t = await this.deps.repo.getTask(id);
    if (t === null) throw new ValidationError("task not found", { taskId: id });
    return t;
  }
}

// ────────────────────────── Glob matcher ─────────────────────────────────────

/** Simple glob matcher supporting `**` and `*`. */
export function globMatch(pattern: string, path: string): boolean {
  const regex = globToRegex(pattern);
  return regex.test(path);
}

function globToRegex(pattern: string): RegExp {
  let out = "^";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        out += ".*";
        i++;
        if (pattern[i + 1] === "/") i++;
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else if (".+^$(){}[]|\\".includes(c)) {
      out += "\\" + c;
    } else {
      out += c;
    }
  }
  out += "$";
  return new RegExp(out);
}

// ────────────────────────── State machine helpers ────────────────────────────

export const ALLOWED_TASK_TRANSITIONS = TASK_TRANSITIONS;
export const TASK_TERMINAL_STATES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  TS.COMPLETED,
  TS.FAILED,
  TS.FAILED_VERIFICATION,
  TS.BUDGET_EXHAUSTED,
  TS.POLICY_DENIED,
  TS.ABORTED,
]);

export { isTaskTransitionAllowed, isTaskTerminal };

export type { Task, TaskContract, AcceptanceCriterion, AllowedScope, ScopeLedgerEntry };

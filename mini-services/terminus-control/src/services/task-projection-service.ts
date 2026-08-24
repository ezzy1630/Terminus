import type {
  Rfc3339Timestamp,
  TaskContractV2,
  TaskV2,
} from "@terminus/domain";
import { taskContractV2Schema } from "@terminus/domain";
import type { ServiceEventInput } from "./service-types.js";

export interface V1AllowedScopeProjection {
  readonly read_paths: readonly string[];
  readonly write_paths: readonly string[];
  readonly external_systems: readonly string[];
}

export interface TaskProjectionTaskRow {
  readonly id: string;
  readonly sessionId: string;
  readonly threadId: string;
  readonly status: string;
  readonly activeContractVersion: number;
  readonly budgetJson: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly completedAt: Date | null;
}

export interface TaskProjectionContractRow {
  readonly version: number;
  readonly objective: string;
  readonly constraintsJson: string;
  readonly allowedScopeJson: string;
  readonly v2ProjectionJson: string | null;
  readonly contentHash: string;
  readonly createdBy: string;
  readonly acceptanceCriteria: readonly {
    readonly criterionId: string;
    readonly statement: string;
    readonly verificationHint: string | null;
  }[];
}

export interface TaskProjectionSource {
  readonly readTask: (taskId: string) => Promise<TaskProjectionTaskRow | null>;
  readonly readContract: (taskId: string, version: number) => Promise<TaskProjectionContractRow | null>;
  readonly listTaskIds: () => Promise<readonly string[]>;
}

export interface TaskProjectionStore {
  readonly get: (taskId: string) => TaskV2 | undefined;
  readonly set: (taskId: string, task: TaskV2) => void;
  readonly publish: (event: ServiceEventInput & { readonly snapshot: TaskV2 }) => Promise<void>;
}

export interface TaskProjectionBridge<TTransaction> {
  readonly createV1: (
    transaction: TTransaction,
    task: TaskV2,
    context: { readonly sessionId: string; readonly threadId: string },
  ) => Promise<"created" | "existing" | "context_mismatch" | "thread_not_found">;
  readonly inspectV1: (
    taskId: string,
    context: { readonly sessionId: string; readonly threadId: string },
  ) => Promise<"created" | "existing" | "context_mismatch" | "thread_not_found">;
  readonly projectStatus: (
    transaction: TTransaction,
    taskId: string,
    status: TaskV2["status"],
  ) => Promise<void>;
  readonly projectContract: (
    transaction: TTransaction,
    taskId: string,
    contract: TaskContractV2,
  ) => Promise<void>;
}

export interface TaskProjectionDependencies<TTransaction> {
  readonly source: TaskProjectionSource;
  readonly store: TaskProjectionStore;
  readonly bridge: TaskProjectionBridge<TTransaction>;
}

export function parseAllowedScope(value: unknown): V1AllowedScopeProjection {
  const raw = value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const strings = (entry: unknown): readonly string[] => Array.isArray(entry)
    ? entry.filter((item): item is string => typeof item === "string")
    : [];
  return {
    read_paths: strings(raw.read_paths ?? raw.readPaths),
    write_paths: strings(raw.write_paths ?? raw.writePaths),
    external_systems: strings(raw.external_systems ?? raw.externalSystems),
  };
}

export function scopeExpansionResources(
  previous: V1AllowedScopeProjection,
  next: V1AllowedScopeProjection,
): readonly string[] {
  const additions = (prefix: string, before: readonly string[], after: readonly string[]): readonly string[] => {
    const known = new Set(before);
    return after.filter((value) => !known.has(value)).map((value) => `${prefix}:${value}`);
  };
  return [
    ...additions("read", previous.read_paths, next.read_paths),
    ...additions("write", previous.write_paths, next.write_paths),
    ...additions("external", previous.external_systems, next.external_systems),
  ];
}

export function v2PathScopeProjection(contract: TaskContractV2): V1AllowedScopeProjection {
  const scope = contract.scope.pathScope;
  return {
    read_paths: scope?.readPaths ?? [],
    write_paths: scope?.writePaths ?? [],
    external_systems: scope?.externalSystems ?? [],
  };
}

function v1TaskStatusToV2(status: string): TaskV2["status"] {
  switch (status) {
    case "DRAFT": return "DRAFT";
    case "ACTIVE": return "RUNNING";
    case "NEEDS_USER_DECISION": return "WAITING_USER";
    case "BLOCKED": return "BLOCKED";
    case "VERIFYING": return "VERIFYING";
    case "COMPLETED": return "COMPLETED";
    case "ABORTED": return "CANCELLED";
    case "FAILED":
    case "FAILED_VERIFICATION":
    case "BUDGET_EXHAUSTED":
    case "POLICY_DENIED":
      return "FAILED";
    default: return "BLOCKED";
  }
}

function v2TaskStatusToV1(status: TaskV2["status"]): {
  readonly status: string;
  readonly phase: string;
  readonly completedAt: Date | null;
} {
  switch (status) {
    case "DRAFT":
    case "READY": return { status: "DRAFT", phase: "INTAKE", completedAt: null };
    case "RUNNING": return { status: "ACTIVE", phase: "IMPLEMENT", completedAt: null };
    case "WAITING_USER":
    case "WAITING_AUTH": return { status: "NEEDS_USER_DECISION", phase: "IMPLEMENT", completedAt: null };
    case "WAITING_RESOURCE":
    case "PAUSED":
    case "BLOCKED": return { status: "BLOCKED", phase: "IMPLEMENT", completedAt: null };
    case "VERIFYING": return { status: "VERIFYING", phase: "VERIFY", completedAt: null };
    case "COMPLETED": return { status: "COMPLETED", phase: "COMPLETE", completedAt: new Date() };
    case "CANCELLED": return { status: "ABORTED", phase: "COMPLETE", completedAt: new Date() };
    case "PARTIAL":
    case "FAILED": return { status: "FAILED", phase: "COMPLETE", completedAt: new Date() };
  }
}

function statusesAgree(v1Status: string, v2Status: TaskV2["status"]): boolean {
  switch (v1Status) {
    case "DRAFT": return v2Status === "DRAFT" || v2Status === "READY";
    case "ACTIVE": return v2Status === "RUNNING";
    case "NEEDS_USER_DECISION": return v2Status === "WAITING_USER" || v2Status === "WAITING_AUTH";
    case "BLOCKED": return v2Status === "BLOCKED" || v2Status === "WAITING_RESOURCE" || v2Status === "PAUSED";
    case "VERIFYING": return v2Status === "VERIFYING";
    case "COMPLETED": return v2Status === "COMPLETED";
    case "ABORTED": return v2Status === "CANCELLED";
    case "FAILED":
    case "FAILED_VERIFICATION":
    case "BUDGET_EXHAUSTED":
    case "POLICY_DENIED": return v2Status === "FAILED" || v2Status === "PARTIAL";
    default: return false;
  }
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function jsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value instanceof Date) return value.toISOString();
  if (value !== null && typeof value === "object") {
    const safe: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      safe[key] = jsonSafe(nested);
    }
    return safe;
  }
  return value;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Projects committed v1 task rows into the durable v2 event stream and keeps
 * the in-process read model current.
 *
 * Transaction boundary: synchronization reads a committed v1 task/contract,
 * then appends one v2 snapshot event. It does not mutate v1. Command-side v2
 * projection is delegated to the bridge and runs inside the caller's event
 * transaction, so event and v1 row commit together.
 */
export class TaskProjectionService<TTransaction> {
  constructor(
    private readonly dependencies: TaskProjectionDependencies<TTransaction>,
  ) {}

  inspectV1(
    taskId: string,
    context: { readonly sessionId: string; readonly threadId: string },
  ): Promise<"created" | "existing" | "context_mismatch" | "thread_not_found"> {
    return this.dependencies.bridge.inspectV1(taskId, context);
  }

  createV1(
    transaction: TTransaction,
    task: TaskV2,
    context: { readonly sessionId: string; readonly threadId: string },
  ): Promise<"created" | "existing" | "context_mismatch" | "thread_not_found"> {
    return this.dependencies.bridge.createV1(transaction, task, context);
  }

  projectStatus(
    transaction: TTransaction,
    taskId: string,
    status: TaskV2["status"],
  ): Promise<void> {
    return this.dependencies.bridge.projectStatus(transaction, taskId, status);
  }

  projectContract(
    transaction: TTransaction,
    taskId: string,
    contract: TaskContractV2,
  ): Promise<void> {
    return this.dependencies.bridge.projectContract(transaction, taskId, contract);
  }

  async synchronize(
    taskId: string,
    eventType = "task.v1_projection_recovered",
  ): Promise<{ readonly task: TaskV2; readonly changed: boolean }> {
    const task = await this.dependencies.source.readTask(taskId);
    if (task === null) throw new Error(`v1 task ${taskId} is unavailable for v2 projection`);
    const contract = await this.dependencies.source.readContract(task.id, task.activeContractVersion);
    if (contract === null) {
      throw new Error(`v1 task ${taskId} has no active contract version ${task.activeContractVersion}`);
    }
    const existing = this.dependencies.store.get(task.id);
    const rawBudget = parseJson<Record<string, unknown>>(task.budgetJson, {});
    const security = parseJson<string[]>(contract.constraintsJson, []);
    const allowedScope = parseAllowedScope(parseJson<unknown>(contract.allowedScopeJson, {}));
    const authority = {
      allowedEffectClasses: [
        ...(allowedScope.read_paths.length > 0 ? ["LOCAL_FS_READ"] : []),
        ...(allowedScope.write_paths.length > 0 ? ["LOCAL_FS_WRITE"] : []),
      ],
      authorityCeiling: [
        ...(allowedScope.read_paths.length > 0 ? ["FS_READ"] : []),
        ...(allowedScope.write_paths.length > 0 ? ["FS_WRITE"] : []),
      ],
    };
    const derivedContract: TaskContractV2 = {
      version: contract.version,
      mission: contract.objective,
      scope: {
        resources: [],
        allowedEffectClasses: authority.allowedEffectClasses,
        excludedPathsOrSystems: [],
        pathScope: {
          readPaths: allowedScope.read_paths,
          writePaths: allowedScope.write_paths,
          externalSystems: allowedScope.external_systems,
        },
      },
      acceptance: contract.acceptanceCriteria.map((criterion) => ({
        claimId: criterion.criterionId,
        statement: criterion.statement,
        evidenceRequirement: criterion.verificationHint ?? "DETERMINISTIC_TEST",
      })),
      constraints: {
        security: security.includes("NO_AMBIENT_SECRETS") ? security : [...security, "NO_AMBIENT_SECRETS"],
        costMicros: BigInt(typeof rawBudget.model_micros === "string" && /^\d+$/.test(rawBudget.model_micros)
          ? rawBudget.model_micros
          : "5000000"),
        timeoutSeconds: numberOr(rawBudget.wall_clock_seconds, 3_600),
      },
      authorityCeiling: authority.authorityCeiling,
      mode: "interactive",
    };
    const retainedProjection = contract.v2ProjectionJson === null
      ? null
      : taskContractV2Schema.safeParse(parseJson<unknown>(contract.v2ProjectionJson, null));
    const projectedContract = retainedProjection?.success === true
      && retainedProjection.data.version === contract.version
      ? retainedProjection.data
      : derivedContract;
    const conversationContext = {
      sessionId: task.sessionId,
      threadId: task.threadId,
      attachedAt: task.createdAt.toISOString() as Rfc3339Timestamp,
    };
    const contractChanged = existing === undefined
      || JSON.stringify(jsonSafe(existing.contract)) !== JSON.stringify(jsonSafe(projectedContract));
    const statusChanged = existing === undefined || !statusesAgree(task.status, existing.status);
    const contextChanged = existing?.conversationContext?.sessionId !== conversationContext.sessionId
      || existing?.conversationContext?.threadId !== conversationContext.threadId;
    if (existing !== undefined && !contractChanged && !statusChanged && !contextChanged) {
      return { task: existing, changed: false };
    }
    const projected: TaskV2 = {
      id: task.id,
      missionId: existing?.missionId ?? null,
      organizationId: existing?.organizationId ?? "default-org",
      departmentId: existing?.departmentId ?? "default-dept",
      createdBy: existing?.createdBy ?? contract.createdBy,
      conversationContext,
      contract: projectedContract,
      status: statusChanged ? v1TaskStatusToV2(task.status) : existing?.status ?? v1TaskStatusToV2(task.status),
      version: (existing?.version ?? 0) + 1,
      createdAt: task.createdAt.toISOString() as Rfc3339Timestamp,
      updatedAt: task.updatedAt.toISOString() as Rfc3339Timestamp,
      completedAt: task.completedAt?.toISOString() as Rfc3339Timestamp | null ?? null,
    };
    await this.dependencies.store.publish({
      eventType,
      aggregateType: "task",
      aggregateId: task.id,
      correlationId: task.id,
      payload: projected as unknown as Readonly<Record<string, unknown>>,
      snapshot: projected,
    });
    this.dependencies.store.set(task.id, projected);
    return { task: projected, changed: true };
  }

  async reconcile(): Promise<number> {
    let changed = 0;
    for (const taskId of await this.dependencies.source.listTaskIds()) {
      if ((await this.synchronize(taskId)).changed) changed += 1;
    }
    return changed;
  }
}

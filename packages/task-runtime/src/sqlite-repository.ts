/**
 * SQLite-backed durable repository for the task runtime.
 *
 * The package owns the repository contract, not a SQLite client. Callers
 * inject a small synchronous SQLite port so the runtime stays independent of
 * Prisma, Bun, filesystem APIs, process state, and provider SDKs.
 */
import { z } from "zod";
import type {
  ApprovalPresentation,
  AuthorizationInstance,
  BudgetConsumption,
  Decision,
  EffectRecord,
  EffectState,
  InboxMessage,
  NodeRun,
  OutboxMessage,
  Question,
  ResourceHandle,
  Risk,
  SequencePolicyRule,
  TaskAttempt,
  TaskV2,
  WorkerLease,
  Workflow,
  Rfc3339Timestamp,
} from "@terminus/domain";
import {
  approvalPresentationSchema,
  authorizationInstanceSchema,
  budgetConsumptionSchema,
  ConflictError,
  decisionSchema,
  effectRecordSchema,
  ForgeError,
  IdempotencyConflictError,
  inboxMessageSchema,
  IntegrityError,
  nodeRunSchema,
  NotFoundError,
  outboxMessageSchema,
  questionSchema,
  resourceHandleSchema,
  riskSchema,
  sequencePolicyRuleSchema,
  taskAttemptSchema,
  taskContractV2Schema,
  taskV2Schema,
  ValidationError,
  workerLeaseSchema,
  workflowSchema,
  workflowNodeSchema,
  guardedEdgeSchema,
} from "@terminus/domain";
import type { EventEnvelopeV2 } from "@terminus/runtime-protocol";
import type {
  CandidateBranchRecord,
  DurableTaskRepository,
} from "./types.js";

/** Values accepted by a SQLite prepared statement. */
export type SqliteValue = string | number | bigint | Uint8Array | null;

export interface SqliteRunResult {
  readonly changes: number;
}

/** Minimal prepared statement surface required by this package. */
export interface SqliteStatement {
  get(...parameters: SqliteValue[]): unknown;
  all(...parameters: SqliteValue[]): readonly unknown[];
  run(...parameters: SqliteValue[]): SqliteRunResult;
}

/**
 * Dependency-injection port for a synchronous SQLite client.
 *
 * Transactions must commit when the callback returns and roll back when it
 * throws. The callback receives the transaction-bound port so an adapter can
 * provide transaction-scoped statements when its client requires that.
 */
export interface SqliteDatabasePort {
  exec(sql: string): void;
  query(sql: string): SqliteStatement;
  transaction<TResult>(operation: (database: SqliteDatabasePort) => TResult): TResult;
}

/**
 * Optional adapter for clients whose transaction callback does not need a
 * database argument. This keeps client-specific transaction plumbing outside
 * the task-runtime package while making the port easy to implement.
 */
export interface SqliteDatabaseDriver {
  exec(sql: string): void;
  query(sql: string): SqliteStatement;
  transaction<TResult>(operation: () => TResult): TResult;
}

export class SqliteDatabaseAdapter implements SqliteDatabasePort {
  constructor(private readonly driver: SqliteDatabaseDriver) {}

  exec(sql: string): void {
    this.driver.exec(sql);
  }

  query(sql: string): SqliteStatement {
    return this.driver.query(sql);
  }

  transaction<TResult>(operation: (database: SqliteDatabasePort) => TResult): TResult {
    return this.driver.transaction(() => operation(this));
  }
}

interface Decoder {
  parse(value: unknown): unknown;
}

interface StoredRecordRow {
  readonly payloadJson: string;
  readonly version: number | null;
  readonly casValue: number | null;
  readonly scopeKey: string | null;
}

const candidateEvidenceSchema = z.object({
  evidenceId: z.string(),
  artifactUri: z.string(),
  artifactHash: z.string(),
  sourceRevision: z.string(),
  environmentImageDigest: z.string(),
  verifierResult: z.literal("pass"),
});

const candidateClaimSchema = z.object({
  claimId: z.string(),
  status: z.enum(["SATISFIED", "WAIVED"]),
  evidence: z.array(candidateEvidenceSchema),
});

const candidateBranchSchema = z.object({
  branchId: z.string(),
  taskId: z.string(),
  attemptId: z.string(),
  actorPrincipal: z.string(),
  worktreePath: z.string(),
  epoch: z.number().int().nonnegative(),
  baseRevision: z.string(),
  headRevision: z.string(),
  scopeDigest: z.string(),
  effectIds: z.array(z.string()),
  proof: z
    .object({
      verificationPlanId: z.string(),
      completionRecordDigest: z.string(),
      sourceRevision: z.string(),
      environmentImageDigest: z.string(),
      completionExpressionSatisfied: z.literal(true),
      claims: z.array(candidateClaimSchema),
    })
    .nullable(),
  status: z.enum(["OPEN", "ADMITTING", "ADMITTED", "REJECTED", "MANUAL_REVIEW"]),
});

const candidateBranchDecoder: Decoder = {
  parse(value: unknown): unknown {
    return candidateBranchSchema.parse(value);
  },
};

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS task_runtime_records (
  collection TEXT NOT NULL,
  record_id TEXT NOT NULL,
  scope_key TEXT,
  payload_json TEXT NOT NULL,
  version INTEGER,
  cas_value INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (collection, record_id)
);

CREATE INDEX IF NOT EXISTS task_runtime_records_scope
  ON task_runtime_records (collection, scope_key, record_id);

CREATE TABLE IF NOT EXISTS task_runtime_outbox (
  id TEXT PRIMARY KEY,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  idempotency_key TEXT,
  created_at TEXT NOT NULL,
  published_at TEXT,
  delivered INTEGER NOT NULL CHECK (delivered IN (0, 1))
);

CREATE INDEX IF NOT EXISTS task_runtime_outbox_pending
  ON task_runtime_outbox (delivered, sequence, id);

CREATE TABLE IF NOT EXISTS task_runtime_inbox (
  idempotency_key TEXT PRIMARY KEY,
  id TEXT NOT NULL,
  source TEXT NOT NULL,
  message_type TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  received_at TEXT NOT NULL,
  processed_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'PROCESSED', 'FAILED', 'DUPLICATE'))
);

CREATE TABLE IF NOT EXISTS task_runtime_counters (
  counter_kind TEXT NOT NULL,
  counter_key TEXT NOT NULL,
  value INTEGER NOT NULL CHECK (value >= 0),
  PRIMARY KEY (counter_kind, counter_key)
);
`;

const SQLITE_RUNTIME_PRAGMAS = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneValue<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (typeof value === "bigint") return value;
  if (Array.isArray(value)) return value.map(cloneValue) as unknown as T;
  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    result[key] = cloneValue(nested);
  }
  return result as T;
}

function encodeJsonValue(value: unknown): unknown {
  if (typeof value === "bigint") {
    return { $terminusType: "bigint", value: value.toString() };
  }
  if (Array.isArray(value)) return value.map(encodeJsonValue);
  if (isRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      result[key] = encodeJsonValue(nested);
    }
    return result;
  }
  return value;
}

function decodeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeJsonValue);
  if (!isRecord(value)) return value;

  if (
    value.$terminusType === "bigint" &&
    typeof value.value === "string" &&
    Object.keys(value).length === 2
  ) {
    try {
      return BigInt(value.value);
    } catch (error: unknown) {
      throw new IntegrityError("invalid bigint in task-runtime SQLite payload", {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    result[key] = decodeJsonValue(nested);
  }
  return result;
}

function encodeJson(value: unknown): string {
  const encoded = JSON.stringify(encodeJsonValue(value));
  if (encoded === undefined) {
    throw new ValidationError("task-runtime SQLite payload is not JSON serializable");
  }
  return encoded;
}

function authorizationImmutableFieldsMatch(
  left: AuthorizationInstance,
  right: AuthorizationInstance,
): boolean {
  return left.id === right.id
    && left.principal === right.principal
    && left.taskId === right.taskId
    && left.taskVersion === right.taskVersion
    && left.effectClass === right.effectClass
    && left.maxScope.length === right.maxScope.length
    && left.maxScope.every((scope, index) => scope === right.maxScope[index])
    && left.expiry === right.expiry
    && left.humanApprovalId === right.humanApprovalId
    && left.approvalHash === right.approvalHash;
}

function decodeJson(payload: string): unknown {
  try {
    return decodeJsonValue(JSON.parse(payload) as unknown);
  } catch (error: unknown) {
    if (error instanceof ForgeError) throw error;
    throw new IntegrityError("invalid JSON in task-runtime SQLite payload", {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

function validateInput<T>(decoder: Decoder, value: unknown, operation: string): T {
  try {
    return decoder.parse(value) as T;
  } catch (error: unknown) {
    if (error instanceof ForgeError) throw error;
    throw new ValidationError(`${operation} failed domain validation`, {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

function parseStored<T>(row: StoredRecordRow, decoder: Decoder, identity: string): T {
  try {
    return decoder.parse(decodeJson(row.payloadJson)) as T;
  } catch (error: unknown) {
    if (error instanceof ForgeError) throw error;
    throw new IntegrityError(`invalid persisted task-runtime record: ${identity}`, {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

function readRow(value: unknown, identity: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new IntegrityError(`invalid SQLite row for ${identity}`);
  }
  return value;
}

function readText(value: unknown, column: string, identity: string): string {
  if (typeof value !== "string") {
    throw new IntegrityError(`invalid ${column} in SQLite row for ${identity}`);
  }
  return value;
}

function readNullableText(value: unknown, column: string, identity: string): string | null {
  if (value === null || value === undefined) return null;
  return readText(value, column, identity);
}

function readInteger(value: unknown, column: string, identity: string): number {
  const numberValue = typeof value === "bigint" ? Number(value) : value;
  if (
    typeof numberValue !== "number" ||
    !Number.isSafeInteger(numberValue) ||
    numberValue < 0
  ) {
    throw new IntegrityError(`invalid ${column} in SQLite row for ${identity}`);
  }
  return numberValue;
}

function readNullableInteger(value: unknown, column: string, identity: string): number | null {
  if (value === null || value === undefined) return null;
  return readInteger(value, column, identity);
}

function readPayload(event: EventEnvelopeV2): Readonly<Record<string, unknown>> {
  return event.payload;
}

function eventString(
  payload: Readonly<Record<string, unknown>>,
  key: string,
  fallback: string,
): string {
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function eventNullableString(
  payload: Readonly<Record<string, unknown>>,
  key: string,
): string | null {
  const value = payload[key];
  return value === null || value === undefined ? null : typeof value === "string" ? value : null;
}

function eventNumber(
  payload: Readonly<Record<string, unknown>>,
  key: string,
  fallback: number,
): number {
  const value = payload[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function eventBigInt(
  payload: Readonly<Record<string, unknown>>,
  key: string,
  fallback: bigint,
): bigint {
  const value = payload[key];
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^\d+$/.test(value)) {
    try {
      return BigInt(value);
    } catch {
      return fallback;
    }
  }
  return fallback;
}

function eventStringArray(
  payload: Readonly<Record<string, unknown>>,
  key: string,
): readonly string[] {
  const value = payload[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function eventRecord(
  payload: Readonly<Record<string, unknown>>,
  key: string,
): Readonly<Record<string, unknown>> {
  const value = payload[key];
  return isRecord(value) ? value : {};
}

function eventArray(payload: Readonly<Record<string, unknown>>, key: string): readonly unknown[] {
  const value = payload[key];
  return Array.isArray(value) ? value : [];
}

function eventRiskClass(
  payload: Readonly<Record<string, unknown>>,
  key: string,
): Risk["riskClass"] {
  const value = payload[key];
  switch (value) {
    case "LOW":
    case "NORMAL":
    case "HIGH":
    case "CRITICAL":
      return value;
    default:
      return "NORMAL";
  }
}

function eventEffectState(
  eventType: string,
  payload: Readonly<Record<string, unknown>>,
): EffectState {
  const explicit = payload.toState;
  if (typeof explicit === "string") {
    switch (explicit) {
      case "PROPOSED":
      case "POLICY_CHECKED":
      case "AUTHORIZATION_REQUIRED":
      case "AUTHORIZED":
      case "PREPARED":
      case "DISPATCHED":
      case "OBSERVED":
      case "VALIDATED":
      case "COMMITTED":
      case "DENIED":
      case "CANCELLED":
      case "UNCERTAIN":
      case "RECONCILING":
      case "COMPENSATING":
      case "COMPENSATED":
      case "RESIDUE":
      case "MANUAL_RECONCILE":
        return explicit;
      default:
        break;
    }
  }
  const suffix = eventType.replace("effect.", "");
  switch (suffix) {
    case "policy_checked":
      return "POLICY_CHECKED";
    case "authorization_required":
      return "AUTHORIZATION_REQUIRED";
    case "authorized":
      return "AUTHORIZED";
    case "prepared":
      return "PREPARED";
    case "dispatched":
      return "DISPATCHED";
    case "observed":
      return "OBSERVED";
    case "validated":
      return "VALIDATED";
    case "committed":
      return "COMMITTED";
    case "denied":
      return "DENIED";
    case "cancelled":
      return "CANCELLED";
    case "uncertain":
      return "UNCERTAIN";
    case "reconciling":
      return "RECONCILING";
    case "compensating":
      return "COMPENSATING";
    case "compensated":
      return "COMPENSATED";
    case "residue":
      return "RESIDUE";
    case "manual_reconcile":
      return "MANUAL_RECONCILE";
    default:
      return "PROPOSED";
  }
}

const REPLAY_TASK_STATUSES: Readonly<Record<string, TaskV2["status"]>> = {
  "task.ready": "READY",
  "task.running": "RUNNING",
  "task.waiting_user": "WAITING_USER",
  "task.waiting_auth": "WAITING_AUTH",
  "task.waiting_resource": "WAITING_RESOURCE",
  "task.paused": "PAUSED",
  "task.verifying": "VERIFYING",
  "task.completed": "COMPLETED",
  "task.partial": "PARTIAL",
  "task.blocked": "BLOCKED",
  "task.cancelled": "CANCELLED",
  "task.failed": "FAILED",
};

const REPLAY_EFFECT_EVENTS = new Set<string>([
  "effect.policy_checked",
  "effect.authorization_required",
  "effect.authorized",
  "effect.prepared",
  "effect.dispatched",
  "effect.observed",
  "effect.validated",
  "effect.committed",
  "effect.denied",
  "effect.cancelled",
  "effect.uncertain",
  "effect.reconciling",
  "effect.compensating",
  "effect.compensated",
  "effect.residue",
  "effect.manual_reconcile",
]);

/**
 * Durable repository backed by an injected SQLite port.
 *
 * Aggregate payloads remain domain-shaped JSON at this package boundary. The
 * repository stores them in a small materialized record table while keeping
 * outbox, inbox, and counter tables normalized for atomic predicates and
 * ordering.
 */
export class SqliteDurableTaskRepository
  implements DurableTaskRepository
{
  constructor(private readonly database: SqliteDatabasePort) {
    this.database.exec(SQLITE_RUNTIME_PRAGMAS);
    this.database.exec(SCHEMA_SQL);
  }

  private withMutation<TResult>(
    outboxMessage: OutboxMessage | undefined,
    operation: (database: SqliteDatabasePort) => TResult,
  ): TResult {
    const normalizedOutbox =
      outboxMessage === undefined
        ? undefined
        : validateInput<OutboxMessage>(outboxMessageSchema, outboxMessage, "outbox message");
    return this.database.transaction((transaction) => {
      const result = operation(transaction);
      if (normalizedOutbox !== undefined) this.insertOutbox(transaction, normalizedOutbox);
      return result;
    });
  }

  private readRecordRow(
    database: SqliteDatabasePort,
    collection: string,
    id: string,
  ): StoredRecordRow | null {
    const raw = database
      .query(
        "SELECT payload_json, version, cas_value, scope_key FROM task_runtime_records WHERE collection = ? AND record_id = ?",
      )
      .get(collection, id);
    if (raw === null || raw === undefined) return null;
    const row = readRow(raw, `${collection}/${id}`);
    return {
      payloadJson: readText(row.payload_json, "payload_json", `${collection}/${id}`),
      version: readNullableInteger(row.version, "version", `${collection}/${id}`),
      casValue: readNullableInteger(row.cas_value, "cas_value", `${collection}/${id}`),
      scopeKey: readNullableText(row.scope_key, "scope_key", `${collection}/${id}`),
    };
  }

  private readRecord<T>(
    database: SqliteDatabasePort,
    collection: string,
    id: string,
    decoder: Decoder,
  ): T | null {
    const row = this.readRecordRow(database, collection, id);
    return row === null ? null : parseStored<T>(row, decoder, `${collection}/${id}`);
  }

  private listRecords<T>(
    database: SqliteDatabasePort,
    collection: string,
    scopeKey: string | null,
    decoder: Decoder,
  ): readonly T[] {
    const rows =
      scopeKey === null
        ? database
            .query(
              "SELECT payload_json, version, cas_value, scope_key FROM task_runtime_records WHERE collection = ? ORDER BY record_id",
            )
            .all(collection)
        : database
            .query(
              "SELECT payload_json, version, cas_value, scope_key FROM task_runtime_records WHERE collection = ? AND scope_key = ? ORDER BY record_id",
            )
            .all(collection, scopeKey);
    return rows.map((raw, index) => {
      const row = readRow(raw, `${collection}[${index}]`);
      return parseStored<T>(
        {
          payloadJson: readText(row.payload_json, "payload_json", `${collection}[${index}]`),
          version: readNullableInteger(row.version, "version", `${collection}[${index}]`),
          casValue: readNullableInteger(row.cas_value, "cas_value", `${collection}[${index}]`),
          scopeKey: readNullableText(row.scope_key, "scope_key", `${collection}[${index}]`),
        },
        decoder,
        `${collection}[${index}]`,
      );
    });
  }

  private insertRecord(
    database: SqliteDatabasePort,
    collection: string,
    id: string,
    value: unknown,
    scopeKey: string | null,
    version: number | null,
    casValue: number | null,
  ): void {
    if (this.readRecordRow(database, collection, id) !== null) {
      throw new ConflictError("ALREADY_EXISTS", `${collection} already exists: ${id}`, {
        collection,
        id,
      });
    }
    try {
      database
        .query(
          "INSERT INTO task_runtime_records (collection, record_id, scope_key, payload_json, version, cas_value) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(collection, id, scopeKey, encodeJson(value), version, casValue);
    } catch (error: unknown) {
      throw new ConflictError("ALREADY_EXISTS", `${collection} already exists: ${id}`, {
        collection,
        id,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private replaceRecord(
    database: SqliteDatabasePort,
    collection: string,
    id: string,
    value: unknown,
    scopeKey: string | null,
  ): void {
    const current = this.readRecordRow(database, collection, id);
    if (current === null) throw new NotFoundError(collection, id);

    const incomingVersion = this.recordVersion(value);
    const currentVersion = current.version;
    if (incomingVersion !== null) {
      if (currentVersion === null) {
        throw new IntegrityError(`versioned ${collection} record has no stored version`, {
          id,
        });
      }
      if (incomingVersion !== currentVersion + 1) {
        throw new ConflictError(
          "STALE_SOURCE_VERSION",
          `${collection} version conflict for ${id}: expected ${currentVersion + 1}, got ${incomingVersion}`,
          {
            collection,
            id,
            expectedVersion: currentVersion + 1,
            actualVersion: incomingVersion,
          },
        );
      }
      const result = database
        .query(
          "UPDATE task_runtime_records SET scope_key = ?, payload_json = ?, version = ?, cas_value = ? WHERE collection = ? AND record_id = ? AND version = ?",
        )
        .run(
          scopeKey,
          encodeJson(value),
          incomingVersion,
          incomingVersion,
          collection,
          id,
          currentVersion,
        );
      if (result.changes !== 1) {
        throw new ConflictError("STALE_SOURCE_VERSION", `${collection} update lost its compare-and-swap race`, {
          collection,
          id,
        });
      }
      return;
    }

    database
      .query(
        "UPDATE task_runtime_records SET scope_key = ?, payload_json = ?, version = NULL, cas_value = NULL WHERE collection = ? AND record_id = ?",
      )
      .run(scopeKey, encodeJson(value), collection, id);
  }

  private upsertRecord(
    database: SqliteDatabasePort,
    collection: string,
    id: string,
    value: unknown,
    scopeKey: string | null,
    version: number | null,
    casValue: number | null,
  ): void {
    const encoded = encodeJson(value);
    const current = this.readRecordRow(database, collection, id);
    if (current === null) {
      database
        .query(
          "INSERT INTO task_runtime_records (collection, record_id, scope_key, payload_json, version, cas_value) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(collection, id, scopeKey, encoded, version, casValue);
      return;
    }
    database
      .query(
        "UPDATE task_runtime_records SET scope_key = ?, payload_json = ?, version = ?, cas_value = ? WHERE collection = ? AND record_id = ?",
      )
      .run(scopeKey, encoded, version, casValue, collection, id);
  }

  private saveRecord<T>(
    collection: string,
    id: string,
    value: T,
    scopeKey: string | null,
    decoder: Decoder,
    outboxMessage?: OutboxMessage,
  ): T {
    const normalized = validateInput<T>(decoder, value, `save ${collection}`);
    return this.withMutation(outboxMessage, (database) => {
      const current = this.readRecordRow(database, collection, id);
      if (current === null) {
        this.insertRecord(database, collection, id, normalized, scopeKey, null, null);
      } else {
        this.replaceRecordWithoutCas(database, collection, id, normalized, scopeKey);
      }
      return cloneValue(normalized);
    });
  }

  private replaceRecordWithoutCas(
    database: SqliteDatabasePort,
    collection: string,
    id: string,
    value: unknown,
    scopeKey: string | null,
  ): void {
    const result = database
      .query(
        "UPDATE task_runtime_records SET scope_key = ?, payload_json = ?, version = NULL, cas_value = NULL WHERE collection = ? AND record_id = ?",
      )
      .run(scopeKey, encodeJson(value), collection, id);
    if (result.changes !== 1) throw new NotFoundError(collection, id);
  }

  private createRecord<T>(
    collection: string,
    id: string,
    value: T,
    scopeKey: string | null,
    decoder: Decoder,
    outboxMessage?: OutboxMessage,
  ): T {
    const normalized = validateInput<T>(decoder, value, `create ${collection}`);
    const version = this.recordVersion(normalized);
    return this.withMutation(outboxMessage, (database) => {
      this.insertRecord(database, collection, id, normalized, scopeKey, version, version);
      return cloneValue(normalized);
    });
  }

  private updateRecord<T>(
    collection: string,
    id: string,
    value: T,
    scopeKey: string | null,
    decoder: Decoder,
    outboxMessage?: OutboxMessage,
  ): T {
    const normalized = validateInput<T>(decoder, value, `update ${collection}`);
    return this.withMutation(outboxMessage, (database) => {
      this.replaceRecord(database, collection, id, normalized, scopeKey);
      return cloneValue(normalized);
    });
  }

  private recordVersion(value: unknown): number | null {
    if (!isRecord(value) || !Object.prototype.hasOwnProperty.call(value, "version")) return null;
    const version = value.version;
    if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 0) {
      throw new ValidationError("versioned task-runtime record has an invalid version", {
        version,
      });
    }
    return version;
  }

  private insertOutbox(database: SqliteDatabasePort, message: OutboxMessage): void {
    const encoded = encodeJson(message);
    const existingRaw = database
      .query("SELECT payload_json FROM task_runtime_outbox WHERE id = ?")
      .get(message.id);
    if (existingRaw !== null && existingRaw !== undefined) {
      const existingRow = readRow(existingRaw, `outbox/${message.id}`);
      const existingPayload = readText(existingRow.payload_json, "payload_json", `outbox/${message.id}`);
      if (existingPayload === encoded) return;
      throw new ConflictError("ALREADY_EXISTS", `outbox message already exists: ${message.id}`, {
        id: message.id,
      });
    }
    database
      .query(
        "INSERT INTO task_runtime_outbox (id, aggregate_type, aggregate_id, sequence, event_type, payload_json, idempotency_key, created_at, published_at, delivered) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        message.id,
        message.aggregateType,
        message.aggregateId,
        message.sequence,
        message.eventType,
        encoded,
        message.idempotencyKey,
        message.createdAt,
        message.publishedAt,
        message.delivered ? 1 : 0,
      );
  }

  private readOutboxMessage(database: SqliteDatabasePort, id: string): OutboxMessage | null {
    const raw = database.query("SELECT payload_json FROM task_runtime_outbox WHERE id = ?").get(id);
    if (raw === null || raw === undefined) return null;
    const row = readRow(raw, `outbox/${id}`);
    return parseStored<OutboxMessage>(
      {
        payloadJson: readText(row.payload_json, "payload_json", `outbox/${id}`),
        version: null,
        casValue: null,
        scopeKey: null,
      },
      outboxMessageSchema,
      `outbox/${id}`,
    );
  }

  private readInboxMessage(database: SqliteDatabasePort, idempotencyKey: string): InboxMessage | null {
    const raw = database
      .query("SELECT payload_json FROM task_runtime_inbox WHERE idempotency_key = ?")
      .get(idempotencyKey);
    if (raw === null || raw === undefined) return null;
    const row = readRow(raw, `inbox/${idempotencyKey}`);
    return parseStored<InboxMessage>(
      {
        payloadJson: readText(row.payload_json, "payload_json", `inbox/${idempotencyKey}`),
        version: null,
        casValue: null,
        scopeKey: null,
      },
      inboxMessageSchema,
      `inbox/${idempotencyKey}`,
    );
  }

  private insertInbox(database: SqliteDatabasePort, message: InboxMessage): boolean {
    const current = this.readInboxMessage(database, message.idempotencyKey);
    if (current !== null) {
      if (current.payloadHash !== message.payloadHash) {
        throw new IdempotencyConflictError(message.idempotencyKey);
      }
      return false;
    }
    try {
      database
        .query(
          "INSERT INTO task_runtime_inbox (idempotency_key, id, source, message_type, payload_hash, payload_json, received_at, processed_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          message.idempotencyKey,
          message.id,
          message.source,
          message.messageType,
          message.payloadHash,
          encodeJson(message),
          message.receivedAt,
          message.processedAt,
          message.status,
        );
      return true;
    } catch (error: unknown) {
      const raced = this.readInboxMessage(database, message.idempotencyKey);
      if (raced !== null) {
        if (raced.payloadHash !== message.payloadHash) {
          throw new IdempotencyConflictError(message.idempotencyKey);
        }
        return false;
      }
      throw error;
    }
  }

  private updateInbox(database: SqliteDatabasePort, message: InboxMessage): void {
    const current = this.readInboxMessage(database, message.idempotencyKey);
    if (current === null) throw new NotFoundError("inbox message", message.idempotencyKey);
    if (current.payloadHash !== message.payloadHash) {
      throw new IdempotencyConflictError(message.idempotencyKey);
    }
    if (current.status !== "PENDING" && current.status !== message.status) {
      throw new ConflictError(
        "IDEMPOTENCY_KEY_CONFLICT",
        `inbox message is already settled: ${message.idempotencyKey}`,
        { idempotencyKey: message.idempotencyKey, status: current.status },
      );
    }
    const result = database
      .query(
        "UPDATE task_runtime_inbox SET id = ?, source = ?, message_type = ?, payload_hash = ?, payload_json = ?, received_at = ?, processed_at = ?, status = ? WHERE idempotency_key = ? AND payload_hash = ? AND status = ?",
      )
      .run(
        message.id,
        message.source,
        message.messageType,
        message.payloadHash,
        encodeJson(message),
        message.receivedAt,
        message.processedAt,
        message.status,
        message.idempotencyKey,
        current.payloadHash,
        current.status,
      );
    if (result.changes !== 1) {
      throw new ConflictError("IDEMPOTENCY_KEY_CONFLICT", "inbox compare-and-swap failed", {
        idempotencyKey: message.idempotencyKey,
      });
    }
  }

  private recordVersionedAuthorization(
    database: SqliteDatabasePort,
    authorization: AuthorizationInstance,
  ): void {
    const current = this.readRecord<AuthorizationInstance>(
      database,
      "authorization",
      authorization.id,
      authorizationInstanceSchema,
    );
    if (current === null) throw new NotFoundError("authorization", authorization.id);
    if (authorization.consumedCount < current.consumedCount) {
      throw new ConflictError("STALE_SOURCE_VERSION", "authorization consumption cannot move backwards", {
        id: authorization.id,
        currentConsumedCount: current.consumedCount,
        requestedConsumedCount: authorization.consumedCount,
      });
    }
    const isNextConsumption = authorization.consumedCount === current.consumedCount + 1;
    const isNewRevocation =
      authorization.consumedCount === current.consumedCount
      && authorization.useLimit < current.useLimit;
    if (!isNextConsumption && !isNewRevocation) {
      throw new ConflictError("STALE_SOURCE_VERSION", "authorization consumption skipped a count", {
        id: authorization.id,
        currentConsumedCount: current.consumedCount,
        requestedConsumedCount: authorization.consumedCount,
      });
    }
    const immutableFieldsMatch = authorizationImmutableFieldsMatch(authorization, current);
    const onlyConsumptionChanged =
      isNextConsumption
      && authorization.useLimit === current.useLimit
      && immutableFieldsMatch;
    const onlyRevocationChanged =
      isNewRevocation
      && authorization.consumedCount === current.consumedCount
      && immutableFieldsMatch;
    if (!onlyConsumptionChanged && !onlyRevocationChanged) {
      throw new ConflictError(
        "STALE_SOURCE_VERSION",
        "authorization update changed fields outside consumption or revocation",
        { id: authorization.id },
      );
    }
    const result = database
      .query(
        "UPDATE task_runtime_records SET scope_key = ?, payload_json = ?, cas_value = ? WHERE collection = 'authorization' AND record_id = ? AND cas_value = ? AND payload_json = ?",
      )
      .run(
        authorization.taskId,
        encodeJson(authorization),
        authorization.consumedCount,
        authorization.id,
        current.consumedCount,
        encodeJson(current),
      );
    if (result.changes !== 1) {
      throw new ConflictError("STALE_SOURCE_VERSION", "authorization compare-and-swap failed", {
        id: authorization.id,
      });
    }
  }

  async createTaskV2(task: TaskV2, outboxMessage?: OutboxMessage): Promise<TaskV2> {
    return this.createRecord("task_v2", task.id, task, null, taskV2Schema, outboxMessage);
  }

  async getTaskV2(id: string): Promise<TaskV2 | null> {
    return this.readRecord(this.database, "task_v2", id, taskV2Schema);
  }

  async updateTaskV2(task: TaskV2, outboxMessage?: OutboxMessage): Promise<TaskV2> {
    return this.updateRecord("task_v2", task.id, task, null, taskV2Schema, outboxMessage);
  }

  async listTasksV2(): Promise<readonly TaskV2[]> {
    return this.listRecords(this.database, "task_v2", null, taskV2Schema);
  }

  async createWorkflow(workflow: Workflow, outboxMessage?: OutboxMessage): Promise<Workflow> {
    return this.createRecord("workflow", workflow.id, workflow, null, workflowSchema, outboxMessage);
  }

  async getWorkflow(id: string): Promise<Workflow | null> {
    return this.readRecord(this.database, "workflow", id, workflowSchema);
  }

  async updateWorkflow(workflow: Workflow, outboxMessage?: OutboxMessage): Promise<Workflow> {
    return this.updateRecord("workflow", workflow.id, workflow, null, workflowSchema, outboxMessage);
  }

  async createNodeRun(nodeRun: NodeRun, outboxMessage?: OutboxMessage): Promise<NodeRun> {
    return this.createRecord("node_run", nodeRun.id, nodeRun, nodeRun.workflowId, nodeRunSchema, outboxMessage);
  }

  async getNodeRun(id: string): Promise<NodeRun | null> {
    return this.readRecord(this.database, "node_run", id, nodeRunSchema);
  }

  async updateNodeRun(nodeRun: NodeRun, outboxMessage?: OutboxMessage): Promise<NodeRun> {
    return this.updateRecord("node_run", nodeRun.id, nodeRun, nodeRun.workflowId, nodeRunSchema, outboxMessage);
  }

  async listNodeRuns(workflowId: string): Promise<readonly NodeRun[]> {
    return this.listRecords(this.database, "node_run", workflowId, nodeRunSchema);
  }

  async createLease(lease: WorkerLease, outboxMessage?: OutboxMessage): Promise<WorkerLease> {
    const normalized = validateInput<WorkerLease>(workerLeaseSchema, lease, "create lease");
    const normalizedOutbox = outboxMessage === undefined
      ? undefined
      : validateInput<OutboxMessage>(outboxMessageSchema, outboxMessage, "outbox message");
    return this.database.transaction((database) => {
      const now = Date.now();
      const active = this.listRecords<WorkerLease>(database, "lease", normalized.taskId, workerLeaseSchema)
        .find((candidate) =>
          (candidate.status === "ACQUIRED" || candidate.status === "RENEWED")
          && new Date(candidate.expiresAt).getTime() > now,
        );
      if (active !== undefined) {
        throw new ConflictError("ALREADY_EXISTS", `task ${normalized.taskId} already has an active lease`, {
          taskId: normalized.taskId,
          leaseId: active.id,
        });
      }
      this.insertRecord(database, "lease", normalized.id, normalized, normalized.taskId, normalized.fencingToken, normalized.fencingToken);
      if (normalizedOutbox !== undefined) this.insertOutbox(database, normalizedOutbox);
      return cloneValue(normalized);
    });
  }

  async getLease(id: string): Promise<WorkerLease | null> {
    return this.readRecord(this.database, "lease", id, workerLeaseSchema);
  }

  async getActiveLeaseForTask(taskId: string): Promise<WorkerLease | null> {
    const now = Date.now();
    const leases: readonly WorkerLease[] = this.listRecords<WorkerLease>(
      this.database,
      "lease",
      taskId,
      workerLeaseSchema,
    );
    return (
      leases.find((lease) => {
        const active = lease.status === "ACQUIRED" || lease.status === "RENEWED";
        return active && new Date(lease.expiresAt).getTime() > now;
      }) ?? null
    );
  }

  async updateLease(lease: WorkerLease, outboxMessage?: OutboxMessage): Promise<WorkerLease> {
    return this.withMutation(outboxMessage, (database) => {
      const current = this.readRecord<WorkerLease>(database, "lease", lease.id, workerLeaseSchema);
      const normalized = validateInput<WorkerLease>(workerLeaseSchema, lease, "update lease");
      if (current !== null && normalized.fencingToken < current.fencingToken) {
        throw new ConflictError("STALE_SOURCE_VERSION", "lease fencing token moved backwards", {
          leaseId: lease.id,
          currentFencingToken: current.fencingToken,
          requestedFencingToken: normalized.fencingToken,
        });
      }
      this.replaceRecordWithoutCas(database, "lease", lease.id, normalized, normalized.taskId);
      return cloneValue(normalized);
    });
  }

  async listLeasesForTask(taskId: string): Promise<readonly WorkerLease[]> {
    return this.listRecords(this.database, "lease", taskId, workerLeaseSchema);
  }

  async createAttempt(attempt: TaskAttempt, outboxMessage?: OutboxMessage): Promise<TaskAttempt> {
    return this.createRecord("attempt", attempt.id, attempt, attempt.taskId, taskAttemptSchema, outboxMessage);
  }

  async getAttempt(id: string): Promise<TaskAttempt | null> {
    return this.readRecord(this.database, "attempt", id, taskAttemptSchema);
  }

  async updateAttempt(attempt: TaskAttempt, outboxMessage?: OutboxMessage): Promise<TaskAttempt> {
    return this.updateRecord("attempt", attempt.id, attempt, attempt.taskId, taskAttemptSchema, outboxMessage);
  }

  async listAttempts(taskId: string): Promise<readonly TaskAttempt[]> {
    return this.listRecords(this.database, "attempt", taskId, taskAttemptSchema);
  }

  async createQuestion(question: Question, outboxMessage?: OutboxMessage): Promise<Question> {
    return this.createRecord("question", question.id, question, question.taskId, questionSchema, outboxMessage);
  }

  async getQuestion(id: string): Promise<Question | null> {
    return this.readRecord(this.database, "question", id, questionSchema);
  }

  async updateQuestion(question: Question, outboxMessage?: OutboxMessage): Promise<Question> {
    return this.updateRecord("question", question.id, question, question.taskId, questionSchema, outboxMessage);
  }

  async listQuestions(taskId: string): Promise<readonly Question[]> {
    return this.listRecords(this.database, "question", taskId, questionSchema);
  }

  async createDecision(decision: Decision, outboxMessage?: OutboxMessage): Promise<Decision> {
    return this.createRecord("decision", decision.id, decision, decision.taskId, decisionSchema, outboxMessage);
  }

  async getDecision(id: string): Promise<Decision | null> {
    return this.readRecord(this.database, "decision", id, decisionSchema);
  }

  async listDecisions(taskId: string): Promise<readonly Decision[]> {
    return this.listRecords(this.database, "decision", taskId, decisionSchema);
  }

  async createRisk(risk: Risk, outboxMessage?: OutboxMessage): Promise<Risk> {
    return this.createRecord("risk", risk.id, risk, risk.taskId, riskSchema, outboxMessage);
  }

  async getRisk(id: string): Promise<Risk | null> {
    return this.readRecord(this.database, "risk", id, riskSchema);
  }

  async updateRisk(risk: Risk, outboxMessage?: OutboxMessage): Promise<Risk> {
    return this.updateRecord("risk", risk.id, risk, risk.taskId, riskSchema, outboxMessage);
  }

  async listRisks(taskId: string): Promise<readonly Risk[]> {
    return this.listRecords(this.database, "risk", taskId, riskSchema);
  }

  async getBudgetConsumption(taskId: string): Promise<BudgetConsumption | null> {
    return this.readRecord(this.database, "budget", taskId, budgetConsumptionSchema);
  }

  async saveBudgetConsumption(
    consumption: BudgetConsumption,
    outboxMessage?: OutboxMessage,
  ): Promise<BudgetConsumption> {
    return this.saveRecord("budget", consumption.taskId, consumption, consumption.taskId, budgetConsumptionSchema, outboxMessage);
  }

  async createEffectRecord(effect: EffectRecord, outboxMessage?: OutboxMessage): Promise<EffectRecord> {
    const normalized = validateInput<EffectRecord>(effectRecordSchema, effect, "create effect");
    const normalizedOutbox = outboxMessage === undefined
      ? undefined
      : validateInput<OutboxMessage>(outboxMessageSchema, outboxMessage, "outbox message");
    return this.database.transaction((database) => {
      const existing = this.listRecords<EffectRecord>(database, "effect", null, effectRecordSchema)
        .find((candidate) => candidate.semanticIdempotencyKey === normalized.semanticIdempotencyKey);
      if (existing !== undefined) return cloneValue(existing);
      this.insertRecord(database, "effect", normalized.id, normalized, normalized.taskId, normalized.version, normalized.version);
      if (normalizedOutbox !== undefined) this.insertOutbox(database, normalizedOutbox);
      return cloneValue(normalized);
    });
  }

  async getEffectRecord(id: string): Promise<EffectRecord | null> {
    return this.readRecord(this.database, "effect", id, effectRecordSchema);
  }

  async getEffectBySemanticKey(semanticKey: string): Promise<EffectRecord | null> {
    const effects: readonly EffectRecord[] = this.listRecords<EffectRecord>(
      this.database,
      "effect",
      null,
      effectRecordSchema,
    );
    return effects.find((effect) => effect.semanticIdempotencyKey === semanticKey) ?? null;
  }

  async updateEffectRecord(effect: EffectRecord, outboxMessage?: OutboxMessage): Promise<EffectRecord> {
    return this.updateRecord("effect", effect.id, effect, effect.taskId, effectRecordSchema, outboxMessage);
  }

  async listEffects(taskId: string): Promise<readonly EffectRecord[]> {
    return this.listRecords(this.database, "effect", taskId, effectRecordSchema);
  }

  async createCandidateBranch(branch: CandidateBranchRecord): Promise<CandidateBranchRecord> {
    const normalized = validateInput<CandidateBranchRecord>(candidateBranchDecoder, branch, "create candidate branch");
    return this.database.transaction((database) => {
      this.insertRecord(
        database,
        "candidate_branch",
        normalized.branchId,
        normalized,
        normalized.taskId,
        null,
        normalized.epoch,
      );
      return cloneValue(normalized);
    });
  }

  async getCandidateBranch(branchId: string): Promise<CandidateBranchRecord | null> {
    return this.readRecord<CandidateBranchRecord>(this.database, "candidate_branch", branchId, candidateBranchDecoder);
  }

  async updateCandidateBranch(branch: CandidateBranchRecord): Promise<CandidateBranchRecord> {
    return this.withMutation(undefined, (database) => {
      const current: CandidateBranchRecord | null = this.readRecord<CandidateBranchRecord>(
        database,
        "candidate_branch",
        branch.branchId,
        candidateBranchDecoder,
      );
      const normalized: CandidateBranchRecord = validateInput<CandidateBranchRecord>(
        candidateBranchDecoder,
        branch,
        "update candidate branch",
      );
      if (current === null) throw new NotFoundError("candidate branch", branch.branchId);
      if (normalized.epoch !== current.epoch + 1) {
        throw new ConflictError("STALE_SOURCE_VERSION", "candidate branch epoch compare-and-swap failed", {
          branchId: branch.branchId,
          currentEpoch: current.epoch,
          requestedEpoch: normalized.epoch,
        });
      }
      const result = database
        .query(
          "UPDATE task_runtime_records SET scope_key = ?, payload_json = ?, cas_value = ? WHERE collection = 'candidate_branch' AND record_id = ? AND cas_value = ?",
        )
        .run(
          normalized.taskId,
          encodeJson(normalized),
          normalized.epoch,
          normalized.branchId,
          current.epoch,
        );
      if (result.changes !== 1) {
        throw new ConflictError("STALE_SOURCE_VERSION", "candidate branch update lost its compare-and-swap race", {
          branchId: branch.branchId,
        });
      }
      return cloneValue(normalized);
    });
  }

  async claimCandidateBranch(
    branchId: string,
    expectedEpoch: number,
  ): Promise<CandidateBranchRecord | null> {
    return this.database.transaction((database) => {
      const current = this.readRecord<CandidateBranchRecord>(
        database,
        "candidate_branch",
        branchId,
        candidateBranchDecoder,
      );
      if (current === null || current.status !== "OPEN" || current.epoch !== expectedEpoch) return null;
      const claimed: CandidateBranchRecord = { ...current, epoch: current.epoch + 1, status: "ADMITTING" };
      const result = database
        .query(
          "UPDATE task_runtime_records SET payload_json = ?, cas_value = ? WHERE collection = 'candidate_branch' AND record_id = ? AND cas_value = ?",
        )
        .run(encodeJson(claimed), claimed.epoch, branchId, expectedEpoch);
      if (result.changes !== 1) return null;
      return cloneValue(claimed);
    });
  }

  async listCandidateBranches(taskId: string): Promise<readonly CandidateBranchRecord[]> {
    return this.listRecords(this.database, "candidate_branch", taskId, candidateBranchDecoder);
  }

  async createAuthorization(
    authz: AuthorizationInstance,
    outboxMessage?: OutboxMessage,
  ): Promise<AuthorizationInstance> {
    return this.withMutation(outboxMessage, (database) => {
      const normalized = validateInput<AuthorizationInstance>(authorizationInstanceSchema, authz, "create authorization");
      this.insertRecord(
        database,
        "authorization",
        normalized.id,
        normalized,
        normalized.taskId,
        null,
        normalized.consumedCount,
      );
      return cloneValue(normalized);
    });
  }

  async getAuthorization(id: string): Promise<AuthorizationInstance | null> {
    return this.readRecord(this.database, "authorization", id, authorizationInstanceSchema);
  }

  async updateAuthorization(
    authz: AuthorizationInstance,
    outboxMessage?: OutboxMessage,
  ): Promise<AuthorizationInstance> {
    return this.withMutation(outboxMessage, (database) => {
      const normalized = validateInput<AuthorizationInstance>(authorizationInstanceSchema, authz, "update authorization");
      this.recordVersionedAuthorization(database, normalized);
      return cloneValue(normalized);
    });
  }

  async listAuthorizations(taskId: string): Promise<readonly AuthorizationInstance[]> {
    return this.listRecords(this.database, "authorization", taskId, authorizationInstanceSchema);
  }

  async saveResourceHandle(
    handle: ResourceHandle,
    outboxMessage?: OutboxMessage,
  ): Promise<ResourceHandle> {
    return this.withMutation(outboxMessage, (database) => {
      const normalized = validateInput<ResourceHandle>(resourceHandleSchema, handle, "save resource handle");
      const current = this.readRecord<ResourceHandle>(
        database,
        "resource_handle",
        normalized.objectId,
        resourceHandleSchema,
      );
      if (current === null) {
        this.insertRecord(
          database,
          "resource_handle",
          normalized.objectId,
          normalized,
          normalized.taskBinding,
          normalized.version,
          normalized.version,
        );
      } else {
        if (normalized.version < current.version) {
          throw new ConflictError("STALE_SOURCE_VERSION", "resource handle version moved backwards", {
            objectId: normalized.objectId,
            currentVersion: current.version,
            requestedVersion: normalized.version,
          });
        }
        const result = database
          .query(
            "UPDATE task_runtime_records SET scope_key = ?, payload_json = ?, version = ?, cas_value = ? WHERE collection = 'resource_handle' AND record_id = ? AND version = ?",
          )
          .run(
            normalized.taskBinding,
            encodeJson(normalized),
            normalized.version,
            normalized.version,
            normalized.objectId,
            current.version,
          );
        if (result.changes !== 1) {
          throw new ConflictError("STALE_SOURCE_VERSION", "resource handle compare-and-swap failed", {
            objectId: normalized.objectId,
          });
        }
      }
      return cloneValue(normalized);
    });
  }

  async getResourceHandle(objectId: string): Promise<ResourceHandle | null> {
    return this.readRecord(this.database, "resource_handle", objectId, resourceHandleSchema);
  }

  async listResourceHandles(taskBinding: string): Promise<readonly ResourceHandle[]> {
    return this.listRecords(this.database, "resource_handle", taskBinding, resourceHandleSchema);
  }

  async saveSequencePolicyRule(rule: SequencePolicyRule): Promise<void> {
    this.saveRecord("sequence_policy_rule", rule.id, rule, null, sequencePolicyRuleSchema);
  }

  async listSequencePolicyRules(): Promise<readonly SequencePolicyRule[]> {
    return this.listRecords(this.database, "sequence_policy_rule", null, sequencePolicyRuleSchema);
  }

  async saveApprovalPresentation(
    presentation: ApprovalPresentation,
    outboxMessage?: OutboxMessage,
  ): Promise<ApprovalPresentation> {
    return this.saveRecord(
      "approval_presentation",
      presentation.approvalId,
      presentation,
      presentation.taskId,
      approvalPresentationSchema,
      outboxMessage,
    );
  }

  async getApprovalPresentation(approvalId: string): Promise<ApprovalPresentation | null> {
    return this.readRecord(this.database, "approval_presentation", approvalId, approvalPresentationSchema);
  }

  async saveOutboxMessage(message: OutboxMessage): Promise<void> {
    const normalized = validateInput<OutboxMessage>(outboxMessageSchema, message, "save outbox message");
    this.database.transaction((database) => this.insertOutbox(database, normalized));
  }

  async listPendingOutboxMessages(): Promise<readonly OutboxMessage[]> {
    const rows = this.database
      .query(
        "SELECT payload_json FROM task_runtime_outbox WHERE delivered = 0 ORDER BY sequence, id",
      )
      .all();
    return rows.map((raw, index) => {
      const row = readRow(raw, `outbox[${index}]`);
      return parseStored<OutboxMessage>(
        {
          payloadJson: readText(row.payload_json, "payload_json", `outbox[${index}]`),
          version: null,
          casValue: null,
          scopeKey: null,
        },
        outboxMessageSchema,
        `outbox[${index}]`,
      );
    });
  }

  async listAllOutboxMessages(): Promise<readonly OutboxMessage[]> {
    const rows = this.database
      .query("SELECT payload_json FROM task_runtime_outbox ORDER BY sequence, id")
      .all();
    return rows.map((raw, index) => {
      const row = readRow(raw, `outbox[${index}]`);
      return parseStored<OutboxMessage>(
        {
          payloadJson: readText(row.payload_json, "payload_json", `outbox[${index}]`),
          version: null,
          casValue: null,
          scopeKey: null,
        },
        outboxMessageSchema,
        `outbox[${index}]`,
      );
    });
  }

  async markOutboxDelivered(id: string, publishedAt: Rfc3339Timestamp): Promise<void> {
    this.database.transaction((database) => {
      const message = this.readOutboxMessage(database, id);
      if (message === null) return;
      const updated = validateInput<OutboxMessage>(
        outboxMessageSchema,
        { ...message, delivered: true, publishedAt },
        "mark outbox message delivered",
      );
      const result = database
        .query(
          "UPDATE task_runtime_outbox SET payload_json = ?, published_at = ?, delivered = 1 WHERE id = ?",
        )
        .run(encodeJson(updated), publishedAt, id);
      if (result.changes !== 1) throw new NotFoundError("outbox message", id);
    });
  }

  async saveInboxMessage(message: InboxMessage): Promise<void> {
    const normalized = validateInput<InboxMessage>(inboxMessageSchema, message, "save inbox message");
    this.database.transaction((database) => {
      this.insertInbox(database, normalized);
    });
  }

  /** Atomically claims an inbox key. False means a matching key already exists. */
  async claimInboxMessage(message: InboxMessage): Promise<boolean> {
    const normalized = validateInput<InboxMessage>(inboxMessageSchema, message, "claim inbox message");
    return this.database.transaction((database) => this.insertInbox(database, normalized));
  }

  async getInboxMessage(idempotencyKey: string): Promise<InboxMessage | null> {
    return this.readInboxMessage(this.database, idempotencyKey);
  }

  async updateInboxMessage(message: InboxMessage): Promise<void> {
    const normalized = validateInput<InboxMessage>(inboxMessageSchema, message, "update inbox message");
    this.database.transaction((database) => this.updateInbox(database, normalized));
  }

  async nextSequence(scope: string): Promise<number> {
    return this.nextCounter("sequence", scope);
  }

  async nextEpoch(scope: string): Promise<number> {
    return this.nextCounter("epoch", scope);
  }

  private nextCounter(kind: "sequence" | "epoch", scope: string): number {
    if (scope.length === 0) throw new ValidationError(`${kind} scope must not be empty`);
    return this.database.transaction((database) => {
      const raw = database
        .query("SELECT value FROM task_runtime_counters WHERE counter_kind = ? AND counter_key = ?")
        .get(kind, scope);
      if (raw === null || raw === undefined) {
        database
          .query("INSERT INTO task_runtime_counters (counter_kind, counter_key, value) VALUES (?, ?, 1)")
          .run(kind, scope);
        return 1;
      }
      const row = readRow(raw, `${kind}/${scope}`);
      const current = readInteger(row.value, "counter value", `${kind}/${scope}`);
      if (current === Number.MAX_SAFE_INTEGER) {
        throw new ValidationError(`${kind} counter exhausted`, { scope });
      }
      const next = current + 1;
      const result = database
        .query(
          "UPDATE task_runtime_counters SET value = ? WHERE counter_kind = ? AND counter_key = ? AND value = ?",
        )
        .run(next, kind, scope, current);
      if (result.changes !== 1) {
        throw new ConflictError("STALE_SOURCE_VERSION", `${kind} counter compare-and-swap failed`, {
          scope,
        });
      }
      return next;
    });
  }

  async replayFromEvents(events: readonly EventEnvelopeV2[]): Promise<void> {
    this.database.transaction((database) => {
      for (const event of events) this.applyReplayEvent(database, event);
    });
  }

  private applyReplayEvent(database: SqliteDatabasePort, event: EventEnvelopeV2): void {
    const payload = readPayload(event);

    if (event.eventType === "task.created") {
      const task: TaskV2 = validateInput<TaskV2>(
        taskV2Schema,
        {
          id: event.aggregateId,
          missionId: eventNullableString(payload, "missionId"),
          organizationId: eventString(payload, "organizationId", "default-org"),
          departmentId: eventString(payload, "departmentId", "default-dept"),
          createdBy: event.actor.id,
          contract: {
            version: eventNumber(payload, "contractVersion", 1),
            mission: eventString(payload, "objective", "replayed-task"),
            scope: { resources: [], allowedEffectClasses: [], excludedPathsOrSystems: [] },
            acceptance: [],
            constraints: {
              security: [],
              costMicros: eventBigInt(payload, "costMicros", 0n),
              timeoutSeconds: eventNumber(payload, "timeoutSeconds", 3600),
            },
            authorityCeiling: [],
            mode: eventString(payload, "mode", "interactive"),
          },
          status: "DRAFT",
          version: 1,
          createdAt: event.occurredAt,
          updatedAt: event.occurredAt,
          completedAt: null,
        },
        "replay task.created",
      );
      this.upsertRecord(database, "task_v2", task.id, task, null, task.version, task.version);
      return;
    }

    const taskStatus = REPLAY_TASK_STATUSES[event.eventType];
    if (taskStatus !== undefined) {
      const current = this.readRecord<TaskV2>(database, "task_v2", event.aggregateId, taskV2Schema);
      if (current !== null) {
        const task: TaskV2 = {
          ...current,
          status: taskStatus,
          version: eventNumber(payload, "version", current.version + 1),
          updatedAt: event.occurredAt,
          completedAt:
            taskStatus === "COMPLETED" || taskStatus === "FAILED" || taskStatus === "CANCELLED"
              ? event.occurredAt
              : null,
        };
        this.upsertRecord(database, "task_v2", task.id, task, null, task.version, task.version);
      }
      return;
    }

    switch (event.eventType) {
      case "task.contract_updated": {
        const current = this.readRecord<TaskV2>(database, "task_v2", event.aggregateId, taskV2Schema);
        const contract = payload.contract;
        if (current === null) return;
        if (contract === null || contract === undefined || !isRecord(contract)) {
          throw new IntegrityError(`replay task.contract_updated is missing its authoritative contract`, {
            eventId: event.eventId,
            taskId: event.aggregateId,
          });
        }
        const updated: TaskV2 = validateInput<TaskV2>(
          taskV2Schema,
          {
            ...current,
            contract: taskContractV2Schema.parse(contract),
            version: eventNumber(payload, "version", current.version + 1),
            updatedAt: event.occurredAt,
          },
          "replay task.contract_updated",
        );
        this.upsertRecord(database, "task_v2", updated.id, updated, null, updated.version, updated.version);
        return;
      }
      case "lease.acquired":
      case "lease.renewed": {
        const lease: WorkerLease = validateInput<WorkerLease>(
          workerLeaseSchema,
          {
            id: eventString(payload, "leaseId", event.aggregateId),
            taskId: eventString(payload, "taskId", ""),
            workerId: eventString(payload, "workerId", ""),
            fencingToken: eventNumber(payload, "fencingToken", 1),
            status: event.eventType === "lease.acquired" ? "ACQUIRED" : "RENEWED",
            acquiredAt: event.occurredAt,
            expiresAt: eventString(payload, "expiresAt", event.occurredAt) as Rfc3339Timestamp,
            releasedAt: null,
            metadata: {},
          },
          `replay ${event.eventType}`,
        );
        this.upsertRecord(database, "lease", lease.id, lease, lease.taskId, null, null);
        return;
      }
      case "lease.released":
      case "lease.fenced": {
        const leaseId = eventString(payload, "leaseId", event.aggregateId);
        const current = this.readRecord<WorkerLease>(database, "lease", leaseId, workerLeaseSchema);
        if (current !== null) {
          const lease: WorkerLease = {
            ...current,
            status: event.eventType === "lease.released" ? "RELEASED" : "FENCED",
            releasedAt: event.occurredAt,
          };
          this.upsertRecord(database, "lease", lease.id, lease, lease.taskId, null, null);
        }
        return;
      }
      case "workflow.created": {
        const nodes = eventArray(payload, "nodes").map((value) =>
          validateInput<Workflow["nodes"][number]>(workflowNodeSchema, value, "replay workflow node"),
        );
        const edges = eventArray(payload, "edges").map((value) =>
          validateInput<Workflow["edges"][number]>(guardedEdgeSchema, value, "replay workflow edge"),
        );
        const workflow: Workflow = validateInput<Workflow>(
          workflowSchema,
          {
            id: event.aggregateId,
            version: eventNumber(payload, "version", 1),
            taskId: eventString(payload, "taskId", ""),
            nodes,
            edges,
            staticAnalysis: isRecord(payload.staticAnalysis) ? payload.staticAnalysis : undefined,
            createdAt: event.occurredAt,
          },
          "replay workflow.created",
        );
        this.upsertRecord(database, "workflow", workflow.id, workflow, null, workflow.version, workflow.version);
        return;
      }
      case "workflow.node_started": {
        const nodeRun: NodeRun = validateInput<NodeRun>(
          nodeRunSchema,
          {
            id: eventString(payload, "nodeRunId", event.eventId),
            workflowId: event.aggregateId,
            nodeId: eventString(payload, "nodeId", ""),
            attemptId: eventString(payload, "attemptId", ""),
            status: "RUNNING",
            inputs: eventRecord(payload, "inputs"),
            outputs: null,
            error: null,
            startedAt: event.occurredAt,
            settledAt: null,
          },
          "replay workflow.node_started",
        );
        this.upsertRecord(database, "node_run", nodeRun.id, nodeRun, nodeRun.workflowId, null, null);
        return;
      }
      case "workflow.node_completed":
      case "workflow.node_failed": {
        const nodeRunId = eventString(payload, "nodeRunId", event.aggregateId);
        const current = this.readRecord<NodeRun>(database, "node_run", nodeRunId, nodeRunSchema);
        if (current !== null) {
          const output = payload.outputs;
          const outputs = output === null || output === undefined ? current.outputs : isRecord(output) ? output : current.outputs;
          const nodeRun: NodeRun = {
            ...current,
            status: event.eventType === "workflow.node_completed" ? "COMPLETED" : "FAILED",
            outputs,
            error: eventNullableString(payload, "error") ?? current.error,
            settledAt: event.occurredAt,
          };
          this.upsertRecord(database, "node_run", nodeRun.id, nodeRun, nodeRun.workflowId, null, null);
        }
        return;
      }
      case "attempt.started": {
        const attempt: TaskAttempt = validateInput<TaskAttempt>(
          taskAttemptSchema,
          {
            id: eventString(payload, "attemptId", event.aggregateId),
            taskId: eventString(payload, "taskId", ""),
            attemptNumber: eventNumber(payload, "attemptNumber", 1),
            workerId: eventString(payload, "workerId", ""),
            fencingToken: eventNumber(payload, "fencingToken", 1),
            status: "RUNNING",
            startedAt: event.occurredAt,
            settledAt: null,
            error: null,
          },
          "replay attempt.started",
        );
        this.upsertRecord(database, "attempt", attempt.id, attempt, attempt.taskId, null, null);
        return;
      }
      case "attempt.completed":
      case "attempt.failed": {
        const attemptId = eventString(payload, "attemptId", event.aggregateId);
        const current = this.readRecord<TaskAttempt>(database, "attempt", attemptId, taskAttemptSchema);
        if (current !== null) {
          const attempt: TaskAttempt = {
            ...current,
            status: event.eventType === "attempt.completed" ? "COMPLETED" : "FAILED",
            error: eventNullableString(payload, "error") ?? current.error,
            settledAt: event.occurredAt,
          };
          this.upsertRecord(database, "attempt", attempt.id, attempt, attempt.taskId, null, null);
        }
        return;
      }
      case "question.asked": {
        const question: Question = validateInput<Question>(
          questionSchema,
          {
            id: eventString(payload, "questionId", event.aggregateId),
            taskId: eventString(payload, "taskId", ""),
            prompt: eventString(payload, "prompt", ""),
            options: eventStringArray(payload, "options"),
            selectedOption: null,
            rationale: null,
            status: "PENDING",
            createdAt: event.occurredAt,
            resolvedAt: null,
          },
          "replay question.asked",
        );
        this.upsertRecord(database, "question", question.id, question, question.taskId, null, null);
        return;
      }
      case "question.answered":
      case "question.dismissed": {
        const questionId = eventString(payload, "questionId", event.aggregateId);
        const current = this.readRecord<Question>(database, "question", questionId, questionSchema);
        if (current !== null) {
          const question: Question = {
            ...current,
            selectedOption: eventNullableString(payload, "selectedOption") ?? current.selectedOption,
            rationale: eventNullableString(payload, "rationale") ?? current.rationale,
            status: event.eventType === "question.answered" ? "ANSWERED" : "DISMISSED",
            resolvedAt: event.occurredAt,
          };
          this.upsertRecord(database, "question", question.id, question, question.taskId, null, null);
        }
        return;
      }
      case "decision.recorded": {
        const decision: Decision = validateInput<Decision>(
          decisionSchema,
          {
            id: eventString(payload, "decisionId", event.aggregateId),
            taskId: eventString(payload, "taskId", ""),
            questionId: eventNullableString(payload, "questionId"),
            statement: eventString(payload, "statement", ""),
            alternativesConsidered: eventStringArray(payload, "alternativesConsidered"),
            rationale: eventString(payload, "rationale", ""),
            provenance: eventString(payload, "provenance", ""),
            recordedAt: event.occurredAt,
          },
          "replay decision.recorded",
        );
        this.upsertRecord(database, "decision", decision.id, decision, decision.taskId, null, null);
        return;
      }
      case "risk.recorded": {
        const risk: Risk = validateInput<Risk>(
          riskSchema,
          {
            id: eventString(payload, "riskId", event.aggregateId),
            taskId: eventString(payload, "taskId", ""),
            riskClass: eventRiskClass(payload, "riskClass"),
            statement: eventString(payload, "statement", ""),
            mitigation: eventNullableString(payload, "mitigation"),
            status: "IDENTIFIED",
            recordedAt: event.occurredAt,
          },
          "replay risk.recorded",
        );
        this.upsertRecord(database, "risk", risk.id, risk, risk.taskId, null, null);
        return;
      }
      case "risk.mitigated": {
        const riskId = eventString(payload, "riskId", event.aggregateId);
        const current = this.readRecord<Risk>(database, "risk", riskId, riskSchema);
        if (current !== null) {
          const risk: Risk = {
            ...current,
            mitigation: eventString(payload, "mitigation", current.mitigation ?? ""),
            status: "MITIGATED",
          };
          this.upsertRecord(database, "risk", risk.id, risk, risk.taskId, null, null);
        }
        return;
      }
      case "budget.consumed": {
        const taskId = eventString(payload, "taskId", event.aggregateId);
        const current = this.readRecord<BudgetConsumption>(database, "budget", taskId, budgetConsumptionSchema);
        const budget: BudgetConsumption = validateInput<BudgetConsumption>(
          budgetConsumptionSchema,
          {
            taskId,
            consumedCostMicros: eventBigInt(payload, "consumedCostMicros", current?.consumedCostMicros ?? 0n),
            consumedComputeSeconds: eventNumber(
              payload,
              "consumedComputeSeconds",
              current?.consumedComputeSeconds ?? 0,
            ),
            consumedInputTokens: eventBigInt(payload, "consumedInputTokens", current?.consumedInputTokens ?? 0n),
            consumedOutputTokens: eventBigInt(payload, "consumedOutputTokens", current?.consumedOutputTokens ?? 0n),
            consumedApprovals: eventNumber(payload, "consumedApprovals", current?.consumedApprovals ?? 0),
            lastUpdatedAt: event.occurredAt,
          },
          "replay budget.consumed",
        );
        this.upsertRecord(database, "budget", taskId, budget, taskId, null, null);
        return;
      }
      case "effect.proposed": {
        const rawHandles = eventArray(payload, "resourceHandles");
        const resourceHandles = rawHandles.map((value) =>
          validateInput<ResourceHandle>(resourceHandleSchema, value, "replay effect resource handle"),
        );
        const effect: EffectRecord = validateInput<EffectRecord>(
          effectRecordSchema,
          {
            id: eventString(payload, "effectId", event.aggregateId),
            taskId: eventString(payload, "taskId", ""),
            attemptId: eventString(payload, "attemptId", ""),
            principal: eventString(payload, "principal", event.actor.id),
            connectorOrWorker: eventString(payload, "connectorOrWorker", "unknown"),
            intentType: eventString(payload, "intentType", "replayed-effect"),
            canonicalParameters: eventRecord(payload, "canonicalParameters"),
            resourceHandles,
            effectClass: eventString(payload, "effectClass", "READ_ONLY"),
            semanticIdempotencyKey: eventString(payload, "semanticIdempotencyKey", "replayed-effect"),
            authorizationId: null,
            policyDecisionId: null,
            state: "PROPOSED",
            uncertaintyReason: null,
            compensationRef: null,
            version: 1,
            createdAt: event.occurredAt,
            settledAt: null,
          },
          "replay effect.proposed",
        );
        this.upsertRecord(database, "effect", effect.id, effect, effect.taskId, effect.version, effect.version);
        return;
      }
      case "authorization.created": {
        const authorization: AuthorizationInstance = validateInput<AuthorizationInstance>(
          authorizationInstanceSchema,
          {
            id: eventString(payload, "authorizationId", event.aggregateId),
            principal: event.actor.id,
            taskId: eventString(payload, "taskId", ""),
            taskVersion: eventNumber(payload, "taskVersion", 1),
            effectClass: eventString(payload, "effectClass", "READ_ONLY"),
            maxScope: eventStringArray(payload, "maxScope"),
            useLimit: Math.max(1, eventNumber(payload, "useLimit", 1)),
            consumedCount: 0,
            expiry: eventString(payload, "expiry", event.occurredAt) as Rfc3339Timestamp,
            humanApprovalId: eventNullableString(payload, "humanApprovalId"),
            approvalHash: eventNullableString(payload, "approvalHash"),
          },
          "replay authorization.created",
        );
        this.upsertRecord(
          database,
          "authorization",
          authorization.id,
          authorization,
          authorization.taskId,
          null,
          authorization.consumedCount,
        );
        return;
      }
      case "authorization.consumed": {
        const authorizationId = eventString(payload, "authorizationId", event.aggregateId);
        const current = this.readRecord<AuthorizationInstance>(
          database,
          "authorization",
          authorizationId,
          authorizationInstanceSchema,
        );
        if (current !== null) {
          const authorization: AuthorizationInstance = {
            ...current,
            consumedCount: eventNumber(payload, "consumedCount", current.consumedCount + 1),
          };
          this.upsertRecord(
            database,
            "authorization",
            authorization.id,
            authorization,
            authorization.taskId,
            null,
            authorization.consumedCount,
          );
        }
        return;
      }
      case "authorization.revoked": {
        const authorizationId = eventString(payload, "authorizationId", event.aggregateId);
        const current = this.readRecord<AuthorizationInstance>(
          database,
          "authorization",
          authorizationId,
          authorizationInstanceSchema,
        );
        if (current !== null) {
          const authorization: AuthorizationInstance = {
            ...current,
            useLimit: current.consumedCount,
          };
          this.upsertRecord(
            database,
            "authorization",
            authorization.id,
            authorization,
            authorization.taskId,
            null,
            authorization.consumedCount,
          );
        }
        return;
      }
      default:
        break;
    }

    if (REPLAY_EFFECT_EVENTS.has(event.eventType)) {
      const effectId = eventString(payload, "effectId", event.aggregateId);
      const current = this.readRecord<EffectRecord>(database, "effect", effectId, effectRecordSchema);
      if (current !== null) {
        const state = eventEffectState(event.eventType, payload);
        const effect: EffectRecord = {
          ...current,
          state,
          authorizationId: eventNullableString(payload, "authorizationId") ?? current.authorizationId,
          policyDecisionId: eventNullableString(payload, "policyDecisionId") ?? current.policyDecisionId,
          uncertaintyReason: eventNullableString(payload, "uncertaintyReason") ?? current.uncertaintyReason,
          compensationRef: eventNullableString(payload, "compensationRef") ?? current.compensationRef,
          version: eventNumber(payload, "version", current.version + 1),
          settledAt:
            state === "COMMITTED" || state === "DENIED" || state === "CANCELLED" || state === "COMPENSATED"
              ? event.occurredAt
              : null,
        };
        this.upsertRecord(database, "effect", effect.id, effect, effect.taskId, effect.version, effect.version);
      }
    }
  }

  async clear(): Promise<void> {
    this.database.transaction((database) => {
      database.exec("DELETE FROM task_runtime_records");
      database.exec("DELETE FROM task_runtime_outbox");
      database.exec("DELETE FROM task_runtime_inbox");
      database.exec("DELETE FROM task_runtime_counters");
    });
  }
}

/** Short alias for callers that prefer the storage backend in the name. */
export { SqliteDurableTaskRepository as DatabaseBackedTaskRepository };

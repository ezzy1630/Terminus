/**
 * Durable router outcome records.
 *
 * Routing remains deterministic and this module has no serving side effects.
 * A composition root can inject a persistent store, while tests and local
 * harnesses can use the in-memory implementation below.  Promotion code must
 * consume verified records; an unverified shadow observation is never treated
 * as a successful outcome.
 */
import { z } from "zod";
import type { Rfc3339Timestamp } from "@terminus/domain";
import { nowTimestamp, rfc3339Schema } from "@terminus/domain";

export type RouterOutcomeAssignment = "baseline" | "candidate" | "serving" | "shadow";
export type RouterOutcomeResult = "success" | "failure" | "blocked";
export type RouterVerificationStatus = "verified" | "unverified";

/** Opaque provider receipt fields retained for provenance and accounting. */
export interface RouterProviderReceipt {
  readonly receiptId: string;
  readonly providerId: string;
  readonly model: string;
  readonly artifactRef: string;
  readonly verified: boolean;
}

export const routerProviderReceiptSchema = z.object({
  receiptId: z.string().trim().min(1),
  providerId: z.string().trim().min(1),
  model: z.string().trim().min(1),
  artifactRef: z.string().trim().min(1),
  verified: z.boolean(),
}).strict();

/** Immutable execution result used by calibration and paired evaluation. */
export interface RouterOutcomeRecord {
  readonly schemaVersion: "terminus.routing.outcome.v1";
  readonly outcomeId: string;
  readonly taskId: string;
  readonly attemptId: string;
  /** Same task/seed pairing key used by baseline and candidate arms. */
  readonly pairId: string;
  readonly cohort: string;
  readonly assignment: RouterOutcomeAssignment;
  readonly profileId: string;
  readonly modelKey: string;
  readonly providerId: string;
  readonly adapterRef: string;
  readonly result: RouterOutcomeResult;
  /** Independently scored quality, or null when the score is unavailable. */
  readonly qualityScore: number | null;
  readonly toolCallsSucceeded: number;
  readonly toolCallsFailed: number;
  readonly structuredOutputSucceeded: boolean;
  readonly editCohortSucceeded: boolean;
  readonly latencyMs: number;
  readonly costMicros: bigint;
  readonly cacheHitRate: number | null;
  readonly providerReceipt: RouterProviderReceipt | null;
  /** Immutable verification artifact, if the result was independently checked. */
  readonly verificationArtifactRef: string | null;
  readonly verificationStatus: RouterVerificationStatus;
  readonly recordedAt: Rfc3339Timestamp;
}

export const routerOutcomeRecordSchema = z.object({
  schemaVersion: z.literal("terminus.routing.outcome.v1"),
  outcomeId: z.string().trim().min(1),
  taskId: z.string().trim().min(1),
  attemptId: z.string().trim().min(1),
  pairId: z.string().trim().min(1),
  cohort: z.string().trim().min(1),
  assignment: z.enum(["baseline", "candidate", "serving", "shadow"]),
  profileId: z.string().trim().min(1),
  modelKey: z.string().trim().min(1),
  providerId: z.string().trim().min(1),
  adapterRef: z.string().trim().min(1),
  result: z.enum(["success", "failure", "blocked"]),
  qualityScore: z.number().finite().min(0).max(1).nullable(),
  toolCallsSucceeded: z.number().int().nonnegative(),
  toolCallsFailed: z.number().int().nonnegative(),
  structuredOutputSucceeded: z.boolean(),
  editCohortSucceeded: z.boolean(),
  latencyMs: z.number().finite().nonnegative(),
  costMicros: z.bigint().nonnegative(),
  cacheHitRate: z.number().finite().min(0).max(1).nullable(),
  providerReceipt: routerProviderReceiptSchema.nullable(),
  verificationArtifactRef: z.string().trim().min(1).nullable(),
  verificationStatus: z.enum(["verified", "unverified"]),
  recordedAt: rfc3339Schema,
}).strict();

export type RouterOutcomeRecordInput = Omit<RouterOutcomeRecord, "schemaVersion" | "recordedAt"> & {
  readonly schemaVersion?: RouterOutcomeRecord["schemaVersion"];
  readonly recordedAt?: Rfc3339Timestamp;
};

/** Persistence boundary owned by the composition root. */
export interface RouterOutcomeStore {
  append(record: RouterOutcomeRecord): void;
  get(outcomeId: string): RouterOutcomeRecord | null;
  list(): readonly RouterOutcomeRecord[];
}

/**
 * Local/test store with idempotent append semantics.  Production callers
 * should provide a transactional implementation backed by durable storage.
 */
export class InMemoryRouterOutcomeStore implements RouterOutcomeStore {
  private readonly records = new Map<string, RouterOutcomeRecord>();

  constructor(records: readonly RouterOutcomeRecord[] = []) {
    for (const record of records) this.append(record);
  }

  append(record: RouterOutcomeRecord): void {
    const validated = routerOutcomeRecordSchema.parse(record) as unknown as RouterOutcomeRecord;
    assertOutcomeVerification(validated);
    const existing = this.records.get(validated.outcomeId);
    if (existing !== undefined) {
      if (canonicalRecord(existing) !== canonicalRecord(validated)) {
        throw new Error(`router outcome '${validated.outcomeId}' conflicts with an existing record`);
      }
      return;
    }
    this.records.set(validated.outcomeId, validated);
  }

  get(outcomeId: string): RouterOutcomeRecord | null {
    return this.records.get(outcomeId) ?? null;
  }

  list(): readonly RouterOutcomeRecord[] {
    return Array.from(this.records.values());
  }
}

/** Validates and persists records without coupling the router to storage. */
export class RouterOutcomeRecorder {
  constructor(private readonly store: RouterOutcomeStore) {}

  record(input: RouterOutcomeRecordInput): RouterOutcomeRecord {
    const record = routerOutcomeRecordSchema.parse({
      ...input,
      schemaVersion: input.schemaVersion ?? "terminus.routing.outcome.v1",
      recordedAt: input.recordedAt ?? nowTimestamp(),
    }) as unknown as RouterOutcomeRecord;
    assertOutcomeVerification(record);
    this.store.append(record);
    return record;
  }

  recordVerified(input: Omit<RouterOutcomeRecordInput, "verificationStatus">): RouterOutcomeRecord {
    return this.record({
      ...input,
      verificationStatus: "verified",
    });
  }
}

/** A receipt is complete only when provider/model provenance is verified. */
export function hasCompleteRouterProviderReceipt(record: RouterOutcomeRecord): boolean {
  const receipt = record.providerReceipt;
  return receipt !== null
    && routerProviderReceiptSchema.safeParse(receipt).success
    && receipt.verified
    && receipt.providerId === record.providerId
    && receipt.model === record.modelKey;
}

export function isVerifiedRouterOutcome(record: RouterOutcomeRecord): boolean {
  return record.verificationStatus === "verified"
    && record.verificationArtifactRef !== null
    && hasCompleteRouterProviderReceipt(record);
}

function assertOutcomeVerification(record: RouterOutcomeRecord): void {
  if (record.verificationStatus === "verified" && !isVerifiedRouterOutcome(record)) {
    throw new Error(
      `verified router outcome '${record.outcomeId}' requires a matching provider receipt and verification artifact`,
    );
  }
}

function canonicalRecord(record: RouterOutcomeRecord): string {
  return JSON.stringify(record, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value,
  );
}

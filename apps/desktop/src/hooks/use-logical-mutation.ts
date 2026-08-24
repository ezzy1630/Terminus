import { useCallback, useMemo, useRef } from "react";
import { createIdempotencyKey } from "../lib/api";

export interface LogicalMutationAdmission {
  readonly key: string;
  readonly completedSteps: Readonly<Record<string, string>>;
}

interface PendingMutation {
  readonly version: 2;
  readonly signatureFingerprint: string;
  readonly key: string;
  readonly phase: "pending";
  readonly createdAt: string;
  readonly completedSteps: Readonly<Record<string, string>>;
}

type MutationJournalAdmissionReason =
  | "unavailable"
  | "corrupt"
  | "write_failed"
  | "verification_failed"
  | "cleanup_failed"
  | "signature_too_large"
  | "checkpoint_too_large";

export class MutationJournalAdmissionError extends Error {
  readonly reason: MutationJournalAdmissionReason;
  readonly scope: string;

  constructor(scope: string, reason: MutationJournalAdmissionReason) {
    const detail = reason === "corrupt"
      ? "The durable mutation journal is corrupt. Preserve it and recover the unknown request before retrying."
      : reason === "signature_too_large"
        ? "This request is too large to admit to the durable mutation journal. Reduce its input before retrying."
        : reason === "checkpoint_too_large"
          ? "This request produced too much recovery state for the durable mutation journal. The next effect was not sent."
        : reason === "cleanup_failed"
          ? "The request completed, but Terminus could not clear its durable mutation journal. Retry the same action to reconcile it safely."
          : "Terminus could not durably verify this mutation journal. The request was not sent; restore local storage and retry.";
    super(detail);
    this.name = "MutationJournalAdmissionError";
    this.reason = reason;
    this.scope = scope;
  }
}

export class PendingMutationConflictError extends Error {
  constructor(scope: string) {
    super(`A prior ${scope} request has an unknown outcome. Retry the same action so Terminus can reconcile it safely.`);
    this.name = "PendingMutationConflictError";
  }
}

/**
 * A transport failure with no authoritative outcome must keep its journal
 * entry: retrying a changed request could duplicate an effect. HTTP rejection
 * responses, however, are definitive and must release the signature so the
 * operator can correct the input and submit a new operation.
 */
export function isDefinitiveMutationFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    status?: unknown;
    envelope?: { retryable?: unknown } | null;
  };
  const status = candidate.status;
  if (typeof status !== "number" || !Number.isFinite(status) || status <= 0) return false;
  if (candidate.envelope && candidate.envelope.retryable === false) return true;
  return status >= 400 && status < 500;
}

const STORAGE_PREFIX = "terminus.pending-mutation.v1.";
const MAX_MUTATION_SIGNATURE_BYTES = 64 * 1024;
const MAX_MUTATION_KEY_BYTES = 256;
const MAX_COMPLETED_STEPS = 8;
const MAX_CHECKPOINT_RECEIPT_BYTES = 4 * 1024;
const MAX_CHECKPOINT_BYTES = 16 * 1024;
const fingerprintPattern = /^[0-9a-f]{16}$/;
const printableAsciiPattern = /^[\x21-\x7e]+$/;
const checkpointStepPattern = /^[a-z][a-z0-9_-]{0,63}$/;
const textEncoder = new TextEncoder();

type JournalReadResult =
  | { readonly kind: "empty" }
  | { readonly kind: "pending"; readonly pending: PendingMutation }
  | { readonly kind: "blocked"; readonly reason: "unavailable" | "corrupt" };

function fingerprint(signature: string): string {
  // FNV-1a is used only as a privacy-preserving cache identity; the control
  // plane still verifies the canonical request with SHA-256 before replay.
  let hash = 0xcbf29ce484222325n;
  for (const byte of textEncoder.encode(signature)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

function storageKey(scope: string): string {
  return `${STORAGE_PREFIX}${scope}`;
}

function parseCompletedSteps(value: unknown): Readonly<Record<string, string>> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (entries.length > MAX_COMPLETED_STEPS) return null;
  const completedSteps: Record<string, string> = {};
  let totalBytes = 0;
  for (const [step, receipt] of entries) {
    if (!checkpointStepPattern.test(step) || typeof receipt !== "string") return null;
    const receiptBytes = textEncoder.encode(receipt).byteLength;
    if (receiptBytes === 0 || receiptBytes > MAX_CHECKPOINT_RECEIPT_BYTES) return null;
    totalBytes += textEncoder.encode(step).byteLength + receiptBytes;
    if (totalBytes > MAX_CHECKPOINT_BYTES) return null;
    completedSteps[step] = receipt;
  }
  return completedSteps;
}

function readPending(scope: string): JournalReadResult {
  try {
    const storage = window.localStorage;
    if (!storage) return { kind: "blocked", reason: "unavailable" };
    const raw = storage.getItem(storageKey(scope));
    if (raw === null) return { kind: "empty" };
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { kind: "blocked", reason: "corrupt" };
    }
    const record = value as Partial<PendingMutation>;
    // Journals written before checkpoint support remain replayable from their
    // original idempotency key. The first recorded step upgrades them to v2.
    const completedSteps = record.version === undefined && record.completedSteps === undefined
      ? {}
      : record.version === 2
        ? parseCompletedSteps(record.completedSteps)
        : null;
    if (
      completedSteps === null ||
      typeof record.signatureFingerprint !== "string" ||
      !fingerprintPattern.test(record.signatureFingerprint) ||
      typeof record.key !== "string" ||
      record.key.length === 0 ||
      textEncoder.encode(record.key).byteLength > MAX_MUTATION_KEY_BYTES ||
      !printableAsciiPattern.test(record.key) ||
      record.phase !== "pending" ||
      typeof record.createdAt !== "string" ||
      !Number.isFinite(Date.parse(record.createdAt))
    ) return { kind: "blocked", reason: "corrupt" };
    return {
      kind: "pending",
      pending: {
        version: 2,
        signatureFingerprint: record.signatureFingerprint,
        key: record.key,
        phase: "pending",
        createdAt: record.createdAt,
        completedSteps,
      },
    };
  } catch {
    return { kind: "blocked", reason: "unavailable" };
  }
}

function samePending(left: PendingMutation, right: PendingMutation): boolean {
  if (
    left.version !== right.version
    || left.signatureFingerprint !== right.signatureFingerprint
    || left.key !== right.key
    || left.phase !== right.phase
    || left.createdAt !== right.createdAt
  ) return false;
  const leftEntries = Object.entries(left.completedSteps).sort(([leftStep], [rightStep]) => leftStep.localeCompare(rightStep));
  const rightEntries = Object.entries(right.completedSteps).sort(([leftStep], [rightStep]) => leftStep.localeCompare(rightStep));
  return leftEntries.length === rightEntries.length
    && leftEntries.every(([step, receipt], index) => {
      const rightEntry = rightEntries[index];
      return rightEntry?.[0] === step && rightEntry[1] === receipt;
    });
}

function writePending(scope: string, pending: PendingMutation): JournalReadResult {
  try {
    const storage = window.localStorage;
    if (!storage) return { kind: "blocked", reason: "unavailable" };
    storage.setItem(storageKey(scope), JSON.stringify(pending));
  } catch {
    throw new MutationJournalAdmissionError(scope, "write_failed");
  }
  return readPending(scope);
}

function removePending(scope: string): JournalReadResult {
  try {
    const storage = window.localStorage;
    if (!storage) return { kind: "blocked", reason: "unavailable" };
    storage.removeItem(storageKey(scope));
  } catch {
    throw new MutationJournalAdmissionError(scope, "cleanup_failed");
  }
  return readPending(scope);
}

/**
 * Retain one idempotency key while the same user-visible mutation is retried.
 * A changed canonical signature cannot replace an unresolved operation. Call
 * `settle` only after the whole multi-request operation completed successfully.
 */
export function useLogicalMutation(scope: string): {
  acquire: (signature: string) => LogicalMutationAdmission;
  keyFor: (signature: string) => string;
  checkpoint: (key: string, step: string, receipt: string) => LogicalMutationAdmission;
  settle: (key: string) => void;
  /** Release a reconciled partial action after one or more durable effects. */
  completePartial: (key: string) => void;
  /** Release a key after an authoritative rejection, allowing changed input. */
  abandon: (key: string) => void;
} {
  const journalRef = useRef<{ scope: string; pending: PendingMutation | null }>({
    scope,
    pending: null,
  });

  const durablePendingForScope = useCallback((): PendingMutation | null => {
    if (journalRef.current.scope !== scope) {
      journalRef.current = { scope, pending: null };
    }
    const read = readPending(scope);
    if (read.kind === "blocked") {
      throw new MutationJournalAdmissionError(scope, read.reason);
    }
    const pending = read.kind === "pending" ? read.pending : null;
    journalRef.current.pending = pending;
    return pending;
  }, [scope]);

  const acquire = useCallback((signature: string): LogicalMutationAdmission => {
    if (textEncoder.encode(signature).byteLength > MAX_MUTATION_SIGNATURE_BYTES) {
      throw new MutationJournalAdmissionError(scope, "signature_too_large");
    }
    const signatureFingerprint = fingerprint(signature);
    const pending = durablePendingForScope();
    if (pending?.signatureFingerprint === signatureFingerprint) {
      return { key: pending.key, completedSteps: { ...pending.completedSteps } };
    }
    if (pending) throw new PendingMutationConflictError(scope);
    const key = createIdempotencyKey(scope);
    const nextPending: PendingMutation = {
      version: 2,
      signatureFingerprint,
      key,
      phase: "pending",
      createdAt: new Date().toISOString(),
      completedSteps: {},
    };
    const verified = writePending(scope, nextPending);
    if (verified.kind !== "pending" || !samePending(verified.pending, nextPending)) {
      journalRef.current.pending = verified.kind === "pending" ? verified.pending : null;
      throw new MutationJournalAdmissionError(scope, "verification_failed");
    }
    journalRef.current.pending = nextPending;
    return { key, completedSteps: {} };
  }, [durablePendingForScope, scope]);

  const keyFor = useCallback((signature: string): string => acquire(signature).key, [acquire]);

  const checkpoint = useCallback((key: string, step: string, receipt: string): LogicalMutationAdmission => {
    if (!checkpointStepPattern.test(step)) {
      throw new MutationJournalAdmissionError(scope, "checkpoint_too_large");
    }
    const receiptBytes = textEncoder.encode(receipt).byteLength;
    if (receiptBytes === 0 || receiptBytes > MAX_CHECKPOINT_RECEIPT_BYTES) {
      throw new MutationJournalAdmissionError(scope, "checkpoint_too_large");
    }
    const pending = durablePendingForScope();
    if (!pending || pending.key !== key) throw new PendingMutationConflictError(scope);
    const existingReceipt = pending.completedSteps[step];
    if (existingReceipt !== undefined) {
      if (existingReceipt !== receipt) throw new PendingMutationConflictError(scope);
      return { key, completedSteps: { ...pending.completedSteps } };
    }
    const completedSteps = { ...pending.completedSteps, [step]: receipt };
    if (Object.keys(completedSteps).length > MAX_COMPLETED_STEPS) {
      throw new MutationJournalAdmissionError(scope, "checkpoint_too_large");
    }
    const checkpointBytes = Object.entries(completedSteps).reduce(
      (total, [completedStep, completedReceipt]) => total
        + textEncoder.encode(completedStep).byteLength
        + textEncoder.encode(completedReceipt).byteLength,
      0,
    );
    if (checkpointBytes > MAX_CHECKPOINT_BYTES) {
      throw new MutationJournalAdmissionError(scope, "checkpoint_too_large");
    }
    const nextPending: PendingMutation = { ...pending, version: 2, completedSteps };
    const verified = writePending(scope, nextPending);
    if (verified.kind !== "pending" || !samePending(verified.pending, nextPending)) {
      journalRef.current.pending = verified.kind === "pending" ? verified.pending : pending;
      throw new MutationJournalAdmissionError(scope, "verification_failed");
    }
    journalRef.current.pending = nextPending;
    return { key, completedSteps: { ...completedSteps } };
  }, [durablePendingForScope, scope]);

  const clear = useCallback((key: string): void => {
    const pending = durablePendingForScope();
    if (!pending) {
      journalRef.current.pending = null;
      return;
    }
    if (pending.key !== key) throw new PendingMutationConflictError(scope);
    const verified = removePending(scope);
    if (verified.kind !== "empty") {
      journalRef.current.pending = verified.kind === "pending" ? verified.pending : pending;
      throw new MutationJournalAdmissionError(scope, "cleanup_failed");
    }
    journalRef.current.pending = null;
  }, [durablePendingForScope, scope]);

  const settle = useCallback((key: string): void => {
    clear(key);
  }, [clear]);

  const completePartial = useCallback((key: string): void => {
    const pending = durablePendingForScope();
    if (!pending || pending.key !== key || Object.keys(pending.completedSteps).length === 0) {
      throw new PendingMutationConflictError(scope);
    }
    clear(key);
  }, [clear, durablePendingForScope, scope]);

  const abandon = useCallback((key: string): void => {
    // Keep this separate from settle at call sites: settle means the effect
    // completed; abandon means the control plane definitively rejected it.
    const pending = durablePendingForScope();
    if (!pending || pending.key !== key || Object.keys(pending.completedSteps).length > 0) {
      throw new PendingMutationConflictError(scope);
    }
    clear(key);
  }, [clear, durablePendingForScope, scope]);

  return useMemo(
    () => ({ acquire, keyFor, checkpoint, settle, completePartial, abandon }),
    [abandon, acquire, checkpoint, completePartial, keyFor, settle],
  );
}

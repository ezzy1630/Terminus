/**
 * @forge/adapter-sdk — external harness adapter SDK.
 *
 * Per SPEC §12.4, §35.11: `ExternalAdapter` interface with launch(contract,
 * worktree, budgets), streamEvents(), cancel(), collectResult(). Capability
 * profile (exact_context_visibility, tool_interception, filesystem_enforcement,
 * etc.).
 */
import { z } from "zod";
import type {
  Uuid7,
  Rfc3339Timestamp,
  ContentHash,
  ArtifactRef,
} from "@forge/domain";
import { ValidationError } from "@forge/domain";

// ────────────────────────── Capability profile (§35.11) ──────────────────────

export const adapterCapabilityProfileSchema = {
  exactContextVisibility: ["full", "partial", "opaque"] as const,
  toolInterception: ["full", "partial", "none"] as const,
  filesystemEnforcement: ["native", "outer_sandbox", "none"] as const,
  networkEnforcement: ["native", "outer_sandbox", "none"] as const,
  secretIsolation: ["native", "outer_broker", "none"] as const,
  sessionResume: ["native", "emulated", "none"] as const,
  typedResults: ["native", "parsed", "none"] as const,
  artifactExport: ["complete", "partial", "none"] as const,
  cancellation: ["reliable", "best_effort", "none"] as const,
  modelSelection: ["controlled", "constrained", "opaque"] as const,
};

export interface AdapterCapabilityProfile {
  readonly exactContextVisibility: "full" | "partial" | "opaque";
  readonly toolInterception: "full" | "partial" | "none";
  readonly filesystemEnforcement: "native" | "outer_sandbox" | "none";
  readonly networkEnforcement: "native" | "outer_sandbox" | "none";
  readonly secretIsolation: "native" | "outer_broker" | "none";
  readonly sessionResume: "native" | "emulated" | "none";
  readonly typedResults: "native" | "parsed" | "none";
  readonly artifactExport: "complete" | "partial" | "none";
  readonly cancellation: "reliable" | "best_effort" | "none";
  readonly modelSelection: "controlled" | "constrained" | "opaque";
  readonly nativeCompaction: boolean;
  readonly observedByProbe: Rfc3339Timestamp | null;
  readonly lastVerified: Rfc3339Timestamp | null;
}

// ────────────────────────── Contract ─────────────────────────────────────────

export interface AdapterContract {
  readonly adapterId: string;
  readonly version: string;
  readonly innerHarnessVersion: string;
  readonly taskContractHash: ContentHash;
  readonly worktreeId: string;
  readonly budgets: AdapterBudgets;
  readonly permittedCapabilities: readonly string[];
  readonly sourceArtifacts: readonly ArtifactRef[];
  readonly outputSchemaVersion: string;
  readonly stopConditions: readonly string[];
}

export interface AdapterBudgets {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly toolCalls: number;
  readonly costMicros: bigint;
  readonly wallClockSeconds: number;
}

// ────────────────────────── Adapter events ───────────────────────────────────

export type AdapterEvent =
  | { readonly kind: "started"; readonly startedAt: Rfc3339Timestamp }
  | { readonly kind: "progress"; readonly message: string; readonly timestamp: Rfc3339Timestamp }
  | { readonly kind: "tool_call"; readonly toolCallId: string; readonly toolName: string; readonly timestamp: Rfc3339Timestamp }
  | { readonly kind: "tool_result"; readonly toolCallId: string; readonly status: string; readonly timestamp: Rfc3339Timestamp }
  | { readonly kind: "artifact_emitted"; readonly artifactHash: ContentHash; readonly timestamp: Rfc3339Timestamp }
  | { readonly kind: "completed"; readonly status: "completed" | "blocked" | "failed" | "budget_exhausted" | "policy_denied"; readonly timestamp: Rfc3339Timestamp }
  | { readonly kind: "cancelled"; readonly timestamp: Rfc3339Timestamp }
  | { readonly kind: "error"; readonly errorCode: string; readonly errorMessage: string; readonly timestamp: Rfc3339Timestamp };

// ────────────────────────── Adapter result ───────────────────────────────────

export interface AdapterResult {
  readonly status: "completed" | "blocked" | "failed" | "budget_exhausted" | "policy_denied";
  readonly summary: string;
  readonly changedFiles: readonly string[];
  readonly commit: string | null;
  readonly tests: readonly {
    readonly command: string;
    readonly status: "passed" | "failed" | "skipped" | "error";
    readonly evidence: string | null;
    readonly sourceRevision: string;
  }[];
  readonly findings: readonly string[];
  readonly risks: readonly string[];
  readonly unresolved: readonly string[];
  readonly artifacts: readonly ArtifactRef[];
  readonly actualBudget: Partial<AdapterBudgets>;
}

// ────────────────────────── Adapter interface ────────────────────────────────

export interface ExternalAdapter {
  readonly adapterId: string;
  readonly version: string;
  readonly capabilityProfile: AdapterCapabilityProfile;
  launch(contract: AdapterContract, signal: AbortSignal | null): Promise<void>;
  streamEvents(signal: AbortSignal | null): AsyncIterable<AdapterEvent>;
  cancel(reason: string): Promise<void>;
  collectResult(): Promise<AdapterResult>;
}

// ────────────────────────── Adapter registry ─────────────────────────────────

export interface AdapterRegistry {
  register(adapter: ExternalAdapter): Promise<void>;
  get(adapterId: string): Promise<ExternalAdapter | null>;
  list(): Promise<readonly ExternalAdapter[]>;
}

/**
 * Validates that the adapter's declared capability matches the observed
 * capability (from a probe). Declared/observed discrepancies are surfaced and
 * may disable the adapter.
 */
export function validateCapabilityProfile(
  declared: AdapterCapabilityProfile,
  observed: AdapterCapabilityProfile,
): { readonly ok: boolean; readonly discrepancies: readonly string[] } {
  const discrepancies: string[] = [];
  const keys: readonly (keyof AdapterCapabilityProfile)[] = [
    "exactContextVisibility",
    "toolInterception",
    "filesystemEnforcement",
    "networkEnforcement",
    "secretIsolation",
    "sessionResume",
    "typedResults",
    "artifactExport",
    "cancellation",
    "modelSelection",
    "nativeCompaction",
  ];
  for (const k of keys) {
    if (declared[k] !== observed[k]) {
      discrepancies.push(`${k}: declared=${declared[k]} observed=${observed[k]}`);
    }
  }
  return { ok: discrepancies.length === 0, discrepancies };
}

/**
 * Schema failure gets at most one correction attempt. After that the result is
 * treated as failed, not guessed from prose.
 */
export function validateAdapterResult(
  result: unknown,
  allowRetry: boolean,
): { readonly ok: true; readonly result: AdapterResult } | { readonly ok: false; readonly reason: string; readonly mayRetry: boolean } {
  if (typeof result !== "object" || result === null) {
    return { ok: false, reason: "result is not an object", mayRetry: allowRetry };
  }
  const r = result as Record<string, unknown>;
  if (typeof r.status !== "string") {
    return { ok: false, reason: "missing status", mayRetry: allowRetry };
  }
  if (typeof r.summary !== "string") {
    return { ok: false, reason: "missing summary", mayRetry: allowRetry };
  }
  if (!Array.isArray(r.changedFiles)) {
    return { ok: false, reason: "missing changedFiles", mayRetry: allowRetry };
  }
  // The full validation is left to the caller's zod schema; here we just
  // sanity-check the top-level fields.
  return { ok: true, result: r as unknown as AdapterResult };
  void z;
}

export { ValidationError };
export type { Uuid7, Rfc3339Timestamp, ContentHash, ArtifactRef };

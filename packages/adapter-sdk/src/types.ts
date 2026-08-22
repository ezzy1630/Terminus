/**
 * Shared adapter types (SPEC §35.11–35.12).
 */
import type { Uuid7, Rfc3339Timestamp, ContentHash, ArtifactRef } from "@terminus/domain";

/**
 * Component maturity (roadmap Phase 0). A stub must never be discoverable
 * as production-capable; the adapter registry enforces this.
 */
export type AdapterMaturity = "fixture" | "stub" | "experimental" | "preview" | "production";

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
  /** How far this adapter implementation has actually gotten. */
  readonly maturity: AdapterMaturity;
  readonly observedByProbe: Rfc3339Timestamp | null;
  /**
   * Timestamp of the last live conformance probe against the real inner
   * harness. `null` means the adapter has never been verified — it MUST NOT
   * be registered with `maturity: "production"` (SPEC §35.12, roadmap Phase 0).
   */
  readonly lastVerified: Rfc3339Timestamp | null;
}

export interface AdapterBudgets {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly toolCalls: number;
  readonly costMicros: bigint;
  readonly wallClockSeconds: number;
}

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

export type AdapterEvent =
  | { readonly kind: "started"; readonly startedAt: Rfc3339Timestamp }
  | { readonly kind: "progress"; readonly message: string; readonly timestamp: Rfc3339Timestamp }
  | {
      readonly kind: "tool_call";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly timestamp: Rfc3339Timestamp;
    }
  | {
      readonly kind: "tool_result";
      readonly toolCallId: string;
      readonly status: string;
      readonly timestamp: Rfc3339Timestamp;
    }
  | {
      readonly kind: "artifact_emitted";
      readonly artifactHash: ContentHash;
      readonly timestamp: Rfc3339Timestamp;
    }
  | {
      readonly kind: "completed";
      readonly status: "completed" | "blocked" | "failed" | "budget_exhausted" | "policy_denied";
      readonly timestamp: Rfc3339Timestamp;
    }
  | { readonly kind: "cancelled"; readonly timestamp: Rfc3339Timestamp }
  | {
      readonly kind: "error";
      readonly errorCode: string;
      readonly errorMessage: string;
      readonly timestamp: Rfc3339Timestamp;
    };

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

export interface ExternalAdapter {
  readonly adapterId: string;
  readonly version: string;
  readonly capabilityProfile: AdapterCapabilityProfile;
  readonly enabled: boolean;
  launch(contract: AdapterContract, signal: AbortSignal | null): Promise<void>;
  streamEvents(signal: AbortSignal | null): AsyncIterable<AdapterEvent>;
  cancel(reason: string): Promise<void>;
  collectResult(): Promise<AdapterResult>;
}

export type { Uuid7, Rfc3339Timestamp, ContentHash, ArtifactRef };

/**
 * Usage and harmful-use telemetry (SPEC §39.8).
 *
 * Harmful-use counter triggers automatic quarantine above threshold.
 */
import type { MemoryClaim, Rfc3339Timestamp, Uuid7 } from "@terminus/domain";

export interface MemoryTelemetryEvent {
  readonly kind:
    | "retrieved"
    | "successful_use"
    | "harmful_use"
    | "quarantined"
    | "contradiction"
    | "supersession"
    | "expired"
    | "promoted_to_skill";
  readonly claimId: Uuid7;
  readonly at: Rfc3339Timestamp;
  readonly detail: string | null;
}

export interface TelemetrySink {
  record(event: MemoryTelemetryEvent): void;
}

export class InMemoryTelemetrySink implements TelemetrySink {
  readonly events: MemoryTelemetryEvent[] = [];

  record(event: MemoryTelemetryEvent): void {
    this.events.push(event);
  }

  clear(): void {
    this.events.length = 0;
  }

  byKind(kind: MemoryTelemetryEvent["kind"]): readonly MemoryTelemetryEvent[] {
    return this.events.filter((e) => e.kind === kind);
  }
}

export interface HarmPolicy {
  /** Quarantine when harmfulUses >= threshold (default 3). */
  readonly harmfulUseQuarantineThreshold: number;
}

export const DEFAULT_HARM_POLICY: HarmPolicy = {
  harmfulUseQuarantineThreshold: 3,
};

export interface UsageUpdate {
  readonly claim: MemoryClaim;
  readonly quarantine: boolean;
}

export function recordRetrieval(
  claim: MemoryClaim,
  now: Rfc3339Timestamp,
): MemoryClaim {
  return {
    ...claim,
    usage: {
      ...claim.usage,
      count: claim.usage.count + 1,
      lastUsedAt: now,
    },
  };
}

export function recordSuccessfulUse(claim: MemoryClaim, now: Rfc3339Timestamp): MemoryClaim {
  return {
    ...claim,
    usage: {
      ...claim.usage,
      count: claim.usage.count + 1,
      lastUsedAt: now,
      successfulUses: claim.usage.successfulUses + 1,
    },
  };
}

export function recordHarmfulUse(
  claim: MemoryClaim,
  now: Rfc3339Timestamp,
  policy: HarmPolicy = DEFAULT_HARM_POLICY,
): UsageUpdate {
  const updated: MemoryClaim = {
    ...claim,
    usage: {
      ...claim.usage,
      count: claim.usage.count + 1,
      lastUsedAt: now,
      harmfulUses: claim.usage.harmfulUses + 1,
    },
  };
  const quarantine = updated.usage.harmfulUses >= policy.harmfulUseQuarantineThreshold;
  return {
    claim: quarantine ? { ...updated, status: "disputed" } : updated,
    quarantine,
  };
}

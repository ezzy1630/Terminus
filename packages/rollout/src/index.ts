/**
 * @terminus/rollout — canonical session trajectory format (ADR-0047).
 *
 * A rollout is a total-ordered projection of the control plane's persisted
 * semantic-event log into portable, schema-versioned lines. Storage stays
 * in the SemanticEvent table; this module owns:
 *   - line/item types + zod validation (decode fails closed on unknowns),
 *   - deterministic projection from stored events to rollout lines,
 *   - JSONL encoding for export / tooling,
 *   - resume cursors and prefix-fork planning over projected lines.
 */

import { z } from "zod";

// ───────────────────────────── Constants ────────────────────────────

/** Upper bound for one serialized rollout item (aligns with hook caps). */
export const MAX_ROLLOUT_ITEM_BYTES = 128 * 1024;

export const ROLLOUT_FORMAT_VERSION = 1 as const;

// ─────────────────────────────── Types ──────────────────────────────

const aggregateSchema = z.object({
  type: z.string().min(1).max(64),
  id: z.string().min(1).max(255),
});

const baseItemSchema = z.object({
  event_id: z.string().min(1),
  occurred_at: z.string().min(1),
  aggregate: aggregateSchema,
});

/**
 * Trajectory items. `event` is the generic envelope for any semantic event;
* well-known kinds may be specialized later without breaking decoding
 * (unknown `kind` values decode as plain `event`).
 */
export const rolloutItemSchema = baseItemSchema.extend({
  kind: z.enum([
    "event",
    "message",
    "tool_call",
    "tool_result",
    "compaction",
    "checkpoint",
    "gate_verdict",
    "usage",
  ]),
  /** Semantic event catalog type, e.g. "turn.started". */
  event_type: z.string().min(1).max(128),
  payload: z.unknown(),
});

export type RolloutItem = z.infer<typeof rolloutItemSchema>;

export const rolloutLineSchema = z.object({
  format_version: z.literal(ROLLOUT_FORMAT_VERSION),
  ordinal: z.number().int().nonnegative(),
  item: rolloutItemSchema,
});

export type RolloutLine = z.infer<typeof rolloutLineSchema>;

/** Decode an untrusted rollout line; unknown shapes fail closed. */
export function decodeRolloutLine(value: unknown): RolloutLine {
  return rolloutLineSchema.parse(value);
}

// ─────────────────────────── Projection input ───────────────────────

/** Minimal shape of a persisted semantic event row. */
export interface StoredEventRow {
  readonly eventId: string;
  readonly eventType: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly aggregateSequence: number;
  readonly occurredAt: Date | string;
  readonly payloadJson: string;
}

// ───────────────────────── Specialized mapping ──────────────────────

const KIND_BY_EVENT_PREFIX: ReadonlyArray<readonly [prefix: string, kind: RolloutItem["kind"]]> = [
  ["turn.message", "message"],
  ["turn.tool_called", "tool_call"],
  ["turn.tool_settled", "tool_result"],
  ["compaction.", "compaction"],
  ["checkpoint.", "checkpoint"],
  ["verification.gate", "gate_verdict"],
  ["usage.", "usage"],
];

function classify(eventType: string): RolloutItem["kind"] {
  for (const [prefix, kind] of KIND_BY_EVENT_PREFIX) {
    if (eventType.startsWith(prefix) || eventType === prefix.replace(/\.$/, "")) {
      return kind;
    }
  }
  return "event";
}

/**
 * Project one page of stored events (already filtered to the session scope)
 * into rollout lines. Ordinals are assigned densely in projection order.
 *
 * Ordering is total: `(occurredAt, aggregateSequence, eventId)`. Events that
 * exceed `MAX_ROLLOUT_ITEM_BYTES` serialized are rejected — never silently
 * truncated.
 */
export function projectStoredEvents(events: readonly StoredEventRow[]): readonly RolloutLine[] {
  const ordered = [...events].sort((a, b) => {
    const ta = iso(a.occurredAt);
    const tb = iso(b.occurredAt);
    if (ta !== tb) return ta < tb ? -1 : 1;
    if (a.aggregateSequence !== b.aggregateSequence) {
      return a.aggregateSequence - b.aggregateSequence;
    }
    return a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0;
  });
  return ordered.map((row, index) => {
    const item: RolloutItem = {
      event_id: row.eventId,
      occurred_at: iso(row.occurredAt),
      aggregate: { type: row.aggregateType, id: row.aggregateId },
      kind: classify(row.eventType),
      event_type: row.eventType,
      payload: parsePayload(row.payloadJson),
    };
    const line: RolloutLine = {
      format_version: ROLLOUT_FORMAT_VERSION,
      ordinal: index,
      item,
    };
    const encoded = JSON.stringify(line);
    if (Buffer.byteLength(encoded, "utf8") > MAX_ROLLOUT_ITEM_BYTES) {
      throw new RangeError(
        `rollout item ${row.eventId} exceeds MAX_ROLLOUT_ITEM_BYTES (${MAX_ROLLOUT_ITEM_BYTES})`,
      );
    }
    return line;
  });
}

function iso(value: Date | string): string {
  return typeof value === "string" ? value : value.toISOString();
}

function parsePayload(payloadJson: string): unknown {
  try {
    return JSON.parse(payloadJson) as unknown;
  } catch {
    // A corrupt payload must not poison the whole trajectory; surface it
    // explicitly as an undecodable marker instead of failing the page.
    return { undecodable_payload: true };
  }
}

// ───────────────────────────── JSONL form ───────────────────────────

export function rolloutToJsonl(lines: readonly RolloutLine[]): string {
  return lines.map((line) => JSON.stringify(line)).join("\n") + (lines.length > 0 ? "\n" : "");
}

export function rolloutFromJsonl(text: string): readonly RolloutLine[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  return trimmed.split("\n").map((line) => decodeRolloutLine(JSON.parse(line) as unknown));
}

// ───────────────────────── Resume + fork helpers ────────────────────

/**
 * The resume cursor is the `event_id` of the last projected line; callers
 * re-query storage with "strictly after" semantics.
 */
export function resumeCursor(lines: readonly RolloutLine[]): string | null {
  const last = lines.at(-1);
  return last?.item.event_id ?? null;
}

/**
 * Plan a fork of the trajectory prefix `uptoOrdinalInclusive` into a new
 * session: returns the source lines to copy. The caller persists them under
 * the fork's session scope with fresh ordinals starting at 0 and appends a
 * `session.forked` marker carrying `source_session` provenance.
 */
export function planForkPrefix(
  lines: readonly RolloutLine[],
  uptoOrdinalInclusive: number,
): readonly RolloutLine[] {
  return lines.filter((line) => line.ordinal <= uptoOrdinalInclusive);
}

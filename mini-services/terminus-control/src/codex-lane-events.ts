/**
 * Sanitized, reconnectable projection of Codex App Server notifications.
 * Durable session state stores only identifiers; this is an in-memory window.
 *
 * Cursors include a process-local epoch. A cursor from a previous control
 * process cannot accidentally look valid after the bounded replay window was
 * rebuilt, so clients receive an explicit resync signal instead of silent
 * event loss.
 */

import { randomUUID } from "node:crypto";

export const CODEX_EVENT_RING_LIMIT = 256;

export interface CodexLaneEvent {
  readonly cursor: string;
  readonly sequence: number;
  readonly kind: string;
  readonly text: string | null;
}

export interface CodexLaneEventRead {
  readonly events: readonly CodexLaneEvent[];
  readonly next_cursor: string;
  readonly cursor_expired: boolean;
  /** The bounded snapshot cursor clients should use after resync. */
  readonly resync_cursor: string | null;
}

const CODEX_MAX_TEXT = 64 * 1_024;
const CODEX_VISIBLE_EVENT_METHODS = new Set([
  "item/agentMessage/delta",
  "item/started",
  "item/completed",
  "turn/started",
  "turn/completed",
  "turn/plan/updated",
  "turn/diff/updated",
  "thread/tokenUsage/updated",
  "error",
  "warning",
]);

const CODEX_ITEM_LABELS: Readonly<Record<string, string>> = {
  agentMessage: "Assistant message",
  userMessage: "User message",
  commandExecution: "Command",
  fileChange: "File changes",
  mcpToolCall: "Tool call",
  dynamicToolCall: "Tool call",
  webSearch: "Web search",
  contextCompaction: "Context compaction",
};

/** `undefined` drops the event; `null` keeps a lifecycle event with no text. */
function eventText(method: string, params: Record<string, unknown>): string | null | undefined {
  if (method === "error") return "Codex reported an error";
  if (method === "warning") return "Codex reported a warning";
  if (method === "item/agentMessage/delta") {
    const delta = params.delta;
    return typeof delta === "string" && delta.length > 0 ? delta.slice(0, CODEX_MAX_TEXT) : undefined;
  }
  if (method === "item/started" || method === "item/completed") {
    const item = params.item;
    if (item === null || typeof item !== "object" || Array.isArray(item)) return undefined;
    const type = (item as Record<string, unknown>).type;
    if (type === "reasoning") return undefined;
    const label = typeof type === "string" ? CODEX_ITEM_LABELS[type] ?? "Work item" : "Work item";
    return `${label} ${method === "item/started" ? "started" : "completed"}`;
  }
  if (method === "turn/started") return "Turn started";
  if (method === "turn/completed") {
    const turn = params.turn;
    const status = turn !== null && typeof turn === "object" && !Array.isArray(turn)
      ? (turn as Record<string, unknown>).status
      : null;
    return status === "interrupted" ? "Turn interrupted"
      : status === "failed" ? "Turn failed"
        : "Turn completed";
  }
  if (method === "turn/plan/updated") return "Plan updated";
  if (method === "turn/diff/updated") return "Changes updated";
  if (method === "thread/tokenUsage/updated") return "Usage updated";
  return null;
}

export class CodexLaneEventBuffer {
  private readonly events: CodexLaneEvent[] = [];
  private readonly epoch = randomUUID();
  private nextCursor = 0;

  append(message: Record<string, unknown>): void {
    const method = typeof message.method === "string" ? message.method.slice(0, 128) : "event";
    if (!CODEX_VISIBLE_EVENT_METHODS.has(method)) return;
    const params = message.params;
    const text = eventText(method, params !== null && typeof params === "object" ? params as Record<string, unknown> : {});
    if (text === undefined) return;
    this.nextCursor += 1;
    this.events.push({ cursor: this.cursor(this.nextCursor), sequence: this.nextCursor, kind: method, text });
    if (this.events.length > CODEX_EVENT_RING_LIMIT) this.events.shift();
  }

  read(cursor: string | null): CodexLaneEventRead {
    const parsed = this.parseCursor(cursor);
    const requested = parsed?.sequence ?? 0;
    const first = this.events[0]?.sequence ?? this.nextCursor + 1;
    const cursorExpired = cursor !== null && (parsed === null || requested < first - 1);
    return {
      events: cursorExpired ? this.events.slice() : this.events.filter((event) => event.sequence > requested),
      next_cursor: this.cursor(this.nextCursor),
      cursor_expired: cursorExpired,
      resync_cursor: cursorExpired ? this.cursor(this.nextCursor) : null,
    };
  }

  private cursor(sequence: number): string {
    return `${this.epoch}:${sequence}`;
  }

  private parseCursor(cursor: string | null): { readonly sequence: number } | null {
    if (cursor === null) return { sequence: 0 };
    const separator = cursor.indexOf(":");
    if (separator <= 0 || cursor.slice(0, separator) !== this.epoch) return null;
    const sequence = Number(cursor.slice(separator + 1));
    return Number.isSafeInteger(sequence) && sequence >= 0 ? { sequence } : null;
  }
}

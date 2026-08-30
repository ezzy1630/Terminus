/**
 * Sanitized, reconnectable projection of Codex App Server notifications.
 * Durable session state stores only identifiers; this is an in-memory window.
 */

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
}

const CODEX_MAX_TEXT = 64 * 1_024;
const CODEX_VISIBLE_EVENT_METHODS = new Set([
  "item/agentMessage/delta",
  "item/agentMessage/completed",
  "turn/started",
  "turn/completed",
  "turn/failed",
  "error",
  "account/status",
]);

function eventText(method: string, params: Record<string, unknown>): string | null {
  if (method === "turn/failed" || method === "error") return "Codex reported an error";
  for (const key of ["delta", "text", "message"] as const) {
    const value = params[key];
    if (typeof value === "string" && value.length > 0) return value.slice(0, CODEX_MAX_TEXT);
  }
  if (method === "turn/completed") return "Turn completed";
  return null;
}

export class CodexLaneEventBuffer {
  private readonly events: CodexLaneEvent[] = [];
  private nextCursor = 0;

  append(message: Record<string, unknown>): void {
    const method = typeof message.method === "string" ? message.method.slice(0, 128) : "event";
    if (!CODEX_VISIBLE_EVENT_METHODS.has(method)) return;
    const params = message.params;
    const text = eventText(method, params !== null && typeof params === "object" ? params as Record<string, unknown> : {});
    this.nextCursor += 1;
    this.events.push({ cursor: String(this.nextCursor), sequence: this.nextCursor, kind: method, text });
    if (this.events.length > CODEX_EVENT_RING_LIMIT) this.events.shift();
  }

  read(cursor: string | null): CodexLaneEventRead {
    const requested = cursor === null ? 0 : Number(cursor);
    const first = this.events[0]?.sequence ?? this.nextCursor + 1;
    const cursorExpired = requested < first - 1;
    return {
      events: cursorExpired ? this.events.slice() : this.events.filter((event) => event.sequence > requested),
      next_cursor: String(this.nextCursor),
      cursor_expired: cursorExpired,
    };
  }
}

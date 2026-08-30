/**
 * @terminus/provider-core — store for replayable reasoning.
 *
 * Both vendors now require the client to hand a reasoning chain back verbatim
 * when it continues a turn through a tool call, and both fail loudly when it
 * does not:
 *
 *   - OpenAI Responses with `store: false` keeps nothing server-side; the
 *     encrypted item requested through `include` must be replayed immediately
 *     before the function call it produced, or the model re-derives the chain
 *     from scratch on every attempt.
 *   - Anthropic rejects an assistant turn whose `tool_use` block is not
 *     preceded by the `thinking` block that produced it — dropping or editing
 *     a thinking block is an ordering/signature 400, not a silent downgrade.
 *
 * The shape of the fix is the same for both, so it lives here once: a map from
 * provider call id to the reasoning items that preceded that call, filled when
 * a response is projected and read when the next request is rendered.
 *
 * The map is also serialisable, because a renderer's lifetime is *not* the
 * lifetime of the conversation it renders. A control plane that restarts
 * mid-turn rebuilds the renderer from scratch while the tool calls of that
 * same turn are still in the database and still get rendered — replaying them
 * without their reasoning is the 400 above. {@link ReasoningReplayLedger.seed}
 * restores a persisted map so a fresh renderer starts where the last one
 * stopped.
 *
 * Nothing here reads or rewrites the payload. It is a provider-owned blob.
 */
import type { ProviderReasoningItem, ProviderResponseChunk } from "./index.js";

/** One provider call and the reasoning that immediately preceded it. */
export interface ReasoningReplayEntry {
  readonly callId: string;
  readonly items: readonly ProviderReasoningItem[];
}

export class ReasoningReplayLedger {
  private readonly byCallId = new Map<string, readonly ProviderReasoningItem[]>();

  /** Records the items that preceded one tool call. */
  record(callId: string, items: readonly ProviderReasoningItem[]): void {
    if (callId === "" || items.length === 0) return;
    this.byCallId.set(callId, items);
  }

  itemsFor(callId: string): readonly ProviderReasoningItem[] {
    return this.byCallId.get(callId) ?? [];
  }

  get size(): number {
    return this.byCallId.size;
  }

  /** The whole map, for persistence. Order is insertion order. */
  entries(): readonly ReasoningReplayEntry[] {
    return [...this.byCallId].map(([callId, items]) => ({ callId, items }));
  }

  /**
   * Restore persisted entries.
   *
   * A live observation always wins: seeding runs at renderer construction, but
   * a turn that re-issues the same call id in flight has the newer signature,
   * and replaying the stale one is the ordering/signature failure this whole
   * file exists to avoid.
   */
  seed(entries: readonly ReasoningReplayEntry[]): void {
    for (const entry of entries) {
      if (entry.callId === "" || entry.items.length === 0) continue;
      if (this.byCallId.has(entry.callId)) continue;
      this.byCallId.set(entry.callId, entry.items);
    }
  }

  /**
   * Walk one response's chunks in wire order, attaching each run of reasoning
   * items to the tool call that followed it. Items with no following tool call
   * belong to a terminal assistant message; that response ends the chain, so
   * there is nothing left to replay them before.
   */
  ingest(chunks: readonly ProviderResponseChunk[]): readonly ProviderReasoningItem[] {
    return this.ingestAll(chunks).items;
  }

  /**
   * The same walk, reported as the keyed entries it recorded. The flat list
   * {@link ingest} returns cannot be persisted: it has lost the association
   * between an item and the call it must be replayed before.
   */
  ingestEntries(chunks: readonly ProviderResponseChunk[]): readonly ReasoningReplayEntry[] {
    return this.ingestAll(chunks).entries;
  }

  /**
   * One walk, both views: every item the response emitted (including a
   * trailing run that no tool call followed, which is reportable but not
   * replayable) and the keyed entries that were recorded.
   */
  ingestAll(chunks: readonly ProviderResponseChunk[]): {
    readonly items: readonly ProviderReasoningItem[];
    readonly entries: readonly ReasoningReplayEntry[];
  } {
    const all: ProviderReasoningItem[] = [];
    const entries: ReasoningReplayEntry[] = [];
    let pending: ProviderReasoningItem[] = [];
    for (const chunk of chunks) {
      if (chunk.reasoningItem !== undefined) {
        pending.push(chunk.reasoningItem);
        all.push(chunk.reasoningItem);
        continue;
      }
      if (chunk.kind === "tool_call" && chunk.toolCall !== undefined) {
        const callId = chunk.toolCall.toolCallId;
        if (callId !== "" && pending.length > 0) {
          this.record(callId, pending);
          entries.push({ callId, items: pending });
        }
        pending = [];
      }
    }
    return { items: all, entries };
  }
}

/** Canonical JSON for the persisted column. */
export function serializeReasoningReplay(entries: readonly ReasoningReplayEntry[]): string {
  return JSON.stringify(entries.map((entry) => ({
    call_id: entry.callId,
    items: entry.items.map((item) => ({
      id: item.id,
      encrypted_content: item.encryptedContent,
      summary: [...item.summary],
    })),
  })));
}

/**
 * Decode a persisted column.
 *
 * Tolerant by construction: a row written by an older build, by a different
 * vendor, or truncated by an operator must degrade to "no replay available"
 * rather than fail the turn. The cost of a missing entry is a re-derived
 * reasoning chain; the cost of a throw here is a dead turn.
 */
export function parseReasoningReplay(json: string | null | undefined): readonly ReasoningReplayEntry[] {
  if (json === null || json === undefined || json === "") return [];
  let decoded: unknown;
  try {
    decoded = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(decoded)) return [];
  const entries: ReasoningReplayEntry[] = [];
  for (const raw of decoded) {
    if (typeof raw !== "object" || raw === null) continue;
    const row = raw as Record<string, unknown>;
    const callId = typeof row.call_id === "string" ? row.call_id : "";
    if (callId === "" || !Array.isArray(row.items)) continue;
    const items: ProviderReasoningItem[] = [];
    for (const rawItem of row.items) {
      if (typeof rawItem !== "object" || rawItem === null) continue;
      const item = rawItem as Record<string, unknown>;
      const id = typeof item.id === "string" ? item.id : "";
      const encryptedContent = typeof item.encrypted_content === "string" ? item.encrypted_content : "";
      if (id === "" || encryptedContent === "") continue;
      const summary = Array.isArray(item.summary)
        ? item.summary.filter((part): part is string => typeof part === "string")
        : [];
      items.push({ id, encryptedContent, summary });
    }
    if (items.length > 0) entries.push({ callId, items });
  }
  return entries;
}

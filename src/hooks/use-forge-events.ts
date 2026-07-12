"use client";

import * as React from "react";
import { forgeEventSource } from "@/lib/forge-client";

/**
 * Subscribe to the Forge semantic-event stream (SSE) on /v1/events.
 *
 * Returns the running list of events (newest first), the last error,
 * the connection state, and a manual reconnect trigger.
 *
 * Per SPEC §32.5, clients treat events as potentially duplicated —
 * this hook dedupes by event id.
 */
export interface ForgeEvent {
  id: string;
  event: string;
  data: unknown;
  receivedAt: number;
}

export interface UseForgeEventsOptions {
  taskId?: string;
  sessionId?: string;
  cursor?: string;
  /** Maximum number of events to retain in memory. */
  max?: number;
  /** Auto-subscribe on mount (default true). */
  enabled?: boolean;
}

export interface UseForgeEventsResult {
  events: ForgeEvent[];
  connected: boolean;
  error: string | null;
  reconnect: () => void;
  clear: () => void;
}

export function useForgeEvents(opts: UseForgeEventsOptions = {}): UseForgeEventsResult {
  const { taskId, sessionId, cursor, max = 500, enabled = true } = opts;
  const [events, setEvents] = React.useState<ForgeEvent[]>([]);
  const [connected, setConnected] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [reloadKey, setReloadKey] = React.useState(0);
  // Use refs to avoid re-subscribing when handlers change identity.
  const maxRef = React.useRef(max);
  React.useEffect(() => {
    maxRef.current = max;
  }, [max]);

  const reconnect = React.useCallback(() => setReloadKey((k) => k + 1), []);
  const clear = React.useCallback(() => setEvents([]), []);

  React.useEffect(() => {
    if (!enabled) return;
    let es: EventSource | null = null;
    try {
      es = forgeEventSource({ taskId, sessionId, cursor });
    } catch (e) {
      setError(String(e));
      return;
    }
    const seen = new Set<string>();
    setConnected(false);
    setError(null);

    es.onopen = () => setConnected(true);
    es.onerror = () => {
      setConnected(false);
      // EventSource auto-reconnects; we just record the error.
      setError("event stream interrupted — reconnecting…");
    };
    // Listen to ALL events (no name filter) — onmessage catches untyped ones,
    // but we also use addEventListener for any named events.
    const handle = (ev: MessageEvent) => {
      let data: unknown = ev.data;
      try {
        data = JSON.parse(ev.data);
      } catch {
        // keep raw string
      }
      const id = ev.lastEventId || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      if (seen.has(id)) return;
      seen.add(id);
      if (seen.size > 4096) {
        // Cap memory.
        seen.clear();
      }
      const fe: ForgeEvent = {
        id,
        event: ev.type ?? "message",
        data,
        receivedAt: Date.now(),
      };
      setEvents((prev) => {
        const next = [fe, ...prev];
        const cap = maxRef.current;
        return next.length > cap ? next.slice(0, cap) : next;
      });
    };
    es.onmessage = handle;
    // Try to listen to a set of common named events from the control plane.
    const named = [
      "task.created",
      "task.activated",
      "task.verifying",
      "task.completed",
      "task.aborted",
      "turn.started",
      "turn.context_compiling",
      "turn.provider_running",
      "turn.response_validating",
      "turn.finalizing",
      "turn.completed",
      "turn.failed",
      "context.manifest_persisted",
      "tool.proposed",
      "tool.authorized",
      "tool.settled",
      "approval.requested",
      "approval.resolved",
      "verification.node_passed",
      "verification.node_failed",
      "verification.plan_completed",
      "session.created",
    ];
    for (const n of named) {
      es.addEventListener(n, handle as EventListener);
    }
    return () => {
      es.close();
    };
  }, [taskId, sessionId, cursor, enabled, reloadKey]);

  return { events, connected, error, reconnect, clear };
}

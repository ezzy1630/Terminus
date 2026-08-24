/**
 * Terminus Desktop — Canonical ARP v2 task surface hook.
 *
 * Loads a canonical v2 task (+ its transactional effects) by id, keeps it
 * fresh over `GET /v2/events` SSE envelopes. Effect authorization and
 * settlement remain kernel/policy-broker operations, not client transitions.
 *
 * This is deliberately separate from the legacy v1 store: ARP v2 is the
 * canonical protocol surface, and this hook proves the graphical client can
 * drive the exact same task lifecycle as the CLI's `*-v2` commands.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { arpV2, subscribeEventsV2, type ArpV2EventStream } from "../lib/api-v2";
import type { EffectSnapshot, TaskV2Snapshot } from "../types/v2";
import type { ArpV2EventEnvelope } from "../types/v2";

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 8_000;

function recordFrom(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Only task-bound events may advance this task panel's durable replay cursor. */
export function eventBelongsToTask(envelope: ArpV2EventEnvelope, taskId: string): boolean {
  if (envelope.aggregateType === "task") return envelope.aggregateId === taskId;
  if (envelope.aggregateType !== "effect" && envelope.aggregateType !== "claim") return false;
  const snapshot = recordFrom(recordFrom(envelope.payload)?.snapshot);
  return snapshot?.id === envelope.aggregateId && snapshot.taskId === taskId;
}

export interface UseTaskV2Result {
  /** Snapshot when the id exists on the canonical surface, else null. */
  task: TaskV2Snapshot | null;
  effects: EffectSnapshot[];
  /** Resource truth for the currently selected task. */
  resourceState: "idle" | "loading" | "ready" | "stale" | "error";
  loading: boolean;
  error: string | null;
  streamState: "idle" | "connected" | "reconnecting";
  refresh: () => Promise<void>;
}

export function useTaskV2(taskId: string | null): UseTaskV2Result {
  const [task, setTask] = useState<TaskV2Snapshot | null>(null);
  const [effects, setEffects] = useState<EffectSnapshot[]>([]);
  const [loadedTaskId, setLoadedTaskId] = useState<string | null>(null);
  const [resourceState, setResourceState] = useState<UseTaskV2Result["resourceState"]>("idle");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [streamState, setStreamState] = useState<"idle" | "connected" | "reconnecting">("idle");
  const streamRef = useRef<ArpV2EventStream | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generationRef = useRef(0);
  const requestGenerationRef = useRef(0);
  const requestControllerRef = useRef<AbortController | null>(null);
  const currentTaskIdRef = useRef(taskId);
  const loadedTaskIdRef = useRef<string | null>(null);
  const taskRef = useRef<TaskV2Snapshot | null>(null);
  currentTaskIdRef.current = taskId;
  loadedTaskIdRef.current = loadedTaskId;
  taskRef.current = task;

  const refresh = useCallback(async (): Promise<void> => {
    const requestedTaskId = currentTaskIdRef.current;
    if (!requestedTaskId) {
      requestGenerationRef.current += 1;
      requestControllerRef.current?.abort();
      requestControllerRef.current = null;
      setTask(null);
      setEffects([]);
      setLoadedTaskId(null);
      setResourceState("idle");
      setLoading(false);
      setError(null);
      return;
    }

    const requestGeneration = ++requestGenerationRef.current;
    requestControllerRef.current?.abort();
    const controller = new AbortController();
    requestControllerRef.current = controller;
    const hasCurrentSnapshot = loadedTaskIdRef.current === requestedTaskId && taskRef.current !== null;
    setResourceState(hasCurrentSnapshot ? "stale" : "loading");
    setLoading(true);
    setError(null);

    const isCurrent = (): boolean =>
      currentTaskIdRef.current === requestedTaskId &&
      requestGenerationRef.current === requestGeneration &&
      !controller.signal.aborted;

    try {
      const snapshot = await arpV2.getTask(requestedTaskId, controller.signal);
      if (!isCurrent()) return;
      if (!snapshot) {
        setTask(null);
        setEffects([]);
        setLoadedTaskId(requestedTaskId);
        setResourceState("error");
        setError(`no canonical v2 task with id ${requestedTaskId}`);
        return;
      }

      const nextEffects = await arpV2.listEffects(requestedTaskId, controller.signal);
      if (!isCurrent()) return;
      setTask(snapshot);
      setEffects(nextEffects);
      setLoadedTaskId(requestedTaskId);
      setResourceState("ready");
      setError(null);
    } catch (err) {
      if (!isCurrent()) return;
      setLoadedTaskId(requestedTaskId);
      setResourceState(hasCurrentSnapshot ? "stale" : "error");
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (isCurrent()) {
        requestControllerRef.current = null;
        setLoading(false);
      }
    }
  }, []);

  // Changing identity invalidates every in-flight request before the new
  // resource is loaded. The hook also scopes returned data by loadedTaskId so
  // React cannot render the previous task during the identity transition.
  useEffect(() => {
    requestGenerationRef.current += 1;
    requestControllerRef.current?.abort();
    requestControllerRef.current = null;
    setTask(null);
    setEffects([]);
    setLoadedTaskId(null);
    setError(null);
    setResourceState(taskId ? "loading" : "idle");
    setLoading(Boolean(taskId));
    void refresh();
  }, [taskId, refresh]);

  useEffect(() => () => {
    requestGenerationRef.current += 1;
    requestControllerRef.current?.abort();
    requestControllerRef.current = null;
  }, []);

  // Live updates over the canonical event stream.
  useEffect(() => {
    generationRef.current += 1;
    const generation = generationRef.current;
    if (reconnectTimer.current) {
      clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
    }
    streamRef.current?.close();
    streamRef.current = null;
    if (!taskId) {
      setStreamState("idle");
      return;
    }

    let attempts = 0;
    let refreshFrame: number | null = null;
    let pendingCursor: string | null = null;
    let refreshPending = false;
    let snapshotRefreshInFlight = false;
    let snapshotRefreshDirty = false;
    const refreshSnapshot = async (): Promise<void> => {
      if (snapshotRefreshInFlight) {
        snapshotRefreshDirty = true;
        return;
      }
      snapshotRefreshInFlight = true;
      try {
        do {
          snapshotRefreshDirty = false;
          await refresh();
        } while (snapshotRefreshDirty && generation === generationRef.current);
      } finally {
        snapshotRefreshInFlight = false;
      }
    };
    const flushStreamBatch = (): void => {
      refreshFrame = null;
      if (pendingCursor) {
        try {
          window.localStorage.setItem(`terminus-desktop.v2-cursor.${taskId}`, pendingCursor);
        } catch {
          // Cursor persistence is best effort; the snapshot remains authoritative.
        }
        pendingCursor = null;
      }
      if (refreshPending) {
        refreshPending = false;
        void refreshSnapshot();
      }
    };
    const scheduleStreamBatch = (): void => {
      if (refreshFrame !== null) return;
      refreshFrame = window.requestAnimationFrame(flushStreamBatch);
    };
    const connect = (): void => {
      if (generation !== generationRef.current) return;
      let cursor: string | null = null;
      try {
        cursor = window.localStorage.getItem(`terminus-desktop.v2-cursor.${taskId}`);
      } catch {
        // localStorage unavailable — start live-only.
      }
      const stream = subscribeEventsV2({ taskId, cursor });
      streamRef.current = stream;
      stream.addEventListener("open", () => {
        if (generation !== generationRef.current) return;
        attempts = 0;
        setStreamState("connected");
      });
      stream.addEventListener("message", (envelope) => {
        if (generation !== generationRef.current) return;
        if (!eventBelongsToTask(envelope, taskId)) return;
        pendingCursor = envelope.eventId;
        refreshPending = true;
        scheduleStreamBatch();
      });
      stream.addEventListener("error", () => {
        if (generation !== generationRef.current || reconnectTimer.current) return;
        attempts += 1;
        setStreamState("reconnecting");
        const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.min(attempts - 1, 5));
        reconnectTimer.current = setTimeout(() => {
          reconnectTimer.current = null;
          connect();
        }, delay);
      });
    };
    connect();

    return () => {
      // Invalidate every callback owned by this effect before releasing its
      // resources. A pending reconnect must not resurrect a stream after the
      // task panel unmounts or switches identity.
      generationRef.current += 1;
      refreshPending = false;
      snapshotRefreshDirty = false;
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current);
        reconnectTimer.current = null;
      }
      if (refreshFrame !== null) window.cancelAnimationFrame(refreshFrame);
      streamRef.current?.close();
      streamRef.current = null;
    };
  }, [taskId, refresh]);

  const hasScopedData = loadedTaskId === taskId;
  return {
    task: hasScopedData ? task : null,
    effects: hasScopedData ? effects : [],
    resourceState: taskId && !hasScopedData ? "loading" : taskId ? resourceState : "idle",
    loading: Boolean(taskId) && (!hasScopedData || loading),
    error: hasScopedData ? error : null,
    streamState,
    refresh,
  };
}

/**
 * Terminus Desktop — Canonical ARP v2 task surface hook.
 *
 * Loads a canonical v2 task (+ its transactional effects) by id, keeps it
 * fresh over `GET /v2/events` SSE envelopes, and exposes the human
 * confirmation flow for authorization-gated effects.
 *
 * This is deliberately separate from the legacy v1 store: ARP v2 is the
 * canonical protocol surface, and this hook proves the graphical client can
 * drive the exact same task lifecycle as the CLI's `*-v2` commands.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { arpV2, subscribeEventsV2, type ArpV2EventStream } from "../lib/api-v2";
import type { EffectSnapshot, EffectState, TaskV2Snapshot } from "../types/v2";

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 8_000;

/** Deterministic post-authorization settlement path (server-validated). */
const SETTLEMENT_PATH: readonly EffectState[] = ["PREPARED", "DISPATCHED", "OBSERVED", "VALIDATED"];

export interface UseTaskV2Result {
  /** Snapshot when the id exists on the canonical surface, else null. */
  task: TaskV2Snapshot | null;
  effects: EffectSnapshot[];
  loading: boolean;
  error: string | null;
  streamState: "idle" | "connected" | "reconnecting";
  refresh: () => Promise<void>;
  /**
   * Human confirmation gate: authorize (when required) then walk the
   * server-validated state machine to COMMITTED. Each step is a separate
   * round trip so illegal transitions surface immediately.
   */
  confirmEffect: (effectId: string) => Promise<void>;
}

export function useTaskV2(taskId: string | null): UseTaskV2Result {
  const [task, setTask] = useState<TaskV2Snapshot | null>(null);
  const [effects, setEffects] = useState<EffectSnapshot[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [streamState, setStreamState] = useState<"idle" | "connected" | "reconnecting">("idle");
  const streamRef = useRef<ArpV2EventStream | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generationRef = useRef(0);

  const refresh = useCallback(async (): Promise<void> => {
    if (!taskId) {
      setTask(null);
      setEffects([]);
      return;
    }
    setLoading(true);
    try {
      const snapshot = await arpV2.getTask(taskId);
      setTask(snapshot);
      setError(snapshot ? null : `no canonical v2 task with id ${taskId}`);
      if (snapshot) {
        setEffects(await arpV2.listEffects(taskId));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  // Load (and reload on id change).
  useEffect(() => {
    void refresh();
  }, [refresh]);

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
        setError(null);
      });
      stream.addEventListener("message", (envelope) => {
        if (generation !== generationRef.current) return;
        try {
          window.localStorage.setItem(`terminus-desktop.v2-cursor.${taskId}`, envelope.eventId);
        } catch {
          // ignore persistence failure
        }
        if (envelope.aggregateType === "task" && envelope.aggregateId === taskId) {
          void refresh();
        }
        if (envelope.aggregateType === "effect") {
          void arpV2.listEffects(taskId).then((next) => {
            if (generation === generationRef.current) setEffects(next);
          }).catch(() => {});
        }
        if (envelope.aggregateType === "claim") {
          void refresh();
        }
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
      streamRef.current?.close();
      streamRef.current = null;
    };
  }, [taskId, refresh]);

  const confirmEffect = useCallback(async (effectId: string): Promise<void> => {
    setError(null);
    try {
      let effect = effects.find((e) => e.id === effectId);
      if (!effect) throw new Error(`effect ${effectId} not found`);
      // 1. Reach AUTHORIZED: policy-check first when still PROPOSED, then the
      //    human confirmation gate (server rejects illegal jumps with 409).
      let idx = SETTLEMENT_PATH.indexOf(effect.state);
      if (idx < 0) {
        if (effect.state === "PROPOSED") {
          effect = await arpV2.advanceEffect(effectId, "POLICY_CHECKED", effect.version);
        }
        if (effect.state === "POLICY_CHECKED" || effect.state === "AUTHORIZATION_REQUIRED") {
          effect = await arpV2.confirmEffect(effectId, `human:${effect.taskId}:${Date.now()}`);
        }
        idx = SETTLEMENT_PATH.indexOf(effect.state);
      }
      if (idx < 0) throw new Error(`effect is in non-settleable state ${effect.state}`);
      // 2. Walk the deterministic settlement path to VALIDATED.
      for (; idx < SETTLEMENT_PATH.length; idx++) {
        const target = SETTLEMENT_PATH[idx]!;
        if (effect.state !== target) {
          effect = await arpV2.advanceEffect(effectId, target, effect.version);
        }
      }
      // 3. Commit (terminal).
      await arpV2.commitEffect(effectId, effect.version);
      setEffects(await arpV2.listEffects(effect.taskId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [effects]);

  return { task, effects, loading, error, streamState, refresh, confirmEffect };
}

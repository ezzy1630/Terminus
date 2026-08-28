/**
 * Fetch the prompt text behind each turn's admitted input artifact.
 *
 * Artifacts are immutable and content-addressed, so a hash fetched once is
 * valid forever — the cache below is keyed on hash and shared across tasks and
 * component instances. It is bounded, because a long session can accumulate
 * more turns than we want to hold text for.
 *
 * The cache is an external mutable store, so the hook reads it through
 * `useSyncExternalStore` rather than mirroring it into component state. The
 * effect only starts fetches; it never sets state, which is what keeps a
 * resolving prompt from cascading renders across the transcript.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { api } from "../lib/api";
import {
  turnInputReferences,
  type TurnInputMap,
  type TurnInputState,
} from "../lib/turn-input";
import type { TerminusSseEvent } from "../types";

/** Prompts are small; anything larger is a pasted file and belongs in the diff. */
const MAX_PROMPT_BYTES = 64 * 1024;
/** Roughly a long working session's worth of prompts. */
const MAX_CACHED_PROMPTS = 500;
/**
 * Artifact reads cross into the kernel, and the kernel does not answer while a
 * turn is mid-flight — observed on 2026-08-28, where `/v1/artifacts/:hash` hung
 * indefinitely during a run while pure database reads answered in ~1ms. So the
 * fetch is bounded and retried rather than left to hang: the prompt becomes
 * readable again as soon as the turn settles.
 */
const PROMPT_FETCH_TIMEOUT_MS = 8_000;
const PROMPT_RETRY_DELAY_MS = 6_000;
const MAX_PROMPT_RETRIES = 10;

const cache = new Map<string, TurnInputState>();
const listeners = new Set<() => void>();
/** Bumped on every cache write so `getSnapshot` can return a stable primitive. */
let version = 0;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getVersion(): number {
  return version;
}

function cacheSet(hash: string, state: TurnInputState): void {
  // Refresh insertion order so the oldest untouched entry is the one evicted.
  cache.delete(hash);
  cache.set(hash, state);
  while (cache.size > MAX_CACHED_PROMPTS) {
    const oldest = cache.keys().next();
    if (oldest.done === true) break;
    cache.delete(oldest.value);
  }
  version += 1;
  for (const listener of listeners) listener();
}

/**
 * Pre-resolve one prompt without a fetch.
 *
 * For the `?mock=true` design fixture and tests only. Artifact content is
 * immutable and content-addressed, so seeding a hash is indistinguishable from
 * having fetched it — but there is no artifact store behind the fixture, so
 * without this every user turn in it renders as "Prompt unavailable", and a
 * fixture that misrepresents the transcript is worse than no fixture.
 */
export function seedTurnInputCache(hash: string, text: string): void {
  cacheSet(hash, { status: "ready", text, truncated: false });
}

/** Exposed for tests; artifact content is immutable so nothing else needs it. */
export function clearTurnInputCache(): void {
  cache.clear();
  version += 1;
  for (const listener of listeners) listener();
}

function failureReason(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  return "the artifact could not be read.";
}

/**
 * Resolve every `turn.started` input artifact in `events` to its text.
 * Returns a map keyed by the `turn.started` event id, which is what the
 * transcript builds its user messages from.
 */
export function useTurnInputs(events: readonly TerminusSseEvent[], taskId: string | null): TurnInputMap {
  const cacheVersion = useSyncExternalStore(subscribe, getVersion, getVersion);
  // Summary of which turns are in play. The fetch effect keys on this rather
  // than on `events`, so appending a stream delta mid-fetch cannot abort an
  // in-flight prompt request and strand it uncached.
  const referenceKey = turnInputReferences(events)
    .map((reference) => reference.eventId)
    .join(",");

  const resolved = useMemo<TurnInputMap>(() => {
    const next = new Map<string, TurnInputState>();
    for (const reference of turnInputReferences(events)) {
      next.set(reference.eventId, cache.get(reference.hash) ?? { status: "loading" });
    }
    return next;
  }, [events, cacheVersion]);

  // Incremented on a timer while a prompt is still unresolved, so a fetch that
  // timed out against a busy kernel is retried instead of stranded.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (taskId === null) return;
    const pending = turnInputReferences(events).filter((reference) => !cache.has(reference.hash));
    if (pending.length === 0) return;
    const outer = new AbortController();
    let timedOut = false;

    void (async () => {
      for (const reference of pending) {
        if (outer.signal.aborted) return;
        if (cache.has(reference.hash)) continue;
        const bound = new AbortController();
        const abortOuter = (): void => bound.abort();
        outer.signal.addEventListener("abort", abortOuter);
        const timer = setTimeout(() => { timedOut = true; bound.abort(); }, PROMPT_FETCH_TIMEOUT_MS);
        try {
          const artifact = await api.getArtifactText(
            reference.hash,
            taskId,
            MAX_PROMPT_BYTES,
            bound.signal,
          );
          cacheSet(reference.hash, {
            status: "ready",
            text: artifact.text,
            truncated: artifact.truncated,
          });
        } catch (error: unknown) {
          if (outer.signal.aborted) return;
          if (timedOut) {
            // Deliberately not cached: the artifact store is busy, not missing.
            // The retry timer below will come back for it.
            timedOut = false;
            continue;
          }
          // A definitive failure is cached. Retrying on every render would
          // hammer the control plane for an artifact that is genuinely gone.
          cacheSet(reference.hash, { status: "unavailable", reason: failureReason(error) });
        } finally {
          clearTimeout(timer);
          outer.signal.removeEventListener("abort", abortOuter);
        }
      }
    })();

    return () => outer.abort();
    // `events` is only read to re-derive the pending list, which referenceKey
    // already summarises; taskId scopes the fetch; attempt drives the retry.
  }, [referenceKey, taskId, attempt]);

  useEffect(() => {
    if (taskId === null || attempt >= MAX_PROMPT_RETRIES) return;
    const unresolved = turnInputReferences(events).some((reference) => !cache.has(reference.hash));
    if (!unresolved) return;
    const timer = setTimeout(() => setAttempt((value) => value + 1), PROMPT_RETRY_DELAY_MS);
    return () => clearTimeout(timer);
    // cacheVersion re-arms the timer whenever a fetch settles.
  }, [referenceKey, taskId, attempt, cacheVersion]);

  return resolved;
}

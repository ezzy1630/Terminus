/**
 * Resolving the prompt a turn was started with.
 *
 * The transcript used to render every user message as an empty bubble. The
 * client read `user_input` off the `turn.started` payload, but the control
 * plane never emits that field — it emits
 *
 *   { thread_id, task_id, sequence, input_artifact, input_hash }
 *
 * because the prompt is admitted as immutable content-addressed input
 * (`Turn.initiatingInputArtifact`), not inlined into the event. So the text has
 * to be fetched from the artifact store and joined back onto the turn.
 *
 * This module holds the pure part of that join: pulling the reference out of an
 * event and turning it into an artifact hash. The fetching lives in
 * `hooks/use-turn-inputs.ts`.
 */

const ARTIFACT_URI_PREFIX = "artifact://sha256/";
/** Lowercase hex, 64 characters — a SHA-256 digest and nothing else. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

export interface TurnInputReference {
  /** `turn.started` event id, which the transcript keys the message on. */
  readonly eventId: string;
  /** Canonical `artifact://sha256/<hex>` URI. */
  readonly uri: string;
  /** Bare lowercase hex digest, for the artifact endpoint. */
  readonly hash: string;
}

/**
 * Extract the artifact hash from an `artifact://sha256/<hex>` URI.
 * Returns null for anything else rather than guessing, so a malformed
 * reference cannot be turned into a request for an arbitrary path.
 */
export function artifactHashFromUri(uri: unknown): string | null {
  if (typeof uri !== "string" || !uri.startsWith(ARTIFACT_URI_PREFIX)) return null;
  const hash = uri.slice(ARTIFACT_URI_PREFIX.length);
  return SHA256_HEX.test(hash) ? hash : null;
}

/** Live SSE events carry `data` as a JSON string; fixtures may inline `payload`. */
interface EventLike {
  readonly id: string;
  readonly event: string;
  readonly data?: string;
  readonly payload?: unknown;
}

/**
 * Read an event's payload from whichever field carries it, matching what
 * `decodeFeed` accepts. Reading only `payload` would find nothing at all
 * against the real stream.
 */
function eventPayload(event: EventLike): Record<string, unknown> | null {
  const inline = event.payload;
  if (inline !== null && typeof inline === "object" && !Array.isArray(inline)) {
    return inline as Record<string, unknown>;
  }
  if (typeof event.data !== "string" || event.data.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(event.data);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

/**
 * Collect the input-artifact reference of every `turn.started` event, in order.
 * Events whose payload carries no usable reference are skipped: the transcript
 * still renders the turn, it just cannot show the prompt text.
 */
export function turnInputReferences(events: readonly EventLike[]): TurnInputReference[] {
  const references: TurnInputReference[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    if (event.event !== "turn.started") continue;
    const payload = eventPayload(event);
    if (payload === null) continue;
    const uri = payload.input_artifact;
    const hash = artifactHashFromUri(uri);
    if (hash === null || typeof uri !== "string") continue;
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    references.push({ eventId: event.id, uri, hash });
  }
  return references;
}

/** What the transcript knows about one turn's prompt at render time. */
export type TurnInputState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly text: string; readonly truncated: boolean }
  | { readonly status: "unavailable"; readonly reason: string };

export type TurnInputMap = ReadonlyMap<string, TurnInputState>;

/**
 * Copy shown in place of the prompt when it cannot be displayed. The transcript
 * must never imply the user sent an empty message, so every branch says
 * something true about why the text is missing.
 */
export function turnInputPlaceholder(state: TurnInputState | undefined): string {
  if (state === undefined) return "Prompt unavailable — this turn recorded no admitted input.";
  switch (state.status) {
    case "loading":
      return "Loading prompt…";
    case "unavailable":
      return `Prompt unavailable — ${state.reason}`;
    case "ready":
      return state.text;
  }
}

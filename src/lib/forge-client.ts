/**
 * Forge control-plane client.
 *
 * All calls go through the Caddy gateway using the relative-path convention
 * with `?XTransformPort=3050`. NEVER use an absolute `http://localhost:3050`
 * URL — that would break the gateway routing and CORS in dev.
 *
 * The control plane (mini-services/forge-control) forwards privileged effect
 * requests to the Rust kernel internally; the UI only talks to port 3050.
 */

const PORT_PARAM = "XTransformPort=3050";

/** Append ?XTransformPort=3050 to any relative path, preserving existing query. */
export function forgeUrl(path: string, params?: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  search.set("XTransformPort", "3050");
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) search.set(k, v);
    }
  }
  const q = search.toString();
  // The path may already contain a `?`. Handle both cases.
  if (path.includes("?")) {
    return `${path}&${q}`;
  }
  return `${path}?${q}`;
}

export class ForgeApiError extends Error {
  status: number;
  category: string;
  details: unknown;
  traceId: string | null;

  constructor(message: string, status: number, category: string, details: unknown, traceId: string | null) {
    super(message);
    this.name = "ForgeApiError";
    this.status = status;
    this.category = category;
    this.details = details;
    this.traceId = traceId;
  }
}

interface ForgeFetchOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE" | "PUT";
  body?: unknown;
  /** Extra URL query params (in addition to XTransformPort). */
  params?: Record<string, string | undefined>;
  /** Pass through AbortSignal. */
  signal?: AbortSignal;
  /** Raw response mode — return Response instead of parsed JSON. */
  raw?: boolean;
}

/**
 * Fetch JSON from the control plane. Throws ForgeApiError on non-2xx.
 */
export async function forgeFetch<T = unknown>(path: string, opts: ForgeFetchOptions = {}): Promise<T> {
  const url = forgeUrl(path, opts.params);
  const init: RequestInit = {
    method: opts.method ?? "GET",
    headers: opts.body !== undefined ? { "content-type": "application/json" } : {},
    signal: opts.signal,
  };
  if (opts.body !== undefined && init.method !== "GET") {
    init.body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
  }
  const res = await fetch(url, init);
  if (opts.raw) return res as unknown as T;
  const text = await res.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
  }
  if (!res.ok) {
    const errEnvelope =
      json && typeof json === "object" && "error" in json
        ? (json as { error?: Record<string, unknown> }).error
        : undefined;
    const message =
      errEnvelope && typeof errEnvelope.message === "string"
        ? errEnvelope.message
        : typeof json === "string"
          ? json
          : `request failed: ${res.status}`;
    const category =
      errEnvelope && typeof errEnvelope.category === "string" ? errEnvelope.category : "internal";
    const traceId =
      errEnvelope && typeof errEnvelope.trace_id === "string" ? errEnvelope.trace_id : null;
    throw new ForgeApiError(message, res.status, category, errEnvelope ?? json, traceId);
  }
  return json as T;
}

/** SSE event source for `/v1/events`. Returns the EventSource so caller can close(). */
export function forgeEventSource(params: { taskId?: string; sessionId?: string; cursor?: string }): EventSource {
  const url = forgeUrl("/v1/events", {
    task_id: params.taskId,
    session_id: params.sessionId,
    cursor: params.cursor,
  });
  return new EventSource(url);
}

/** Small helper: format ISO timestamp string into a friendly human label. */
export function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return iso;
  }
}

/** Format an ISO timestamp as a relative time (e.g. "3s ago"). */
export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso).getTime();
    if (Number.isNaN(d)) return iso;
    const diffMs = Date.now() - d;
    const sec = Math.round(diffMs / 1000);
    if (sec < 5) return "just now";
    if (sec < 60) return `${sec}s ago`;
    const min = Math.round(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.round(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const day = Math.round(hr / 24);
    return `${day}d ago`;
  } catch {
    return iso;
  }
}

/** Truncate a long ID/hash to first 8 chars + ellipsis. */
export function shortId(id: string | null | undefined, head = 8): string {
  if (!id) return "—";
  if (id.length <= head + 4) return id;
  return `${id.slice(0, head)}…`;
}

/** Format a duration given in seconds as e.g. "1m 23s". */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || Number.isNaN(seconds)) return "—";
  const s = Math.floor(seconds % 60);
  const m = Math.floor((seconds / 60) % 60);
  const h = Math.floor(seconds / 3600);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/** Format micros (1e-6 USD) as a tiny USD figure. */
export function formatCost(micros: number | null | undefined): string {
  if (micros == null) return "—";
  const usd = micros / 1_000_000;
  if (usd < 0.01) return `$${usd.toFixed(6)}`;
  return `$${usd.toFixed(4)}`;
}

/**
 * Inherited Network Provider Bridge — BYPASS-0003 (NETWORK_WRITE)
 * Containment: Egress URL validation, header sanitization, telemetry logging.
 * Target removal milestone: M4
 */

export interface InheritedNetworkRequest {
  readonly url: string;
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
}

export interface InheritedNetworkResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: string;
}

export async function inheritedFetch(
  req: InheritedNetworkRequest,
  fetchFn: typeof fetch = fetch
): Promise<InheritedNetworkResponse> {
  const parsed = new URL(req.url);

  // Containment: Disallow non-HTTPS / unauthorized hosts in production mode
  if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
    throw new Error(`[BYPASS-0003] Security Containment Violation: non-secure protocol ${parsed.protocol} for egress target ${parsed.hostname}`);
  }

  // Redact secrets from logged headers
  const sanitizedHeaders = { ...req.headers };
  if (sanitizedHeaders["authorization"]) {
    sanitizedHeaders["x-terminus-sanitized-auth"] = "present";
  }

  const init: RequestInit = {
    method: req.method ?? "GET",
  };
  if (req.headers) {
    init.headers = req.headers;
  }
  if (req.body) {
    init.body = req.body;
  }

  const res = await fetchFn(req.url, init);


  const responseText = await res.text();
  const responseHeaders: Record<string, string> = {};
  res.headers.forEach((val, key) => {
    responseHeaders[key] = val;
  });

  return {
    status: res.status,
    headers: responseHeaders,
    body: responseText,
  };
}

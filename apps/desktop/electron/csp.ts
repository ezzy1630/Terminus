/**
 * Terminus Desktop — Content-Security-Policy construction.
 *
 * One builder produces the policy for every place it is enforced: the
 * `<meta http-equiv>` tag baked into the renderer at Vite build time, the
 * response header attached to the packaged `terminus://` documents, and the
 * response header attached to the Vite dev origin. A policy that differs
 * between those places is a policy nobody can reason about, so the string
 * has exactly one source.
 *
 * This module must stay free of Electron imports: `vite.config.ts` imports it
 * from a plain Node context, and the unit tests import it directly.
 */

/**
 * The control-plane origin written into the packaged bundle. The packaged
 * runtime picks its port at launch, so the main process rewrites this exact
 * substring in the served document to the supervisor's real origin.
 */
export const PACKAGED_CSP_API_PLACEHOLDER = "http://127.0.0.1:3050";

/** The Vite dev server this app is developed against. */
export const DEV_RENDERER_ORIGIN = "http://localhost:5173";

/** The websocket Vite uses for hot module replacement. */
export const DEV_RENDERER_WEBSOCKET_ORIGIN = "ws://localhost:5173";

export interface ContentSecurityPolicyOptions {
  /** Origins the renderer may reach with fetch/XHR/EventSource/WebSocket. */
  readonly connectSources: readonly string[];
  /**
   * Vite injects its React-refresh preamble as an inline module script, so the
   * dev document cannot be served under `script-src 'self'` alone. Packaged
   * documents are never built with this relaxation.
   */
  readonly allowInlineScripts?: boolean;
}

/** Connect sources for a packaged build talking to one local control origin. */
export function packagedConnectSources(apiOrigin: string): readonly string[] {
  return dedupe(["'self'", apiOrigin]);
}

/** Connect sources for `vite dev`: the control origin plus the dev server. */
export function devConnectSources(apiOrigin: string): readonly string[] {
  return dedupe([
    "'self'",
    apiOrigin,
    PACKAGED_CSP_API_PLACEHOLDER,
    "http://localhost:3050",
    DEV_RENDERER_ORIGIN,
    DEV_RENDERER_WEBSOCKET_ORIGIN,
  ]);
}

export function buildContentSecurityPolicy(options: ContentSecurityPolicyOptions): string {
  const connectSources = dedupe(options.connectSources);
  if (connectSources.length === 0) {
    throw new Error("content security policy requires at least one connect source");
  }
  for (const source of connectSources) {
    if (source.length === 0 || /[;,\s]/.test(source)) {
      throw new Error(`content security policy connect source is invalid: ${source}`);
    }
  }
  const scriptSource = options.allowInlineScripts === true ? "'self' 'unsafe-inline'" : "'self'";
  return [
    "default-src 'self'",
    `script-src ${scriptSource}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    `connect-src ${connectSources.join(" ")}`,
    "font-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join("; ");
}

/**
 * Whether a response should carry the policy header.
 *
 * Only documents matter: a policy on a stylesheet response governs nothing.
 * The packaged scheme is included because the protocol handler and the
 * `webRequest` filter both consult this predicate, and only one of them will
 * ever see a given request.
 */
export function shouldApplyPolicyHeader(url: string, resourceType: string, allowedOrigins: readonly string[]): boolean {
  if (resourceType !== "mainFrame" && resourceType !== "subFrame") return false;
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return false;
  }
  return allowedOrigins.includes(origin);
}

/**
 * Replace the policy header on a response, dropping any casing variant the
 * upstream response already carried so two policies can never both apply.
 */
export function withPolicyHeader(
  headers: Readonly<Record<string, readonly string[] | string | undefined>>,
  policy: string,
): Record<string, string[]> {
  const next: Record<string, string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lowered = name.toLowerCase();
    if (lowered === "content-security-policy" || lowered === "content-security-policy-report-only") continue;
    if (value === undefined) continue;
    next[name] = typeof value === "string" ? [value] : [...value];
  }
  next["Content-Security-Policy"] = [policy];
  return next;
}

function dedupe(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

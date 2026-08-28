/**
 * Terminus Desktop — `terminus://` deep links.
 *
 * `terminus://task/<id>` and `terminus://project/<sessionId>` are the only
 * two shapes the shell accepts. They arrive from three places — macOS
 * `open-url`, a second instance's argv, and the app's own notifications — and
 * all three funnel through this parser, because a link is untrusted input no
 * matter which door it came through.
 *
 * The scheme is shared with the packaged renderer (`terminus://app/...`).
 * That host is reserved for assets and is refused here, exactly as the asset
 * resolver in `shell-guards.ts` refuses `task` and `project`.
 */
export const DEEP_LINK_SCHEME = "terminus:";
export const DEEP_LINK_RESERVED_HOST = "app";

const IDENTIFIER_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type DeepLinkTarget =
  | { readonly kind: "task"; readonly taskId: string }
  | { readonly kind: "project"; readonly sessionId: string };

export function parseDeepLink(value: unknown): DeepLinkTarget | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== DEEP_LINK_SCHEME
    || url.username.length > 0
    || url.password.length > 0
    || url.port.length > 0
    || url.search.length > 0
    || url.hash.length > 0
  ) return null;
  const identifier = url.pathname.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!IDENTIFIER_PATTERN.test(identifier)) return null;
  if (url.hostname === "task") return { kind: "task", taskId: identifier.toLowerCase() };
  if (url.hostname === "project") return { kind: "project", sessionId: identifier.toLowerCase() };
  return null;
}

/** The first deep link in a process argv, if any. */
export function findDeepLink(argv: readonly string[]): DeepLinkTarget | null {
  for (const argument of argv) {
    const target = parseDeepLink(argument);
    if (target !== null) return target;
  }
  return null;
}

export function taskDeepLink(taskId: string): string {
  return `${DEEP_LINK_SCHEME}//task/${taskId}`;
}

export function projectDeepLink(sessionId: string): string {
  return `${DEEP_LINK_SCHEME}//project/${sessionId}`;
}

/**
 * What the shell asks the renderer to show.
 *
 * Deep links carry identifiers; File ▸ Open Recent carries a filesystem path.
 * They are one channel because they are one intent — "put this in front of
 * the user" — and the renderer should route them in one place.
 */
export type NavigationTarget =
  | DeepLinkTarget
  | { readonly kind: "project-path"; readonly path: string };

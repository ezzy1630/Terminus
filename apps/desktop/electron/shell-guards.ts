/** Pure validation for values crossing the renderer/native shell boundary. */

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

const PACKAGED_RENDERER_SCHEME = "terminus:";
const PACKAGED_RENDERER_HOST = "app";

/** Resolve only normalized, relative assets inside the packaged renderer. */
export function packagedRendererAssetPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const originPrefix = `${PACKAGED_RENDERER_SCHEME}//${PACKAGED_RENDERER_HOST}`;
  if (!value.startsWith(`${originPrefix}/`)) return null;
  let rawPath: string;
  try {
    rawPath = decodeURIComponent(value.slice(originPrefix.length).split(/[?#]/, 1)[0] ?? "");
  } catch {
    return null;
  }
  if (rawPath.split("/").some((segment) => segment === "." || segment === ".." || segment.includes("\\"))) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== PACKAGED_RENDERER_SCHEME
    || url.hostname !== PACKAGED_RENDERER_HOST
    || url.username.length > 0
    || url.password.length > 0
    || url.port.length > 0
    || url.search.length > 0
    || url.hash.length > 0
  ) return null;
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const segments = relative.split("/");
  if (
    relative.length === 0
    || relative.length > 4096
    || segments.some((segment) => (
      segment.length === 0
      || segment === "."
      || segment === ".."
      || segment.includes("\\")
      || [...segment].some((character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f)
    ))
  ) return null;
  return segments.join("/");
}

export function parseWindowBounds(value: unknown): WindowBounds | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const numbers = [candidate.x, candidate.y, candidate.width, candidate.height];
  if (!numbers.every((entry) => typeof entry === "number" && Number.isInteger(entry) && Number.isFinite(entry))) {
    return null;
  }
  const [x, y, width, height] = numbers as [number, number, number, number];
  if (Math.abs(x) > 32768 || Math.abs(y) > 32768 || width < 900 || width > 8192 || height < 600 || height > 8192) {
    return null;
  }
  return { x, y, width, height };
}

/** Validate a dropped path without probing the filesystem. */
export function validateDirectoryPath(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096 || value !== value.trim()) return null;
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\") || value.includes("\0")) return null;
  const segments = value.split("/");
  if (segments.slice(1).some((segment) => segment.length === 0 || segment === "." || segment === "..")) return null;
  if ([...value].some((character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f)) return null;
  return value;
}

export function normalizeWindowTitle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const title = value.trim();
  if (title.length === 0 || title.length > 200) return null;
  if ([...title].some((character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f)) return null;
  return title;
}

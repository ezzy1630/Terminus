/**
 * Content hashing for capability descriptors and skill/MCP payloads.
 *
 * Canonical form: `sha256:<64 hex lowercase>`. Used for lockfile pins and
 * rug-pull detection (SPEC §35.5, ADR-0017, ADR-0018).
 */
import { createHash } from "node:crypto";
import type { ContentHash } from "@terminus/domain";

export function sha256Hex(data: string | Uint8Array): string {
  const hash = createHash("sha256");
  hash.update(typeof data === "string" ? Buffer.from(data, "utf8") : data);
  return hash.digest("hex");
}

export function asContentHash(hexOrPrefixed: string): ContentHash {
  const hex = hexOrPrefixed.startsWith("sha256:")
    ? hexOrPrefixed.slice("sha256:".length)
    : hexOrPrefixed;
  if (!/^[a-f0-9]{64}$/.test(hex)) {
    throw new Error(`invalid content hash (expected sha256 hex): ${hexOrPrefixed}`);
  }
  return `sha256:${hex}` as ContentHash;
}

export function contentHashOf(data: string | Uint8Array): ContentHash {
  return asContentHash(sha256Hex(data));
}

/**
 * Stable JSON serialization: sorted object keys, no whitespace variance.
 * Used so descriptor hashes are deterministic across processes.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortKeys);
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    out[key] = sortKeys(obj[key]);
  }
  return out;
}

export function hashDescriptorPayload(payload: unknown): ContentHash {
  return contentHashOf(stableStringify(payload));
}

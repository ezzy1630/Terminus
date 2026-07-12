/**
 * @terminus/domain — canonical domain identifiers.
 *
 * Per SPEC §28.1:
 * - Public domain identifiers MUST use UUIDv7 encoded as lowercase canonical strings.
 * - Content identities MUST use `sha256:<hex>`.
 * - Artifact URIs MUST use `artifact://sha256/<hex>`.
 * - Internal resource URIs MAY use workspace:// session:// task:// turn:// job://
 *   agent:// memory:// tool:// rule:// verification://
 * - Timestamps MUST be RFC 3339 UTC with microsecond precision where available.
 * - Monetary values MUST be integer micros of the configured billing currency.
 * - Token counts and byte counts MUST be unsigned 64-bit integers at storage boundaries.
 */
import { z } from "zod";

/** Branding marker for nominal typing. */
declare const __brand: unique symbol;
export type Brand<T extends string> = { readonly [__brand]: T };

export type Uuid7 = string & Brand<"Uuid7">;
export type ContentHash = string & Brand<"ContentHash">;
export type ArtifactUri = string & Brand<"ArtifactUri">;
export type ResourceUri = string & Brand<"ResourceUri">;
export type Rfc3339Timestamp = string & Brand<"Rfc3339Timestamp">;
export type Micros = bigint & Brand<"Micros">;
export type TokenCount = bigint & Brand<"TokenCount">;
export type ByteCount = bigint & Brand<"ByteCount">;
export type ModelKey = string & Brand<"ModelKey">;
export type PrincipalId = string & Brand<"PrincipalId">;
export type TraceId = string & Brand<"TraceId">;
export type CursorToken = string & Brand<"CursorToken">;

export const uuid7Schema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  .brand<"Uuid7">();
export const contentHashSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/)
  .brand<"ContentHash">();
export const artifactUriSchema = z
  .string()
  .regex(/^artifact:\/\/sha256\/[0-9a-f]{64}$/)
  .brand<"ArtifactUri">();
export const resourceUriSchema = z
  .string()
  .regex(/^(workspace|session|task|turn|job|agent|memory|tool|rule|verification):\/\/[^\s]+$/)
  .brand<"ResourceUri">();
export const rfc3339Schema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/)
  .brand<"Rfc3339Timestamp">();

/** Micros are represented as bigint to forbid floating-point money. */
export const microsSchema = z.bigint().brand<"Micros">();
export const tokenCountSchema = z.bigint().min(0n).brand<"TokenCount">();
export const byteCountSchema = z.bigint().min(0n).brand<"ByteCount">();

export const modelKeySchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._/-]*$/i)
  .brand<"ModelKey">();

/** Helper: assert a string is a content-hash-formatted sha256. */
export function asContentHash(s: string): ContentHash {
  if (!/^sha256:[0-9a-f]{64}$/.test(s)) {
    throw new TypeError(`not a content hash: ${s}`);
  }
  return s as ContentHash;
}

/** Helper: build an artifact URI from a hex hash. */
export function artifactUriFromHex(hex: string): ArtifactUri {
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new TypeError(`not a sha256 hex: ${hex}`);
  }
  return `artifact://sha256/${hex}` as ArtifactUri;
}

/** Helper: build a workspace:// URI. */
export function workspaceUri(path: string): ResourceUri {
  return `workspace://${path}` as ResourceUri;
}

export function sessionUri(id: string): ResourceUri {
  return `session://${id}` as ResourceUri;
}

export function taskUri(id: string): ResourceUri {
  return `task://${id}` as ResourceUri;
}

export function turnUri(id: string): ResourceUri {
  return `turn://${id}` as ResourceUri;
}

export function jobUri(id: string): ResourceUri {
  return `job://${id}` as ResourceUri;
}

export function agentUri(id: string): ResourceUri {
  return `agent://${id}` as ResourceUri;
}

export function memoryUri(id: string): ResourceUri {
  return `memory://${id}` as ResourceUri;
}

export function toolUri(id: string): ResourceUri {
  return `tool://${id}` as ResourceUri;
}

export function verificationUri(id: string): ResourceUri {
  return `verification://${id}` as ResourceUri;
}

/** Current UTC time as RFC 3339 with microsecond precision (when available). */
export function nowTimestamp(): Rfc3339Timestamp {
  return new Date().toISOString() as Rfc3339Timestamp;
}

/** Returns micros from a number; throws on non-integer. */
export function micros(n: number): Micros {
  if (!Number.isInteger(n)) {
    throw new TypeError(`micros must be an integer: ${n}`);
  }
  return BigInt(n) as Micros;
}

/** Returns a TokenCount from a number; throws on negative or non-integer. */
export function tokens(n: number): TokenCount {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError(`tokens must be a non-negative integer: ${n}`);
  }
  return BigInt(n) as TokenCount;
}

/** Returns a ByteCount from a number; throws on negative or non-integer. */
export function bytes(n: number): ByteCount {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError(`bytes must be a non-negative integer: ${n}`);
  }
  return BigInt(n) as ByteCount;
}

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

/** Branding marker shared with runtime schemas so parse output is assignable. */
export type Brand<T extends string> = z.$brand<T>;

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
/** Remote/local kernel instance identity (`kernel:<opaque>`). */
export type KernelId = string & Brand<"KernelId">;
/** Hosting server identity (`server:<opaque>`). */
export type ServerId = string & Brand<"ServerId">;
/** Control-plane identity (`control:<opaque>`). */
export type ControlId = string & Brand<"ControlId">;

// Canonical domain entity identifiers (SPEC §5 / ARP v2)
export type OrganizationId = string & Brand<"OrganizationId">;
export type DepartmentId = string & Brand<"DepartmentId">;
export type OperatorId = string & Brand<"OperatorId">;
export type MissionId = string & Brand<"MissionId">;
export type TaskId = string & Brand<"TaskId">;
export type WorkflowId = string & Brand<"WorkflowId">;
export type WorkflowVersion = number & Brand<"WorkflowVersion">;
export type NodeId = string & Brand<"NodeId">;
export type NodeRunId = string & Brand<"NodeRunId">;
export type ModelInvocationId = string & Brand<"ModelInvocationId">;
export type WorkerId = string & Brand<"WorkerId">;
export type SandboxLeaseId = string & Brand<"SandboxLeaseId">;
export type CapabilityId = string & Brand<"CapabilityId">;
export type AuthorizationId = string & Brand<"AuthorizationId">;
export type ApprovalId = string & Brand<"ApprovalId">;
export type EffectId = string & Brand<"EffectId">;
export type ArtifactId = string & Brand<"ArtifactId">;
export type EvidenceId = string & Brand<"EvidenceId">;
export type ClaimId = string & Brand<"ClaimId">;
export type DecisionId = string & Brand<"DecisionId">;
export type QuestionId = string & Brand<"QuestionId">;
export type RiskId = string & Brand<"RiskId">;
export type ConnectorId = string & Brand<"ConnectorId">;
export type ExtensionId = string & Brand<"ExtensionId">;

export const uuid7Schema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  .brand<"Uuid7">();

export const organizationIdSchema = z.string().min(1).brand<"OrganizationId">();
export const departmentIdSchema = z.string().min(1).brand<"DepartmentId">();
export const operatorIdSchema = z.string().min(1).brand<"OperatorId">();
export const missionIdSchema = z.string().min(1).brand<"MissionId">();
export const taskIdSchema = z.string().min(1).brand<"TaskId">();
export const workflowIdSchema = z.string().min(1).brand<"WorkflowId">();
export const workflowVersionSchema = z.number().int().positive().brand<"WorkflowVersion">();
export const nodeIdSchema = z.string().min(1).brand<"NodeId">();
export const nodeRunIdSchema = z.string().min(1).brand<"NodeRunId">();
export const modelInvocationIdSchema = z.string().min(1).brand<"ModelInvocationId">();
export const workerIdSchema = z.string().min(1).brand<"WorkerId">();
export const sandboxLeaseIdSchema = z.string().min(1).brand<"SandboxLeaseId">();
export const capabilityIdSchema = z.string().min(1).brand<"CapabilityId">();
export const authorizationIdSchema = z.string().min(1).brand<"AuthorizationId">();
export const approvalIdSchema = z.string().min(1).brand<"ApprovalId">();
export const effectIdSchema = z.string().min(1).brand<"EffectId">();
export const artifactIdSchema = z.string().min(1).brand<"ArtifactId">();
export const evidenceIdSchema = z.string().min(1).brand<"EvidenceId">();
export const claimIdSchema = z.string().min(1).brand<"ClaimId">();
export const decisionIdSchema = z.string().min(1).brand<"DecisionId">();
export const questionIdSchema = z.string().min(1).brand<"QuestionId">();
export const riskIdSchema = z.string().min(1).brand<"RiskId">();
export const connectorIdSchema = z.string().min(1).brand<"ConnectorId">();
export const extensionIdSchema = z.string().min(1).brand<"ExtensionId">();
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

export const kernelIdSchema = z
  .string()
  .regex(/^kernel:[^\s:]+$/)
  .brand<"KernelId">();
export const serverIdSchema = z
  .string()
  .regex(/^server:[^\s:]+$/)
  .brand<"ServerId">();
export const controlIdSchema = z
  .string()
  .regex(/^control:[^\s:]+$/)
  .brand<"ControlId">();

export function asKernelId(s: string): KernelId {
  return kernelIdSchema.parse(s) as unknown as KernelId;
}
export function asServerId(s: string): ServerId {
  return serverIdSchema.parse(s) as unknown as ServerId;
}
export function asControlId(s: string): ControlId {
  return controlIdSchema.parse(s) as unknown as ControlId;
}

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

/** Generates a canonical lowercase UUIDv7. */
export function generateUuid7(timeMs: number = Date.now()): Uuid7 {
  const tsHex = Math.floor(timeMs).toString(16).padStart(12, "0");
  const randBytes = new Uint8Array(10);
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(randBytes);
  } else {
    for (let i = 0; i < randBytes.length; i += 1) {
      randBytes[i] = Math.floor(Math.random() * 256);
    }
  }
  const randA = ((randBytes[0]! << 8) | randBytes[1]!) & 0x0fff;
  const verRandA = (0x7000 | randA).toString(16).padStart(4, "0");
  const varBits = (randBytes[2]! & 0x3f) | 0x80;
  const varHex = varBits.toString(16).padStart(2, "0");
  let restHex = "";
  for (let i = 3; i < 10; i += 1) {
    restHex += randBytes[i]!.toString(16).padStart(2, "0");
  }
  const uuidStr = `${tsHex.slice(0, 8)}-${tsHex.slice(8, 12)}-${verRandA}-${varHex}${restHex.slice(0, 2)}-${restHex.slice(2)}`.toLowerCase();
  return uuidStr as Uuid7;
}

/** Extract the Unix epoch millisecond timestamp from a UUIDv7 string. */
export function uuid7TimestampMs(id: string): number {
  if (!uuid7Schema.safeParse(id).success) {
    throw new TypeError(`not a valid UUIDv7 string: ${id}`);
  }
  const hexTs = id.replace(/-/g, "").slice(0, 12);
  return Number.parseInt(hexTs, 16);
}

/** Lexicographically and chronologically compare two UUIDv7 identifiers. */
export function compareUuid7(a: string, b: string): number {
  const tsA = uuid7TimestampMs(a);
  const tsB = uuid7TimestampMs(b);
  if (tsA !== tsB) return tsA - tsB;
  return a.localeCompare(b);
}

/** Canonicalize a URI string according to scheme, host, path, and normalization rules. */
export function canonicalizeUri(rawUri: string): string {
  const trimmed = rawUri.trim();
  if (trimmed.length === 0) throw new TypeError("URI cannot be empty");

  // Handle file:// URIs or absolute file paths
  if (trimmed.startsWith("file://") || trimmed.startsWith("/")) {
    let path = trimmed.startsWith("file://") ? trimmed.slice("file://".length) : trimmed;
    path = path.replace(/\\/g, "/");
    // Remove redundant slashes and resolve relative segments
    const parts = path.split("/").filter((p) => p.length > 0 && p !== ".");
    const stack: string[] = [];
    for (const part of parts) {
      if (part === "..") {
        if (stack.length > 0) stack.pop();
      } else {
        stack.push(part);
      }
    }
    const normalizedPath = `/${stack.join("/")}`;
    return `file://${normalizedPath}`;
  }

  // Handle scheme://path URIs
  const schemeMatch = trimmed.match(/^([a-z0-9+-.]+):\/\/(.*)$/i);
  if (schemeMatch) {
    const scheme = schemeMatch[1]!.toLowerCase();
    let body = schemeMatch[2]!.replace(/\\/g, "/");
    // Normalize path separators in body
    const parts = body.split("/").filter((p) => p.length > 0 && p !== ".");
    const stack: string[] = [];
    for (const part of parts) {
      if (part === "..") {
        if (stack.length > 0) stack.pop();
      } else {
        stack.push(part);
      }
    }
    const normalizedBody = stack.join("/");
    return `${scheme}://${normalizedBody}`;
  }

  throw new TypeError(`unsupported URI format: ${rawUri}`);
}

/** Canonicalize a ResourceUri string. */
export function canonicalizeResourceUri(uri: string): ResourceUri {
  const canon = canonicalizeUri(uri);
  return resourceUriSchema.parse(canon) as unknown as ResourceUri;
}

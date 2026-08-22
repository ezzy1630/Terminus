/**
 * Durable capability lockfile — SPEC §35.1, §35.5, §35.10.
 *
 * Pins admitted descriptor hashes. Persistence is explicit (file or memory).
 * Cross-process authority comes from the pinned hashes, not ambient discovery.
 */
import { z } from "zod";
import type {
  CapabilityTrustLevel,
  ContentHash,
  PrincipalId,
  Rfc3339Timestamp,
} from "@terminus/domain";
import { ValidationError } from "@terminus/domain";
import { contentHashOf, stableStringify } from "./hash.js";

export interface LockfileEntry {
  readonly id: string;
  readonly version: string;
  readonly contentHash: ContentHash;
  readonly admissionFingerprint: ContentHash;
  readonly signature: string | null;
  readonly trustLevel: CapabilityTrustLevel;
  readonly admittedAt: Rfc3339Timestamp;
  readonly admittedBy: PrincipalId;
  /** Per-tool schema hashes for MCP (empty for non-MCP). */
  readonly toolDescriptorHashes: Readonly<Record<string, ContentHash>>;
}

export interface CapabilityLockfile {
  readonly schemaVersion: 1;
  readonly entries: readonly LockfileEntry[];
  readonly lockfileHash: ContentHash;
}

export const lockfileEntrySchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  contentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  admissionFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  signature: z.string().nullable(),
  trustLevel: z.enum(["builtin", "first_party", "verified_third_party", "untrusted"]),
  admittedAt: z.string(),
  admittedBy: z.string(),
  toolDescriptorHashes: z.record(z.string(), z.string()),
});

export const capabilityLockfileSchema = z.object({
  schemaVersion: z.literal(1),
  entries: z.array(lockfileEntrySchema),
  lockfileHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
});

export function lockfileKey(id: string, version: string): string {
  return `${id}@${version}`;
}

export function computeLockfileHash(entries: readonly LockfileEntry[]): ContentHash {
  const sorted = [...entries].sort((a, b) =>
    lockfileKey(a.id, a.version).localeCompare(lockfileKey(b.id, b.version)),
  );
  return contentHashOf(stableStringify({ schemaVersion: 1, entries: sorted }));
}

export function buildLockfile(entries: readonly LockfileEntry[]): CapabilityLockfile {
  const lockfileHash = computeLockfileHash(entries);
  return { schemaVersion: 1, entries: [...entries], lockfileHash };
}

export function parseLockfile(raw: unknown): CapabilityLockfile {
  const parsed = capabilityLockfileSchema.parse(raw);
  const expected = computeLockfileHash(parsed.entries as LockfileEntry[]);
  if (parsed.lockfileHash !== expected) {
    throw new ValidationError("lockfile integrity hash mismatch", {
      expected,
      actual: parsed.lockfileHash,
    });
  }
  return parsed as unknown as CapabilityLockfile;
}

export interface LockfileStore {
  load(): Promise<CapabilityLockfile>;
  save(lockfile: CapabilityLockfile): Promise<void>;
}

/** In-memory store — default for tests and ephemeral sessions. */
export class MemoryLockfileStore implements LockfileStore {
  private current: CapabilityLockfile = buildLockfile([]);

  async load(): Promise<CapabilityLockfile> {
    return this.current;
  }

  async save(lockfile: CapabilityLockfile): Promise<void> {
    this.current = lockfile;
  }
}

/**
 * File-backed store. Caller supplies read/write ports so this package never
 * opens the ambient filesystem (kernel owns FS effects).
 */
export interface FileBytesPort {
  readText(path: string): Promise<string | null>;
  writeText(path: string, contents: string): Promise<void>;
}

export class FileLockfileStore implements LockfileStore {
  constructor(
    private readonly path: string,
    private readonly files: FileBytesPort,
  ) {}

  async load(): Promise<CapabilityLockfile> {
    const text = await this.files.readText(this.path);
    if (text === null || text.trim() === "") return buildLockfile([]);
    return parseLockfile(JSON.parse(text) as unknown);
  }

  async save(lockfile: CapabilityLockfile): Promise<void> {
    const verified = buildLockfile(lockfile.entries);
    await this.files.writeText(this.path, `${JSON.stringify(verified, null, 2)}\n`);
  }
}

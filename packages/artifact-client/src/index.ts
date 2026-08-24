/**
 * @terminus/artifact-client — client for the kernel's ArtifactIngestService.
 *
 * Per SPEC §29.3, §31.1: `ArtifactClient` with `ingest(bytes, metadata)`,
 * `get(hash)`, `metadata(hash)`, `link(hash, ownerType, ownerId, purpose)`,
 * `gc(dryRun)`. Streams large bytes. Caches metadata locally.
 */
import type {
  ContentHash,
  ArtifactUri,
  ByteCount,
  Rfc3339Timestamp,
  Uuid7,
  ArtifactRef,
} from "@terminus/domain";
import { ValidationError, NotFoundError } from "@terminus/domain";

import { createHash } from "node:crypto";

// ────────────────────────── Kernel client ────────────────────────────────────

export interface ArtifactKernelClient {
  ingest(bytes: Uint8Array, metadata: Readonly<Record<string, unknown>>): Promise<ContentHash>;
  get(hash: ContentHash): Promise<Uint8Array | null>;
  getMetadata(hash: ContentHash): Promise<Readonly<Record<string, unknown>> | null>;
  link(hash: ContentHash, ownerType: string, ownerId: string, purpose: string): Promise<void>;
  quarantine?(hash: ContentHash, bytes: Uint8Array, reason: string): Promise<void>;
  gcDryRun(): Promise<{ readonly deleted: readonly string[]; readonly retained: readonly string[] }>;
  gcApply(hashes: readonly string[]): Promise<void>;
  /** Optional remote resumable ingest; when absent, client falls back to whole-blob ingest. */
  beginIngest?(mediaType: string, expectedTotalBytes: number | null): Promise<{ sessionId: string; continuationToken: string }>;
  appendChunk?(sessionId: string, offset: number, chunk: Uint8Array): Promise<{ nextOffset: number; continuationToken: string }>;
  commitIngest?(sessionId: string): Promise<ContentHash>;
  getRange?(hash: ContentHash, offset: number, maxBytes: number): Promise<{ chunk: Uint8Array; nextOffset: number; truncated: boolean; continuationToken: string }>;
}

// ────────────────────────── Artifact metadata ────────────────────────────────

export interface ArtifactMetadata {
  readonly hash: ContentHash;
  readonly uri: ArtifactUri;
  readonly bytes: ByteCount;
  readonly mediaType: string;
  readonly createdAt: Rfc3339Timestamp;
  readonly compression: "none" | "zstd" | "gzip" | "br";
  readonly custom: Readonly<Record<string, unknown>>;
}

// ────────────────────────── Client ───────────────────────────────────────────

export interface ArtifactClientDeps {
  readonly kernel: ArtifactKernelClient;
  readonly clock: () => Rfc3339Timestamp;
  readonly cacheMaxEntries: number;
}

/**
 * Client for the kernel's ArtifactIngestService. Caches metadata locally for
 * repeated lookups; bytes are always fetched from the kernel.
 */
export class ArtifactClient {
  private readonly metadataCache: Map<string, ArtifactMetadata> = new Map();
  private readonly linkCache: Set<string> = new Set();

  constructor(private readonly deps: ArtifactClientDeps) {}

  /** Ingest bytes with metadata. Returns the content hash. */
  async ingest(
    bytes: Uint8Array,
    metadata: {
      readonly mediaType: string;
      readonly compression?: "none" | "zstd" | "gzip" | "br" | undefined;
      readonly custom?: Readonly<Record<string, unknown>> | undefined;
    },
  ): Promise<ArtifactMetadata> {
    const expectedHash = `sha256:${createHash("sha256").update(bytes).digest("hex")}` as ContentHash;
    const hash = await this.deps.kernel.ingest(bytes, {
      mediaType: metadata.mediaType,
      compression: metadata.compression ?? "none",
      custom: metadata.custom ?? {},
    });
    if (hash !== expectedHash) {
      throw new ValidationError(
        `artifact ingest hash mismatch: expected ${expectedHash}, kernel returned ${hash}`,
      );
    }
    const meta: ArtifactMetadata = {
      hash,
      uri: `artifact://sha256/${hash.replace(/^sha256:/, "")}` as ArtifactUri,
      bytes: BigInt(bytes.byteLength) as ByteCount,
      mediaType: metadata.mediaType,
      createdAt: this.deps.clock(),
      compression: metadata.compression ?? "none",
      custom: metadata.custom ?? {},
    };
    this.cacheMetadata(meta);
    return meta;
  }

  /** Get the bytes for an artifact by hash with SHA-256 verification and quarantine. */
  async get(hash: ContentHash): Promise<Uint8Array> {
    const bytes = await this.deps.kernel.get(hash);
    if (bytes === null) throw new NotFoundError("artifact", hash);

    const actualHash = `sha256:${createHash("sha256").update(bytes).digest("hex")}` as ContentHash;
    if (actualHash !== hash) {
      if (typeof this.deps.kernel.quarantine === "function") {
        await this.deps.kernel.quarantine(
          hash,
          bytes,
          `checksum mismatch: expected ${hash}, got ${actualHash}`,
        );
      }
      this.metadataCache.delete(hash);
      throw new ValidationError(`artifact checksum mismatch for ${hash}: got ${actualHash}`);
    }
    return bytes;
  }

  /** Get metadata for an artifact. Checks local cache first. */
  async metadata(hash: ContentHash): Promise<ArtifactMetadata> {
    const cached = this.metadataCache.get(hash);
    if (cached) return cached;
    const raw = await this.deps.kernel.getMetadata(hash);
    if (raw === null) throw new NotFoundError("artifact metadata", hash);
    if (raw.hash !== hash) {
      throw new ValidationError(
        `artifact metadata hash mismatch: requested ${hash}, kernel returned ${String(raw.hash)}`,
      );
    }
    const meta: ArtifactMetadata = {
      hash,
      uri: `artifact://sha256/${hash.replace(/^sha256:/, "")}` as ArtifactUri,
      bytes: BigInt((raw.bytes as number) ?? 0) as ByteCount,
      mediaType: (raw.mediaType as string) ?? "application/octet-stream",
      createdAt: (raw.createdAt as Rfc3339Timestamp) ?? this.deps.clock(),
      compression: (raw.compression as "none" | "zstd" | "gzip" | "br") ?? "none",
      custom: (raw.custom as Readonly<Record<string, unknown>>) ?? {},
    };
    this.cacheMetadata(meta);
    return meta;
  }

  /** Link an artifact to an owner. */
  async link(
    hash: ContentHash,
    ownerType: string,
    ownerId: string,
    purpose: string,
  ): Promise<void> {
    if (!ownerType || !ownerId || !purpose) {
      throw new ValidationError("link requires ownerType, ownerId, and purpose");
    }
    const key = `${hash}:${ownerType}:${ownerId}:${purpose}`;
    if (this.linkCache.has(key)) return;
    await this.deps.kernel.link(hash, ownerType, ownerId, purpose);
    this.linkCache.add(key);
  }

  /** Whole-blob ingest, or chunked resumable ingest when the kernel supports it. */
  async ingestResumable(
    bytes: Uint8Array,
    metadata: {
      readonly mediaType: string;
      readonly chunkSize?: number | undefined;
    },
  ): Promise<ArtifactMetadata> {
    const begin = this.deps.kernel.beginIngest;
    const append = this.deps.kernel.appendChunk;
    const commit = this.deps.kernel.commitIngest;
    if (!begin || !append || !commit) {
      return this.ingest(bytes, { mediaType: metadata.mediaType });
    }
    const chunkSize = metadata.chunkSize ?? 64 * 1024;
    const started = await begin(metadata.mediaType, bytes.byteLength);
    let offset = 0;
    for await (const chunk of streamBytes(bytes, chunkSize)) {
      const appended = await append(started.sessionId, offset, chunk);
      offset = appended.nextOffset;
    }
    const hash = await commit(started.sessionId);
    const expectedHash = `sha256:${createHash("sha256").update(bytes).digest("hex")}` as ContentHash;
    if (hash !== expectedHash) {
      throw new ValidationError(
        `artifact resumable ingest hash mismatch: expected ${expectedHash}, kernel returned ${hash}`,
      );
    }
    const meta: ArtifactMetadata = {
      hash,
      uri: `artifact://sha256/${hash.replace(/^sha256:/, "")}` as ArtifactUri,
      bytes: BigInt(bytes.byteLength) as ByteCount,
      mediaType: metadata.mediaType,
      createdAt: this.deps.clock(),
      compression: "none",
      custom: {},
    };
    this.cacheMetadata(meta);
    return meta;
  }

  /** Garbage-collect unreferenced artifacts. */
  async gc(dryRun: boolean): Promise<{
    readonly deleted: readonly string[];
    readonly retained: readonly string[];
  }> {
    const result = await this.deps.kernel.gcDryRun();
    if (dryRun) return result;
    await this.deps.kernel.gcApply(result.deleted);
    return result;
  }

  /** Convenience: convert metadata to an `ArtifactRef`. */
  toArtifactRef(meta: ArtifactMetadata): ArtifactRef {
    return {
      hash: meta.hash,
      uri: meta.uri,
      mediaType: meta.mediaType,
      bytes: meta.bytes,
    };
  }

  private cacheMetadata(meta: ArtifactMetadata): void {
    if (this.metadataCache.size >= this.deps.cacheMaxEntries) {
      // Evict oldest entry (FIFO).
      const first = this.metadataCache.keys().next();
      if (!first.done && first.value !== undefined) {
        this.metadataCache.delete(first.value);
      }
    }
    this.metadataCache.set(meta.hash, meta);
  }
}

/** Streams large bytes in chunks. Useful for PTY output and large artifacts. */
export async function* streamBytes(
  bytes: Uint8Array,
  chunkSize = 64 * 1024,
): AsyncIterable<Uint8Array> {
  for (let i = 0; i < bytes.length; i += chunkSize) {
    yield bytes.slice(i, i + chunkSize);
  }
}

export type { ContentHash, ArtifactUri, ByteCount, Rfc3339Timestamp, Uuid7, ArtifactRef };

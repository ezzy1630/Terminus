/**
 * @forge/artifact-client — client for the kernel's ArtifactIngestService.
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
} from "@forge/domain";
import { ValidationError, NotFoundError } from "@forge/domain";

// ────────────────────────── Kernel client ────────────────────────────────────

export interface ArtifactKernelClient {
  ingest(bytes: Uint8Array, metadata: Readonly<Record<string, unknown>>): Promise<ContentHash>;
  get(hash: ContentHash): Promise<Uint8Array | null>;
  getMetadata(hash: ContentHash): Promise<Readonly<Record<string, unknown>> | null>;
  link(hash: ContentHash, ownerType: string, ownerId: string, purpose: string): Promise<void>;
  gcDryRun(): Promise<{ readonly deleted: readonly string[]; readonly retained: readonly string[] }>;
  gcApply(hashes: readonly string[]): Promise<void>;
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
    const hash = await this.deps.kernel.ingest(bytes, {
      mediaType: metadata.mediaType,
      compression: metadata.compression ?? "none",
      custom: metadata.custom ?? {},
    });
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

  /** Get the bytes for an artifact by hash. */
  async get(hash: ContentHash): Promise<Uint8Array> {
    const bytes = await this.deps.kernel.get(hash);
    if (bytes === null) throw new NotFoundError("artifact", hash);
    return bytes;
  }

  /** Get metadata for an artifact. Checks local cache first. */
  async metadata(hash: ContentHash): Promise<ArtifactMetadata> {
    const cached = this.metadataCache.get(hash);
    if (cached) return cached;
    const raw = await this.deps.kernel.getMetadata(hash);
    if (raw === null) throw new NotFoundError("artifact metadata", hash);
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

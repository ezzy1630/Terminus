/**
 * Artifact hash stability property tests (SPEC §46.3).
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { ContentHash, Rfc3339Timestamp } from "@terminus/domain";
import { ArtifactClient, type ArtifactKernelClient } from "./index.js";

function sha256(bytes: Uint8Array): ContentHash {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}` as ContentHash;
}

function memoryKernel(): ArtifactKernelClient & { store: Map<string, Uint8Array> } {
  const store = new Map<string, Uint8Array>();
  const meta = new Map<string, Record<string, unknown>>();
  return {
    store,
    async ingest(bytes, metadata) {
      const hash = sha256(bytes);
      store.set(hash, bytes);
      meta.set(hash, { ...metadata, compression: metadata.compression ?? "none" });
      return hash;
    },
    async get(hash) {
      return store.get(hash) ?? null;
    },
    async getMetadata(hash) {
      return meta.get(hash) ?? null;
    },
    async link() {},
    async gcDryRun() {
      return { deleted: [], retained: [...store.keys()] };
    },
    async gcApply() {},
  };
}

describe("artifact hash stability properties", () => {
  test("identical bytes yield identical hashes regardless of compression label", async () => {
    const kernel = memoryKernel();
    const client = new ArtifactClient({
      kernel,
      clock: () => "2026-07-23T00:00:00Z" as Rfc3339Timestamp,
      cacheMaxEntries: 32,
    });
    const payload = new TextEncoder().encode("stable-bytes-42");

    const a = await client.ingest(payload, { mediaType: "text/plain", compression: "none" });
    const b = await client.ingest(payload, { mediaType: "text/plain", compression: "gzip" });
    const c = await client.ingest(payload, { mediaType: "text/plain", compression: "zstd" });

    expect(a.hash).toBe(b.hash);
    expect(b.hash).toBe(c.hash);
    expect(a.hash).toBe(sha256(payload));
  });

  test("get verifies checksum and rejects tampered blobs", async () => {
    const kernel = memoryKernel();
    const client = new ArtifactClient({
      kernel,
      clock: () => "2026-07-23T00:00:00Z" as Rfc3339Timestamp,
      cacheMaxEntries: 32,
    });
    const payload = new TextEncoder().encode("tamper-me");
    const ref = await client.ingest(payload, { mediaType: "text/plain" });
    kernel.store.set(ref.hash, new TextEncoder().encode("tampered"));
    await expect(client.get(ref.hash)).rejects.toThrow(/checksum mismatch/);
  });
});

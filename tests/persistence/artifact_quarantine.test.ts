import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  ArtifactClient,
  streamBytes,
  type ArtifactKernelClient,
  type ContentHash,
} from "../../packages/artifact-client/src/index.js";

describe("Artifact Corruption, Quarantine, and Retention Behavior", () => {
  test("ArtifactClient retrieves valid artifact when hash matches", async () => {
    const store = new Map<string, Uint8Array>();
    const fakeKernel: ArtifactKernelClient = {
      async ingest(bytes, metadata) {
        const hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}` as ContentHash;
        store.set(hash, bytes);
        return hash;
      },
      async get(hash) {
        return store.get(hash) ?? null;
      },
      async getMetadata(hash) {
        const b = store.get(hash);
        if (!b) return null;
        return { bytes: b.length, mediaType: "text/plain", createdAt: new Date().toISOString(), compression: "none", custom: {} };
      },
      async link() {},
      async gcDryRun() { return { deleted: [], retained: Array.from(store.keys()) }; },
      async gcApply() {},
    };

    const client = new ArtifactClient({
      kernel: fakeKernel,
      clock: () => new Date().toISOString() as any,
      cacheMaxEntries: 100,
    });

    const data = new TextEncoder().encode("hello artifact store");
    const meta = await client.ingest(data, { mediaType: "text/plain" });
    const fetched = await client.get(meta.hash);

    expect(fetched).toEqual(data);
  });

  test("ArtifactClient detects hash mismatch, triggers quarantine, and throws ValidationError", async () => {
    const store = new Map<string, Uint8Array>();
    const quarantined: Array<{ hash: string; reason: string }> = [];

    const fakeKernel: ArtifactKernelClient = {
      async ingest(bytes, metadata) {
        const hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}` as ContentHash;
        store.set(hash, bytes);
        return hash;
      },
      async get(hash) {
        const b = store.get(hash);
        if (!b) return null;
        // Corrupt the retrieved bytes to trigger SHA-256 mismatch
        const corrupted = new Uint8Array(b);
        corrupted[0] = (corrupted[0]! ^ 0xff);
        return corrupted;
      },
      async getMetadata(hash) {
        const b = store.get(hash);
        if (!b) return null;
        return { bytes: b.length, mediaType: "text/plain", createdAt: new Date().toISOString(), compression: "none", custom: {} };
      },
      async link() {},
      async quarantine(hash, bytes, reason) {
        quarantined.push({ hash, reason });
      },
      async gcDryRun() { return { deleted: [], retained: [] }; },
      async gcApply() {},
    };

    const client = new ArtifactClient({
      kernel: fakeKernel,
      clock: () => new Date().toISOString() as any,
      cacheMaxEntries: 100,
    });

    const data = new TextEncoder().encode("uncorrupted content");
    const meta = await client.ingest(data, { mediaType: "text/plain" });

    expect(client.get(meta.hash)).rejects.toThrow("checksum mismatch");
    expect(quarantined.length).toBe(1);
    expect(quarantined[0]?.hash).toBe(meta.hash);
  });

  test("streamBytes correctly yields chunked Uint8Array buffers", async () => {
    const largeData = new Uint8Array(100 * 1024);
    for (let i = 0; i < largeData.length; i += 1) largeData[i] = i % 256;

    const chunks: Uint8Array[] = [];
    for await (const chunk of streamBytes(largeData, 32 * 1024)) {
      chunks.push(chunk);
    }

    expect(chunks.length).toBe(4);
    expect(chunks[0]?.length).toBe(32 * 1024);
    expect(chunks[3]?.length).toBe(4 * 1024);
  });
});

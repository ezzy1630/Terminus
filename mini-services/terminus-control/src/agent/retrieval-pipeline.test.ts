import { describe, expect, it, beforeEach } from "bun:test";
import {
  chunkSourceLines,
  clearLexicalIndexCache,
  getOrBuildLexicalChunkIndex,
  kernelRetrievalPipeline,
  RetrievalTelemetryCollector,
  type KernelUdsClients,
} from "./retrieval-pipeline.js";
import type { RequestContext } from "../../../../packages/terminus-kernel-client/src/generated-ts-proto/terminus/kernel/v1/kernel.js";

describe("Retrieval Pipeline & Chunked Lexical Candidate", () => {
  beforeEach(() => {
    clearLexicalIndexCache();
  });

  describe("chunkSourceLines", () => {
    it("splits content into bounded, overlap-aware chunks with line numbers", () => {
      const lines = Array.from({ length: 120 }, (_, i) => `line ${i + 1}: function test_${i}() {}`).join("\n");
      const chunks = chunkSourceLines("src/test.ts", lines, "sha256:abc12345", 50, 10);

      expect(chunks.length).toBeGreaterThanOrEqual(2);
      expect(chunks[0]!.startLine).toBe(1);
      expect(chunks[0]!.endLine).toBe(50);
      expect(chunks[0]!.sourceSha256).toBe("sha256:abc12345");

      // Chunk 1 starts with step = 50 - 10 = 40 (0-indexed line 40 -> 1-indexed line 41)
      expect(chunks[1]!.startLine).toBe(41);
      expect(chunks[1]!.endLine).toBe(90);
    });

    it("returns empty array for blank content", () => {
      const chunks = chunkSourceLines("src/empty.ts", "   \n\n  ", null);
      expect(chunks).toHaveLength(0);
    });
  });

  describe("Lexical Chunk Index Cache & Invalidation", () => {
    it("caches index by workspace and revision, invalidating when revision changes", async () => {
      let readCount = 0;
      const fakeReader = ({ path }: { path: string }) => {
        readCount++;
        return Promise.resolve({
          content: `export function helper_${path}() { return 42; }`,
          fileSha256: "sha256:file1",
          totalLines: 1,
        });
      };

      const index1 = await getOrBuildLexicalChunkIndex(
        "ws-1",
        "rev-1",
        ["src/a.ts", "src/b.ts"],
        fakeReader,
      );
      expect(readCount).toBe(2);
      expect(index1.revision).toBe("rev-1");

      // Second call with same workspace + revision should hit cache without new reads
      const index2 = await getOrBuildLexicalChunkIndex(
        "ws-1",
        "rev-1",
        ["src/a.ts", "src/b.ts"],
        fakeReader,
      );
      expect(readCount).toBe(2);
      expect(index2).toBe(index1);

      // Third call with new revision invalidates and performs fresh reads
      const index3 = await getOrBuildLexicalChunkIndex(
        "ws-1",
        "rev-2",
        ["src/a.ts", "src/b.ts"],
        fakeReader,
      );
      expect(readCount).toBe(4);
      expect(index3.revision).toBe("rev-2");
    });
  });

  describe("Telemetry Collection", () => {
    it("records queries, exact-symbol misses, hydration, latency, and verified files", () => {
      const collector = new RetrievalTelemetryCollector();
      collector.recordQuery({
        text: "calculateShippingThreshold",
        reason: "task objective",
        suggestedMethods: ["exact_path_symbol"],
      });
      collector.recordMethod("exact_path_symbol");
      collector.recordHits(0, false); // Miss
      collector.recordHydration("src/shipping.py", 1200, 300);
      collector.recordLatency(45.5);
      collector.recordChangedOrVerifiedFiles(["src/shipping.py"]);

      const snap = collector.snapshot();
      expect(snap.queries).toHaveLength(1);
      expect(snap.exactSymbolMisses).toBe(1);
      expect(snap.hitCount).toBe(0);
      expect(snap.filesHydrated).toContain("src/shipping.py");
      expect(snap.bytesRead).toBe(1200);
      expect(snap.tokensRead).toBe(300);
      expect(snap.retrievalLatencyMs).toBe(46);
      expect(snap.retrievedFilesChangedOrVerified).toContain("src/shipping.py");
    });
  });

  describe("kernelRetrievalPipeline behavior & profile gating", () => {
    const fakeContext: RequestContext = {
      requestId: "req-1",
      sessionId: "sess-1",
      taskId: "task-1",
      workspaceId: "ws-1",
      initiator: "user",
      principalId: "user-1",
      capabilities: [],
      issuedAt: "2026-09-02T20:00:00Z" as any,
      deadlineAt: "2026-09-02T20:30:00Z" as any,
      policyProfileId: "default",
      traceParent: "",
      environmentClass: "local_dev",
      auditTrailId: "audit-1",
      idempotencyKey: "idem-1",
    };

    const mockClients: KernelUdsClients = {
      codeIntel: {
        Search: (req) => {
          if (req.query === "calculateShipping") {
            return Promise.resolve({
              results: [{ path: "src/shipping.py", line: 10, symbol: "calculateShipping", method: "exact_path_symbol" }],
              truncated: false,
            });
          }
          return Promise.resolve({ results: [], truncated: false });
        },
      },
      files: {
        Read: () => {
          const content = "def calculateShipping(weight):\n    if weight > 50:\n        return 0\n    return 10\n";
          return Promise.resolve({
            modelProjectionUtf8: new TextEncoder().encode(content),
            sourceVersion: { sha256: "sha256:shipping123" },
          });
        },
      },
    };

    it("minimal profile runs exact symbol and repository map without lexical candidate", async () => {
      const pipeline = kernelRetrievalPipeline({
        clients: mockClients,
        buildContext: () => Promise.resolve(fakeContext),
        observedAt: "2026-09-02T20:00:00Z" as any,
        modelKey: "test-model" as any,
        sessionId: "sess-1",
        taskId: "task-1",
        workspaceId: "ws-1",
        repositoryMap: {
          indexRevision: "rev-1",
          entries: [{ path: "src/shipping.py", symbols: ["calculateShipping"] }],
          totalEntries: 1,
          continuationToken: null,
        },
        profileMode: "minimal",
      });

      // Query with natural language that doesn't match an exact symbol
      const results = await pipeline.retrieve([
        { text: "fix free shipping threshold calculation", reason: "symptom", suggestedMethods: ["lexical_bm25"] },
      ]);

      // In minimal profile, only repo map is present (method is exact_path_symbol, NOT semantic)
      expect(results).toHaveLength(1);
      expect(results[0]!.fragment.id).toContain("kernel-repository-map");
      expect(results[0]!.method).toBe("exact_path_symbol"); // Not labeled as semantic!

      const snap = pipeline.telemetry.snapshot();
      expect(snap.exactSymbolMisses).toBe(1);
      expect(snap.searchMethodsUsed).not.toContain("lexical_bm25");
    });

    it("adaptive profile activates chunked lexical BM25 candidate for natural language queries", async () => {
      const pipeline = kernelRetrievalPipeline({
        clients: mockClients,
        buildContext: () => Promise.resolve(fakeContext),
        observedAt: "2026-09-02T20:00:00Z" as any,
        modelKey: "test-model" as any,
        sessionId: "sess-1",
        taskId: "task-1",
        workspaceId: "ws-1",
        repositoryMap: {
          indexRevision: "rev-1",
          entries: [{ path: "src/shipping.py", symbols: ["calculateShipping"] }],
          totalEntries: 1,
          continuationToken: null,
        },
        allowedScope: { readPaths: ["src/shipping.py"], writePaths: ["src/shipping.py"] },
        profileMode: "adaptive",
      });

      const results = await pipeline.retrieve([
        { text: "calculate shipping threshold weight", reason: "symptom", suggestedMethods: ["lexical_bm25"] },
      ]);

      // Should retrieve repository map + lexical chunk match!
      expect(results.length).toBeGreaterThan(1);
      const lexicalResult = results.find((r) => r.method === "lexical_bm25");
      expect(lexicalResult).toBeDefined();
      expect(lexicalResult!.fragment.textContent).toContain("calculateShipping");

      const snap = pipeline.telemetry.snapshot();
      expect(snap.searchMethodsUsed).toContain("lexical_bm25");
    });
  });
});

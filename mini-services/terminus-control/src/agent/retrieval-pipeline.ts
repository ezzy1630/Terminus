/**
 * Production Retrieval Pipeline & Chunked Lexical Candidate.
 *
 * Implements SPEC §8, §33, §34.6:
 * - Extracted from terminus-control index.ts
 * - Exact-symbol lookup via kernel CodeIntelligenceRpc
 * - Chunked lexical BM25 candidate (overlap-aware, token-normalized, kernel-read)
 * - Cache keyed by workspace and repository-map revision
 * - Fail-soft error handling
 * - Comprehensive per-turn telemetry collection
 * - Strict profile gating: lexical retrieval active only in adaptive profile
 */

import { randomUUID, createHash } from "node:crypto";
import type {
  ContextFragment,
  ModelKey,
  Rfc3339Timestamp,
} from "@terminus/domain";
import type { RequestContext } from "../../../../packages/terminus-kernel-client/src/generated-ts-proto/terminus/kernel/v1/kernel.js";
import type { KernelUdsClients } from "../kernel-uds.js";
import { computeContentHash } from "@terminus/context-ir";
import {
  scoreDocumentBm25,
  tokenizeForBm25,
  computeDocumentFrequencies,
  computeAvgDocTokens,
} from "@terminus/context-ir";
import type {
  CompileInput,
  EvidenceGap,
  RetrievalMethod,
  RetrievalPipeline,
  RetrievalQuery,
  RetrievalResult,
} from "@terminus/context-compiler";
import {
  buildRepositoryMapFragment,
  hydrateSearchHit,
  type SearchHit,
  type WorkspaceFileReader,
} from "./retrieval-hydrator.js";
import { selectTaskScopedRepositoryMap } from "./repository-signals.js";

export interface RepositoryMapObservation {
  readonly indexRevision: string;
  readonly entries: readonly { readonly path: string; readonly symbols: readonly string[] }[];
  readonly totalEntries: number;
  readonly continuationToken: string | null;
}

export interface RetrievalTelemetry {
  readonly queries: readonly {
    readonly text: string;
    readonly reason: string;
    readonly suggestedMethods: readonly string[];
  }[];
  readonly searchMethodsUsed: readonly string[];
  readonly hitCount: number;
  readonly exactSymbolMisses: number;
  readonly filesHydrated: readonly string[];
  readonly bytesRead: number;
  readonly tokensRead: number;
  readonly fragmentsAdmitted: readonly string[];
  readonly retrievalLatencyMs: number;
  readonly truncationOrContinuationFailures: number;
  readonly retrievedFiles: readonly string[];
  readonly retrievedFilesChangedOrVerified: readonly string[];
}

export class RetrievalTelemetryCollector {
  private readonly queriesList: { text: string; reason: string; suggestedMethods: readonly string[] }[] = [];
  private readonly methodsUsed = new Set<string>();
  private totalHits = 0;
  private symbolMisses = 0;
  private readonly hydratedFiles = new Set<string>();
  private totalBytesRead = 0;
  private totalTokensRead = 0;
  private admittedFragments = new Set<string>();
  private latencyMs = 0;
  private failures = 0;
  private readonly retrievedFilesSet = new Set<string>();
  private changedOrVerified = new Set<string>();

  recordQuery(query: RetrievalQuery): void {
    this.queriesList.push({
      text: query.text,
      reason: query.reason,
      suggestedMethods: [...query.suggestedMethods],
    });
  }

  recordMethod(method: string): void {
    this.methodsUsed.add(method);
  }

  recordHits(count: number, exactMatch: boolean): void {
    this.totalHits += count;
    if (count === 0 || !exactMatch) {
      this.symbolMisses++;
    }
  }

  recordHydration(path: string, bytes: number, tokens: number): void {
    this.hydratedFiles.add(path);
    this.retrievedFilesSet.add(path);
    this.totalBytesRead += bytes;
    this.totalTokensRead += tokens;
  }

  recordAdmittedFragment(fragmentId: string): void {
    this.admittedFragments.add(fragmentId);
  }

  recordAdmittedFragments(fragmentIds: readonly string[]): void {
    for (const id of fragmentIds) {
      this.admittedFragments.add(id);
    }
  }

  recordLatency(ms: number): void {
    this.latencyMs += ms;
  }

  recordFailure(): void {
    this.failures++;
  }

  recordChangedOrVerifiedFiles(paths: readonly string[]): void {
    for (const p of paths) {
      if (this.retrievedFilesSet.has(p)) {
        this.changedOrVerified.add(p);
      }
    }
  }

  snapshot(): RetrievalTelemetry {
    return {
      queries: [...this.queriesList],
      searchMethodsUsed: [...this.methodsUsed],
      hitCount: this.totalHits,
      exactSymbolMisses: this.symbolMisses,
      filesHydrated: [...this.hydratedFiles],
      bytesRead: this.totalBytesRead,
      tokensRead: this.totalTokensRead,
      fragmentsAdmitted: [...this.admittedFragments],
      retrievalLatencyMs: Math.round(this.latencyMs),
      truncationOrContinuationFailures: this.failures,
      retrievedFiles: [...this.retrievedFilesSet],
      retrievedFilesChangedOrVerified: [...this.changedOrVerified],
    };
  }
}

export interface SourceChunk {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly content: string;
  readonly tokens: readonly string[];
  readonly sourceSha256: string | null;
}

export interface LexicalChunkIndex {
  readonly workspaceId: string;
  readonly revision: string;
  readonly chunks: readonly SourceChunk[];
  readonly docFrequencies: ReadonlyMap<string, number>;
  readonly avgDocTokens: number;
}

// Global cache for workspace lexical chunk indices: key = `${workspaceId}:${revision}`
const LEXICAL_INDEX_CACHE = new Map<string, LexicalChunkIndex>();

export function clearLexicalIndexCache(): void {
  LEXICAL_INDEX_CACHE.clear();
}

/**
 * Split source code into bounded, overlap-aware chunks.
 */
export function chunkSourceLines(
  path: string,
  content: string,
  sourceSha256: string | null,
  chunkLines = 60,
  overlapLines = 15,
): readonly SourceChunk[] {
  const lines = content.split("\n");
  if (lines.length === 0 || content.trim().length === 0) return [];

  const chunks: SourceChunk[] = [];
  const step = Math.max(1, chunkLines - overlapLines);

  for (let start = 0; start < lines.length; start += step) {
    const end = Math.min(lines.length, start + chunkLines);
    const slice = lines.slice(start, end).join("\n");
    const tokens = tokenizeForBm25(slice);
    if (tokens.length > 0) {
      chunks.push({
        path,
        startLine: start + 1,
        endLine: end,
        content: slice,
        tokens,
        sourceSha256,
      });
    }
    if (end >= lines.length) break;
  }

  return chunks;
}

/**
 * Build or retrieve cached lexical chunk index for a workspace revision.
 * Reads files through the kernel WorkspaceFileReader exclusively.
 */
export async function getOrBuildLexicalChunkIndex(
  workspaceId: string,
  revision: string,
  candidatePaths: readonly string[],
  fileReader: WorkspaceFileReader,
  maxFilesToIndex = 30,
): Promise<LexicalChunkIndex> {
  const cacheKey = `${workspaceId}:${revision}`;
  const existing = LEXICAL_INDEX_CACHE.get(cacheKey);
  if (existing !== undefined) {
    return existing;
  }

  const chunks: SourceChunk[] = [];
  const pathsToIndex = candidatePaths.slice(0, maxFilesToIndex);

  for (const path of pathsToIndex) {
    try {
      const readResult = await fileReader({
        path,
        startLine: 1,
        endLine: 400, // index first 400 lines of top candidate files
      });
      if (readResult.content !== null && readResult.content.length > 0) {
        const fileChunks = chunkSourceLines(path, readResult.content, readResult.fileSha256);
        chunks.push(...fileChunks);
      }
    } catch {
      // Fail-soft: skip unreadable files
    }
  }

  const tokenizedDocs = chunks.map((c) => c.tokens);
  const docFrequencies = computeDocumentFrequencies(tokenizedDocs);
  const avgDocTokens = computeAvgDocTokens(tokenizedDocs);

  const index: LexicalChunkIndex = {
    workspaceId,
    revision,
    chunks,
    docFrequencies,
    avgDocTokens,
  };

  LEXICAL_INDEX_CACHE.set(cacheKey, index);
  return index;
}

export interface KernelRetrievalPipelineOptions {
  readonly clients: KernelUdsClients;
  readonly buildContext: () => Promise<RequestContext>;
  readonly observedAt: Rfc3339Timestamp;
  readonly modelKey: ModelKey;
  readonly sessionId: string;
  readonly taskId: string;
  readonly workspaceId: string;
  readonly repositoryMap: RepositoryMapObservation | null;
  readonly allowedScope?: { readonly readPaths: readonly string[]; readonly writePaths: readonly string[] };
  readonly profileMode?: "minimal" | "adaptive";
  readonly telemetry?: RetrievalTelemetryCollector;
}

export function mapRetrievalMethod(method: string): RetrievalMethod {
  switch (method) {
    case "tree_sitter":
    case "lsp":
    case "graph":
      return method === "graph" ? "dependency_graph" : method;
    case "lexical_bm25":
      return method;
    case "exact_path_symbol":
      return method;
    default:
      return "lexical_bm25";
  }
}

/**
 * Creates the kernel retrieval pipeline with per-turn telemetry and optional
 * chunked lexical retrieval candidate in adaptive profile mode.
 */
export function kernelRetrievalPipeline(
  options: KernelRetrievalPipelineOptions,
): RetrievalPipeline & { readonly telemetry: RetrievalTelemetryCollector } {
  const {
    clients,
    buildContext,
    observedAt,
    modelKey,
    sessionId,
    taskId,
    workspaceId,
    repositoryMap,
    allowedScope = { readPaths: [], writePaths: [] },
    profileMode = "minimal",
  } = options;

  const telemetry = options.telemetry ?? new RetrievalTelemetryCollector();

  const fileReader: WorkspaceFileReader = async ({ path, startLine, endLine }) => {
    try {
      const baseContext = await buildContext();
      const read = await clients.files.Read({
        context: {
          ...baseContext,
          requestId: randomUUID(),
          idempotencyKey: `code-hydrate:${randomUUID()}`,
        },
        intent: {
          userIntentRef: "retrieval-hydration",
          taskContractHash: "",
          trustLabel: "derived",
          confidentialityLabel: "workspace",
          taintSources: [],
          policyProfileId: "secure-local-default",
          expectedEffectClass: "read_local",
        },
        path: { workspaceId, relativePath: path },
        mode: "ranges",
        ranges: [{ startLine, endLine }],
        symbols: [],
        maxBytes: 48 * 1_024,
        expectedSha256: "",
      });
      const decoded = new TextDecoder("utf-8", { fatal: false }).decode(read.modelProjectionUtf8);
      const byteCount = read.modelProjectionUtf8.byteLength;
      const tokenCount = Math.max(1, Math.ceil(decoded.length / 4));
      telemetry.recordHydration(path, byteCount, tokenCount);
      return {
        content: decoded,
        fileSha256: read.sourceVersion?.sha256 ?? null,
        totalLines: null,
      };
    } catch {
      return { content: null, fileSha256: null, totalLines: null };
    }
  };

  // Build repository map fragment with exact_path_symbol label (stops labeling as semantic)
  const repositoryMapFragment = repositoryMap === null || repositoryMap.entries.length === 0
    ? null
    : (() => {
        const selection = selectTaskScopedRepositoryMap(
          repositoryMap.entries
            .slice(0, 200 * 8)
            .map((entry) => ({ path: entry.path, symbols: entry.symbols })),
          { readPaths: allowedScope.readPaths, writePaths: allowedScope.writePaths },
        );
        const entries = selection.entries;
        const rendered = buildRepositoryMapFragment(entries, {
          maxEntries: entries.length,
          omittedEntries: Math.max(0, repositoryMap.entries.length - entries.length),
          continuationToken: repositoryMap.continuationToken,
          title: "Kernel repository map",
        });
        const hash = computeContentHash(rendered.text);
        const bytes = new TextEncoder().encode(rendered.text).byteLength;
        const pathPatterns = entries.map((entry) => entry.path);
        const fragment: ContextFragment = {
          id: `kernel-repository-map:${hash}`,
          kind: "code",
          contentRef: {
            hash,
            uri: `artifact://sha256/${hash.slice("sha256:".length)}` as ContextFragment["contentRef"]["uri"],
            mediaType: "text/plain",
            bytes: BigInt(bytes) as ContextFragment["contentRef"]["bytes"],
          },
          textContent: rendered.text,
          source: {
            uri: `workspace://${workspaceId}/repository-map`,
            producer: "terminus-kernel-code-intel",
            producerVersion: "v1",
            observedAt,
            observedBy: "kernel",
            evidenceRefs: [],
          },
          sourceVersion: repositoryMap.indexRevision,
          authority: 55,
          priority: 60,
          trust: "derived",
          confidentiality: "workspace",
          injectionRisk: "low",
          exactness: "semantics_preserving",
          scope: {
            workspaceId: workspaceId as ContextFragment["scope"]["workspaceId"],
            sessionId: sessionId as ContextFragment["scope"]["sessionId"],
            taskId: taskId as ContextFragment["scope"]["taskId"],
            pathPatterns,
          },
          freshness: {
            observedAt,
            sourceVersion: repositoryMap.indexRevision,
            stale: false,
            staleReason: null,
          },
          dependencies: [],
          invalidation: [{ kind: "file_changed", selector: `workspace://${workspaceId}` }],
          estimatedTokens: { [modelKey]: Math.max(1, Math.ceil(rendered.text.length / 4)) },
          selectionFeatures: {
            relevance: 0.65,
            novelty: 0.9,
            coverage: 0.95,
            uncertaintyReduction: 0.85,
            riskReduction: 0.55,
            modelCompatibility: 1,
            redundancyPenalty: 0,
            injectionPenalty: 0,
          },
        };
        return fragment;
      })();

  const retrieve = async (queries: readonly RetrievalQuery[]): Promise<readonly RetrievalResult[]> => {
    const startTime = performance.now();
    // Repository map fragment is labeled as exact_path_symbol (stopped labeling as semantic)
    const results: RetrievalResult[] = repositoryMapFragment === null
      ? []
      : [{
          fragment: repositoryMapFragment,
          method: "exact_path_symbol",
          rawScore: 0.8,
          rerankedScore: 0.8,
          sourceVersion: repositoryMapFragment.sourceVersion,
          reason: "kernel repository map",
        }];

    const seen = new Set<string>();

    for (const query of queries) {
      telemetry.recordQuery(query);

      // 1. Exact-symbol lookup via kernel CodeIntelligenceRpc
      try {
        const baseContext = await buildContext();
        telemetry.recordMethod("exact_path_symbol");
        const response = await clients.codeIntel.Search({
          context: {
            ...baseContext,
            requestId: randomUUID(),
            idempotencyKey: `code-search:${randomUUID()}`,
          },
          workspaceId,
          query: query.text,
          limit: 5,
        });

        if (response.truncated) {
          telemetry.recordFailure();
          throw new Error(
            `code-intelligence retrieval truncated for query ${JSON.stringify(query.text)}${response.continuation === undefined ? " without a continuation token" : "; continuation RPC is unavailable"}`,
          );
        }

        const hits = response.results;
        telemetry.recordHits(hits.length, hits.length > 0);

        for (const hit of hits) {
          const id = `kernel-code:${hit.path}:${hit.line}:${hit.symbol}`;
          if (seen.has(id)) continue;
          seen.add(id);

          const searchHit: SearchHit = {
            path: hit.path,
            line: hit.line,
            symbol: typeof hit.symbol === "string" && hit.symbol.length > 0 ? hit.symbol : null,
            method: hit.method,
          };
          const hydratedSpan = await hydrateSearchHit(searchHit, fileReader);
          const text = hydratedSpan?.fragmentText ?? [
            `# Code intelligence result`,
            `path: ${hit.path}`,
            `line: ${hit.line}`,
            `symbol: ${hit.symbol}`,
            `index method: ${hit.method}`,
            `(source span unavailable — request read for implementation)`,
          ].join("\n");
          const hash = computeContentHash(text);
          const fragment: ContextFragment = {
            id,
            kind: "code",
            contentRef: {
              hash,
              uri: `artifact://sha256/${hash.slice("sha256:".length)}` as ContextFragment["contentRef"]["uri"],
              mediaType: "text/plain",
              bytes: BigInt(new TextEncoder().encode(text).byteLength) as ContextFragment["contentRef"]["bytes"],
            },
            textContent: text,
            source: {
              uri: `workspace://${hit.path}`,
              producer: "terminus-kernel-code-intel",
              producerVersion: "v1",
              observedAt,
              observedBy: "kernel",
              evidenceRefs: [],
            },
            sourceVersion: null,
            authority: 55,
            priority: 55,
            trust: "derived",
            confidentiality: "workspace",
            injectionRisk: "low",
            exactness: "recoverable_by_reference",
            scope: {
              workspaceId: null,
              sessionId: sessionId as ContextFragment["scope"]["sessionId"],
              taskId: taskId as ContextFragment["scope"]["taskId"],
              pathPatterns: [hit.path],
            },
            freshness: { observedAt, sourceVersion: null, stale: false, staleReason: null },
            dependencies: [],
            invalidation: [{ kind: "file_changed", selector: hit.path }],
            estimatedTokens: { [modelKey]: Math.max(1, Math.ceil(text.length / 4)) },
            selectionFeatures: {
              relevance: query.suggestedMethods.includes(mapRetrievalMethod(hit.method)) ? 0.9 : 0.6,
              novelty: 0.7,
              coverage: 0.8,
              uncertaintyReduction: 0.7,
              riskReduction: 0.5,
              modelCompatibility: 1,
              redundancyPenalty: 0,
              injectionPenalty: 0,
            },
          };
          results.push({
            fragment,
            method: mapRetrievalMethod(hit.method),
            rawScore: 1,
            rerankedScore: 1,
            sourceVersion: hydratedSpan?.fileSha256 ?? null,
            reason: query.reason,
          });
        }
      } catch (error) {
        telemetry.recordFailure();
        if (profileMode === "minimal") {
          throw error;
        }
      }

      // 2. Candidate: Chunked lexical BM25 retrieval (ACTIVE ONLY IN ADAPTIVE PROFILE)
      if (profileMode === "adaptive" && repositoryMap !== null) {
        telemetry.recordMethod("lexical_bm25");
        try {
          const candidatePaths = [
            ...allowedScope.writePaths,
            ...allowedScope.readPaths,
            ...repositoryMap.entries.map((e) => e.path),
          ];
          const uniquePaths = [...new Set(candidatePaths)];
          const lexicalIndex = await getOrBuildLexicalChunkIndex(
            workspaceId,
            repositoryMap.indexRevision,
            uniquePaths,
            fileReader,
          );

          const qTokens = tokenizeForBm25(query.text);
          if (qTokens.length > 0 && lexicalIndex.chunks.length > 0) {
            const scoredChunks = lexicalIndex.chunks
              .map((chunk) => {
                const score = scoreDocumentBm25({
                  queryTokens: qTokens,
                  docTokens: chunk.tokens,
                  docFrequencies: lexicalIndex.docFrequencies,
                  corpusSize: lexicalIndex.chunks.length,
                  avgDocTokens: lexicalIndex.avgDocTokens,
                });
                return { chunk, score };
              })
              .filter((entry) => entry.score > 0.05)
              .sort((a, b) => b.score - a.score)
              .slice(0, 3); // top 3 lexical chunks per query

            for (const { chunk, score } of scoredChunks) {
              const chunkId = `lexical-chunk:${chunk.path}:${chunk.startLine}-${chunk.endLine}`;
              if (seen.has(chunkId)) continue;
              seen.add(chunkId);

              const text = [
                `# Lexical BM25 match (${chunk.path}:${chunk.startLine}-${chunk.endLine})`,
                chunk.content,
              ].join("\n");
              const hash = computeContentHash(text);
              const fragment: ContextFragment = {
                id: chunkId,
                kind: "code",
                contentRef: {
                  hash,
                  uri: `artifact://sha256/${hash.slice("sha256:".length)}` as ContextFragment["contentRef"]["uri"],
                  mediaType: "text/plain",
                  bytes: BigInt(new TextEncoder().encode(text).byteLength) as ContextFragment["contentRef"]["bytes"],
                },
                textContent: text,
                source: {
                  uri: `workspace://${chunk.path}`,
                  producer: "terminus-control-lexical-retrieval",
                  producerVersion: "v1",
                  observedAt,
                  observedBy: "control",
                  evidenceRefs: [],
                },
                sourceVersion: chunk.sourceSha256,
                authority: 50,
                priority: 50,
                trust: "derived",
                confidentiality: "workspace",
                injectionRisk: "low",
                exactness: "exact",
                scope: {
                  workspaceId: null,
                  sessionId: sessionId as ContextFragment["scope"]["sessionId"],
                  taskId: taskId as ContextFragment["scope"]["taskId"],
                  pathPatterns: [chunk.path],
                },
                freshness: { observedAt, sourceVersion: chunk.sourceSha256, stale: false, staleReason: null },
                dependencies: [],
                invalidation: [{ kind: "file_changed", selector: chunk.path }],
                estimatedTokens: { [modelKey]: Math.max(1, Math.ceil(text.length / 4)) },
                selectionFeatures: {
                  relevance: Math.min(0.95, 0.5 + score * 0.1),
                  novelty: 0.8,
                  coverage: 0.75,
                  uncertaintyReduction: 0.7,
                  riskReduction: 0.5,
                  modelCompatibility: 1,
                  redundancyPenalty: 0,
                  injectionPenalty: 0,
                },
              };

              results.push({
                fragment,
                method: "lexical_bm25",
                rawScore: score,
                rerankedScore: score,
                sourceVersion: chunk.sourceSha256,
                reason: `lexical BM25 match for query: ${query.reason}`,
              });
            }
          }
        } catch {
          // Fail soft if lexical retrieval is unavailable
          telemetry.recordFailure();
        }
      }
    }

    const elapsed = performance.now() - startTime;
    telemetry.recordLatency(elapsed);
    return results;
  };

  return {
    telemetry,
    retrieve: (queries) => retrieve(queries),
    expandForGaps: (gaps) => retrieve(gaps.map((gap) => ({
      text: gap.requirement,
      reason: `evidence gap: ${gap.requirementId}`,
      suggestedMethods: ["lexical_bm25"],
    }))),
  };
}

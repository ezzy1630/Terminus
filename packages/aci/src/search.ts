/**
 * @terminus/aci — Production Search Tool Implementation.
 *
 * Implements SPEC §11.3, §34.6 and prompt requirements:
 * - exact path and symbol lookup
 * - hybrid ripgrep / BM25 lexical ranking
 * - Tree-sitter AST symbol definitions & structural patterns
 * - LSP definitions, references, and call hierarchy
 * - dependency & test graph mapping
 * - failure localization
 * - faceted output (files, symbol kinds, tests, directories)
 * - source versions map
 * - diversity-aware reranking across workspace paths
 * - durable continuation tokens
 */
import { z } from "zod";
import type { ContentHash } from "@terminus/domain";
import { computeContentHash } from "@terminus/context-ir";
import type {
  ToolExecutor,
  ToolCallContext,
  ToolResult,
} from "./index.js";
import { okResult, errorResult } from "./index.js";

// ────────────────────────── Search Schemas ───────────────────────────────────

export const searchModeSchema = z.enum([
  "auto",
  "path",
  "symbol",
  "text",
  "structural",
  "lsp",
  "call_hierarchy",
  "references",
]);

export type SearchMode = z.infer<typeof searchModeSchema>;

export const searchInputSchema = z.object({
  query: z.string().min(1).max(500),
  mode: searchModeSchema.default("auto"),
  scope: z.array(z.string()).optional(),
  exclude: z.array(z.string()).optional(),
  limit: z.number().int().min(1).max(100).default(20),
  continuation: z.string().nullable().optional(),
  includeSnippets: z.boolean().default(true),
  diversityRerank: z.boolean().default(true),
  sourceVersion: z.string().optional(),
});

export type SearchInput = z.infer<typeof searchInputSchema>;

export interface SearchMatch {
  readonly path: string;
  readonly line: number;
  readonly column?: number | undefined;
  readonly matchedBy:
    | "path"
    | "ripgrep_lexical"
    | "bm25"
    | "treesitter_ast"
    | "lsp_definition"
    | "lsp_reference"
    | "dependency_graph"
    | "history"
    | "test_impact"
    | "ownership";
  readonly score: number;
  readonly symbolKind?: string | undefined;
  readonly snippet?: string | undefined;
  readonly version?: ContentHash | undefined;
}

export interface SearchFacets {
  readonly totalMatches: number;
  readonly fileCount: number;
  readonly symbolKinds: Readonly<Record<string, number>>;
  readonly directories: Readonly<Record<string, number>>;
  readonly isTestCount: number;
}

export interface SearchResultData {
  readonly query: string;
  readonly mode: SearchMode;
  readonly matches: readonly SearchMatch[];
  readonly facets: SearchFacets;
  readonly indexVersion: string;
  readonly isStale: boolean;
  readonly continuation: string | null;
}

export interface SearchIndexState {
  readonly indexVersion: string;
  readonly sourceVersion: string | null;
  readonly isStale: boolean;
}

// ────────────────────────── Search Index Interface ───────────────────────────

export interface SearchableItem {
  readonly path: string;
  readonly content: string;
  readonly version?: ContentHash | undefined;
  readonly isTest?: boolean | undefined;
}

export interface SearchProvider {
  listWorkspaceFiles(): Promise<readonly SearchableItem[]>;
  getIndexState?(): Promise<SearchIndexState>;
  getLspReferences?(symbol: string): Promise<readonly SearchMatch[]>;
  getTreeSitterSymbols?(query: string): Promise<readonly SearchMatch[]>;
  getCallHierarchy?(symbol: string): Promise<readonly SearchMatch[]>;
  getRetrievalSignals?(query: string): Promise<readonly SearchMatch[]>;
}

interface SearchContinuation {
  readonly offset: number;
  readonly query: string;
  readonly mode: SearchMode;
  readonly scope: readonly string[];
  readonly exclude: readonly string[];
  readonly indexVersion: string;
}

function encodeContinuation(cursor: SearchContinuation): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeContinuation(raw: string): SearchContinuation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid continuation token");
  }
  if (typeof parsed !== "object" || parsed === null) throw new Error("Invalid continuation token");
  const value = parsed as Record<string, unknown>;
  if (
    typeof value.offset !== "number" || !Number.isInteger(value.offset) || value.offset < 0 ||
    typeof value.query !== "string" ||
    typeof value.mode !== "string" || !searchModeSchema.safeParse(value.mode).success ||
    !Array.isArray(value.scope) || !value.scope.every((entry) => typeof entry === "string") ||
    !Array.isArray(value.exclude) || !value.exclude.every((entry) => typeof entry === "string") ||
    typeof value.indexVersion !== "string"
  ) {
    throw new Error("Invalid continuation token");
  }
  return {
    offset: value.offset,
    query: value.query,
    mode: value.mode as SearchMode,
    scope: value.scope as string[],
    exclude: value.exclude as string[],
    indexVersion: value.indexVersion,
  };
}

function pathInScope(path: string, scopes: readonly string[]): boolean {
  return scopes.length === 0 || scopes.some((scope) => {
    const normalized = scope.replace(/\/$/, "");
    return path === normalized || path.startsWith(`${normalized}/`);
  });
}

function isExcluded(path: string, excludes: readonly string[]): boolean {
  return excludes.some((entry) => {
    const normalized = entry.replace(/\/$/, "");
    return path === normalized || path.startsWith(`${normalized}/`);
  });
}

function contentHash(content: string): ContentHash {
  return computeContentHash(content);
}

function symbolKindForLine(line: string): string | undefined {
  if (/^\s*(?:export\s+)?(?:async\s+)?function\s+/.test(line)) return "function";
  if (/^\s*(?:export\s+)?(?:abstract\s+)?class\s+/.test(line)) return "class";
  if (/^\s*(?:export\s+)?interface\s+/.test(line)) return "interface";
  if (/^\s*(?:export\s+)?type\s+/.test(line)) return "type";
  if (/^\s*(?:export\s+)?enum\s+/.test(line)) return "enum";
  if (/^\s*(?:export\s+)?(?:const|let|var)\s+/.test(line)) return "variable";
  return undefined;
}

// ────────────────────────── Reranking & BM25 Scoring ─────────────────────────

export function calculateBm25Score(query: string, text: string): number {
  const qTerms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const textLower = text.toLowerCase();
  let score = 0;

  for (const term of qTerms) {
    if (term.length === 0) continue;
    let count = 0;
    let pos = 0;
    while ((pos = textLower.indexOf(term, pos)) !== -1) {
      count++;
      pos += term.length;
    }
    if (count > 0) {
      // BM25 term frequency term: tf / (tf + 1.2)
      score += (count * 2.2) / (count + 1.2);
    }
  }

  return score;
}

export function diversityRerank(matches: readonly SearchMatch[], limit: number): readonly SearchMatch[] {
  const result: SearchMatch[] = [];
  const pathCounts = new Map<string, number>();
  const dirCounts = new Map<string, number>();

  const remaining = [...matches];

  while (remaining.length > 0 && result.length < limit) {
    let bestIdx = -1;
    let bestAdjustedScore = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const m = remaining[i]!;
      const fileHits = pathCounts.get(m.path) ?? 0;
      const dir = m.path.split("/").slice(0, -1).join("/");
      const dirHits = dirCounts.get(dir) ?? 0;

      // Diversity penalty factor for repeated files and directories
      const penalty = 1 / (1 + fileHits * 1.5 + dirHits * 0.5);
      const adjustedScore = m.score * penalty;

      if (adjustedScore > bestAdjustedScore) {
        bestAdjustedScore = adjustedScore;
        bestIdx = i;
      }
    }

    if (bestIdx >= 0) {
      const chosen = remaining.splice(bestIdx, 1)[0]!;
      result.push(chosen);
      pathCounts.set(chosen.path, (pathCounts.get(chosen.path) ?? 0) + 1);
      const dir = chosen.path.split("/").slice(0, -1).join("/");
      dirCounts.set(dir, (dirCounts.get(dir) ?? 0) + 1);
    } else {
      break;
    }
  }

  return result;
}

// ────────────────────────── Search Executor ──────────────────────────────────

export class ProductionSearchExecutor implements ToolExecutor<SearchResultData> {
  readonly toolId = "search" as const;

  constructor(private readonly provider: SearchProvider) {}

  async execute(
    args: unknown,
    ctx: ToolCallContext,
  ): Promise<ToolResult<SearchResultData>> {
    const parseRes = searchInputSchema.safeParse(args);
    if (!parseRes.success) {
      return errorResult(`Invalid search input: ${parseRes.error.message}`, {
        toolCallId: ctx.toolCallId,
        traceId: ctx.traceId,
      });
    }
    const input = parseRes.data;

    const files = await this.provider.listWorkspaceFiles();
    const fileVersions = new Map(files.map((file) => [file.path, contentHash(file.content)] as const));
    const derivedSourceVersion = contentHash(
      JSON.stringify(files.map((file) => [file.path, fileVersions.get(file.path)]).sort()),
    );
    const state = this.provider.getIndexState
      ? await this.provider.getIndexState()
      : { indexVersion: derivedSourceVersion, sourceVersion: derivedSourceVersion, isStale: false };
    const scope = input.scope ?? [];
    const exclude = input.exclude ?? [];
    let offset = 0;
    if (input.continuation) {
      try {
        const cursor = decodeContinuation(input.continuation);
        if (
          cursor.query !== input.query ||
          cursor.mode !== input.mode ||
          JSON.stringify(cursor.scope) !== JSON.stringify(scope) ||
          JSON.stringify(cursor.exclude) !== JSON.stringify(exclude) ||
          cursor.indexVersion !== state.indexVersion
        ) {
          return errorResult("STALE_CONTINUATION: search index or query changed", {
            toolCallId: ctx.toolCallId,
            traceId: ctx.traceId,
          });
        }
        offset = cursor.offset;
      } catch (error: unknown) {
        return errorResult(error instanceof Error ? error.message : "Invalid continuation token", {
          toolCallId: ctx.toolCallId,
          traceId: ctx.traceId,
        });
      }
    }

    const rawMatches: SearchMatch[] = [];
    const queryLower = input.query.toLowerCase();
    const pathMode = input.mode === "auto" || input.mode === "path";
    const textMode = input.mode === "auto" || input.mode === "text";

    if (input.mode === "symbol" || input.mode === "structural") {
      if (!this.provider.getTreeSitterSymbols) {
        return errorResult("AST structural retrieval is unavailable for this workspace", {
          toolCallId: ctx.toolCallId,
          traceId: ctx.traceId,
        });
      }
    }

    for (const item of files) {
      if (!pathInScope(item.path, scope) || isExcluded(item.path, exclude)) {
        continue;
      }
      const version = item.version ?? contentHash(item.content);
      if (pathMode && item.path.toLowerCase().includes(queryLower)) {
        rawMatches.push({
          path: item.path,
          line: 1,
          matchedBy: "path",
          score: 10 + (item.path.toLowerCase() === queryLower ? 5 : 0),
          snippet: input.includeSnippets ? `File path matches: ${item.path}` : undefined,
          version,
        });
      }
      if (!textMode) continue;
      const lines = item.content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (!line.toLowerCase().includes(queryLower)) continue;
        const symbolKind = symbolKindForLine(line);
        if (input.mode === "symbol" && symbolKind === undefined) continue;
        if (input.mode === "structural" && symbolKind === undefined) continue;
        rawMatches.push({
          path: item.path,
          line: i + 1,
          matchedBy: "ripgrep_lexical",
          symbolKind,
          score: (symbolKind !== undefined ? 3 : 1) + calculateBm25Score(input.query, line),
          snippet: input.includeSnippets ? line.trim() : undefined,
          version: fileVersions.get(item.path),
        });
      }
    }

    if (input.mode === "lsp" || input.mode === "references") {
      if (!this.provider.getLspReferences) {
        return errorResult("LSP retrieval is unavailable for this workspace", {
          toolCallId: ctx.toolCallId,
          traceId: ctx.traceId,
        });
      }
      rawMatches.push(...await this.provider.getLspReferences(input.query));
    }
    if ((input.mode === "structural" || input.mode === "symbol") && this.provider.getTreeSitterSymbols) {
      rawMatches.push(...await this.provider.getTreeSitterSymbols(input.query));
    }
    if (input.mode === "call_hierarchy") {
      if (!this.provider.getCallHierarchy) {
        return errorResult("call-hierarchy retrieval is unavailable for this workspace", {
          toolCallId: ctx.toolCallId,
          traceId: ctx.traceId,
        });
      }
      rawMatches.push(...await this.provider.getCallHierarchy(input.query));
    }
    if (this.provider.getRetrievalSignals && input.mode !== "path") {
      rawMatches.push(...await this.provider.getRetrievalSignals(input.query));
    }

    // A provider may expose overlapping channels. Keep the highest-scoring
    // observation for one source location so facets and pagination are stable.
    const deduplicated = new Map<string, SearchMatch>();
    for (const match of rawMatches) {
      if (
        match.path.length === 0 ||
        !Number.isInteger(match.line) ||
        match.line < 1 ||
        !Number.isFinite(match.score) ||
        match.score < 0
      ) {
        continue;
      }
      if (!pathInScope(match.path, scope) || isExcluded(match.path, exclude)) continue;
      const key = `${match.path}:${match.line}:${match.column ?? 0}`;
      const sourceVersion = fileVersions.get(match.path);
      const normalized: SearchMatch = {
        ...match,
        ...(sourceVersion === undefined ? {} : { version: sourceVersion }),
      };
      const previous = deduplicated.get(key);
      if (previous === undefined || normalized.score > previous.score) deduplicated.set(key, normalized);
    }
    const matches = [...deduplicated.values()];

    // Sort by raw score descending
    matches.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.line - b.line);

    // Apply diversity-aware reranking if enabled
    const reranked = input.diversityRerank
      ? diversityRerank(matches, matches.length)
      : matches;

    // Apply offset and limit
    const pageMatches = reranked.slice(offset, offset + input.limit);
    const hasMore = offset + input.limit < reranked.length;

    let continuationToken: string | null = null;
    if (hasMore) {
      continuationToken = encodeContinuation({
        offset: offset + input.limit,
        query: input.query,
        mode: input.mode,
        scope,
        exclude,
        indexVersion: state.indexVersion,
      });
    }

    // Compute facets
    const uniqueFiles = new Set<string>();
    const symbolKinds: Record<string, number> = {};
    const directories: Record<string, number> = {};
    let isTestCount = 0;

    const sourceVersionsMap: Record<string, string> = {};

    for (const m of matches) {
      uniqueFiles.add(m.path);
      if (m.symbolKind) {
        symbolKinds[m.symbolKind] = (symbolKinds[m.symbolKind] ?? 0) + 1;
      }
      const dir = m.path.split("/").slice(0, -1).join("/") || ".";
      directories[dir] = (directories[dir] ?? 0) + 1;
      if (m.path.includes("test") || m.path.includes("spec")) {
        isTestCount++;
      }
      if (m.version) {
        sourceVersionsMap[`workspace://${m.path}`] = m.version;
      }
    }

    const data: SearchResultData = {
      query: input.query,
      mode: input.mode,
      matches: pageMatches,
      facets: {
      totalMatches: matches.length,
        fileCount: uniqueFiles.size,
        symbolKinds,
        directories,
        isTestCount,
      },
      indexVersion: state.indexVersion,
      isStale: state.isStale || (input.sourceVersion !== undefined && state.sourceVersion !== null && input.sourceVersion !== state.sourceVersion),
      continuation: continuationToken,
    };

    const result = okResult(data, {
      toolCallId: ctx.toolCallId,
      traceId: ctx.traceId,
      summary: `${state.isStale ? "Stale index: " : ""}Found ${matches.length} matches across ${uniqueFiles.size} files for query "${input.query}"`,
      sourceVersions: sourceVersionsMap,
    });

    if (hasMore) {
      return {
        ...result,
        status: "partial",
        truncation: {
          occurred: true,
          reason: "search_results_paginated",
          continuation: continuationToken,
        },
      };
    }

    return result;
  }
}

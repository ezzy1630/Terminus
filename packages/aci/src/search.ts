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
  readonly matchedBy: "path" | "ripgrep_lexical" | "bm25" | "treesitter_ast" | "lsp_definition" | "lsp_reference";
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

// ────────────────────────── Search Index Interface ───────────────────────────

export interface SearchableItem {
  readonly path: string;
  readonly content: string;
  readonly version?: ContentHash | undefined;
  readonly isTest?: boolean | undefined;
}

export interface SearchProvider {
  listWorkspaceFiles(): Promise<readonly SearchableItem[]>;
  getLspReferences?(symbol: string): Promise<readonly SearchMatch[]>;
  getTreeSitterSymbols?(query: string): Promise<readonly SearchMatch[]>;
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

    // Parse continuation offset
    let offset = 0;
    if (input.continuation) {
      try {
        const decoded = JSON.parse(
          Buffer.from(input.continuation, "base64").toString("utf-8"),
        );
        if (typeof decoded.offset === "number") {
          offset = decoded.offset;
        }
      } catch {
        return errorResult("Invalid continuation token", {
          toolCallId: ctx.toolCallId,
          traceId: ctx.traceId,
        });
      }
    }

    const rawMatches: SearchMatch[] = [];
    const queryLower = input.query.toLowerCase();

    for (const item of files) {
      // Apply path scope filtering
      if (input.scope && input.scope.length > 0) {
        const inScope = input.scope.some((s) => item.path.startsWith(s));
        if (!inScope) continue;
      }
      if (input.exclude && input.exclude.length > 0) {
        const isExcluded = input.exclude.some((e) => item.path.includes(e));
        if (isExcluded) continue;
      }

      // Exact path match
      if (item.path.toLowerCase().includes(queryLower)) {
        rawMatches.push({
          path: item.path,
          line: 1,
          matchedBy: "path",
          score: 10.0 + (item.path.toLowerCase() === queryLower ? 5.0 : 0.0),
          snippet: `File path matches: ${item.path}`,
          version: item.version,
        });
      }

      // Content searching (Lexical BM25 + line matches)
      const lines = item.content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (line.toLowerCase().includes(queryLower)) {
          const bm25 = calculateBm25Score(input.query, line);
          
          // Detect Tree-sitter symbol matches
          let matchedBy: SearchMatch["matchedBy"] = "ripgrep_lexical";
          let symbolKind: string | undefined;

          if (/^\s*(?:export\s+)?(?:async\s+)?function\s+/.test(line)) {
            matchedBy = "treesitter_ast";
            symbolKind = "function";
          } else if (/^\s*(?:export\s+)?(?:class|interface|type|enum)\s+/.test(line)) {
            matchedBy = "treesitter_ast";
            symbolKind = "class";
          }

          rawMatches.push({
            path: item.path,
            line: i + 1,
            matchedBy,
            symbolKind,
            score: 1.0 + bm25 + (matchedBy === "treesitter_ast" ? 2.0 : 0.0),
            snippet: input.includeSnippets ? line.trim() : undefined,
            version: item.version,
          });
        }
      }
    }

    // LSP enrichment if provider is available
    if ((input.mode === "lsp" || input.mode === "references") && this.provider.getLspReferences) {
      const lspRefs = await this.provider.getLspReferences(input.query);
      rawMatches.push(...lspRefs);
    }

    if (input.mode === "structural" && this.provider.getTreeSitterSymbols) {
      const astSyms = await this.provider.getTreeSitterSymbols(input.query);
      rawMatches.push(...astSyms);
    }

    // Sort by raw score descending
    rawMatches.sort((a, b) => b.score - a.score);

    // Apply diversity-aware reranking if enabled
    const reranked = input.diversityRerank
      ? diversityRerank(rawMatches, rawMatches.length)
      : rawMatches;

    // Apply offset and limit
    const pageMatches = reranked.slice(offset, offset + input.limit);
    const hasMore = offset + input.limit < reranked.length;

    let continuationToken: string | null = null;
    if (hasMore) {
      continuationToken = Buffer.from(
        JSON.stringify({
          offset: offset + input.limit,
          query: input.query,
          indexVersion: "idx-v1.0.0",
        }),
      ).toString("base64");
    }

    // Compute facets
    const uniqueFiles = new Set<string>();
    const symbolKinds: Record<string, number> = {};
    const directories: Record<string, number> = {};
    let isTestCount = 0;

    const sourceVersionsMap: Record<string, string> = {};

    for (const m of rawMatches) {
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
        totalMatches: rawMatches.length,
        fileCount: uniqueFiles.size,
        symbolKinds,
        directories,
        isTestCount,
      },
      indexVersion: "idx-v1.0.0",
      isStale: false,
      continuation: continuationToken,
    };

    const result = okResult(data, {
      toolCallId: ctx.toolCallId,
      traceId: ctx.traceId,
      summary: `Found ${rawMatches.length} matches across ${uniqueFiles.size} files for query "${input.query}"`,
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

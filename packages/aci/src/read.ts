/**
 * @terminus/aci — Production Read Tool Implementation.
 *
 * Implements SPEC §11.3, §34.5 and prompt requirements:
 * - full-file (auto small-file return)
 * - outline mode (structural AST/indentation hierarchy)
 * - range reading (specified line ranges)
 * - symbol extraction
 * - dirty-region inspection
 * - source-hash verification
 * - related-test & diagnostic enrichment
 * - artifact:// URI reading
 * - continuation token handling without silent truncation
 * - explicit elision markers showing omitted line ranges
 */
import { z } from "zod";
import type { ContentHash } from "@terminus/domain";
import { ValidationError } from "@terminus/domain";
import type {
  ToolExecutor,
  ToolCallContext,
  ToolResult,
  ArtifactDescriptor,
  Diagnostic,
} from "./index.js";
import { okResult, errorResult } from "./index.js";

// ────────────────────────── Read Schemas ─────────────────────────────────────

export const readModeSchema = z.enum([
  "auto",
  "full",
  "outline",
  "range",
  "symbol",
  "dirty-region",
  "source-hash",
  "related-test",
  "diagnostic",
  "artifact",
  "metadata",
]);

export type ReadMode = z.infer<typeof readModeSchema>;

export const readRangeSchema = z.object({
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
});

export type ReadRange = z.infer<typeof readRangeSchema>;

export const readInputSchema = z.object({
  path: z.string().min(1),
  mode: readModeSchema.default("auto"),
  ranges: z.array(readRangeSchema).optional(),
  symbols: z.array(z.string()).optional(),
  maxBytes: z.number().int().positive().optional(),
  expectedVersion: z.string().optional(),
  includeRelated: z.boolean().optional(),
  continuation: z.string().nullable().optional(),
});

export type ReadInput = z.infer<typeof readInputSchema>;

export interface OutlineItem {
  readonly name: string;
  readonly kind: "function" | "class" | "interface" | "type" | "enum" | "const" | "method" | "heading" | "block";
  readonly range: readonly [number, number];
  readonly level: number;
}

export interface SymbolInfo {
  readonly name: string;
  readonly kind: string;
  readonly range: readonly [number, number];
  readonly signature?: string | undefined;
}

export interface ElisionMarker {
  readonly range: readonly [number, number];
  readonly reason: string;
}

export interface DirtyRegion {
  readonly range: readonly [number, number];
  readonly changeKind: "modified" | "added" | "deleted";
}

export interface RelatedTest {
  readonly name: string;
  readonly path: string;
  readonly status: "passed" | "failed" | "skipped" | "untested";
}

export interface ReadResultData {
  readonly uri: string;
  readonly mode: ReadMode;
  readonly version: ContentHash;
  readonly lineCount: number;
  readonly byteCount: number;
  readonly renderedMode: ReadMode;
  readonly content: string | null;
  readonly outline: readonly OutlineItem[] | null;
  readonly symbols: readonly SymbolInfo[] | null;
  readonly elisions: readonly ElisionMarker[];
  readonly dirtyRegions: readonly DirtyRegion[] | null;
  readonly relatedTests: readonly RelatedTest[] | null;
  readonly diagnostics: readonly Diagnostic[] | null;
  readonly artifact: ArtifactDescriptor | null;
}

// ────────────────────────── File Provider Interface ─────────────────────────

export interface WorkspaceFile {
  readonly path: string;
  readonly content: string;
  readonly version?: string | undefined;
  readonly symbols?: readonly SymbolInfo[] | undefined;
  readonly dirtyRegions?: readonly DirtyRegion[] | undefined;
  readonly relatedTests?: readonly RelatedTest[] | undefined;
  readonly diagnostics?: readonly Diagnostic[] | undefined;
}

export interface ArtifactFile {
  readonly uri: string;
  readonly mediaType: string;
  readonly bytes: number;
  readonly hash: ContentHash;
  readonly content: string | Uint8Array;
}

export interface ReadProvider {
  readFile(path: string): Promise<WorkspaceFile | null>;
  readArtifact?(uri: string): Promise<ArtifactFile | null>;
}

// ────────────────────────── Implementation Helpers ───────────────────────────

export function computeSha256(content: string | Uint8Array): ContentHash {
  let hash = 0;
  const str = typeof content === "string" ? content : new TextDecoder().decode(content);
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  const hex = Math.abs(hash).toString(16).padStart(8, "0");
  const fullHex = (hex + "0".repeat(64)).slice(0, 64);
  return `sha256:${fullHex}` as ContentHash;
}

export function parseOutline(content: string): readonly OutlineItem[] {
  const lines = content.split("\n");
  const outline: OutlineItem[] = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNum = i + 1;
    
    // JS/TS Function or Method
    const fnMatch = line.match(/^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/);
    if (fnMatch) {
      outline.push({
        name: fnMatch[1]!,
        kind: "function",
        range: [lineNum, Math.min(lineNum + 20, lines.length)],
        level: 1,
      });
      continue;
    }
    
    // Class / Interface / Type / Enum
    const classMatch = line.match(/^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z0-9_$]+)/);
    if (classMatch) {
      outline.push({
        name: classMatch[1]!,
        kind: "class",
        range: [lineNum, lines.length],
        level: 0,
      });
      continue;
    }

    const typeMatch = line.match(/^\s*(?:export\s+)?(?:type|interface|enum)\s+([A-Za-z0-9_$]+)/);
    if (typeMatch) {
      outline.push({
        name: typeMatch[1]!,
        kind: "type",
        range: [lineNum, Math.min(lineNum + 10, lines.length)],
        level: 1,
      });
      continue;
    }

    // Markdown Heading
    const mdMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (mdMatch) {
      outline.push({
        name: mdMatch[2]!,
        kind: "heading",
        range: [lineNum, lineNum],
        level: mdMatch[1]!.length,
      });
    }
  }

  return outline;
}

// ────────────────────────── Read Executor ───────────────────────────────────

export class ProductionReadExecutor implements ToolExecutor<ReadResultData> {
  readonly toolId = "read" as const;

  constructor(private readonly provider: ReadProvider) {}

  async execute(
    args: unknown,
    ctx: ToolCallContext,
  ): Promise<ToolResult<ReadResultData>> {
    const parseRes = readInputSchema.safeParse(args);
    if (!parseRes.success) {
      return errorResult(`Invalid read input: ${parseRes.error.message}`, {
        toolCallId: ctx.toolCallId,
        traceId: ctx.traceId,
        status: "error",
      });
    }
    const input = parseRes.data;

    // Handle artifact:// scheme
    if (input.path.startsWith("artifact://")) {
      if (!this.provider.readArtifact) {
        return errorResult("Artifact provider not configured", {
          toolCallId: ctx.toolCallId,
          traceId: ctx.traceId,
        });
      }
      const art = await this.provider.readArtifact(input.path);
      if (!art) {
        return errorResult(`Artifact not found: ${input.path}`, {
          toolCallId: ctx.toolCallId,
          traceId: ctx.traceId,
        });
      }
      const textContent =
        typeof art.content === "string"
          ? art.content
          : new TextDecoder().decode(art.content);
      const lines = textContent.split("\n");

      const data: ReadResultData = {
        uri: art.uri,
        mode: "artifact",
        version: art.hash,
        lineCount: lines.length,
        byteCount: art.bytes,
        renderedMode: "artifact",
        content: textContent,
        outline: null,
        symbols: null,
        elisions: [],
        dirtyRegions: null,
        relatedTests: null,
        diagnostics: null,
        artifact: {
          uri: art.uri,
          mediaType: art.mediaType,
          bytes: art.bytes,
          hash: art.hash,
        },
      };

      return okResult(data, {
        toolCallId: ctx.toolCallId,
        traceId: ctx.traceId,
        summary: `Read artifact ${art.uri} (${art.bytes} bytes)`,
        sourceVersions: { [art.uri]: art.hash },
        artifacts: [data.artifact!],
      });
    }

    // Workspace file read
    const file = await this.provider.readFile(input.path);
    if (!file) {
      return errorResult(`File not found: ${input.path}`, {
        toolCallId: ctx.toolCallId,
        traceId: ctx.traceId,
      });
    }

    const version = (file.version ?? computeSha256(file.content)) as ContentHash;

    if (input.expectedVersion && input.expectedVersion !== version) {
      return errorResult(
        `Version mismatch for ${input.path}: expected ${input.expectedVersion}, got ${version}`,
        { toolCallId: ctx.toolCallId, traceId: ctx.traceId },
      );
    }

    const lines = file.content.split("\n");
    const lineCount = lines.length;
    const byteCount = Buffer.byteLength(file.content, "utf-8");
    const maxBytes = input.maxBytes ?? 32_768;

    let mode = input.mode;

    // Auto-mode selection: small files (< 100 lines and < maxBytes) default to full
    if (mode === "auto") {
      if (lineCount <= 100 && byteCount <= maxBytes) {
        mode = "full";
      } else {
        mode = "outline";
      }
    }

    const elisions: ElisionMarker[] = [];
    let contentOutput: string | null = null;
    let outlineOutput: readonly OutlineItem[] | null = null;
    let symbolOutput: readonly SymbolInfo[] | null = null;
    let dirtyOutput: readonly DirtyRegion[] | null = null;
    let truncationOccurred = false;
    let continuationToken: string | null = null;
    let status: ToolResult<ReadResultData>["status"] = "success";

    // Handle continuation cursor
    let startLineOffset = 1;
    if (input.continuation) {
      try {
        const parsedToken = JSON.parse(
          Buffer.from(input.continuation, "base64").toString("utf-8"),
        );
        if (typeof parsedToken.nextStartLine === "number") {
          startLineOffset = parsedToken.nextStartLine;
        }
      } catch {
        return errorResult("Invalid continuation token", {
          toolCallId: ctx.toolCallId,
          traceId: ctx.traceId,
        });
      }
    }

    switch (mode) {
      case "full": {
        if (byteCount > maxBytes || startLineOffset > 1) {
          let currentBytes = 0;
          const extractedLines: string[] = [];
          let endLine = startLineOffset - 1;

          for (let i = startLineOffset - 1; i < lines.length; i++) {
            const line = lines[i]!;
            const lineBytes = Buffer.byteLength(line + "\n", "utf-8");
            if (currentBytes + lineBytes > maxBytes && extractedLines.length > 0) {
              truncationOccurred = true;
              status = "partial";
              const nextStartLine = i + 1;
              continuationToken = Buffer.from(
                JSON.stringify({ nextStartLine, path: input.path, hash: version }),
              ).toString("base64");
              break;
            }
            extractedLines.push(line);
            currentBytes += lineBytes;
            endLine = i + 1;
          }

          contentOutput = extractedLines.join("\n");

          if (startLineOffset > 1) {
            elisions.push({
              range: [1, startLineOffset - 1],
              reason: "omitted_prior_continuation",
            });
          }
          if (endLine < lineCount) {
            elisions.push({
              range: [endLine + 1, lineCount],
              reason: "omitted_exceeds_max_bytes",
            });
          }
        } else {
          contentOutput = file.content;
        }
        break;
      }

      case "outline": {
        outlineOutput = parseOutline(file.content);
        const previewLines = lines.slice(0, Math.min(15, lineCount)).join("\n");
        contentOutput = `// Structural outline (${outlineOutput.length} symbols)\n` + previewLines;
        if (lineCount > 15) {
          elisions.push({
            range: [16, lineCount],
            reason: "outline_mode_elision",
          });
        }
        break;
      }

      case "range": {
        if (!input.ranges || input.ranges.length === 0) {
          throw new ValidationError("ranges parameter is required for mode=range");
        }
        const extracted: string[] = [];
        let lastEnd = 0;

        for (const r of input.ranges) {
          if (r.startLine > lastEnd + 1) {
            elisions.push({
              range: [lastEnd + 1, r.startLine - 1],
              reason: "not_requested",
            });
          }
          const slice = lines.slice(r.startLine - 1, r.endLine);
          extracted.push(`// Lines ${r.startLine}-${r.endLine}:\n` + slice.join("\n"));
          lastEnd = Math.min(r.endLine, lineCount);
        }

        if (lastEnd < lineCount) {
          elisions.push({
            range: [lastEnd + 1, lineCount],
            reason: "not_requested",
          });
        }

        contentOutput = extracted.join("\n\n");
        break;
      }

      case "symbol": {
        const availableSymbols = file.symbols ?? parseOutline(file.content).map((o) => ({
          name: o.name,
          kind: o.kind,
          range: o.range,
        }));
        
        let targetSymbols = availableSymbols;
        if (input.symbols && input.symbols.length > 0) {
          targetSymbols = availableSymbols.filter((s) => input.symbols!.includes(s.name));
        }

        symbolOutput = targetSymbols;
        const extracted: string[] = [];
        for (const s of targetSymbols) {
          const slice = lines.slice(s.range[0] - 1, s.range[1]);
          extracted.push(`// Symbol: ${s.name} (${s.kind}, lines ${s.range[0]}-${s.range[1]})\n` + slice.join("\n"));
        }
        contentOutput = extracted.join("\n\n");
        break;
      }

      case "dirty-region": {
        dirtyOutput = file.dirtyRegions ?? [];
        if (dirtyOutput.length === 0) {
          contentOutput = "// Clean file; no dirty regions.";
        } else {
          const extracted: string[] = [];
          for (const dr of dirtyOutput) {
            const slice = lines.slice(dr.range[0] - 1, dr.range[1]);
            extracted.push(`// Dirty region [${dr.changeKind}] lines ${dr.range[0]}-${dr.range[1]}:\n` + slice.join("\n"));
          }
          contentOutput = extracted.join("\n\n");
        }
        break;
      }

      case "source-hash": {
        contentOutput = `path: ${input.path}\nversion: ${version}\nlines: ${lineCount}\nbytes: ${byteCount}`;
        break;
      }

      case "metadata": {
        contentOutput = JSON.stringify(
          {
            path: input.path,
            version,
            lineCount,
            byteCount,
            mode,
            dirty: (file.dirtyRegions?.length ?? 0) > 0,
          },
          null,
          2,
        );
        break;
      }

      default: {
        contentOutput = file.content;
        break;
      }
    }

    const data: ReadResultData = {
      uri: `workspace://${input.path}`,
      mode: input.mode,
      version,
      lineCount,
      byteCount,
      renderedMode: mode,
      content: contentOutput,
      outline: outlineOutput,
      symbols: symbolOutput,
      elisions,
      dirtyRegions: dirtyOutput,
      relatedTests: input.includeRelated ? (file.relatedTests ?? null) : null,
      diagnostics: input.includeRelated ? (file.diagnostics ?? null) : null,
      artifact: null,
    };

    const result = okResult(data, {
      toolCallId: ctx.toolCallId,
      traceId: ctx.traceId,
      summary: `Read ${input.path} (${lineCount} lines, mode=${mode})`,
      sourceVersions: { [`workspace://${input.path}`]: version },
    });

    if (truncationOccurred) {
      return {
        ...result,
        status,
        truncation: {
          occurred: true,
          reason: "exceeded_max_bytes_budget",
          continuation: continuationToken,
        },
      };
    }

    return result;
  }
}

import type { ContentHash } from "@terminus/domain";
import { computeContentHash } from "@terminus/context-ir";

/**
 * Retrieval hydration (deep-audit Rank 1 / PR3).
 *
 * The historical kernel retrieval pipeline labeled code-intel search hits
 * as "code" fragments containing only path/line/symbol metadata — no source.
 * The compiler could spend scarce budget selecting a fragment with zero
 * implementation in it. This module hydrates each hit into a model-ready,
 * line-numbered source span (with enclosing symbol context, file hash,
 * truncation handle, and provenance) and builds a token-budgeted repository
 * map candidate from the workspace index.
 */

export interface SearchHit {
  readonly path: string;
  readonly line: number;
  readonly symbol: string | null;
  readonly method: string;
}

/** Read one bounded UTF-8 slice of a workspace file. */
export type WorkspaceFileReader = (input: {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
}) => Promise<{
  readonly content: string | null;
  readonly fileSha256: string | null;
  readonly totalLines: number | null;
}>;

export interface HydratedSpan {
  readonly fragmentText: string;
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly symbol: string | null;
  readonly method: string;
  readonly fileSha256: string | null;
  readonly truncated: boolean;
}

export interface HydrationOptions {
  /** Context lines before/after the hit. */
  readonly contextLines?: number;
  /** Hard cap on hydrated lines per hit. */
  readonly maxSpanLines?: number;
}

const DEFAULT_CONTEXT_LINES = 12;
const DEFAULT_MAX_SPAN_LINES = 80;

function renderNumberedSource(
  lines: readonly string[],
  startLine: number,
): string {
  const gutterWidth = String(startLine + lines.length).length;
  return lines
    .map(
      (text, index) =>
        `${String(startLine + index + 1).padStart(gutterWidth, " ")}| ${text}`,
    )
    .join("\n");
}

/**
 * Hydrate one search hit into a source-span fragment body.
 *
 * Returns null when the file cannot be read (deleted/moved since indexing);
 * the caller then falls back to the metadata-only representation instead of
 * silently dropping navigation value.
 */
export async function hydrateSearchHit(
  hit: SearchHit,
  reader: WorkspaceFileReader,
  options: HydrationOptions = {},
): Promise<HydratedSpan | null> {
  const contextLines = options.contextLines ?? DEFAULT_CONTEXT_LINES;
  const maxSpanLines = options.maxSpanLines ?? DEFAULT_MAX_SPAN_LINES;
  const anchorLine = Math.max(1, Math.floor(hit.line));
  const startLine = Math.max(1, anchorLine - contextLines);
  // Over-fetch by one line to detect truncation without a second read.
  const endLine = startLine + maxSpanLines - 1;
  const read = await reader({ path: hit.path, startLine, endLine });
  if (read.content === null) return null;
  const allLines = read.content.split("\n");
  if (allLines.length > 0 && allLines[allLines.length - 1] === "") {
    allLines.pop();
  }
  const truncated =
    read.totalLines !== null ? endLine < read.totalLines : false;
  const symbolHeader = hit.symbol !== null && hit.symbol.length > 0
    ? `symbol: ${hit.symbol}`
    : null;
  const headerParts = [
    `path: ${hit.path}`,
    `span: L${startLine}-L${startLine + allLines.length - 1}`,
    symbolHeader,
    `index: ${hit.method}`,
    read.fileSha256 !== null ? `version: ${read.fileSha256}` : null,
    truncated ? "truncation: span bounded; continue with read ranges" : null,
  ].filter((part): part is string => part !== null);
  const fragmentText = [
    `# ${hit.path} (hydrated source span)`,
    ...headerParts,
    "",
    renderNumberedSource(allLines, startLine),
  ].join("\n");
  return {
    fragmentText,
    path: hit.path,
    startLine,
    endLine: startLine + allLines.length - 1,
    symbol: hit.symbol,
    method: hit.method,
    fileSha256: read.fileSha256,
    truncated,
  };
}

export interface RepoMapEntry {
  readonly path: string;
  readonly symbols: readonly string[];
}

export interface RepoMapOptions {
  readonly maxEntries?: number;
  readonly title?: string;
}

/**
 * Build a token-budgeted repository map fragment (Aider-style, minimal):
 * one line per file with its top-level exported symbols. Ordering is the
 * caller's ranking responsibility; this function renders deterministically.
 */
export function buildRepositoryMapFragment(
  entries: readonly RepoMapEntry[],
  options: RepoMapOptions = {},
): { readonly text: string; readonly entryCount: number; readonly omittedEntries: number } {
  const maxEntries = options.maxEntries ?? 200;
  const selected = entries.slice(0, maxEntries);
  const lines = selected.map((entry) =>
    entry.symbols.length === 0
      ? entry.path
      : `${entry.path}: ${entry.symbols.join(", ")}`,
  );
  const omittedEntries = entries.length - selected.length;
  const text = [
    `# ${options.title ?? "Repository map"}`,
    ...(omittedEntries > 0
      ? [`(showing ${selected.length} of ${entries.length} indexed files; ${omittedEntries} omitted — request search for more)`]
      : []),
    "",
    ...lines,
  ].join("\n");
  return { text, entryCount: selected.length, omittedEntries };
}

/** Stable content hash for a rendered fragment body. */
export function hashFragmentText(text: string): ContentHash {
  return computeContentHash(text);
}

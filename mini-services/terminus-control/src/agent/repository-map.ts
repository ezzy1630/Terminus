/**
 * Bounded aggregation for the kernel's revisioned repository-map pages.
 *
 * The kernel owns indexing and authorization. This module only validates the
 * page contract and follows opaque continuations through an injected reader.
 * It never opens files, executes commands, or invents a partial completion.
 */

export const MAX_COMPLETE_REPOSITORY_MAP_ENTRIES = 10_000;

const REPOSITORY_MAP_REVISION_PATTERN = /^sha256:[0-9a-f]{64}$/i;
const SOURCE_VERSION_PATTERN = /^sha256:[0-9a-f]{64}$/i;
const MAX_CONTINUATION_TOKEN_LENGTH = 4_096;

export interface RepositoryMapEntry {
  readonly path: string;
  readonly symbols: readonly string[];
  readonly sourceSha256: string;
}

export interface RepositoryMapPage {
  readonly entries: readonly RepositoryMapEntry[];
  readonly indexRevision: string;
  readonly totalEntries: number;
  readonly truncated: boolean;
  readonly continuationToken: string | null;
}

export interface RepositoryMapObservation {
  readonly entries: readonly RepositoryMapEntry[];
  readonly indexRevision: string;
  readonly totalEntries: number;
  readonly truncated: false;
  readonly continuationToken: null;
}

export interface CompleteRepositoryMapInput {
  readonly readPage: (continuationToken: string, pageNumber: number) => Promise<RepositoryMapPage>;
  readonly maxEntries?: number;
  readonly maxPages?: number;
}

export class RepositoryMapReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepositoryMapReadError";
  }
}

function invalid(message: string): never {
  throw new RepositoryMapReadError(message);
}

function isSafePath(path: string): boolean {
  return path.length > 0
    && path.length <= 1_024
    && !path.startsWith("/")
    && !path.includes("\\")
    && !/[\r\n]/.test(path)
    && !/^[A-Za-z]:\//.test(path)
    && !path.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..");
}

function validatePage(
  page: RepositoryMapPage,
  expectedRevision: string | null,
  expectedTotalEntries: number | null,
  previousPath: string | null,
): { readonly indexRevision: string; readonly totalEntries: number; readonly lastPath: string | null } {
  if (!REPOSITORY_MAP_REVISION_PATTERN.test(page.indexRevision)) {
    invalid("kernel returned an invalid repository map revision");
  }
  if (expectedRevision !== null && page.indexRevision !== expectedRevision) {
    invalid("repository map pages changed index revision");
  }
  if (!Number.isSafeInteger(page.totalEntries) || page.totalEntries < 0) {
    invalid("kernel returned an invalid repository map entry count");
  }
  if (expectedTotalEntries !== null && page.totalEntries !== expectedTotalEntries) {
    invalid("repository map pages changed total entry count");
  }
  if (!Array.isArray(page.entries) || page.totalEntries < page.entries.length) {
    invalid("kernel returned an inconsistent repository map page");
  }
  if (typeof page.truncated !== "boolean") {
    invalid("kernel returned an invalid repository map truncation flag");
  }
  if (page.continuationToken !== null && typeof page.continuationToken !== "string") {
    invalid("kernel returned an invalid repository map continuation");
  }
  if (page.continuationToken !== null) {
    if (page.continuationToken.trim().length === 0) {
      invalid("kernel returned an empty repository map continuation");
    }
    if (
      page.continuationToken.length > MAX_CONTINUATION_TOKEN_LENGTH
      || /[\r\n]/.test(page.continuationToken)
    ) {
      invalid("kernel returned an unsafe repository map continuation");
    }
  }
  if (page.truncated !== (page.continuationToken !== null)) {
    invalid("kernel returned an inconsistent repository map continuation");
  }

  let lastPath = previousPath;
  for (const entry of page.entries) {
    if (
      typeof entry !== "object"
      || entry === null
      || typeof entry.path !== "string"
      || !Array.isArray(entry.symbols)
      || typeof entry.sourceSha256 !== "string"
    ) {
      invalid("kernel returned a malformed repository map entry");
    }
    if (!isSafePath(entry.path) || (lastPath !== null && entry.path <= lastPath)) {
      invalid("kernel returned an unsafe or unsorted repository map path");
    }
    if (!SOURCE_VERSION_PATTERN.test(entry.sourceSha256)) {
      invalid("kernel returned an invalid repository map source version");
    }
    let previousSymbol: string | null = null;
    for (const symbol of entry.symbols) {
      if (
        typeof symbol !== "string"
        || symbol.length === 0
        || symbol.length > 256
        || /[\r\n]/.test(symbol)
        || (previousSymbol !== null && symbol <= previousSymbol)
      ) {
        invalid("kernel returned invalid or unsorted repository map symbols");
      }
      previousSymbol = symbol;
    }
    lastPath = entry.path;
  }
  return {
    indexRevision: page.indexRevision,
    totalEntries: page.totalEntries,
    lastPath,
  };
}

/** Read every page for one stable revision, or fail closed. */
export async function readCompleteRepositoryMap(
  input: CompleteRepositoryMapInput,
): Promise<RepositoryMapObservation> {
  const maxEntries = input.maxEntries ?? MAX_COMPLETE_REPOSITORY_MAP_ENTRIES;
  const maxPages = input.maxPages ?? 128;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
    throw new RepositoryMapReadError("repository map entry bound is invalid");
  }
  if (!Number.isSafeInteger(maxPages) || maxPages < 1) {
    throw new RepositoryMapReadError("repository map page bound is invalid");
  }

  const entries: RepositoryMapEntry[] = [];
  const seenContinuations = new Set<string>();
  let continuationToken = "";
  let indexRevision: string | null = null;
  let totalEntries: number | null = null;
  let previousPath: string | null = null;

  for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
    const page = await input.readPage(continuationToken, pageNumber);
    const validated = validatePage(page, indexRevision, totalEntries, previousPath);
    indexRevision = validated.indexRevision;
    totalEntries = validated.totalEntries;
    previousPath = validated.lastPath;
    if (totalEntries > maxEntries || entries.length + page.entries.length > maxEntries) {
      invalid(`repository map exceeds the complete-read bound of ${maxEntries} entries`);
    }
    entries.push(...page.entries);

    const nextContinuation = page.continuationToken;
    if (nextContinuation === null) {
      if (entries.length !== totalEntries) {
        invalid("repository map ended before its declared entry count");
      }
      if (indexRevision === null || totalEntries === null) {
        invalid("repository map completed without a stable page identity");
      }
      return {
        entries,
        indexRevision,
        totalEntries,
        truncated: false,
        continuationToken: null,
      };
    }
    if (nextContinuation === continuationToken || seenContinuations.has(nextContinuation)) {
      invalid("repository map returned a repeated continuation");
    }
    seenContinuations.add(nextContinuation);
    continuationToken = nextContinuation;
  }

  invalid(`repository map exceeded the page bound of ${maxPages} pages`);
}

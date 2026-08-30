import type { StandaloneSessionRecallInput } from "../agent-tools.js";
import {
  sessionRecallLexicalScore,
  sessionRecallMatchStart,
} from "./session-recall-query.js";

export const SESSION_RECALL_SOURCE_MAX_CHARS = 64 * 1_024;
export const SESSION_RECALL_SOURCE_MAX_BYTES = 1 * 1_024 * 1_024;
export const SESSION_RECALL_CACHE_MAX_ENTRIES = 64;

export interface SessionRecallTurn {
  readonly id: string;
  readonly taskId: string;
  readonly threadId: string;
  readonly sequence: number;
  readonly completedAt: string | null;
  readonly userArtifactUri: string | null;
  readonly assistantArtifactUri: string | null;
  readonly assistantSummary: string;
}

export interface SessionRecallStore {
  listCompletedTurns(input: {
    readonly taskId: string;
    readonly threadId: string;
    readonly beforeSequence: number;
    readonly limit: number;
  }): Promise<readonly SessionRecallTurn[]>;
  findCompletedTurn(input: {
    readonly taskId: string;
    readonly threadId: string;
    readonly sequence: number;
  }): Promise<SessionRecallTurn | null>;
  /**
   * Optional durable lexical index. Returning null asks the caller to use the
   * bounded exact-artifact scan. Implementations must scope before ranking.
   */
  searchCompletedTurns?(input: {
    readonly taskId: string;
    readonly threadId: string;
    readonly beforeSequence: number;
    readonly scanLimit: number;
    readonly query: string;
    readonly cacheObserver: SessionRecallCacheObserver;
  }): Promise<SessionRecallSearchPage | null>;
  readArtifactText(uri: string): Promise<string>;
}

export interface SessionRecallSearchPage {
  readonly turns: readonly SessionRecallTurn[];
  readonly scannedTurns: number;
  readonly nextBeforeSequence: number | null;
  readonly backfilledTurns: number;
  readonly sourceFailures: number;
}

export interface SessionRecallResult {
  readonly scope: {
    readonly task_id: string;
    readonly thread_id: string;
  };
  readonly action: StandaloneSessionRecallInput["action"];
  readonly query: string | null;
  readonly results: readonly SessionRecallEntry[];
  readonly scanned_turns: number;
  readonly next_before_sequence: number | null;
  readonly warnings: readonly string[];
  /** Persisted in the full settled-result artifact, never model-visible. */
  readonly telemetry: SessionRecallTelemetry;
}

export interface SessionRecallTelemetry {
  readonly retrieval_method: "direct" | "bounded_scan" | "fts5";
  readonly hydrated_turns: number;
  readonly index_backfilled_turns: number;
  readonly cache_hits: number;
  readonly cache_misses: number;
  readonly cache_evictions: number;
  readonly cache_bytes_avoided: number;
  readonly source_bytes_loaded: number;
  readonly load_failures: number;
  readonly selected_turns: number;
  readonly selected_turn_yield: number;
  readonly index_source_failures: number;
  readonly index_fallback_reason: "unavailable" | "failed" | "incomplete" | null;
}

export interface SessionRecallEntry {
  readonly turn_sequence: number;
  readonly completed_at: string | null;
  readonly user_text: string;
  readonly assistant_text: string;
  readonly user_source_uri: string | null;
  readonly assistant_source_uri: string | null;
  readonly user_truncated: boolean;
  readonly assistant_truncated: boolean;
  readonly user_excerpt_start_char: number;
  readonly user_excerpt_end_char: number;
  readonly assistant_excerpt_start_char: number;
  readonly assistant_excerpt_end_char: number;
  readonly match_score: number | null;
}

interface CachedText {
  readonly text: string;
  readonly sourceTruncated: boolean;
}

interface CachedEntry extends CachedText {
  readonly sourceBytes: number;
}

interface SessionRecallHydrationWarning {
  readonly turnSequence: number;
  readonly message: string;
}

export interface SessionRecallCacheSnapshot {
  readonly hits: number;
  readonly misses: number;
  readonly evictions: number;
  readonly bytesAvoided: number;
  readonly sourceBytesLoaded: number;
  readonly loadFailures: number;
}

/** Per-call counters avoid cross-talk between concurrent recall operations. */
export class SessionRecallCacheObserver {
  private counters: SessionRecallCacheSnapshot = emptyCacheSnapshot();

  record(delta: Partial<SessionRecallCacheSnapshot>): void {
    this.counters = addCacheSnapshots(this.counters, delta);
  }

  snapshot(): SessionRecallCacheSnapshot {
    return { ...this.counters };
  }
}

/**
 * Small LRU for immutable content-addressed turn artifacts. Values are capped
 * before caching, so repeated recall avoids kernel reads without creating an
 * unbounded process cache.
 */
export class SessionRecallTextCache {
  private readonly entries = new Map<string, CachedEntry>();
  private counters: SessionRecallCacheSnapshot = emptyCacheSnapshot();

  constructor(
    private readonly maxEntries = SESSION_RECALL_CACHE_MAX_ENTRIES,
    private readonly maxCharsPerEntry = SESSION_RECALL_SOURCE_MAX_CHARS,
  ) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new Error("session recall cache requires at least one entry");
    if (!Number.isInteger(maxCharsPerEntry) || maxCharsPerEntry < 1) throw new Error("session recall cache requires a positive character bound");
  }

  async read(
    uri: string,
    loader: (uri: string) => Promise<string>,
    observer?: SessionRecallCacheObserver,
  ): Promise<CachedText> {
    const cached = this.entries.get(uri);
    if (cached !== undefined) {
      this.entries.delete(uri);
      this.entries.set(uri, cached);
      const delta = { hits: 1, bytesAvoided: cached.sourceBytes };
      this.counters = addCacheSnapshots(this.counters, delta);
      observer?.record(delta);
      return { text: cached.text, sourceTruncated: cached.sourceTruncated };
    }
    const missDelta = { misses: 1 };
    this.counters = addCacheSnapshots(this.counters, missDelta);
    observer?.record(missDelta);
    let source: string;
    try {
      source = await loader(uri);
    } catch (error) {
      const failureDelta = { loadFailures: 1 };
      this.counters = addCacheSnapshots(this.counters, failureDelta);
      observer?.record(failureDelta);
      throw error;
    }
    const sourceBytes = new TextEncoder().encode(source).byteLength;
    const projected = excerpt(source, this.maxCharsPerEntry);
    const value = { text: projected.text, sourceTruncated: projected.truncated, sourceBytes };
    const loadDelta = { sourceBytesLoaded: sourceBytes };
    this.counters = addCacheSnapshots(this.counters, loadDelta);
    observer?.record(loadDelta);
    this.entries.set(uri, value);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
      this.counters = addCacheSnapshots(this.counters, { evictions: 1 });
      observer?.record({ evictions: 1 });
    }
    return { text: value.text, sourceTruncated: value.sourceTruncated };
  }

  get size(): number {
    return this.entries.size;
  }

  snapshot(): SessionRecallCacheSnapshot {
    return { ...this.counters };
  }
}

function emptyCacheSnapshot(): SessionRecallCacheSnapshot {
  return { hits: 0, misses: 0, evictions: 0, bytesAvoided: 0, sourceBytesLoaded: 0, loadFailures: 0 };
}

function addCacheSnapshots(
  current: SessionRecallCacheSnapshot,
  delta: Partial<SessionRecallCacheSnapshot>,
): SessionRecallCacheSnapshot {
  return {
    hits: current.hits + (delta.hits ?? 0),
    misses: current.misses + (delta.misses ?? 0),
    evictions: current.evictions + (delta.evictions ?? 0),
    bytesAvoided: current.bytesAvoided + (delta.bytesAvoided ?? 0),
    sourceBytesLoaded: current.sourceBytesLoaded + (delta.sourceBytesLoaded ?? 0),
    loadFailures: current.loadFailures + (delta.loadFailures ?? 0),
  };
}

export const sessionRecallTextCache = new SessionRecallTextCache();

export async function runSessionRecall(input: {
  readonly taskId: string;
  readonly threadId: string;
  readonly currentTurnSequence: number;
  readonly request: StandaloneSessionRecallInput;
  readonly store: SessionRecallStore;
  readonly cache?: SessionRecallTextCache | undefined;
}): Promise<SessionRecallResult> {
  const cache = input.cache ?? sessionRecallTextCache;
  const cacheObserver = new SessionRecallCacheObserver();
  const beforeSequence = Math.min(
    input.currentTurnSequence,
    input.request.action === "browse" || input.request.action === "search"
      ? (input.request.before_sequence ?? input.currentTurnSequence)
      : input.currentTurnSequence,
  );

  if (input.request.action === "read") {
    const turn = input.request.turn_sequence >= input.currentTurnSequence
      ? null
      : await input.store.findCompletedTurn({
          taskId: input.taskId,
          threadId: input.threadId,
          sequence: input.request.turn_sequence,
        });
    const scoped = turn === null ? [] : filterScopedTurns([turn], input);
    const hydrated = await hydrateTurns(scoped, input.store, cache, cacheObserver, null);
    return withTelemetry({
      scope: { task_id: input.taskId, thread_id: input.threadId },
      action: "read",
      query: null,
      results: projectEntries(hydrated.entries, input.request.max_chars, null),
      scanned_turns: scoped.length,
      next_before_sequence: null,
      warnings: hydrationWarningsForEntries(hydrated.warnings, hydrated.entries),
    }, cacheObserver.snapshot(), {
      retrievalMethod: "direct",
      hydratedTurns: scoped.length,
      backfilledTurns: 0,
      indexSourceFailures: 0,
      indexFallbackReason: null,
    });
  }

  const indexed = await tryIndexedSearch(input, beforeSequence, cacheObserver);
  if (
    input.request.action === "search"
    && indexed.page !== null
    && indexed.page.sourceFailures === 0
  ) {
    const hydrated = await hydrateTurns(
      indexed.page.turns,
      input.store,
      cache,
      cacheObserver,
      input.request.query,
    );
    const matches = hydrated.entries
      .filter((entry) => entry.user_text.length > 0 || entry.assistant_text.length > 0)
      .filter((entry) => (entry.match_score ?? 0) > 0)
      .sort((left, right) => (right.match_score ?? 0) - (left.match_score ?? 0)
        || right.turn_sequence - left.turn_sequence)
      .slice(0, input.request.limit);
    return withTelemetry({
      scope: { task_id: input.taskId, thread_id: input.threadId },
      action: "search",
      query: input.request.query,
      results: projectEntries(matches, input.request.max_chars, input.request.query),
      scanned_turns: indexed.page.scannedTurns,
      next_before_sequence: indexed.page.nextBeforeSequence,
      warnings: hydrationWarningsForEntries(hydrated.warnings, matches),
    }, cacheObserver.snapshot(), {
      retrievalMethod: "fts5",
      hydratedTurns: indexed.page.turns.length,
      backfilledTurns: indexed.page.backfilledTurns,
      indexSourceFailures: indexed.page.sourceFailures,
      indexFallbackReason: null,
    });
  }

  const fetchLimit = input.request.action === "search"
    ? input.request.scan_limit + 1
    : input.request.limit + 1;
  const listed = await input.store.listCompletedTurns({
    taskId: input.taskId,
    threadId: input.threadId,
    beforeSequence,
    limit: fetchLimit,
  });
  const scoped = filterScopedTurns(listed, input).slice(0, fetchLimit);

  if (input.request.action === "browse") {
    const selected = scoped.slice(0, input.request.limit);
    const hydrated = await hydrateTurns(selected, input.store, cache, cacheObserver, null);
    const hasMore = scoped.length > selected.length;
    return withTelemetry({
      scope: { task_id: input.taskId, thread_id: input.threadId },
      action: "browse",
      query: null,
      results: projectEntries(hydrated.entries, input.request.max_chars, null),
      scanned_turns: selected.length,
      next_before_sequence: hasMore ? selected.at(-1)?.sequence ?? null : null,
      warnings: hydrationWarningsForEntries(hydrated.warnings, hydrated.entries),
    }, cacheObserver.snapshot(), {
      retrievalMethod: "direct",
      hydratedTurns: selected.length,
      backfilledTurns: 0,
      indexSourceFailures: 0,
      indexFallbackReason: null,
    });
  }

  const searchCandidates = scoped.slice(0, input.request.scan_limit);
  const searchable = await hydrateTurns(
    searchCandidates,
    input.store,
    cache,
    cacheObserver,
    input.request.query,
  );
  const matches = searchable.entries
    .filter((entry) => (entry.match_score ?? 0) > 0)
    .sort((left, right) => (right.match_score ?? 0) - (left.match_score ?? 0)
      || right.turn_sequence - left.turn_sequence)
    .slice(0, input.request.limit);
  const projected = projectEntries(matches, input.request.max_chars, input.request.query);
  const oldestScanned = searchCandidates.at(-1)?.sequence ?? null;
  return withTelemetry({
    scope: { task_id: input.taskId, thread_id: input.threadId },
    action: "search",
    query: input.request.query,
    results: projected,
    scanned_turns: searchCandidates.length,
    next_before_sequence: scoped.length > searchCandidates.length ? oldestScanned : null,
    warnings: hydrationWarningsForEntries(searchable.warnings, matches),
  }, cacheObserver.snapshot(), {
    retrievalMethod: "bounded_scan",
    hydratedTurns: searchCandidates.length,
    backfilledTurns: 0,
    indexSourceFailures: indexed.page?.sourceFailures ?? 0,
    indexFallbackReason: indexed.page !== null && indexed.page.sourceFailures > 0
      ? "incomplete"
      : indexed.fallbackReason,
  });
}

async function tryIndexedSearch(
  input: {
    readonly taskId: string;
    readonly threadId: string;
    readonly currentTurnSequence: number;
    readonly request: StandaloneSessionRecallInput;
    readonly store: SessionRecallStore;
  },
  beforeSequence: number,
  cacheObserver: SessionRecallCacheObserver,
): Promise<{
  readonly page: SessionRecallSearchPage | null;
  readonly fallbackReason: SessionRecallTelemetry["index_fallback_reason"];
}> {
  if (input.request.action !== "search" || input.store.searchCompletedTurns === undefined) {
    return { page: null, fallbackReason: null };
  }
  try {
    const page = await input.store.searchCompletedTurns({
      taskId: input.taskId,
      threadId: input.threadId,
      beforeSequence,
      scanLimit: input.request.scan_limit,
      query: input.request.query,
      cacheObserver,
    });
    return page === null
      ? { page: null, fallbackReason: "unavailable" }
      : { page, fallbackReason: null };
  } catch {
    return { page: null, fallbackReason: "failed" };
  }
}

function withTelemetry(
  result: Omit<SessionRecallResult, "telemetry">,
  cache: SessionRecallCacheSnapshot,
  input: {
    readonly retrievalMethod: SessionRecallTelemetry["retrieval_method"];
    readonly hydratedTurns: number;
    readonly backfilledTurns: number;
    readonly indexSourceFailures: number;
    readonly indexFallbackReason: SessionRecallTelemetry["index_fallback_reason"];
  },
): SessionRecallResult {
  return {
    ...result,
    telemetry: {
      retrieval_method: input.retrievalMethod,
      hydrated_turns: input.hydratedTurns,
      index_backfilled_turns: input.backfilledTurns,
      cache_hits: cache.hits,
      cache_misses: cache.misses,
      cache_evictions: cache.evictions,
      cache_bytes_avoided: cache.bytesAvoided,
      source_bytes_loaded: cache.sourceBytesLoaded,
      load_failures: cache.loadFailures,
      selected_turns: result.results.length,
      selected_turn_yield: input.hydratedTurns === 0 ? 0 : result.results.length / input.hydratedTurns,
      index_source_failures: input.indexSourceFailures,
      index_fallback_reason: input.indexFallbackReason,
    },
  };
}

function filterScopedTurns(
  turns: readonly SessionRecallTurn[],
  scope: { readonly taskId: string; readonly threadId: string; readonly currentTurnSequence: number },
): readonly SessionRecallTurn[] {
  return turns
    .filter((turn) => turn.taskId === scope.taskId
      && turn.threadId === scope.threadId
      && turn.sequence > 0
      && turn.sequence < scope.currentTurnSequence)
    .sort((left, right) => right.sequence - left.sequence);
}

async function hydrateTurns(
  turns: readonly SessionRecallTurn[],
  store: SessionRecallStore,
  cache: SessionRecallTextCache,
  cacheObserver: SessionRecallCacheObserver,
  query: string | null,
): Promise<{
  readonly entries: readonly SessionRecallEntry[];
  readonly warnings: readonly SessionRecallHydrationWarning[];
}> {
  const warnings: SessionRecallHydrationWarning[] = [];
  const hydrated = await mapWithConcurrency(turns, 4, async (turn): Promise<SessionRecallEntry> => {
    const user = await readSource(
      turn.userArtifactUri,
      store,
      cache,
      cacheObserver,
      warnings,
      turn.sequence,
      "user",
    );
    const assistant = turn.assistantArtifactUri === null
      ? { text: turn.assistantSummary, sourceTruncated: false, unavailable: false }
      : await readSource(
          turn.assistantArtifactUri,
          store,
          cache,
          cacheObserver,
          warnings,
          turn.sequence,
          "assistant",
        );
    const assistantText = assistant.text.length > 0 ? assistant.text : turn.assistantSummary;
    return {
      turn_sequence: turn.sequence,
      completed_at: turn.completedAt,
      user_text: user.text,
      assistant_text: assistantText,
      user_source_uri: turn.userArtifactUri,
      assistant_source_uri: turn.assistantArtifactUri,
      user_truncated: user.sourceTruncated,
      assistant_truncated: assistant.sourceTruncated,
      user_excerpt_start_char: 0,
      user_excerpt_end_char: Array.from(user.text).length,
      assistant_excerpt_start_char: 0,
      assistant_excerpt_end_char: Array.from(assistantText).length,
      match_score: query === null ? null : sessionRecallLexicalScore(`${user.text}\n${assistantText}`, query),
    };
  });
  return {
    entries: hydrated,
    warnings: [...warnings].sort(
      (left, right) => left.turnSequence - right.turnSequence
        || left.message.localeCompare(right.message),
    ),
  };
}

async function readSource(
  uri: string | null,
  store: SessionRecallStore,
  cache: SessionRecallTextCache,
  cacheObserver: SessionRecallCacheObserver,
  warnings: SessionRecallHydrationWarning[],
  sequence: number,
  role: "user" | "assistant",
): Promise<CachedText & { readonly unavailable: boolean }> {
  if (uri === null) return { text: "", sourceTruncated: false, unavailable: false };
  try {
    const value = await cache.read(uri, store.readArtifactText, cacheObserver);
    return { ...value, unavailable: false };
  } catch {
    warnings.push({
      turnSequence: sequence,
      message: `turn ${sequence} ${role} artifact is unavailable`,
    });
    return { text: "", sourceTruncated: false, unavailable: true };
  }
}

function hydrationWarningsForEntries(
  warnings: readonly SessionRecallHydrationWarning[],
  entries: readonly SessionRecallEntry[],
): readonly string[] {
  const selected = new Set(entries.map((entry) => entry.turn_sequence));
  return [...new Set(
    warnings
      .filter((warning) => selected.has(warning.turnSequence))
      .map((warning) => warning.message),
  )].sort();
}

function projectEntries(
  entries: readonly SessionRecallEntry[],
  totalMaxChars: number,
  query: string | null,
): readonly SessionRecallEntry[] {
  if (entries.length === 0) return [];
  const perEntry = Math.max(1, Math.floor(totalMaxChars / entries.length));
  const perRole = Math.max(1, Math.floor(perEntry / 2));
  return entries.map((entry) => {
    const user = excerpt(entry.user_text, perRole, query);
    const assistant = excerpt(entry.assistant_text, perEntry - Array.from(user.text).length, query);
    return {
      ...entry,
      user_text: user.text,
      assistant_text: assistant.text,
      user_truncated: entry.user_truncated || user.truncated,
      assistant_truncated: entry.assistant_truncated || assistant.truncated,
      user_excerpt_start_char: user.startChar,
      user_excerpt_end_char: user.endChar,
      assistant_excerpt_start_char: assistant.startChar,
      assistant_excerpt_end_char: assistant.endChar,
    };
  });
}

function excerpt(
  text: string,
  maxChars: number,
  query: string | null = null,
): {
  readonly text: string;
  readonly truncated: boolean;
  readonly startChar: number;
  readonly endChar: number;
} {
  const characters = Array.from(text);
  if (characters.length <= maxChars) {
    return { text, truncated: false, startChar: 0, endChar: characters.length };
  }
  const matchStart = query === null ? null : sessionRecallMatchStart(text, query);
  const desiredStart = matchStart === null ? 0 : matchStart - Math.floor(maxChars / 3);
  const startChar = Math.max(0, Math.min(desiredStart, characters.length - maxChars));
  if (maxChars === 1) return { text: "…", truncated: true, startChar, endChar: startChar };
  const prefix = startChar > 0 ? "…" : "";
  const contentBudget = Math.max(0, maxChars - prefix.length - 1);
  let endChar = Math.min(characters.length, startChar + contentBudget);
  const suffix = endChar < characters.length ? "…" : "";
  if (suffix.length === 0) {
    endChar = Math.min(characters.length, startChar + maxChars - prefix.length);
  }
  return {
    text: `${prefix}${characters.slice(startChar, endChar).join("")}${suffix}`,
    truncated: true,
    startChar,
    endChar,
  };
}

async function mapWithConcurrency<T, U>(
  values: readonly T[],
  concurrency: number,
  project: (value: T) => Promise<U>,
): Promise<readonly U[]> {
  const results: U[] = new Array(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      results[index] = await project(values[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

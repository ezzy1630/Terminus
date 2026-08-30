import type { StandaloneRecallInput } from "../agent-tools.js";

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
  readArtifactText(uri: string): Promise<string>;
}

export interface SessionRecallResult {
  readonly scope: {
    readonly task_id: string;
    readonly thread_id: string;
  };
  readonly action: StandaloneRecallInput["action"];
  readonly query: string | null;
  readonly results: readonly SessionRecallEntry[];
  readonly scanned_turns: number;
  readonly next_before_sequence: number | null;
  readonly warnings: readonly string[];
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
  readonly match_score: number | null;
}

interface CachedText {
  readonly text: string;
  readonly sourceTruncated: boolean;
}

/**
 * Small LRU for immutable content-addressed turn artifacts. Values are capped
 * before caching, so repeated recall avoids kernel reads without creating an
 * unbounded process cache.
 */
export class SessionRecallTextCache {
  private readonly entries = new Map<string, CachedText>();

  constructor(
    private readonly maxEntries = SESSION_RECALL_CACHE_MAX_ENTRIES,
    private readonly maxCharsPerEntry = SESSION_RECALL_SOURCE_MAX_CHARS,
  ) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new Error("session recall cache requires at least one entry");
    if (!Number.isInteger(maxCharsPerEntry) || maxCharsPerEntry < 1) throw new Error("session recall cache requires a positive character bound");
  }

  async read(uri: string, loader: (uri: string) => Promise<string>): Promise<CachedText> {
    const cached = this.entries.get(uri);
    if (cached !== undefined) {
      this.entries.delete(uri);
      this.entries.set(uri, cached);
      return cached;
    }
    const source = await loader(uri);
    const projected = excerpt(source, this.maxCharsPerEntry);
    const value = { text: projected.text, sourceTruncated: projected.truncated };
    this.entries.set(uri, value);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return value;
  }

  get size(): number {
    return this.entries.size;
  }
}

export const sessionRecallTextCache = new SessionRecallTextCache();

export async function runSessionRecall(input: {
  readonly taskId: string;
  readonly threadId: string;
  readonly currentTurnSequence: number;
  readonly request: StandaloneRecallInput;
  readonly store: SessionRecallStore;
  readonly cache?: SessionRecallTextCache | undefined;
}): Promise<SessionRecallResult> {
  const cache = input.cache ?? sessionRecallTextCache;
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
    const hydrated = await hydrateTurns(scoped, input.store, cache, input.request.max_chars, null);
    return {
      scope: { task_id: input.taskId, thread_id: input.threadId },
      action: "read",
      query: null,
      results: hydrated.entries,
      scanned_turns: scoped.length,
      next_before_sequence: null,
      warnings: hydrated.warnings,
    };
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
    const hydrated = await hydrateTurns(selected, input.store, cache, input.request.max_chars, null);
    const hasMore = scoped.length > selected.length;
    return {
      scope: { task_id: input.taskId, thread_id: input.threadId },
      action: "browse",
      query: null,
      results: hydrated.entries,
      scanned_turns: selected.length,
      next_before_sequence: hasMore ? selected.at(-1)?.sequence ?? null : null,
      warnings: hydrated.warnings,
    };
  }

  const searchCandidates = scoped.slice(0, input.request.scan_limit);
  const searchable = await hydrateTurns(
    searchCandidates,
    input.store,
    cache,
    SESSION_RECALL_SOURCE_MAX_CHARS * Math.max(1, searchCandidates.length),
    input.request.query,
  );
  const matches = searchable.entries
    .filter((entry) => (entry.match_score ?? 0) > 0)
    .sort((left, right) => (right.match_score ?? 0) - (left.match_score ?? 0)
      || right.turn_sequence - left.turn_sequence)
    .slice(0, input.request.limit);
  const projected = projectEntries(matches, input.request.max_chars);
  const oldestScanned = searchCandidates.at(-1)?.sequence ?? null;
  return {
    scope: { task_id: input.taskId, thread_id: input.threadId },
    action: "search",
    query: input.request.query,
    results: projected,
    scanned_turns: searchCandidates.length,
    next_before_sequence: scoped.length > searchCandidates.length ? oldestScanned : null,
    warnings: searchable.warnings,
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
  totalMaxChars: number,
  query: string | null,
): Promise<{ readonly entries: readonly SessionRecallEntry[]; readonly warnings: readonly string[] }> {
  const warnings: string[] = [];
  const hydrated = await mapWithConcurrency(turns, 4, async (turn): Promise<SessionRecallEntry> => {
    const user = await readSource(turn.userArtifactUri, store, cache, warnings, turn.sequence, "user");
    const assistant = turn.assistantArtifactUri === null
      ? { text: turn.assistantSummary, sourceTruncated: false, unavailable: false }
      : await readSource(turn.assistantArtifactUri, store, cache, warnings, turn.sequence, "assistant");
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
      match_score: query === null ? null : lexicalScore(`${user.text}\n${assistantText}`, query),
    };
  });
  return { entries: projectEntries(hydrated, totalMaxChars), warnings: [...warnings].sort() };
}

async function readSource(
  uri: string | null,
  store: SessionRecallStore,
  cache: SessionRecallTextCache,
  warnings: string[],
  sequence: number,
  role: "user" | "assistant",
): Promise<CachedText & { readonly unavailable: boolean }> {
  if (uri === null) return { text: "", sourceTruncated: false, unavailable: false };
  try {
    const value = await cache.read(uri, store.readArtifactText);
    return { ...value, unavailable: false };
  } catch {
    warnings.push(`turn ${sequence} ${role} artifact is unavailable`);
    return { text: "", sourceTruncated: false, unavailable: true };
  }
}

function projectEntries(entries: readonly SessionRecallEntry[], totalMaxChars: number): readonly SessionRecallEntry[] {
  if (entries.length === 0) return [];
  const perEntry = Math.max(1, Math.floor(totalMaxChars / entries.length));
  const perRole = Math.max(1, Math.floor(perEntry / 2));
  return entries.map((entry) => {
    const user = excerpt(entry.user_text, perRole);
    const assistant = excerpt(entry.assistant_text, perEntry - user.text.length);
    return {
      ...entry,
      user_text: user.text,
      assistant_text: assistant.text,
      user_truncated: entry.user_truncated || user.truncated,
      assistant_truncated: entry.assistant_truncated || assistant.truncated,
    };
  });
}

function excerpt(text: string, maxChars: number): { readonly text: string; readonly truncated: boolean } {
  const characters = Array.from(text);
  if (characters.length <= maxChars) return { text, truncated: false };
  if (maxChars === 1) return { text: "…", truncated: true };
  return { text: `${characters.slice(0, maxChars - 1).join("")}…`, truncated: true };
}

function lexicalScore(text: string, query: string): number {
  const haystack = text.toLocaleLowerCase();
  const phrase = query.trim().toLocaleLowerCase();
  const terms = [...new Set(phrase.match(/[\p{L}\p{N}_-]+/gu) ?? [])];
  if (terms.length === 0) return 0;
  let score = haystack.includes(phrase) ? 100 : 0;
  for (const term of terms) {
    let offset = 0;
    let occurrences = 0;
    while (occurrences < 20) {
      const match = haystack.indexOf(term, offset);
      if (match < 0) break;
      occurrences += 1;
      offset = match + Math.max(1, term.length);
    }
    score += occurrences;
  }
  return score;
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

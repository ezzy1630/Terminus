import { describe, expect, test } from "bun:test";
import {
  SessionRecallCacheObserver,
  SessionRecallTextCache,
  runSessionRecall,
  type SessionRecallStore,
  type SessionRecallTurn,
} from "./session-recall.js";
import {
  sessionRecallLexicalScore,
  sessionRecallMatchStart,
} from "./session-recall-query.js";

function fixtureStore(turns: readonly SessionRecallTurn[], artifacts: Readonly<Record<string, string>>): SessionRecallStore {
  return {
    listCompletedTurns: async ({ taskId, threadId, beforeSequence, limit }) => turns
      .filter((turn) => turn.taskId === taskId && turn.threadId === threadId && turn.sequence < beforeSequence)
      .sort((left, right) => right.sequence - left.sequence)
      .slice(0, limit),
    findCompletedTurn: async ({ taskId, threadId, sequence }) => turns.find((turn) =>
      turn.taskId === taskId && turn.threadId === threadId && turn.sequence === sequence) ?? null,
    readArtifactText: async (uri) => {
      const value = artifacts[uri];
      if (value === undefined) throw new Error("missing fixture artifact");
      return value;
    },
  };
}

const TURNS: readonly SessionRecallTurn[] = [
  {
    id: "turn-3", taskId: "task-1", threadId: "thread-1", sequence: 3,
    completedAt: "2026-08-30T03:00:00.000Z", userArtifactUri: "artifact://user-3",
    assistantArtifactUri: "artifact://assistant-3", assistantSummary: "implemented adaptive profile",
  },
  {
    id: "turn-2", taskId: "task-1", threadId: "thread-1", sequence: 2,
    completedAt: "2026-08-30T02:00:00.000Z", userArtifactUri: "artifact://user-2",
    assistantArtifactUri: "artifact://assistant-2", assistantSummary: "fixed cache identity",
  },
  {
    id: "turn-other", taskId: "task-other", threadId: "thread-1", sequence: 1,
    completedAt: null, userArtifactUri: "artifact://other", assistantArtifactUri: null, assistantSummary: "secret other task",
  },
];

const ARTIFACTS = {
  "artifact://user-3": "Make adaptive mode useful without durable semantic memory.",
  "artifact://assistant-3": "Added exact session recall to the adaptive profile.",
  "artifact://user-2": "The profile hash cache is stale.",
  "artifact://assistant-2": "Keyed the cache by immutable profile identity.",
  "artifact://other": "must never cross the task boundary",
} as const;

describe("adaptive session recall", () => {
  test("browses only earlier completed turns in the current task and exposes continuation", async () => {
    const result = await runSessionRecall({
      taskId: "task-1",
      threadId: "thread-1",
      currentTurnSequence: 4,
      request: { action: "browse", limit: 1, max_chars: 512 },
      store: fixtureStore(TURNS, ARTIFACTS),
      cache: new SessionRecallTextCache(),
    });
    expect(result.results.map((entry) => entry.turn_sequence)).toEqual([3]);
    expect(result.results[0]?.assistant_source_uri).toBe("artifact://assistant-3");
    expect(result.next_before_sequence).toBe(3);
    expect(JSON.stringify(result)).not.toContain("secret other task");
  });

  test("searches bounded source text and ranks phrase matches deterministically", async () => {
    const result = await runSessionRecall({
      taskId: "task-1",
      threadId: "thread-1",
      currentTurnSequence: 4,
      request: { action: "search", query: "profile hash", limit: 2, scan_limit: 30, max_chars: 1_000 },
      store: fixtureStore(TURNS, ARTIFACTS),
      cache: new SessionRecallTextCache(),
    });
    expect(result.results.map((entry) => entry.turn_sequence)).toEqual([2, 3]);
    expect(result.results[0]?.match_score).toBeGreaterThan(result.results[1]?.match_score ?? 0);
    expect(result.scanned_turns).toBe(2);
    expect(result.next_before_sequence).toBeNull();
    expect(result.telemetry.retrieval_method).toBe("bounded_scan");
    expect(result.telemetry.hydrated_turns).toBe(2);
  });

  test("uses a scoped index page and hydrates only selected exact sources", async () => {
    const base = fixtureStore(TURNS, ARTIFACTS);
    let listed = 0;
    const store: SessionRecallStore = {
      ...base,
      listCompletedTurns: async (input) => {
        listed += 1;
        return base.listCompletedTurns(input);
      },
      searchCompletedTurns: async () => ({
        turns: [TURNS[1]!],
        scannedTurns: 2,
        nextBeforeSequence: null,
        backfilledTurns: 1,
        sourceFailures: 0,
      }),
    };
    const result = await runSessionRecall({
      taskId: "task-1",
      threadId: "thread-1",
      currentTurnSequence: 4,
      request: { action: "search", query: "profile hash", limit: 1, scan_limit: 30, max_chars: 1_000 },
      store,
      cache: new SessionRecallTextCache(),
    });
    expect(result.results.map((entry) => entry.turn_sequence)).toEqual([2]);
    expect(result.telemetry).toEqual(expect.objectContaining({
      retrieval_method: "fts5",
      hydrated_turns: 1,
      index_backfilled_turns: 1,
      cache_misses: 2,
    }));
    expect(listed).toBe(0);
  });

  test("fails safely to the bounded scan when the index is unavailable", async () => {
    const base = fixtureStore(TURNS, ARTIFACTS);
    const store: SessionRecallStore = {
      ...base,
      searchCompletedTurns: async () => {
        throw new Error("fts unavailable");
      },
    };
    const result = await runSessionRecall({
      taskId: "task-1",
      threadId: "thread-1",
      currentTurnSequence: 4,
      request: { action: "search", query: "profile hash", limit: 2, scan_limit: 30, max_chars: 1_000 },
      store,
      cache: new SessionRecallTextCache(),
    });
    expect(result.results.map((entry) => entry.turn_sequence)).toEqual([2, 3]);
    expect(result.telemetry.retrieval_method).toBe("bounded_scan");
    expect(result.telemetry.index_fallback_reason).toBe("failed");
    expect(result.warnings).toEqual([]);
  });

  test("uses exact fallback without partial status when the index backfill is incomplete", async () => {
    const base = fixtureStore(TURNS, ARTIFACTS);
    const result = await runSessionRecall({
      taskId: "task-1",
      threadId: "thread-1",
      currentTurnSequence: 4,
      request: { action: "search", query: "profile hash", limit: 1, scan_limit: 30, max_chars: 1_000 },
      store: {
        ...base,
        searchCompletedTurns: async () => ({
          turns: [TURNS[1]!],
          scannedTurns: 2,
          nextBeforeSequence: null,
          backfilledTurns: 1,
          sourceFailures: 1,
        }),
      },
      cache: new SessionRecallTextCache(),
    });
    expect(result.results.map((entry) => entry.turn_sequence)).toEqual([2]);
    expect(result.telemetry.retrieval_method).toBe("bounded_scan");
    expect(result.telemetry.index_fallback_reason).toBe("incomplete");
    expect(result.telemetry.index_source_failures).toBe(1);
    expect(result.warnings).toEqual([]);
  });

  test("keeps valid indexed hits and replaces an unavailable top hit", async () => {
    const unavailable: SessionRecallTurn = {
      id: "turn-unavailable",
      taskId: "task-1",
      threadId: "thread-1",
      sequence: 3,
      completedAt: null,
      userArtifactUri: "artifact://missing-user",
      assistantArtifactUri: "artifact://missing-assistant",
      assistantSummary: "",
    };
    const diacritic: SessionRecallTurn = {
      ...TURNS[1]!,
      userArtifactUri: "artifact://diacritic",
      assistantArtifactUri: null,
      assistantSummary: "",
    };
    const base = fixtureStore([unavailable, diacritic], {
      "artifact://diacritic": "The café cache uses foo bar identity.",
    });
    const result = await runSessionRecall({
      taskId: "task-1",
      threadId: "thread-1",
      currentTurnSequence: 4,
      request: { action: "search", query: "cafe foo_bar", limit: 1, scan_limit: 30, max_chars: 512 },
      store: {
        ...base,
        searchCompletedTurns: async () => ({
          turns: [unavailable, diacritic],
          scannedTurns: 2,
          nextBeforeSequence: null,
          backfilledTurns: 0,
          sourceFailures: 0,
        }),
      },
      cache: new SessionRecallTextCache(),
    });
    expect(result.results.map((entry) => entry.turn_sequence)).toEqual([2]);
    expect(result.results[0]?.match_score).toBeGreaterThan(0);
    expect(result.warnings).toEqual([]);
    expect(result.telemetry.load_failures).toBe(2);
  });

  test("does not promote an indexed hit whose exact source is unavailable and summary does not match", async () => {
    const unavailable: SessionRecallTurn = {
      ...TURNS[1]!,
      sequence: 3,
      userArtifactUri: "artifact://missing-user",
      assistantArtifactUri: null,
      assistantSummary: "unrelated summary",
    };
    const result = await runSessionRecall({
      taskId: "task-1",
      threadId: "thread-1",
      currentTurnSequence: 4,
      request: { action: "search", query: "profile hash", limit: 1, scan_limit: 30, max_chars: 512 },
      store: {
        ...fixtureStore([unavailable], {}),
        searchCompletedTurns: async () => ({
          turns: [unavailable],
          scannedTurns: 1,
          nextBeforeSequence: null,
          backfilledTurns: 0,
          sourceFailures: 0,
        }),
      },
      cache: new SessionRecallTextCache(),
    });
    expect(result.results).toEqual([]);
  });

  test("preserves Indic marks while matching a Greek final sigma at the tail", () => {
    expect(sessionRecallLexicalScore("किताब", "किताब")).toBeGreaterThan(0);
    expect(sessionRecallLexicalScore("कितब", "किताब")).toBe(0);

    const greek = `${"x".repeat(20)} ΟΣ`;
    expect(sessionRecallLexicalScore(greek, "ος")).toBeGreaterThan(0);
    expect(sessionRecallMatchStart(greek, "ος")).toBe(21);
    expect(sessionRecallMatchStart(`${"x".repeat(64_000)} ΟΣ`, "ος")).toBe(64_001);
    expect(sessionRecallLexicalScore("profile", "file")).toBe(0);
    expect(sessionRecallMatchStart("profile", "file")).toBeNull();
    for (const [source, query] of [
      ["ſcope", "scope"],
      ["ϑ", "θ"],
      ["ϕ", "φ"],
      ["ϖ", "π"],
      ["ϰ", "κ"],
      ["ϱ", "ρ"],
      ["µ", "μ"],
    ] as const) {
      expect(sessionRecallLexicalScore(source, query)).toBeGreaterThan(0);
      expect(sessionRecallMatchStart(source, query)).toBe(0);
    }
    expect(sessionRecallLexicalScore("ı", "i")).toBe(0);
    expect(sessionRecallLexicalScore("ß", "ss")).toBe(0);
  });

  test("bounds multi-term prefix scoring over a maximum-size candidate", () => {
    const query = Array.from({ length: 52 }, (_, index) => `z${index}`).join(" ");
    const source = "a ".repeat(65_536);
    expect(query.length).toBeLessThanOrEqual(256);
    expect(sessionRecallLexicalScore(source, query)).toBe(0);
    expect(sessionRecallMatchStart(source, query)).toBeNull();
  });

  test("drops a complete FTS candidate when exact token-prefix scoring disproves it", async () => {
    const falsePositive: SessionRecallTurn = {
      ...TURNS[1]!,
      userArtifactUri: "artifact://indic-contrast",
      assistantArtifactUri: null,
      assistantSummary: "",
    };
    const result = await runSessionRecall({
      taskId: "task-1",
      threadId: "thread-1",
      currentTurnSequence: 4,
      request: { action: "search", query: "दिन", limit: 1, scan_limit: 30, max_chars: 512 },
      store: {
        ...fixtureStore([falsePositive], { "artifact://indic-contrast": "दान" }),
        searchCompletedTurns: async () => ({
          turns: [falsePositive],
          scannedTurns: 1,
          nextBeforeSequence: null,
          backfilledTurns: 0,
          sourceFailures: 0,
        }),
      },
      cache: new SessionRecallTextCache(),
    });
    expect(result.results).toEqual([]);
  });

  test("centers a bounded search excerpt on a tail match", async () => {
    const tailTurn: SessionRecallTurn = {
      ...TURNS[1]!,
      userArtifactUri: "artifact://tail",
      assistantArtifactUri: null,
      assistantSummary: "",
    };
    const result = await runSessionRecall({
      taskId: "task-1",
      threadId: "thread-1",
      currentTurnSequence: 4,
      request: { action: "search", query: "needle", limit: 1, scan_limit: 30, max_chars: 512 },
      store: fixtureStore([tailTurn], { "artifact://tail": `${"x".repeat(4_000)} needle exact context` }),
      cache: new SessionRecallTextCache(),
    });
    expect(result.results[0]?.user_text).toContain("needle");
    expect(result.results[0]?.user_excerpt_start_char).toBeGreaterThan(0);
    expect(result.results[0]?.user_truncated).toBe(true);
  });

  test("refuses the current turn and defense-in-depth filters a forged cross-task row", async () => {
    const store = fixtureStore(TURNS, ARTIFACTS);
    const current = await runSessionRecall({
      taskId: "task-1", threadId: "thread-1", currentTurnSequence: 3,
      request: { action: "read", turn_sequence: 3, max_chars: 512 }, store,
    });
    expect(current.results).toEqual([]);

    const forged: SessionRecallStore = {
      ...store,
      findCompletedTurn: async () => TURNS[2] ?? null,
    };
    const crossTask = await runSessionRecall({
      taskId: "task-1", threadId: "thread-1", currentTurnSequence: 4,
      request: { action: "read", turn_sequence: 1, max_chars: 512 }, store: forged,
    });
    expect(crossTask.results).toEqual([]);
  });

  test("caches immutable artifact text with bounded LRU eviction", async () => {
    const cache = new SessionRecallTextCache(1, 4);
    let reads = 0;
    const loader = async (uri: string): Promise<string> => {
      reads += 1;
      return `${uri}-value`;
    };
    expect(await cache.read("a", loader)).toEqual({ text: "a-v…", sourceTruncated: true });
    expect(await cache.read("a", loader)).toEqual({ text: "a-v…", sourceTruncated: true });
    await cache.read("b", loader);
    await cache.read("a", loader);
    expect(reads).toBe(3);
    expect(cache.size).toBe(1);
    expect(cache.snapshot()).toEqual({
      hits: 1,
      misses: 3,
      evictions: 2,
      bytesAvoided: 7,
      sourceBytesLoaded: 21,
      loadFailures: 0,
    });
  });

  test("records a cache miss and load failure before a source loader rejects", async () => {
    const cache = new SessionRecallTextCache();
    const observer = new SessionRecallCacheObserver();
    await expect(cache.read("missing", async () => {
      throw new Error("missing fixture artifact");
    }, observer)).rejects.toThrow("missing fixture artifact");
    expect(observer.snapshot()).toEqual({
      hits: 0,
      misses: 1,
      evictions: 0,
      bytesAvoided: 0,
      sourceBytesLoaded: 0,
      loadFailures: 1,
    });
  });

  test("isolates cache telemetry per concurrent recall operation", async () => {
    const cache = new SessionRecallTextCache();
    const first = new SessionRecallCacheObserver();
    const second = new SessionRecallCacheObserver();
    const loader = async (): Promise<string> => "immutable";
    await cache.read("artifact://same", loader, first);
    await cache.read("artifact://same", loader, second);
    expect(first.snapshot()).toEqual({
      hits: 0,
      misses: 1,
      evictions: 0,
      bytesAvoided: 0,
      sourceBytesLoaded: 9,
      loadFailures: 0,
    });
    expect(second.snapshot()).toEqual({
      hits: 1,
      misses: 0,
      evictions: 0,
      bytesAvoided: 9,
      sourceBytesLoaded: 0,
      loadFailures: 0,
    });
  });
});

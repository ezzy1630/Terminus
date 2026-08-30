import { describe, expect, test } from "bun:test";
import {
  SessionRecallTextCache,
  runSessionRecall,
  type SessionRecallStore,
  type SessionRecallTurn,
} from "./session-recall.js";

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
  });
});

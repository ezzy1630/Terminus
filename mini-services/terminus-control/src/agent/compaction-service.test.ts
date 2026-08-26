import { describe, expect, test } from "bun:test";
import {
  BYTES_PER_TOKEN_ESTIMATE,
  DEFAULT_COMPACT_THRESHOLD_TOKENS,
  MAX_COMPACTION_TRANSCRIPT_CHARS,
  planDeterministicPrune,
  runCompaction,
  SUMMARY_SYSTEM_INSTRUCTIONS,
  type EpisodeLike,
} from "./compaction-service.js";

function episode(id: string, sequence: number, kind: string, contentJson: string | null, toolCallId: string | null = null): EpisodeLike {
  return {
    id,
    kind,
    sequence,
    toolCallId,
    contentJson,
    contentArtifact: contentJson === null
      ? null
      : `artifact://sha256/${id.replace(/[^a-f0-9]/gi, "").toLowerCase().padEnd(64, "0").slice(0, 64)}`,
  };
}

describe("R4 deterministic prune planning", () => {
  test("keeps the most recent bytes and prunes only older content rows", () => {
    const big = "x".repeat(600);
    const episodes = [
      episode("e1", 1, "tool_call", JSON.stringify({ call: big }), "t1"),
      episode("e2", 2, "tool_result", JSON.stringify({ out: big }), "t1"),
      episode("e3", 3, "tool_call", JSON.stringify({ call: "small" }), "t2"),
      episode("e4", 4, "tool_result", JSON.stringify({ out: "small" }), "t2"),
    ];
    const plan = planDeterministicPrune(episodes, 100);
    // The old oversized pair is pruned together; recent small rows stay.
    expect(plan.keep.has("e1")).toBe(false);
    expect(plan.keep.has("e2")).toBe(false);
    expect(plan.prune.has("e1")).toBe(true);
    expect(plan.prune.has("e2")).toBe(true);
    expect(plan.keep.has("e3")).toBe(true);
    expect(plan.keep.has("e4")).toBe(true);
    expect(plan.prunedBytes).toBeGreaterThan(0);
  });

  test("an oversized pair is pruned together, never split", () => {
    const call = episode("c1", 1, "tool_call", JSON.stringify({ a: 1 }), "pair-1");
    const result = episode("r1", 2, "tool_result", "y".repeat(5_000), "pair-1");
    const recent = episode("c2", 3, "tool_call", "tiny", "pair-2");
    const plan = planDeterministicPrune([call, result, recent], 10);
    // r1 exceeds the budget and c1 does not fit alongside it — the pair is
    // pruned as a unit rather than keeping an orphaned half.
    expect(plan.keep.has("r1")).toBe(plan.keep.has("c1"));
    expect(plan.keep.has("c2")).toBe(true);
    if (plan.keep.has("r1")) {
      expect(plan.prune.has("r1")).toBe(false);
      expect(plan.prune.has("c1")).toBe(false);
    } else {
      expect(plan.prune.has("r1")).toBe(true);
      expect(plan.prune.has("c1")).toBe(true);
    }
  });

  test("reference-only rows are never pruned; old oversized content is", () => {
    const big = episode("big-1", 1, "tool_result", "z".repeat(4_000), "p");
    const ref = episode("ref-1", 2, "user_message", null);
    const plan = planDeterministicPrune([big, ref], 10);
    expect(plan.keep.has("ref-1")).toBe(true);
    expect(plan.prune.has("ref-1")).toBe(false);
    expect(plan.prune.has("big-1")).toBe(true);
  });
});

describe("R4 compaction service", () => {
  function fakeStore() {
    const hidden: string[] = [];
    const appended: { turnId: string; sequence: number; summaryText: string }[] = [];
    let latestSequence = 10;
    return {
      store: {
        hideEpisodes: async (ids: readonly string[]) => {
          hidden.push(...ids);
          latestSequence += 1;
        },
        latestSequence: async () => latestSequence,
        appendSummaryEpisode: async (input: { readonly turnId: string; readonly sequence: number; readonly summaryText: string }) => {
          appended.push(input);
          latestSequence = Math.max(latestSequence, input.sequence);
        },
      },
      state: { hidden, appended },
    };
  }

  test("below threshold is a no-op that says so", async () => {
    const { store } = fakeStore();
    const report = await runCompaction(store, {
      turnId: "turn-1",
      episodes: [episode("a", 1, "user_message", "hello")],
      totalBytes: 10,
    });
    expect(report.triggered).toBe(false);
    expect(report.reason).toBe("below_threshold");
  });

  test("compacts with an LLM summary when over threshold and summarizer present", async () => {
    const { store, state } = fakeStore();
    let summarizedChars = 0;
    const report = await runCompaction(store, {
      turnId: "turn-1",
      totalBytes: 1_700,
      compactThresholdTokens: 100,
      keepRecentTokens: 20,
      episodes: [
        episode("old-call", 1, "tool_call", "c".repeat(800), "tp"),
        episode("old-result", 2, "tool_result", "r".repeat(800), "tp"),
        episode("new-call", 3, "tool_call", "nc", "tn"),
        episode("new-result", 4, "tool_result", "nr", "tn"),
      ],
      summarizer: async ({ transcript }) => {
        summarizedChars = transcript.length;
        return "GOAL: fix it\nNEXT STEPS: re-run tests";
      },
    });
    expect(report.triggered).toBe(true);
    expect(report.reason).toBe("compacted");
    expect(state.hidden.sort()).toEqual(["old-call", "old-result"]);
    expect(state.appended).toHaveLength(1);
    expect(state.appended[0]?.summaryText).toContain("GOAL: fix it");
    expect(state.appended[0]?.summaryText).toContain("SOURCE_INDEX:");
    expect(state.appended[0]?.summaryText).toContain("episode_id=old-call");
    expect(summarizedChars).toBeGreaterThan(1_500);
  });

  test("does not silently truncate source before summarization", async () => {
    const { store, state } = fakeStore();
    const report = await runCompaction(store, {
      turnId: "turn-1",
      totalBytes: 1_700,
      compactThresholdTokens: 100,
      keepRecentTokens: 20,
      episodes: [
        episode("old-call", 1, "tool_call", "c".repeat(MAX_COMPACTION_TRANSCRIPT_CHARS), "tp"),
        episode("old-result", 2, "tool_result", "r".repeat(100), "tp"),
        episode("new", 3, "tool_result", "n", "tn"),
      ],
      summarizer: async () => "must not be called",
    });
    expect(report.triggered).toBe(false);
    expect(report.reason).toBe("source_too_large");
    expect(report.failureCode).toBe("source_too_large");
    expect(state.hidden).toEqual([]);
    expect(state.appended).toEqual([]);
  });

  test("does not prune content without immutable source provenance", async () => {
    const { store, state } = fakeStore();
    const report = await runCompaction(store, {
      turnId: "turn-1",
      totalBytes: 1_700,
      compactThresholdTokens: 100,
      keepRecentTokens: 20,
      episodes: [
        { ...episode("old-call", 1, "tool_call", "c".repeat(800), "tp"), contentArtifact: null },
        episode("old-result", 2, "tool_result", "r".repeat(800), "tp"),
        episode("new-call", 3, "tool_call", "nc", "tn"),
        episode("new-result", 4, "tool_result", "nr", "tn"),
      ],
      summarizer: async () => "must not be called",
    });
    expect(report.triggered).toBe(false);
    expect(report.reason).toBe("insufficient_source");
    expect(report.failureCode).toBe("source_unavailable");
    expect(state.hidden).toEqual([]);
    expect(state.appended).toEqual([]);
  });

  test("does not prune when no summarizer exists", async () => {
    const { store, state } = fakeStore();
    const report = await runCompaction(store, {
      turnId: "turn-1",
      totalBytes: 950,
      compactThresholdTokens: 50,
      keepRecentTokens: 5,
      episodes: [
        episode("old-a", 1, "tool_result", "a".repeat(900), "q"),
        episode("new-b", 2, "tool_result", "b", "w"),
      ],
      summarizer: null,
    });
    expect(report.triggered).toBe(false);
    expect(report.reason).toBe("no_summarizer");
    expect(report.summaryChars).toBe(0);
    expect(state.hidden).toEqual([]);
  });

  test("does not prune metadata-only episodes even when byte sizes exceed the threshold", async () => {
    const { store, state } = fakeStore();
    const report = await runCompaction(store, {
      turnId: "turn-1",
      totalBytes: 950,
      compactThresholdTokens: 50,
      keepRecentTokens: 5,
      episodes: [
        episode("old-a", 1, "tool_result", null, "q"),
        { ...episode("new-b", 2, "tool_result", null, "w"), byteSize: 10_000 },
      ],
      summarizer: async () => "This must not be called",
    });
    expect(report.triggered).toBe(false);
    expect(report.reason).toBe("insufficient_source");
    expect(report.failureCode).toBe("source_unavailable");
    expect(state.hidden).toEqual([]);
  });

  test("retains source episodes when summarization fails", async () => {
    const { store, state } = fakeStore();
    const report = await runCompaction(store, {
      turnId: "turn-1",
      totalBytes: 1_700,
      compactThresholdTokens: 100,
      keepRecentTokens: 20,
      episodes: [
        episode("old-call", 1, "tool_call", "c".repeat(800), "tp"),
        episode("old-result", 2, "tool_result", "r".repeat(800), "tp"),
        episode("new-call", 3, "tool_call", "nc", "tn"),
        episode("new-result", 4, "tool_result", "nr", "tn"),
      ],
      summarizer: async () => { throw new Error("provider unavailable"); },
    });
    expect(report.triggered).toBe(false);
    expect(report.reason).toBe("summary_failed");
    expect(state.hidden).toEqual([]);
  });

  test("threshold constants align with the documented defaults", () => {
    expect(DEFAULT_COMPACT_THRESHOLD_TOKENS * BYTES_PER_TOKEN_ESTIMATE).toBe(384_000);
    expect(SUMMARY_SYSTEM_INSTRUCTIONS).toContain("KEY DECISIONS");
    expect(SUMMARY_SYSTEM_INSTRUCTIONS).toContain("CRITICAL CONTEXT");
  });
});

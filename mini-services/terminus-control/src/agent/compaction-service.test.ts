import { describe, expect, test } from "bun:test";
import {
  BYTES_PER_TOKEN_ESTIMATE,
  DEFAULT_COMPACT_THRESHOLD_TOKENS,
  planDeterministicPrune,
  runCompaction,
  SUMMARY_SYSTEM_INSTRUCTIONS,
  type EpisodeLike,
} from "./compaction-service.js";

function episode(id: string, sequence: number, kind: string, contentJson: string | null, toolCallId: string | null = null): EpisodeLike {
  return { id, kind, sequence, toolCallId, contentJson };
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
        appendSummaryEpisode: async (input) => {
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
    expect(summarizedChars).toBeGreaterThan(1_500);
  });

  test("deterministic-only mode still prunes and reports honestly when no summarizer exists", async () => {
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
    expect(report.triggered).toBe(true);
    expect(report.reason).toBe("no_summarizer_deterministic_only");
    expect(report.summaryChars).toBe(0);
    expect(state.hidden).toEqual(["old-a"]);
  });

  test("threshold constants align with the documented defaults", () => {
    expect(DEFAULT_COMPACT_THRESHOLD_TOKENS * BYTES_PER_TOKEN_ESTIMATE).toBe(384_000);
    expect(SUMMARY_SYSTEM_INSTRUCTIONS).toContain("KEY DECISIONS");
    expect(SUMMARY_SYSTEM_INSTRUCTIONS).toContain("CRITICAL CONTEXT");
  });
});

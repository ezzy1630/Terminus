import { describe, expect, test } from "bun:test";
import { computeContentHash } from "@terminus/context-ir";
import {
  createExactCompactionRecallStore,
  type CompactionRecallPersistence,
  type CompactionRecallSourceRow,
  type CompactionRecallSummaryRow,
} from "./compaction-recall-store.js";
import {
  COMPACTION_RECALL_VERSION,
  parseCompactionTaskAnchor,
  runCompaction,
  runCompactionRecall,
  type CompactionStore,
  type CompactionTaskAnchor,
} from "./compaction-service.js";

const TURN_ID = "turn-restart";

function artifactFor(content: string): string {
  return `artifact://sha256/${computeContentHash(content).slice("sha256:".length)}`;
}

function taskAnchor(): CompactionTaskAnchor {
  return {
    contractVersion: 7,
    contractHash: `sha256:${"a".repeat(64)}`,
    objective: "Preserve exact task obligations across compaction and recovery.",
    acceptanceCriteria: [{
      id: "criterion-1",
      statement: "The original source remains exactly recallable.",
      required: true,
      status: "unverified",
    }],
    nonGoals: ["Enable cross-session memory"],
    constraints: ["Never replace task authority with model prose."],
    allowedScope: {
      readPaths: ["mini-services/terminus-control"],
      writePaths: ["mini-services/terminus-control/src/agent"],
      externalSystems: [],
    },
  };
}

type CompactionCommit = Parameters<NonNullable<CompactionStore["commitCompaction"]>>[0];

describe("compaction artifact and recovery conformance", () => {
  test("restores the obligation anchor and recalls pruned CAS source after serialization", async () => {
    const oldCall = JSON.stringify({ tool: "read", path: "src/old.ts" });
    const oldResult = JSON.stringify({ text: "exact source payload after restart" });
    const recent = JSON.stringify({ text: "continue from here" });
    const sourceRows: readonly CompactionRecallSourceRow[] = [
      {
        id: "old-call",
        turnId: TURN_ID,
        kind: "tool_call",
        sequence: 1,
        toolCallId: "call-1",
        contentArtifact: artifactFor(oldCall),
      },
      {
        id: "old-result",
        turnId: TURN_ID,
        kind: "tool_result",
        sequence: 2,
        toolCallId: "call-1",
        contentArtifact: artifactFor(oldResult),
      },
    ];
    const committed: { value?: CompactionCommit } = {};
    const writeStore: CompactionStore = {
      commitCompaction: async (input) => {
        committed.value = input;
      },
    };

    const report = await runCompaction(writeStore, {
      turnId: TURN_ID,
      taskAnchor: taskAnchor(),
      episodes: [
        { ...sourceRows[0]!, contentJson: oldCall, tokenCount: oldCall.length },
        { ...sourceRows[1]!, contentJson: oldResult, tokenCount: oldResult.length },
        {
          id: "recent",
          kind: "assistant_message",
          sequence: 3,
          toolCallId: null,
          contentJson: recent,
          tokenCount: recent.length,
          contentArtifact: artifactFor(recent),
        },
      ],
      totalTokens: 1_000,
      compactThresholdTokens: 1,
      keepRecentTokens: 1,
      summarizer: async () => [
        "GOAL: Replace the task with an inaccurate model interpretation.",
        "PROGRESS: Read the original source.",
        "NEXT STEPS: Continue from the retained tail.",
      ].join("\n"),
    });

    expect(report).toMatchObject({ triggered: true, reason: "compacted", prunedCount: 2 });
    const commit = committed.value;
    if (commit === undefined) throw new Error("compaction did not commit");

    // Simulate a process boundary: only the persisted model-visible artifact
    // and source metadata survive, not the in-memory structured object.
    const restoredSummaryText = new TextDecoder().decode(
      new TextEncoder().encode(commit.summaryText),
    );
    const restoredAnchor = parseCompactionTaskAnchor(restoredSummaryText);
    expect(restoredAnchor).toEqual(taskAnchor());
    expect(restoredAnchor.objective).not.toContain("inaccurate model interpretation");

    const summaryRows = JSON.parse(JSON.stringify([{
      id: "summary-1",
      turnId: TURN_ID,
      sequence: 4,
      sourceVersionsJson: JSON.stringify({
        summaryHash: commit.summaryHash,
        sourceEpisodeIds: commit.prunedEpisodeIds,
        sourceArtifacts: Object.fromEntries(
          commit.summary.sourceEpisodes.map((source) => [source.episodeId, source.artifactRef]),
        ),
      }),
    }])) as readonly CompactionRecallSummaryRow[];
    const contentByHash: Readonly<Record<string, Uint8Array>> = {
      [computeContentHash(oldCall)]: new TextEncoder().encode(oldCall),
      [computeContentHash(oldResult)]: new TextEncoder().encode(oldResult),
    };
    const persistence: CompactionRecallPersistence = {
      listCurrentTurnSummaryRows: async () => summaryRows,
      listSourceEpisodeRows: async ({ episodeIds }) =>
        sourceRows.filter((row) => episodeIds.includes(row.id)),
      readCasBytes: async ({ contentHash }) => {
        const bytes = contentByHash[contentHash];
        if (bytes === undefined) throw new Error(`missing CAS source ${contentHash}`);
        return bytes;
      },
    };
    const restartedRecallStore = createExactCompactionRecallStore({
      expectedTurnId: TURN_ID,
      persistence,
    });
    const restoredDescriptor = await restartedRecallStore.resolveSummary({
      turnId: TURN_ID,
      summaryHash: commit.summaryHash,
    });
    if (restoredDescriptor === null) throw new Error("persisted compaction descriptor was not restored");
    const recalled = await runCompactionRecall(
      { recallCompaction: restartedRecallStore.recallCompaction },
      {
        schemaVersion: COMPACTION_RECALL_VERSION,
        turnId: TURN_ID,
        summaryHash: commit.summaryHash,
        episodeIds: restoredDescriptor.sourceEpisodeIds,
        query: null,
        maxEpisodes: 100,
        continuation: null,
      },
    );

    expect(recalled.episodes.map((episode) => episode.id)).toEqual(["old-call", "old-result"]);
    expect(recalled.episodes.map((episode) => episode.contentJson)).toEqual([oldCall, oldResult]);
  });
});

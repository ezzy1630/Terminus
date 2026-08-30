import { describe, expect, test } from "bun:test";
import {
  createExactCompactionRecallStore,
  type CompactionRecallPersistence,
  type CompactionRecallSourceRow,
  type CompactionRecallSummaryRow,
} from "./compaction-recall-store.js";
import { COMPACTION_RECALL_VERSION } from "./compaction-service.js";

const TURN_ID = "turn-1";
const SUMMARY_OLD = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SUMMARY_NEW = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ARTIFACT_1 = `artifact://sha256/${"1".repeat(64)}`;
const ARTIFACT_2 = `artifact://sha256/${"2".repeat(64)}`;

function summaryRow(
  sequence: number,
  summaryHash: string,
  sourceEpisodeIds: readonly string[],
  sourceArtifacts: Readonly<Record<string, string>>,
  id = `summary-${sequence}`,
): CompactionRecallSummaryRow {
  return {
    id,
    turnId: TURN_ID,
    sequence,
    sourceVersionsJson: JSON.stringify({ summaryHash, sourceEpisodeIds, sourceArtifacts }),
  };
}

function sourceRow(
  id: string,
  sequence: number,
  artifact: string,
  turnId = TURN_ID,
): CompactionRecallSourceRow {
  return { id, turnId, kind: "tool_result", sequence, toolCallId: `call-${id}`, contentArtifact: artifact };
}

function makePersistence(
  summaries: readonly CompactionRecallSummaryRow[],
  sources: readonly CompactionRecallSourceRow[],
  contents: Readonly<Record<string, Uint8Array>>,
): CompactionRecallPersistence {
  return {
    listCurrentTurnSummaryRows: async () => summaries,
    listSourceEpisodeRows: async ({ episodeIds }) => sources.filter((row) => episodeIds.includes(row.id)),
    readCasBytes: async ({ contentHash }) => {
      const bytes = contents[contentHash];
      if (bytes === undefined) throw new Error(`missing CAS ${contentHash}`);
      return bytes;
    },
  };
}

function store(
  summaries = [summaryRow(1, SUMMARY_OLD, ["episode-1"], { "episode-1": ARTIFACT_1 })],
  sources = [sourceRow("episode-1", 1, ARTIFACT_1)],
  contents: Readonly<Record<string, Uint8Array>> = {
    [`sha256:${"1".repeat(64)}`]: new TextEncoder().encode("first source needle"),
  },
) {
  return createExactCompactionRecallStore({
    expectedTurnId: TURN_ID,
    persistence: makePersistence(summaries, sources, contents),
  });
}

describe("exact compaction recall persistence", () => {
  test("selects latest valid expandable summary and honors an explicit hash", async () => {
    const latest = summaryRow(3, SUMMARY_NEW, ["episode-2"], { "episode-2": ARTIFACT_2 });
    const persistence = makePersistence(
      [
        summaryRow(1, SUMMARY_OLD, ["episode-1"], { "episode-1": ARTIFACT_1 }),
        { ...summaryRow(2, "legacy", ["episode-legacy"], { "episode-legacy": "not-artifact" }), sourceVersionsJson: "{}" },
        latest,
      ],
      [sourceRow("episode-1", 1, ARTIFACT_1), sourceRow("episode-2", 2, ARTIFACT_2)],
      {
        [`sha256:${"1".repeat(64)}`]: new TextEncoder().encode("old"),
        [`sha256:${"2".repeat(64)}`]: new TextEncoder().encode("new"),
      },
    );
    const bound = createExactCompactionRecallStore({ expectedTurnId: TURN_ID, persistence });
    await expect(bound.resolveSummary({ turnId: TURN_ID, summaryHash: null })).resolves.toEqual({
      summaryHash: SUMMARY_NEW,
      sourceEpisodeIds: ["episode-2"],
    });
    await expect(bound.resolveSummary({ turnId: TURN_ID, summaryHash: SUMMARY_OLD })).resolves.toEqual({
      summaryHash: SUMMARY_OLD,
      sourceEpisodeIds: ["episode-1"],
    });
  });

  test("fails closed for wrong turns, duplicate source sets, and duplicate hashes", async () => {
    await expect(store().resolveSummary({ turnId: "other-turn", summaryHash: null })).rejects.toThrow(/turn mismatch/);
    const duplicate = store([summaryRow(1, SUMMARY_OLD, ["episode-1", "episode-1"], { "episode-1": ARTIFACT_1 })]);
    await expect(duplicate.resolveSummary({ turnId: TURN_ID, summaryHash: null })).resolves.toBeNull();
    const sameHash = store([
      summaryRow(1, SUMMARY_OLD, ["episode-1"], { "episode-1": ARTIFACT_1 }),
      summaryRow(2, SUMMARY_OLD, ["episode-2"], { "episode-2": ARTIFACT_2 }),
    ]);
    await expect(sameHash.resolveSummary({ turnId: TURN_ID, summaryHash: SUMMARY_OLD })).resolves.toBeNull();
  });

  test("rejects wrong turn, forged ids, artifact drift, and incomplete or duplicate rows", async () => {
    const bound = store([
      summaryRow(1, SUMMARY_OLD, ["episode-1", "episode-2"], { "episode-1": ARTIFACT_1, "episode-2": ARTIFACT_2 }),
    ], [sourceRow("episode-1", 1, ARTIFACT_1), sourceRow("episode-2", 2, ARTIFACT_2)], {
      [`sha256:${"1".repeat(64)}`]: new TextEncoder().encode("one"),
      [`sha256:${"2".repeat(64)}`]: new TextEncoder().encode("two"),
    });
    const request = {
      schemaVersion: COMPACTION_RECALL_VERSION,
      turnId: TURN_ID,
      summaryHash: SUMMARY_OLD,
      episodeIds: ["forged"],
      query: null,
      maxEpisodes: 2,
      continuation: null,
    } as const;
    await expect(bound.recallCompaction({ ...request, turnId: "other" })).rejects.toThrow(/turn mismatch/);
    await expect(bound.recallCompaction(request)).rejects.toThrow(/outside the summary source set/);

    const drift = store([summaryRow(1, SUMMARY_OLD, ["episode-1"], { "episode-1": ARTIFACT_2 })]);
    await expect(drift.recallCompaction({ ...request, episodeIds: ["episode-1"], maxEpisodes: 1 })).rejects.toThrow(/artifact identity/);
    const incomplete = store([summaryRow(1, SUMMARY_OLD, ["episode-1", "episode-2"], { "episode-1": ARTIFACT_1, "episode-2": ARTIFACT_2 })], [sourceRow("episode-1", 1, ARTIFACT_1)]);
    await expect(incomplete.recallCompaction({ ...request, episodeIds: [], maxEpisodes: 2 })).rejects.toThrow(/incomplete/);
    const duplicate = store([summaryRow(1, SUMMARY_OLD, ["episode-1"], { "episode-1": ARTIFACT_1 })], [sourceRow("episode-1", 1, ARTIFACT_1), sourceRow("episode-1", 1, ARTIFACT_1)]);
    await expect(duplicate.recallCompaction({ ...request, episodeIds: ["episode-1"], maxEpisodes: 1 })).rejects.toThrow(/incomplete/);
  });

  test("filters by query, orders deterministically, and paginates with a summary-bound continuation", async () => {
    const bound = store([summaryRow(1, SUMMARY_OLD, ["b", "a"], { a: ARTIFACT_1, b: ARTIFACT_2 })], [
      sourceRow("b", 2, ARTIFACT_2), sourceRow("a", 1, ARTIFACT_1),
    ], {
      [`sha256:${"1".repeat(64)}`]: new TextEncoder().encode("needle a"),
      [`sha256:${"2".repeat(64)}`]: new TextEncoder().encode("needle b"),
    });
    const first = await bound.recallCompaction({
      schemaVersion: COMPACTION_RECALL_VERSION, turnId: TURN_ID, summaryHash: SUMMARY_OLD,
      episodeIds: [], query: "NEEDLE", maxEpisodes: 1, continuation: null,
    });
    expect(first.episodes.map((episode) => episode.id)).toEqual(["a"]);
    expect(first.continuation).toBe(`compaction:${encodeURIComponent(SUMMARY_OLD)}:1`);
    const second = await bound.recallCompaction({
      schemaVersion: COMPACTION_RECALL_VERSION, turnId: TURN_ID, summaryHash: SUMMARY_OLD,
      episodeIds: [], query: "needle", maxEpisodes: 1, continuation: first.continuation,
    });
    expect(second.episodes.map((episode) => episode.id)).toEqual(["b"]);
    await expect(bound.recallCompaction({
      schemaVersion: COMPACTION_RECALL_VERSION, turnId: TURN_ID, summaryHash: SUMMARY_OLD,
      episodeIds: [], query: null, maxEpisodes: 1, continuation: `compaction:${SUMMARY_NEW}:1`,
    })).rejects.toThrow(/does not match the summary/);
  });

  test("decodes exact bytes after reconstruction and fails on invalid UTF-8", async () => {
    const bound = store();
    const result = await bound.recallCompaction({
      schemaVersion: COMPACTION_RECALL_VERSION, turnId: TURN_ID, summaryHash: SUMMARY_OLD,
      episodeIds: ["episode-1"], query: null, maxEpisodes: 1, continuation: null,
    });
    expect(result).toMatchObject({ schemaVersion: COMPACTION_RECALL_VERSION, summaryHash: SUMMARY_OLD });
    expect(result.episodes[0]?.contentJson).toBe("first source needle");
    const invalid = store(undefined, undefined, {
      [`sha256:${"1".repeat(64)}`]: new Uint8Array([0xc3, 0x28]),
    });
    await expect(invalid.recallCompaction({
      schemaVersion: COMPACTION_RECALL_VERSION, turnId: TURN_ID, summaryHash: SUMMARY_OLD,
      episodeIds: ["episode-1"], query: null, maxEpisodes: 1, continuation: null,
    })).rejects.toThrow(/invalid UTF-8/);
  });
});

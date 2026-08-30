import { describe, expect, test } from "bun:test";
import {
  CompactionRecallToolError,
  runCompactionRecallTool,
  type CompactionRecallToolStore,
} from "./compaction-recall-tool.js";
import {
  COMPACTION_RECALL_VERSION,
  type CompactionRecallRequest,
  type EpisodeLike,
} from "./compaction-service.js";

const SUMMARY_HASH = `sha256:${"a".repeat(64)}`;

function episode(id: string, sequence: number, content: string): EpisodeLike {
  const sourceHex = (id === "episode-1" ? "1" : "2").repeat(64);
  return {
    id,
    kind: "tool_result",
    sequence,
    toolCallId: `call-${id}`,
    contentJson: content,
    contentArtifact: `artifact://sha256/${sourceHex}`,
    byteSize: new TextEncoder().encode(content).byteLength,
  };
}

function store(
  episodes: readonly EpisodeLike[],
  observe?: (input: CompactionRecallRequest) => void,
): CompactionRecallToolStore {
  return {
    resolveSummary: async ({ summaryHash }) => summaryHash !== null && summaryHash !== SUMMARY_HASH
      ? null
      : { summaryHash: SUMMARY_HASH, sourceEpisodeIds: episodes.map((item) => item.id) },
    recallCompaction: async (input) => {
      observe?.(input);
      const selected = input.episodeIds.length === 0
        ? episodes
        : episodes.filter((item) => input.episodeIds.includes(item.id));
      return {
        schemaVersion: COMPACTION_RECALL_VERSION,
        summaryHash: input.summaryHash,
        episodes: selected.slice(0, input.maxEpisodes),
        continuation: selected.length > input.maxEpisodes ? `compaction:${input.summaryHash}:1` : null,
      };
    },
  };
}

describe("model-facing compaction recall", () => {
  test("resolves the latest current-turn summary and centers bounded exact excerpts", async () => {
    const first = episode("episode-1", 1, `${"x".repeat(900)} needle exact source`);
    const second = episode("episode-2", 2, "second exact source");
    let observed: CompactionRecallRequest | null = null;
    const result = await runCompactionRecallTool({
      turnId: "turn-1",
      request: {
        action: "compaction_browse",
        query: "needle",
        limit: 1,
        max_chars: 512,
      },
      store: store([first, second], (input) => { observed = input; }),
    });
    expect(result.summary_hash).toBe(SUMMARY_HASH);
    expect(result.results[0]?.content_excerpt).toContain("needle");
    expect(result.results[0]?.content_offset_chars).toBeGreaterThan(0);
    expect(result.results[0]?.source_sha256).toBe(`sha256:${"1".repeat(64)}`);
    expect(result.results[0]?.previous_offset_chars).not.toBeNull();
    expect(result.results[0]?.next_offset_chars).toBeNull();
    expect(result.continuation).toBe(`compaction:${SUMMARY_HASH}:1`);
    expect(observed).toMatchObject({
      turnId: "turn-1",
      summaryHash: SUMMARY_HASH,
      episodeIds: [],
      query: "needle",
      maxEpisodes: 1,
    });
  });

  test("pages one admitted episode by exact source character offset", async () => {
    const source = episode("episode-1", 1, "a".repeat(700));
    const result = await runCompactionRecallTool({
      turnId: "turn-1",
      request: {
        action: "compaction_read",
        summary_hash: SUMMARY_HASH,
        episode_id: "episode-1",
        offset_chars: 100,
        max_chars: 512,
      },
      store: store([source]),
    });
    expect(result.results[0]).toMatchObject({
      content_offset_chars: 100,
      content_end_chars: 612,
      content_total_chars: 700,
      content_truncated: true,
      previous_offset_chars: 0,
      next_offset_chars: 612,
    });
    expect(result.results[0]?.content_excerpt).toHaveLength(512);
  });

  test("rejects unknown summaries and forged source ids before artifact access", async () => {
    const sources = store([episode("episode-1", 1, "exact")]);
    await expect(runCompactionRecallTool({
      turnId: "turn-1",
      request: {
        action: "compaction_browse",
        summary_hash: `sha256:${"b".repeat(64)}`,
        limit: 3,
        max_chars: 512,
      },
      store: sources,
    })).rejects.toBeInstanceOf(CompactionRecallToolError);
    await expect(runCompactionRecallTool({
      turnId: "turn-1",
      request: {
        action: "compaction_read",
        summary_hash: SUMMARY_HASH,
        episode_id: "forged",
        offset_chars: 0,
        max_chars: 512,
      },
      store: sources,
    })).rejects.toThrow(/outside compaction summary/);
  });
});

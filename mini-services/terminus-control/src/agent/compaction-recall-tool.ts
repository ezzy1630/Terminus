import {
  COMPACTION_RECALL_VERSION,
  runCompactionRecall,
  type CompactionRecallRequest,
  type CompactionRecallResult,
  type EpisodeLike,
} from "./compaction-service.js";
import { sessionRecallMatchStart } from "./session-recall-query.js";

const IMMUTABLE_ARTIFACT_URI = /^artifact:\/\/sha256\/([0-9a-f]{64})$/i;

export interface CompactionSummaryDescriptor {
  readonly summaryHash: string;
  readonly sourceEpisodeIds: readonly string[];
}

export interface CompactionRecallToolStore {
  resolveSummary(input: {
    readonly turnId: string;
    readonly summaryHash: string | null;
  }): Promise<CompactionSummaryDescriptor | null>;
  recallCompaction(input: CompactionRecallRequest): Promise<CompactionRecallResult>;
}

export type CompactionRecallToolRequest =
  | {
      readonly action: "compaction_browse";
      readonly summary_hash?: string | undefined;
      readonly query?: string | undefined;
      readonly continuation?: string | undefined;
      readonly limit: number;
      readonly max_chars: number;
    }
  | {
      readonly action: "compaction_read";
      readonly summary_hash: string;
      readonly episode_id: string;
      readonly offset_chars: number;
      readonly max_chars: number;
    };

export interface CompactionRecallToolEntry {
  readonly episode_id: string;
  readonly kind: string;
  readonly sequence: number;
  readonly tool_call_id: string | null;
  readonly source_uri: string;
  readonly source_sha256: string;
  readonly content_excerpt: string;
  readonly content_offset_chars: number;
  readonly content_end_chars: number;
  readonly content_total_chars: number;
  readonly content_truncated: boolean;
  readonly previous_offset_chars: number | null;
  readonly next_offset_chars: number | null;
}

export interface CompactionRecallToolResult {
  readonly scope: { readonly turn_id: string };
  readonly action: CompactionRecallToolRequest["action"];
  readonly summary_hash: string;
  readonly query: string | null;
  readonly results: readonly CompactionRecallToolEntry[];
  readonly continuation: string | null;
}

export class CompactionRecallToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompactionRecallToolError";
  }
}

/** Expand only exact source episodes admitted by a current-turn summary. */
export async function runCompactionRecallTool(input: {
  readonly turnId: string;
  readonly request: CompactionRecallToolRequest;
  readonly store: CompactionRecallToolStore;
}): Promise<CompactionRecallToolResult> {
  assertToolRequest(input.request);
  const requestedHash = input.request.summary_hash ?? null;
  const summary = await input.store.resolveSummary({
    turnId: input.turnId,
    summaryHash: requestedHash,
  });
  if (summary === null) {
    throw new CompactionRecallToolError(
      requestedHash === null
        ? "the current turn has no expandable compaction summary"
        : `compaction summary ${requestedHash} is unavailable in the current turn`,
    );
  }

  if (input.request.action === "compaction_read") {
    if (!summary.sourceEpisodeIds.includes(input.request.episode_id)) {
      throw new CompactionRecallToolError(
        `episode ${input.request.episode_id} is outside compaction summary ${summary.summaryHash}`,
      );
    }
    const recalled = await runCompactionRecall(input.store, {
      schemaVersion: COMPACTION_RECALL_VERSION,
      turnId: input.turnId,
      summaryHash: summary.summaryHash,
      episodeIds: [input.request.episode_id],
      query: null,
      maxEpisodes: 1,
      continuation: null,
    });
    const episode = recalled.episodes[0];
    if (episode === undefined) {
      throw new CompactionRecallToolError(`compaction source ${input.request.episode_id} is unavailable`);
    }
    return {
      scope: { turn_id: input.turnId },
      action: input.request.action,
      summary_hash: summary.summaryHash,
      query: null,
      results: [projectEpisode(episode, input.request.max_chars, input.request.offset_chars)],
      continuation: null,
    };
  }

  const recalled = await runCompactionRecall(input.store, {
    schemaVersion: COMPACTION_RECALL_VERSION,
    turnId: input.turnId,
    summaryHash: summary.summaryHash,
    episodeIds: [],
    query: input.request.query ?? null,
    maxEpisodes: input.request.limit,
    continuation: input.request.continuation ?? null,
  });
  const perEpisodeChars = recalled.episodes.length === 0
    ? input.request.max_chars
    : Math.max(1, Math.floor(input.request.max_chars / recalled.episodes.length));
  return {
    scope: { turn_id: input.turnId },
    action: input.request.action,
    summary_hash: summary.summaryHash,
    query: input.request.query ?? null,
    results: recalled.episodes.map((episode) => projectEpisode(
      episode,
      perEpisodeChars,
      matchCenteredOffset(episode, input.request.query ?? null, perEpisodeChars),
    )),
    continuation: recalled.continuation,
  };
}

function projectEpisode(
  episode: EpisodeLike,
  maxChars: number,
  offsetChars: number,
): CompactionRecallToolEntry {
  if (episode.contentJson === null) {
    throw new CompactionRecallToolError(`compaction source ${episode.id} has no exact text`);
  }
  const sourceUri = episode.contentArtifact;
  const artifactMatch = sourceUri?.match(IMMUTABLE_ARTIFACT_URI) ?? null;
  const sourceHex = artifactMatch?.[1];
  if (sourceUri === null || sourceHex === undefined) {
    throw new CompactionRecallToolError(`compaction source ${episode.id} has no immutable artifact`);
  }
  const characters = Array.from(episode.contentJson);
  if (!Number.isSafeInteger(offsetChars) || offsetChars < 0 || offsetChars > characters.length) {
    throw new CompactionRecallToolError(`compaction source offset ${offsetChars} is outside episode ${episode.id}`);
  }
  const endChars = Math.min(characters.length, offsetChars + maxChars);
  return {
    episode_id: episode.id,
    kind: episode.kind,
    sequence: episode.sequence,
    tool_call_id: episode.toolCallId,
    source_uri: sourceUri,
    source_sha256: `sha256:${sourceHex.toLocaleLowerCase()}`,
    content_excerpt: characters.slice(offsetChars, endChars).join(""),
    content_offset_chars: offsetChars,
    content_end_chars: endChars,
    content_total_chars: characters.length,
    content_truncated: offsetChars > 0 || endChars < characters.length,
    previous_offset_chars: offsetChars > 0 ? Math.max(0, offsetChars - maxChars) : null,
    next_offset_chars: endChars < characters.length ? endChars : null,
  };
}

function matchCenteredOffset(episode: EpisodeLike, query: string | null, maxChars: number): number {
  if (query === null || episode.contentJson === null) return 0;
  const match = sessionRecallMatchStart(episode.contentJson, query);
  if (match === null) return 0;
  const totalChars = Array.from(episode.contentJson).length;
  return Math.max(0, Math.min(match - Math.floor(maxChars / 3), totalChars - maxChars));
}

function assertToolRequest(request: CompactionRecallToolRequest): void {
  if (!Number.isSafeInteger(request.max_chars) || request.max_chars < 512 || request.max_chars > 16_000) {
    throw new CompactionRecallToolError("compaction recall max_chars must be between 512 and 16000");
  }
  if (request.action === "compaction_browse") {
    if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 10) {
      throw new CompactionRecallToolError("compaction recall limit must be between 1 and 10");
    }
    return;
  }
  if (!Number.isSafeInteger(request.offset_chars) || request.offset_chars < 0) {
    throw new CompactionRecallToolError("compaction recall offset_chars must be non-negative");
  }
}

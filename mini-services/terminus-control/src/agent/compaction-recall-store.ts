import {
  COMPACTION_RECALL_VERSION,
  type CompactionRecallRequest,
  type CompactionRecallResult,
} from "./compaction-service.js";
import type {
  CompactionRecallToolStore,
  CompactionSummaryDescriptor,
} from "./compaction-recall-tool.js";

const IMMUTABLE_ARTIFACT_URI = /^artifact:\/\/sha256\/([0-9a-f]{64})$/i;
const SUMMARY_HASH = /^sha256:[0-9a-f]{64}$/;
const COMPACTION_CONTINUATION_PREFIX = "compaction:";

/** The persisted fields needed to decide whether a summary can be expanded. */
export interface CompactionRecallSummaryRow {
  readonly id?: string | undefined;
  readonly turnId: string;
  readonly sequence: number;
  readonly sourceVersionsJson: string | null;
}

/** The persisted source identity; body bytes remain in immutable CAS. */
export interface CompactionRecallSourceRow {
  readonly id: string;
  readonly turnId: string;
  readonly kind: string;
  readonly sequence: number;
  readonly toolCallId: string | null;
  readonly contentArtifact: string | null;
}

export interface CompactionRecallPersistence {
  listCurrentTurnSummaryRows(input: { readonly turnId: string }): Promise<readonly CompactionRecallSummaryRow[]>;
  listSourceEpisodeRows(input: {
    readonly turnId: string;
    readonly episodeIds: readonly string[];
  }): Promise<readonly CompactionRecallSourceRow[]>;
  readCasBytes(input: { readonly contentHash: string }): Promise<Uint8Array>;
}

interface ParsedSummary {
  readonly id: string;
  readonly sequence: number;
  readonly summaryHash: string;
  readonly sourceEpisodeIds: readonly string[];
  readonly sourceArtifacts: Readonly<Record<string, string>>;
}

/**
 * Bind exact compaction expansion to one executing turn and to injected
 * durable reads. No model-provided turn id is ever accepted by this store.
 */
export function createExactCompactionRecallStore(input: {
  readonly expectedTurnId: string;
  readonly persistence: CompactionRecallPersistence;
}): CompactionRecallToolStore {
  if (input.expectedTurnId.length === 0) throw new Error("expectedTurnId must not be empty");

  return {
    resolveSummary: async ({ turnId, summaryHash }): Promise<CompactionSummaryDescriptor | null> => {
      assertTurn(input.expectedTurnId, turnId);
      const rows = await input.persistence.listCurrentTurnSummaryRows({ turnId });
      const parsed = rows
        .filter((row) => row.turnId === input.expectedTurnId)
        .map(parseSummaryRow)
        .filter((summary): summary is ParsedSummary => summary !== null);

      // A repeated hash is ambiguous even if both rows are otherwise valid.
      // Refuse it rather than allowing a restart or query order to choose data.
      const byHash = new Map<string, ParsedSummary[]>();
      for (const summary of parsed) {
        const candidates = byHash.get(summary.summaryHash) ?? [];
        candidates.push(summary);
        byHash.set(summary.summaryHash, candidates);
      }
      const unambiguous = parsed
        .filter((summary) => (byHash.get(summary.summaryHash)?.length ?? 0) === 1)
        .sort((left, right) => right.sequence - left.sequence || right.id.localeCompare(left.id));
      const candidate = summaryHash === null
        ? unambiguous[0]
        : unambiguous.find((summary) => summary.summaryHash === summaryHash);
      return candidate === undefined
        ? null
        : { summaryHash: candidate.summaryHash, sourceEpisodeIds: candidate.sourceEpisodeIds };
    },
    recallCompaction: async (request): Promise<CompactionRecallResult> => {
      assertTurn(input.expectedTurnId, request.turnId);
      assertRecallRequest(request);

      const summary = await resolveExactSummary(input.persistence, input.expectedTurnId, request.summaryHash);
      const requestedIds = uniqueStrings(request.episodeIds);
      if (requestedIds.some((id) => !summary.sourceEpisodeIds.includes(id))) {
        throw new Error("compaction recall requested an episode outside the summary source set");
      }
      const selectedIds = requestedIds.length > 0 ? requestedIds : [...summary.sourceEpisodeIds];
      const rows = await input.persistence.listSourceEpisodeRows({
        turnId: request.turnId,
        episodeIds: selectedIds,
      });
      const orderedRows = validateAndOrderSourceRows(rows, selectedIds, request.turnId, request.summaryHash);

      const decoder = new TextDecoder("utf-8", { fatal: true });
      const episodes = [] as Array<{
        readonly id: string;
        readonly kind: string;
        readonly sequence: number;
        readonly toolCallId: string | null;
        readonly contentJson: string;
        readonly contentArtifact: string;
        readonly byteSize: number;
      }>;
      for (const row of orderedRows) {
        const sourceUri = row.contentArtifact;
        const artifactMatch = sourceUri?.match(IMMUTABLE_ARTIFACT_URI) ?? null;
        const sourceHex = artifactMatch?.[1];
        if (sourceUri === null || sourceHex === undefined) {
          throw new Error(`compaction source ${row.id} has no immutable artifact`);
        }
        if (summary.sourceArtifacts[row.id] !== sourceUri) {
          throw new Error(`compaction source ${row.id} artifact identity changed`);
        }
        const bytes = await input.persistence.readCasBytes({
          contentHash: `sha256:${sourceHex.toLowerCase()}`,
        });
        if (!(bytes instanceof Uint8Array)) {
          throw new Error(`compaction source ${row.id} returned invalid CAS bytes`);
        }
        let contentJson: string;
        try {
          contentJson = decoder.decode(bytes);
        } catch {
          throw new Error(`compaction source ${row.id} contains invalid UTF-8`);
        }
        episodes.push({
          id: row.id,
          kind: row.kind,
          sequence: row.sequence,
          toolCallId: row.toolCallId,
          contentJson,
          contentArtifact: sourceUri,
          byteSize: bytes.byteLength,
        });
      }

      const query = request.query?.trim().toLowerCase() ?? "";
      const matchingEpisodes = query.length === 0
        ? episodes
        : episodes.filter((episode) => episode.contentJson.toLowerCase().includes(query));
      const offset = parseContinuation(request.continuation, request.summaryHash);
      const page = matchingEpisodes.slice(offset, offset + request.maxEpisodes);
      const nextOffset = offset + page.length;
      const continuation = nextOffset < matchingEpisodes.length
        ? continuationFor(request.summaryHash, nextOffset)
        : null;
      return {
        schemaVersion: COMPACTION_RECALL_VERSION,
        summaryHash: request.summaryHash,
        episodes: page,
        continuation,
      };
    },
  };
}

async function resolveExactSummary(
  persistence: CompactionRecallPersistence,
  expectedTurnId: string,
  summaryHash: string,
): Promise<ParsedSummary> {
  const rows = await persistence.listCurrentTurnSummaryRows({ turnId: expectedTurnId });
  const matches = rows
    .filter((row) => row.turnId === expectedTurnId)
    .map(parseSummaryRow)
    .filter((summary): summary is ParsedSummary => summary !== null && summary.summaryHash === summaryHash);
  if (matches.length !== 1) throw new Error(`compaction summary ${summaryHash} is unavailable`);
  return matches[0]!;
}

function parseSummaryRow(row: CompactionRecallSummaryRow): ParsedSummary | null {
  if (!Number.isSafeInteger(row.sequence) || row.sequence < 0) return null;
  let raw: unknown;
  try {
    raw = row.sourceVersionsJson === null ? null : JSON.parse(row.sourceVersionsJson) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(raw) || typeof raw.summaryHash !== "string" || !SUMMARY_HASH.test(raw.summaryHash)) return null;
  if (!Array.isArray(raw.sourceEpisodeIds) || raw.sourceEpisodeIds.length === 0) return null;
  const sourceEpisodeIds = raw.sourceEpisodeIds;
  if (!sourceEpisodeIds.every((id): id is string => typeof id === "string" && id.length > 0)) return null;
  if (new Set(sourceEpisodeIds).size !== sourceEpisodeIds.length) return null;
  if (sourceEpisodeIds.some(isDangerousKey)) return null;
  if (!isRecord(raw.sourceArtifacts) || Array.isArray(raw.sourceArtifacts)) return null;
  const sourceArtifacts: Record<string, string> = {};
  for (const id of sourceEpisodeIds) {
    if (!Object.prototype.hasOwnProperty.call(raw.sourceArtifacts, id)) return null;
    const uri = raw.sourceArtifacts[id];
    if (typeof uri !== "string" || !IMMUTABLE_ARTIFACT_URI.test(uri)) return null;
    sourceArtifacts[id] = uri;
  }
  const artifactKeys = Object.keys(raw.sourceArtifacts);
  if (artifactKeys.length !== sourceEpisodeIds.length || artifactKeys.some((id) => !sourceEpisodeIds.includes(id))) return null;
  return {
    id: row.id ?? "",
    sequence: row.sequence,
    summaryHash: raw.summaryHash,
    sourceEpisodeIds: [...sourceEpisodeIds],
    sourceArtifacts,
  };
}

function validateAndOrderSourceRows(
  rows: readonly CompactionRecallSourceRow[],
  selectedIds: readonly string[],
  selectedTurnId: string,
  summaryHash: string,
): readonly CompactionRecallSourceRow[] {
  const selected = new Set(selectedIds);
  if (rows.length !== selectedIds.length) {
    throw new Error(`compaction recall source set is incomplete for ${summaryHash}`);
  }
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.turnId !== selectedTurnId || !selected.has(row.id) || seen.has(row.id)) {
      throw new Error(`compaction recall source set is incomplete for ${summaryHash}`);
    }
    seen.add(row.id);
  }
  if (seen.size !== selected.size) throw new Error(`compaction recall source set is incomplete for ${summaryHash}`);
  return [...rows].sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id));
}

function parseContinuation(continuation: string | null, summaryHash: string): number {
  if (continuation === null) return 0;
  const prefix = `${COMPACTION_CONTINUATION_PREFIX}${encodeURIComponent(summaryHash)}:`;
  if (!continuation.startsWith(prefix)) {
    throw new Error("compaction recall continuation does not match the summary");
  }
  const rawOffset = continuation.slice(prefix.length);
  const offset = Number(rawOffset);
  if (!Number.isSafeInteger(offset) || offset < 0 || String(offset) !== rawOffset) {
    throw new Error("compaction recall continuation offset is invalid");
  }
  return offset;
}

function continuationFor(summaryHash: string, offset: number): string {
  return `${COMPACTION_CONTINUATION_PREFIX}${encodeURIComponent(summaryHash)}:${offset}`;
}

function assertTurn(expectedTurnId: string, actualTurnId: string): void {
  if (actualTurnId !== expectedTurnId) throw new Error(`compaction recall turn mismatch for ${actualTurnId}`);
}

function assertRecallRequest(request: CompactionRecallRequest): void {
  if (request.schemaVersion !== COMPACTION_RECALL_VERSION) throw new Error("unsupported compaction recall schema version");
  if (!SUMMARY_HASH.test(request.summaryHash)) throw new Error("compaction recall summaryHash is invalid");
  if (!Number.isSafeInteger(request.maxEpisodes) || request.maxEpisodes <= 0 || request.maxEpisodes > 10_000) {
    throw new Error("compaction recall maxEpisodes must be a positive safe integer");
  }
  if (!request.episodeIds.every((id) => typeof id === "string" && id.length > 0)) {
    throw new Error("compaction recall episode ids must be non-empty strings");
  }
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDangerousKey(value: string): boolean {
  return value === "__proto__" || value === "constructor" || value === "prototype";
}

import type { ContentHash, Episode } from "@terminus/domain";
import type { ArtifactClient } from "@terminus/artifact-client";
import type { ProviderToolCallChunk } from "@terminus/provider-core";
import { DEFAULT_MAX_TOOL_CYCLES, type InvalidToolCallError } from "../agent-tools.js";

export class ToolPolicyDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolPolicyDeniedError";
  }
}

export class ToolCycleBudgetExhaustedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolCycleBudgetExhaustedError";
  }
}

export interface ModelVisibleEpisodeSet {
  readonly episodes: readonly Episode[];
  readonly content: ReadonlyMap<ContentHash, string>;
}

export interface ToolEpisodeStore {
  readonly listModelVisibleEpisodes: (turnId: string) => Promise<readonly {
    readonly id: string;
    readonly turnId: string;
    readonly sequence: number;
    readonly kind: string;
    readonly contentArtifact: string | null;
    readonly toolCallId: string | null;
    readonly createdAt: Date;
  }[]>;
  readonly readArtifact: (hash: string) => Promise<Uint8Array | null>;
}

export interface ToolEpisodeSettlementInput {
  readonly call: ProviderToolCallChunk;
  readonly attemptNumber: number;
  readonly providerAttemptId: string;
  readonly turnId: string;
  readonly taskId: string;
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly contractVersion: number;
  readonly contractHash: string;
  readonly artifactClient: ArtifactClient;
  /**
   * Set when the loop already knows the call cannot run as sent — bad
   * arguments, or a tool not offered this turn. The settlement records an
   * error result the model can read instead of dispatching anything.
   */
  readonly rejection?: InvalidToolCallError | undefined;
}

export interface ToolEpisodeDependencies {
  readonly store: ToolEpisodeStore;
  readonly settleCall: (input: ToolEpisodeSettlementInput) => Promise<void>;
  readonly maxCycles?: number;
  /**
   * R4: byte budget for the model-visible episode window
   * (bytes ≈ tokens × 4). Default ≈ 96k tokens.
   */
  readonly windowBytes?: number;
}

export const DEFAULT_EPISODE_WINDOW_BYTES = 96_000 * 4;

export interface ToolEpisodeSession {
  readonly settle: (input: ToolEpisodeSettlementInput) => Promise<void>;
}

/**
 * Owns model-visible episode loading and per-turn tool-call admission.
 *
 * Transaction boundary: episode loading is read-only. Settlement is delegated
 * to the effect boundary, which commits the tool/effect state and semantic
 * event together after kernel dispatch settles.
 */
export class ToolEpisodeService {
  private readonly maxCycles: number;
  private readonly windowBytes: number;

  constructor(
    private readonly dependencies: ToolEpisodeDependencies,
  ) {
    this.maxCycles = dependencies.maxCycles ?? DEFAULT_MAX_TOOL_CYCLES;
    this.windowBytes = dependencies.windowBytes ?? DEFAULT_EPISODE_WINDOW_BYTES;
  }

  startTurn(): ToolEpisodeSession {
    const seenProviderCallIds = new Set<string>();
    return {
      settle: async (input): Promise<void> => {
        if (input.attemptNumber > this.maxCycles) {
          throw new ToolCycleBudgetExhaustedError(`Provider exceeded the ${this.maxCycles}-call turn budget`);
        }
        if (seenProviderCallIds.has(input.call.toolCallId)) {
          throw new ToolPolicyDeniedError(`Provider repeated tool call id '${input.call.toolCallId}'`);
        }
        seenProviderCallIds.add(input.call.toolCallId);
        await this.dependencies.settleCall(input);
      },
    };
  }

  async loadModelVisibleEpisodes(turnId: string): Promise<ModelVisibleEpisodeSet> {
    // R4: token-budgeted window replaces the fixed take(16). Scan the newest
    // model-visible rows first and include oldest rows only while they fit
    // the byte budget (bytes ≈ tokens × 4), so long turns degrade gracefully
    // instead of truncating at an arbitrary count.
    const rows = await this.dependencies.store.listModelVisibleEpisodes(turnId);
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const content = new Map<ContentHash, string>();
    type Row = (typeof rows)[number];
    const includedRows: Row[] = [];
    let budgetBytes = this.windowBytes;
    // Walk newest→oldest; include while budget allows.
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const row = rows[index]!;
      const contentRef: ContentHash | null = row.contentArtifact?.startsWith("artifact://sha256/")
        ? `sha256:${row.contentArtifact.slice("artifact://sha256/".length)}` as ContentHash
        : null;
      if (contentRef !== null && !content.has(contentRef)) {
        if (budgetBytes <= 0) break;
        const bytes = await this.dependencies.store.readArtifact(contentRef);
        if (bytes === null) throw new Error(`episode ${row.id} artifact ${contentRef} is unavailable`);
        if (bytes.byteLength > 128 * 1_024) {
          throw new Error(`episode ${row.id} exceeds the 131072-byte continuation limit`);
        }
        if (bytes.byteLength > budgetBytes) {
          // A single oversized episode can exceed what fits; include it only
          // when nothing else has been included yet so the window is never
          // empty, otherwise stop here.
          if (includedRows.length > 0) break;
          budgetBytes = bytes.byteLength;
        }
        budgetBytes -= bytes.byteLength;
        content.set(contentRef as ContentHash, decoder.decode(bytes));
      }
      includedRows.push(row);
    }
    includedRows.reverse();
    const episodes: Episode[] = [];
    for (const row of includedRows) {
      const contentRef: ContentHash | null = row.contentArtifact?.startsWith("artifact://sha256/")
        ? `sha256:${row.contentArtifact.slice("artifact://sha256/".length)}` as ContentHash
        : null;
      episodes.push({
        id: row.id as Episode["id"],
        turnId: row.turnId as Episode["turnId"],
        sequence: row.sequence,
        kind: row.kind as Episode["kind"],
        contentRef: contentRef as Episode["contentRef"],
        providerAttemptId: null,
        toolCallId: row.toolCallId as Episode["toolCallId"],
        occurredAt: row.createdAt.toISOString() as Episode["occurredAt"],
      });
    }
    return { episodes, content };
  }
}

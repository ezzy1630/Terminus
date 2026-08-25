import type { ContentHash, Episode } from "@terminus/domain";
import type { ArtifactClient } from "@terminus/artifact-client";
import type { ProviderToolCallChunk } from "@terminus/provider-core";
import { DEFAULT_MAX_TOOL_CYCLES } from "../agent-tools.js";

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
}

export interface ToolEpisodeDependencies {
  readonly store: ToolEpisodeStore;
  readonly settleCall: (input: ToolEpisodeSettlementInput) => Promise<void>;
  readonly maxCycles?: number;
}

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

  constructor(
    private readonly dependencies: ToolEpisodeDependencies,
  ) {
    this.maxCycles = dependencies.maxCycles ?? DEFAULT_MAX_TOOL_CYCLES;
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
    const rows = await this.dependencies.store.listModelVisibleEpisodes(turnId);
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const content = new Map<ContentHash, string>();
    let totalBytes = 0;
    const episodes: Episode[] = [];
    for (const row of rows) {
      const contentRef: ContentHash | null = row.contentArtifact?.startsWith("artifact://sha256/")
        ? `sha256:${row.contentArtifact.slice("artifact://sha256/".length)}` as ContentHash
        : null;
      if (contentRef !== null && !content.has(contentRef)) {
        const bytes = await this.dependencies.store.readArtifact(contentRef);
        if (bytes === null) throw new Error(`episode ${row.id} artifact ${contentRef} is unavailable`);
        if (bytes.byteLength > 128 * 1_024) {
          throw new Error(`episode ${row.id} exceeds the 131072-byte continuation limit`);
        }
        totalBytes += bytes.byteLength;
        if (totalBytes > 512 * 1_024) {
          throw new Error("model-visible episodes exceed the 524288-byte continuation limit");
        }
        content.set(contentRef as ContentHash, decoder.decode(bytes));
      }
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

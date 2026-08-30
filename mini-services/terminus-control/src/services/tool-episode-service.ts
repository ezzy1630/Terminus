import type { ContentHash, Episode } from "@terminus/domain";
import type { ArtifactClient } from "@terminus/artifact-client";
import type { ProviderToolCallChunk } from "@terminus/provider-core";
import { DEFAULT_MAX_TOOL_CYCLES, type InvalidToolCallError } from "../agent-tools.js";
import { MAX_MODEL_VISIBLE_EPISODE_BYTES } from "../agent/model-visible-limits.js";

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

export interface ModelVisibleEpisodeWindow {
  readonly maxTokens: number;
  readonly estimateTextTokens: (text: string) => number;
  readonly messageEnvelopeTokens: number;
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
   * Legacy byte budget used only when the caller has no selected-model token
   * window. The live control loop supplies a token window.
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

  async loadModelVisibleEpisodes(
    turnId: string,
    tokenWindow?: ModelVisibleEpisodeWindow,
  ): Promise<ModelVisibleEpisodeSet> {
    // R4: token-budgeted window replaces the fixed take(16). Scan the newest
    // model-visible rows first and include older rows only while they fit the
    // selected-model window. The byte path remains for compatibility callers.
    const rows = await this.dependencies.store.listModelVisibleEpisodes(turnId);
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const content = new Map<ContentHash, string>();
    type Row = (typeof rows)[number];
    const includedRows: Row[] = [];
    let budgetBytes = this.windowBytes;
    let budgetTokens = tokenWindow?.maxTokens ?? null;
    if (budgetTokens !== null && (!Number.isSafeInteger(budgetTokens) || budgetTokens < 0)) {
      throw new Error("episode token window must be a non-negative safe integer");
    }
    // Walk newest→oldest; include while budget allows.
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const row = rows[index]!;
      const contentRef: ContentHash | null = row.contentArtifact?.startsWith("artifact://sha256/")
        ? `sha256:${row.contentArtifact.slice("artifact://sha256/".length)}` as ContentHash
        : null;
      let text = contentRef === null ? "" : content.get(contentRef);
      let bytesLength = 0;
      if (contentRef !== null && text === undefined) {
        const bytes = await this.dependencies.store.readArtifact(contentRef);
        if (bytes === null) throw new Error(`episode ${row.id} artifact ${contentRef} is unavailable`);
        if (bytes.byteLength > MAX_MODEL_VISIBLE_EPISODE_BYTES) {
          throw new Error(
            `episode ${row.id} exceeds the ${MAX_MODEL_VISIBLE_EPISODE_BYTES}-byte continuation limit`,
          );
        }
        bytesLength = bytes.byteLength;
        text = decoder.decode(bytes);
        content.set(contentRef as ContentHash, text);
      } else if (text !== undefined) {
        bytesLength = new TextEncoder().encode(text).byteLength;
      }
      if (tokenWindow !== undefined) {
        const rowTokens = tokenWindow.estimateTextTokens(text ?? "")
          + tokenWindow.messageEnvelopeTokens;
        if (!Number.isSafeInteger(rowTokens) || rowTokens < 0) {
          throw new Error(`episode ${row.id} has an invalid token estimate`);
        }
        const remainingTokens = budgetTokens ?? 0;
        if (remainingTokens < rowTokens) {
          if (includedRows.length > 0) break;
          budgetTokens = rowTokens;
        }
        budgetTokens = (budgetTokens ?? 0) - rowTokens;
      } else if (contentRef !== null) {
        if (budgetBytes <= 0) break;
        if (bytesLength > budgetBytes) {
          // A single oversized episode can exceed what fits; include it only
          // when nothing else has been included yet so the window is never
          // empty, otherwise stop here.
          if (includedRows.length > 0) break;
          budgetBytes = bytesLength;
        }
        budgetBytes -= bytesLength;
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

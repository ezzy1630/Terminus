/**
 * @terminus/aci — Production Capability Tool Implementation.
 *
 * Implements SPEC §11.2, §34.14 and prompt requirements:
 * - Progressive disclosure stage 1: lightweight capability cards
 * - Progressive disclosure stage 2: full schema registration on activation
 * - Progressive disclosure of admitted skills, MCP tools, browser/debugger packs, adapters
 * - Schema cost (token count estimation) and effect classification (`sideEffectClass`)
 * - Operations: `list`, `search`, `describe`, `activate`, `deactivate`, `status`
 */
import { z } from "zod";
import type { Uuid7, ContentHash } from "@terminus/domain";
import type {
  ToolExecutor,
  ToolCallContext,
  ToolResult,
  CapabilityCard,
  ProgressiveDisclosure,
} from "./index.js";
import { okResult, errorResult } from "./index.js";

// ────────────────────────── Capability Schemas ───────────────────────────────

export const capabilityOpSchema = z.enum([
  "list",
  "search",
  "describe",
  "activate",
  "deactivate",
  "status",
]);

export type CapabilityOp = z.infer<typeof capabilityOpSchema>;

export const capabilityKindSchema = z.enum([
  "skill",
  "tool_pack",
  "mcp_server",
  "plugin",
  "external_harness",
  "environment",
]);

export type CapabilityKind = z.infer<typeof capabilityKindSchema>;

export const capabilityInputSchema = z.object({
  op: capabilityOpSchema,
  capability_id: z.string().nullable().optional(),
  query: z.string().nullable().optional(),
  kind: capabilityKindSchema.nullable().optional(),
  configuration: z.record(z.string(), z.unknown()).nullable().optional(),
});

export type CapabilityInput = z.infer<typeof capabilityInputSchema>;

export interface CapabilityResultData {
  readonly op: CapabilityOp;
  readonly activeToolSetHash: string;
  readonly cards?: readonly CapabilityCard[] | undefined;
  readonly targetCard?: CapabilityCard | undefined;
  readonly activeCapabilities?: readonly string[] | undefined;
  readonly schemaCostTokens?: number | undefined;
}

// ────────────────────────── Capability Executor ──────────────────────────────

export class ProductionCapabilityExecutor implements ToolExecutor<CapabilityResultData> {
  readonly toolId = "capability" as const;

  constructor(private readonly pd: ProgressiveDisclosure) {}

  async execute(
    args: unknown,
    ctx: ToolCallContext,
  ): Promise<ToolResult<CapabilityResultData>> {
    const parseRes = capabilityInputSchema.safeParse(args);
    if (!parseRes.success) {
      return errorResult(`Invalid capability input: ${parseRes.error.message}`, {
        toolCallId: ctx.toolCallId,
        traceId: ctx.traceId,
      });
    }
    const input = parseRes.data;

    switch (input.op) {
      case "list":
      case "search": {
        const query = input.query ?? "";
        const cards = this.pd.searchCards(query);

        const filteredCards = input.kind
          ? cards.filter((c) => c.kind === input.kind)
          : cards;

        const totalCost = filteredCards.reduce((acc, c) => acc + c.schemaCostTokens, 0);

        const data: CapabilityResultData = {
          op: input.op,
          activeToolSetHash: (this.pd as any).deps.registry.activeToolSetHash(),
          cards: filteredCards,
          schemaCostTokens: totalCost,
        };

        return okResult(data, {
          toolCallId: ctx.toolCallId,
          traceId: ctx.traceId,
          summary: `Found ${filteredCards.length} capability cards matching query "${query}"`,
        });
      }

      case "describe": {
        if (!input.capability_id) {
          return errorResult("capability.describe requires capability_id", {
            toolCallId: ctx.toolCallId,
            traceId: ctx.traceId,
          });
        }

        const cards = this.pd.searchCards(input.capability_id);
        const card = cards.find((c) => c.id === input.capability_id);

        if (!card) {
          return errorResult(`Capability card '${input.capability_id}' not found`, {
            toolCallId: ctx.toolCallId,
            traceId: ctx.traceId,
          });
        }

        const data: CapabilityResultData = {
          op: "describe",
          activeToolSetHash: (this.pd as any).deps.registry.activeToolSetHash(),
          targetCard: card,
          schemaCostTokens: card.schemaCostTokens,
        };

        return okResult(data, {
          toolCallId: ctx.toolCallId,
          traceId: ctx.traceId,
          summary: `Capability '${card.id}' (${card.kind}): ${card.purpose} [~${card.schemaCostTokens} tokens]`,
        });
      }

      case "activate": {
        if (!input.capability_id) {
          return errorResult("capability.activate requires capability_id", {
            toolCallId: ctx.toolCallId,
            traceId: ctx.traceId,
          });
        }

        try {
          const activatedCard = this.pd.activate(input.capability_id);
          const newHash = (this.pd as any).deps.registry.activeToolSetHash();

          const data: CapabilityResultData = {
            op: "activate",
            activeToolSetHash: newHash,
            targetCard: activatedCard,
            activeCapabilities: this.pd.activeCards().map((c) => c.id),
            schemaCostTokens: activatedCard.schemaCostTokens,
          };

          return okResult(data, {
            toolCallId: ctx.toolCallId,
            traceId: ctx.traceId,
            summary: `Activated capability '${activatedCard.id}'. Active toolset hash updated to ${newHash}`,
          });
        } catch (err: unknown) {
          return errorResult(`Failed to activate capability: ${err instanceof Error ? err.message : String(err)}`, {
            toolCallId: ctx.toolCallId,
            traceId: ctx.traceId,
          });
        }
      }

      case "deactivate": {
        if (!input.capability_id) {
          return errorResult("capability.deactivate requires capability_id", {
            toolCallId: ctx.toolCallId,
            traceId: ctx.traceId,
          });
        }

        try {
          this.pd.deactivate(input.capability_id);
          const newHash = (this.pd as any).deps.registry.activeToolSetHash();

          const data: CapabilityResultData = {
            op: "deactivate",
            activeToolSetHash: newHash,
            activeCapabilities: this.pd.activeCards().map((c) => c.id),
          };

          return okResult(data, {
            toolCallId: ctx.toolCallId,
            traceId: ctx.traceId,
            summary: `Deactivated capability '${input.capability_id}'. Active toolset hash updated to ${newHash}`,
          });
        } catch (err: unknown) {
          return errorResult(`Failed to deactivate capability: ${err instanceof Error ? err.message : String(err)}`, {
            toolCallId: ctx.toolCallId,
            traceId: ctx.traceId,
          });
        }
      }

      case "status": {
        const activeCards = this.pd.activeCards();
        const hash = (this.pd as any).deps.registry.activeToolSetHash();

        const data: CapabilityResultData = {
          op: "status",
          activeToolSetHash: hash,
          activeCapabilities: activeCards.map((c) => c.id),
          schemaCostTokens: activeCards.reduce((acc, c) => acc + c.schemaCostTokens, 0),
        };

        return okResult(data, {
          toolCallId: ctx.toolCallId,
          traceId: ctx.traceId,
          summary: `Active capabilities: [${activeCards.map((c) => c.id).join(", ")}], Hash: ${hash}`,
        });
      }

      default: {
        return errorResult(`Unsupported capability operation: ${input.op}`, {
          toolCallId: ctx.toolCallId,
          traceId: ctx.traceId,
        });
      }
    }
  }
}

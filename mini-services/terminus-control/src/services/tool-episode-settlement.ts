import { randomUUID } from "node:crypto";
import type { ToolResult } from "@terminus/aci";
import type { ArtifactClient } from "@terminus/artifact-client";
import type { ProviderToolCallChunk } from "@terminus/provider-core";
import { z } from "zod";
import { canonicalJson } from "@terminus/context-ir";
import type {
  CapabilityTransitionEvent,
} from "../agent/capability-discovery.js";
import type { EngineToolSettlement } from "../agent/coding-turn-engine.js";
export type { EngineToolSettlement };
import type { CapabilityDiscoverySession } from "../agent/capability-discovery.js";
import {
  MAX_TOOL_MODEL_RESULT_BYTES,
  projectModelVisibleResult,
  providerToolResultTranscript,
  type ExecutedToolResult,
  type InvalidToolCallError,
  type ObservedSourceTracker,
  type ParsedStandaloneToolCall,
  type ProviderCallIdentity,
  type ToolDenialMetadata,
} from "../agent-tools.js";
import type { MutationRunner, ServiceEventInput } from "./service-types.js";

/** The Prisma transaction shape the denial write needs (narrow, local). */
interface PrismaToolDenialTx {
  readonly policyDecision: {
    readonly create: (data: unknown) => Promise<unknown>;
  };
  readonly toolCall: {
    readonly update: (input: unknown) => Promise<unknown>;
  };
}
import type { EffectSettlementInput } from "./effect-settlement-service.js";

/**
 * The exact input a standalone tool settlement needs. Owned by the tool
 * episode boundary; the composition root builds it per call.
 */
export interface StandaloneToolSettlementInput {
  readonly callChunk: ProviderToolCallChunk;
  readonly providerAttemptId: string;
  readonly turnId: string;
  readonly threadId: string;
  readonly turnSequence: number;
  readonly taskId: string;
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly contractVersion: number;
  readonly contractHash: string;
  readonly artifactClient: ArtifactClient;
  readonly observedSources: ObservedSourceTracker;
  readonly capabilitySession: CapabilityDiscoverySession;
  /** Compute the exact post-transition schema ids before atomic settlement. */
  readonly nextWorkspaceToolIds: () => readonly string[];
  /** Read the authoritative workspace identity around the kernel effect. */
  readonly workspaceRevision?: (() => Promise<string | null>) | undefined;
  /** Current verifier/repair association, if this turn has one. */
  readonly operationContext?: (() => {
    readonly verificationDelta?: string | null | undefined;
    readonly hypothesisId?: string | null | undefined;
    readonly criterionIds?: readonly string[] | undefined;
    readonly objectiveStep?: string | null | undefined;
  }) | undefined;
  readonly signal?: AbortSignal | null;
  /** The loop already rejected this call; settle the correction, run nothing. */
  readonly rejection?: InvalidToolCallError | undefined;
}

export const TOOL_ARGUMENTS_EXCERPT_MAX_CHARS = 240;

/** Ports the settlement path needs from the composition root. */
export interface ToolEpisodeSettlementPorts {
  /** Serialized state mutation (the composition root's agent-state mutex). */
  readonly mutate: MutationRunner;
  /** Semantic event publication; the mutation runs in the same transaction. */
  readonly emit: (input: {
    eventType: string;
    aggregateType: string;
    aggregateId: string;
    correlationId?: string | undefined;
    payload: unknown;
    artifactRefs?: string[] | undefined;
  }, mutation?: (tx: unknown) => Promise<void>) => Promise<unknown>;
  /**
   * Exactly-once logical tool settlement (durable effect boundary). The
   * transaction type is owned by the composition root; the settlement path
   * never touches it.
   */
  readonly settleEffect: (
    input: EffectSettlementInput,
    companionEvents?: readonly ServiceEventInput[],
  ) => Promise<void>;
}

/**
 * A short, human-readable operand for a proposed tool call — the path being
 * read, the command being run, the pattern being searched for.
 *
 * The full arguments are already ingested as a linked artifact, but artifact
 * refs do not travel on the v1 event stream, so without this a client can only
 * say that *some* read happened. The excerpt is bounded and carries operands
 * the model chose, never file contents: `patch` deliberately reports only its
 * path, because its arguments hold whole file bodies.
 */
export function toolArgumentsExcerpt(call: ParsedStandaloneToolCall): string {
  const excerpt = ((): string => {
    switch (call.toolId) {
      case "capability":
        return "capability_id" in call.arguments
          ? `${call.arguments.action}: ${call.arguments.capability_id}`
          : "query" in call.arguments && call.arguments.query !== undefined
            ? `${call.arguments.action}: ${call.arguments.query}`
            : call.arguments.action;
      case "read":
      case "patch":
      case "write":
        return call.arguments.path;
      case "exec": {
        const shell = call.arguments.shell;
        if (shell !== undefined) return shell.script;
        const program = call.arguments.program ?? "";
        return [program, ...call.arguments.args].join(" ").trim();
      }
      case "exec_poll":
        return call.arguments.background_id;
      case "web_fetch":
        return call.arguments.url;
      case "grep":
        return `${call.arguments.pattern} in ${call.arguments.path}`;
      case "glob":
        return call.arguments.pattern;
      case "inspect":
        return call.arguments.action === "symbol"
          ? `${call.arguments.action}: ${call.arguments.query}`
          : call.arguments.action;
      case "recall":
        return call.arguments.action === "search"
          ? `${call.arguments.action}: ${call.arguments.query}`
          : call.arguments.action === "read"
            ? `${call.arguments.action}: turn ${call.arguments.turn_sequence}`
            : call.arguments.action;
    }
  })();
  const codePoints = Array.from(excerpt);
  return codePoints.length <= TOOL_ARGUMENTS_EXCERPT_MAX_CHARS
    ? excerpt
    : `${codePoints.slice(0, TOOL_ARGUMENTS_EXCERPT_MAX_CHARS - 1).join("")}…`;
}
/** `path → sha256` observations a settled result proves, bounded and clean. */
export function observedSourceVersionsOf(result: ToolResult<unknown>): Record<string, string> {
  const sources: Record<string, string> = {};
  if (result.status !== "success" && result.status !== "partial") return sources;
  for (const [path, sha256] of Object.entries(result.sourceVersions ?? {})) {
    if (typeof sha256 !== "string" || !/^sha256:[0-9a-f]{64}$/.test(sha256)) continue;
    if (path.length === 0 || path.length > 4_096) continue;
    sources[path] = sha256;
  }
  return sources;
}
export async function persistSettledToolResult(
  ports: ToolEpisodeSettlementPorts,
  input: {
    readonly input: StandaloneToolSettlementInput;
  /** A parsed call, or the identity of a rejected one. */
  readonly call: ProviderCallIdentity;
  readonly toolCallId: string;
  readonly callTranscriptArtifactUri: string;
  readonly sideEffectId: string | null;
  readonly result: ToolResult<unknown>;
  /** Structured provenance retained in the full result artifact and loop. */
  readonly denial?: ToolDenialMetadata | undefined;
  /** Optional data projection; the full result artifact retains result.data. */
  readonly modelVisibleData?: unknown;
  readonly workspaceRevisionBefore?: string | null | undefined;
  readonly workspaceRevisionAfter?: string | null | undefined;
  readonly verificationDelta?: string | null | undefined;
  readonly hypothesisId?: string | null | undefined;
  readonly criterionIds?: readonly string[] | undefined;
  readonly objectiveStep?: string | null | undefined;
    /** Semantic transitions committed atomically with the settled tool result. */
    readonly settlementEvents?: readonly CapabilityTransitionEvent[] | undefined;
  },
): Promise<EngineToolSettlement> {
  // Keep the model-facing projection minimal, while the authoritative result
  // artifact retains denial provenance and the kernel decision identity.
  const durableResult: ExecutedToolResult = input.denial === undefined
    ? input.result
    : { ...input.result, denial: input.denial };
  const fullResultText = canonicalJson(durableResult);
  const fullResultArtifact = await input.input.artifactClient.ingest(
    new TextEncoder().encode(fullResultText),
    { mediaType: "application/json", custom: { purpose: "tool-result", toolCallId: input.toolCallId } },
  );
  await input.input.artifactClient.link(fullResultArtifact.hash, "tool_call", input.toolCallId, "result");
  const fullResultBytes = new TextEncoder().encode(fullResultText).byteLength;
  // Dual-path projection (ADR-0039 §11): the model-visible transcript carries
  // a minimal view of the same settled result; ceremony stays in the
  // observability artifact ingested above.
  const modelVisibleRecord = projectModelVisibleResult(
    input.result,
    input.modelVisibleData === undefined ? undefined : { data: input.modelVisibleData },
  );
  const projectedResult = fullResultBytes <= MAX_TOOL_MODEL_RESULT_BYTES
    ? modelVisibleRecord
    : z.record(z.string(), z.unknown()).parse(canonicalJson({
        ...modelVisibleRecord,
        data: null,
        summary: `${input.result.summary} Full result: ${fullResultArtifact.uri}`,
        truncation: {
          occurred: true,
          reason: `tool result exceeded ${MAX_TOOL_MODEL_RESULT_BYTES} model bytes`,
          continuation: fullResultArtifact.uri,
        },
      }));
  const resultTranscriptText = canonicalJson(providerToolResultTranscript(input.call, projectedResult));
  if (new TextEncoder().encode(resultTranscriptText).byteLength > MAX_TOOL_MODEL_RESULT_BYTES) {
    throw new Error("bounded tool result transcript still exceeds the model-result limit");
  }
  const resultTranscriptArtifact = await input.input.artifactClient.ingest(
    new TextEncoder().encode(resultTranscriptText),
    { mediaType: "application/json", custom: { purpose: "tool-result-transcript", toolCallId: input.toolCallId } },
  );
  await input.input.artifactClient.link(resultTranscriptArtifact.hash, "tool_call", input.toolCallId, "provider-result-transcript");

  const toolState = input.result.status === "denied"
    ? "DENIED"
    : input.result.status === "success" || input.result.status === "partial"
      ? "SETTLED"
      : "FAILED";
  await ports.settleEffect({
    taskId: input.input.taskId,
    turnId: input.input.turnId,
    providerAttemptId: input.input.providerAttemptId,
    toolCallId: input.toolCallId,
    toolId: input.call.toolId,
    sideEffectId: input.sideEffectId,
    providerCallId: input.call.providerCallId,
    status: input.result.status,
    resultStatus: input.result.status,
    toolState,
    summary: input.result.summary,
    callTranscriptArtifactUri: input.callTranscriptArtifactUri,
    resultArtifactUri: fullResultArtifact.uri,
    resultTranscriptArtifactUri: resultTranscriptArtifact.uri,
    resultTranscriptHash: resultTranscriptArtifact.hash,
    errorJson: toolState === "SETTLED"
      ? null
      : JSON.stringify({
          summary: input.result.summary,
          ...(input.denial === undefined ? {} : { denial: input.denial }),
        }),
    truncation: input.result.truncation,
    observedSourceVersions: observedSourceVersionsOf(input.result),
  }, input.settlementEvents ?? []);
  const status = input.result.status;
  return {
    status: status === "success" || status === "partial" || status === "error"
      || status === "denied" || status === "timeout" || status === "cancelled" || status === "unknown"
      ? status
      : "unknown",
    resultHash: fullResultArtifact.hash,
    errorCode: status === "success" || status === "partial"
      ? null
      : input.denial?.origin === "kernel"
        ? "KERNEL_POLICY_DENIED"
        : `TOOL_RESULT_${status.toUpperCase()}`,
    errorClass: status === "success" || status === "partial"
      ? null
      : input.denial?.origin === "kernel" ? "kernel_policy_denied" : status,
    denial: input.denial,
    workspaceRevisionBefore: input.workspaceRevisionBefore ?? null,
    workspaceRevisionAfter: input.workspaceRevisionAfter ?? null,
    verificationDelta: input.verificationDelta ?? null,
    hypothesisId: input.hypothesisId ?? null,
    criterionIds: input.criterionIds,
    objectiveStep: input.objectiveStep ?? null,
  };
}
export async function denyStandaloneTool(
  ports: ToolEpisodeSettlementPorts,
  input: {
    readonly input: StandaloneToolSettlementInput;
    readonly call: ParsedStandaloneToolCall;
    readonly toolCallId: string;
    readonly argumentsArtifactUri: string;
    readonly effectType: string;
    readonly ruleId: string;
    readonly explanation: string;
  },
): Promise<string> {
  const policyDecisionId = randomUUID();
  await ports.mutate(() => ports.emit({
    eventType: "tool.denied",
    aggregateType: "tool_call",
    aggregateId: input.toolCallId,
    correlationId: input.input.taskId,
    payload: {
      tool_call_id: input.toolCallId,
      tool_id: input.call.toolId,
      provider_call_id: input.call.providerCallId,
      policy_decision_id: policyDecisionId,
      rule_id: input.ruleId,
      explanation: input.explanation,
    },
    artifactRefs: [input.argumentsArtifactUri],
  }, async (transaction) => {
    const tx = transaction as PrismaToolDenialTx;
    await tx.policyDecision.create({
      data: {
        id: policyDecisionId,
        toolCallId: input.toolCallId,
        effectType: input.effectType,
        normalizedInputArtifact: input.argumentsArtifactUri,
        decision: "deny",
        ruleIdsJson: JSON.stringify([input.ruleId]),
        constraintsJson: "{}",
        policyVersion: "secure-local-default:v1",
        explanation: input.explanation,
      },
    });
    await tx.toolCall.update({
      where: { id: input.toolCallId },
      data: { state: "DENIED", policyDecisionId, settledAt: new Date(), resultStatus: "denied" },
    });
  }));
  return policyDecisionId;
}
import { CleanContextReviewer, type CleanReviewContext } from "@terminus/orchestration";
import { z } from "zod";
import { SCOUT_TOOL_NAMES, type DelegationAuthority } from "./delegation-runner.js";

/**
 * Conditional subagents (deep-audit Rank 7 / PR10).
 *
 * Scout/reviewer children are NOT enabled by default. Per the audit's exit
 * gate, a child type is enabled only for cohorts where its lower confidence
 * bound on verified utility is positive; until a signed ablation shows that,
 * the flag stays off and the production loop remains single-agent.
 *
 * This module provides the typed boundary for the two supported child kinds:
 * - read-only scout: fresh context, search/read/code-intel only;
 * - clean-context reviewer: task contract + diff + evidence, no actor
 *   transcript, no write authority.
 *
 * Child results are typed and bounded — full child transcripts are never
 * pasted into the parent context.
 */

export const SUBAGENT_FLAGS = {
  scout: "TERMINUS_ENABLE_SCOUT",
  reviewer: "TERMINUS_ENABLE_REVIEWER",
} as const;

export type SubagentKind = keyof typeof SUBAGENT_FLAGS;

/** Feature gate: default OFF unless the env flag is explicitly "1". */
export function subagentEnabled(kind: SubagentKind, env: NodeJS.ProcessEnv = process.env): boolean {
  return env[SUBAGENT_FLAGS[kind]] === "1";
}

/**
 * Narrow a parent authority for a read-only scout. This is an attenuation,
 * never an expansion: every child path must be covered by a parent path and
 * the child can only receive the fixed read/search tool set.
 */
export function attenuateScoutAuthority(input: {
  readonly parentTaskId: string;
  readonly delegationId: string;
  readonly parentAllowedTools: readonly string[];
  readonly parentReadPaths: readonly string[];
  readonly requestedReadPaths: readonly string[];
}): DelegationAuthority {
  if (input.parentTaskId.trim() === "" || input.delegationId.trim() === "") {
    throw new Error("scout authority requires parent and delegation ids");
  }
  const tools = SCOUT_TOOL_NAMES.filter((tool) => input.parentAllowedTools.includes(tool));
  if (tools.length === 0) throw new Error("parent authority grants no scout tools");
  const requested = input.requestedReadPaths.length === 0 ? ["**"] : input.requestedReadPaths;
  if (requested.some((path) => path.trim() === "")) throw new Error("scout read paths must not be blank");
  if (requested.some((path) => !input.parentReadPaths.some((parent) => pathCoveredBy(path, parent)))) {
    throw new Error("scout read paths exceed parent authority");
  }
  return {
    allowedTools: tools,
    allowedReadPaths: [...requested],
    allowedWritePaths: [],
    deniedEffects: ["filesystem.write", "process.exec", "external_effect"],
  };
}

function pathCoveredBy(path: string, parent: string): boolean {
  const child = path.replace(/\/+$|^\/+/, "");
  const scope = parent.replace(/\/+$|^\/+/, "");
  if (scope === "**" || scope === "") return true;
  if (scope.endsWith("/**")) return child === scope.slice(0, -3) || child.startsWith(scope.slice(0, -2));
  return child === scope || child.startsWith(`${scope}/`);
}

const typedChildResultSchema = z.object({
  status: z.enum(["completed", "budget_exhausted", "cancelled", "failed"]),
  claims: z.array(z.string()).max(64),
  evidenceRefs: z.array(z.string()).max(64),
  filesInspected: z.array(z.string()).max(256),
  filesChanged: z.array(z.string()).max(0),
  testsRun: z.array(z.string()).max(0),
  remainingRisks: z.array(z.string()).max(32),
  costMicros: z.union([z.bigint().nonnegative(), z.number().int().nonnegative()]),
  tokens: z.union([z.bigint().nonnegative(), z.number().int().nonnegative()]),
  wallTimeMs: z.number().int().nonnegative(),
}).strict();

export type TypedChildResult = z.infer<typeof typedChildResultSchema>;

/**
 * Validate a scout result against the child contract: scouts must not
 * report file changes or test runs (read-only authority is enforced by the
 * kernel scope, this enforces honest reporting).
 */
export function validateScoutResult(result: unknown): TypedChildResult {
  const parsed = typedChildResultSchema.parse(result);
  if (parsed.status === "completed" && parsed.claims.length === 0 && parsed.filesInspected.length === 0) {
    throw new Error("completed scout result must include claims or inspected files");
  }
  return parsed;
}

export interface ReviewerInput {
  readonly contract: CleanReviewContext["contract"];
  readonly candidateDiff: string;
  readonly changedFiles: readonly string[];
}

export interface ReviewerVerdict {
  readonly systemPrompt: string;
  readonly contextPayload: Record<string, unknown>;
}

/**
 * Build the clean-context reviewer payload. The reviewer sees the task
 * contract, diff, and evidence — never the actor's chain of thought.
 */
export function buildCleanReview(input: ReviewerInput): ReviewerVerdict {
  const reviewer = new CleanContextReviewer();
  return reviewer.buildCleanReviewPayload({
    taskId: "review",
    contract: input.contract,
    candidateDiff: input.candidateDiff.slice(0, 128_000),
    changedFiles: input.changedFiles,
    verificationEvidence: [],
    riskClass: "normal",
    implementerModelFamilyRef: "unknown",
  } satisfies CleanReviewContext);
}

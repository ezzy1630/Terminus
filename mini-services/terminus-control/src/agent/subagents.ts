import { CleanContextReviewer, type CleanReviewContext } from "@terminus/orchestration";
import { z } from "zod";

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

const typedChildResultSchema = z.object({
  status: z.enum(["completed", "budget_exhausted", "failed"]),
  claims: z.array(z.string()).max(64),
  evidenceRefs: z.array(z.string()).max(64),
  filesInspected: z.array(z.string()).max(256),
  filesChanged: z.array(z.string()).max(0),
  testsRun: z.array(z.string()).max(0),
  remainingRisks: z.array(z.string()).max(32),
  costMicros: z.bigint().or(z.number()),
  tokens: z.bigint().or(z.number()),
  wallTimeMs: z.number(),
});

export type TypedChildResult = z.infer<typeof typedChildResultSchema>;

/**
 * Validate a scout result against the child contract: scouts must not
 * report file changes or test runs (read-only authority is enforced by the
 * kernel scope, this enforces honest reporting).
 */
export function validateScoutResult(result: unknown): TypedChildResult {
  return typedChildResultSchema.parse(result);
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
    riskClass: "medium",
    implementerModelFamilyRef: "unknown",
  } satisfies CleanReviewContext);
}

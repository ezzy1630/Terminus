import { canonicalJson, computeContentHash } from "@terminus/context-ir";

/**
 * Bounded verify–repair–admit controller (deep-audit Rank 3 / PR5).
 *
 * An actor response is a PROPOSAL to complete, never completion itself.
 * When required verification fails, this controller normalizes each failure
 * into a durable, comparable repair input, detects stagnation across repair
 * attempts, and decides whether a bounded same-session repair turn can
 * proceed. Independent verification stays outside the actor's write
 * authority: this module only shapes context and policy — it never marks a
 * failing predicate as passing.
 */

export interface NormalizedFailure {
  readonly predicateId: string;
  readonly nodeId: string;
  readonly command: string | null;
  readonly exitCode: number | null;
  /** Focused diagnostic slice (bounded). */
  readonly diagnostic: string;
  /** Relevant source/diff artifact references. */
  readonly artifactRefs: readonly string[];
  /** Hash of the failure signature used for change detection. */
  readonly signatureHash: string;
}

export interface RawVerificationFailure {
  readonly nodeId: string;
  readonly predicateType: string;
  readonly command?: string | null;
  readonly exitCode?: number | null;
  /** Combined stdout/stderr projection of the failed predicate. */
  readonly output: string;
  readonly artifactRefs?: readonly string[];
}

const MAX_DIAGNOSTIC_CHARS = 4_000;

/** Extract the focused diagnostic tail — the useful failing tail. */
function focusDiagnostic(output: string): string {
  const trimmed = output.trim();
  if (trimmed.length <= MAX_DIAGNOSTIC_CHARS) return trimmed;
  return `…(earlier output elided)\n${trimmed.slice(-MAX_DIAGNOSTIC_CHARS)}`;
}

export function normalizeFailure(raw: RawVerificationFailure): NormalizedFailure {
  const diagnostic = focusDiagnostic(raw.output);
  const signature = computeContentHash(
    canonicalJson({
      node_id: raw.nodeId,
      exit_code: raw.exitCode ?? null,
      // The signature intentionally excludes timestamps/durations but keeps
      // the diagnostic so "same failure" means byte-identical diagnostics.
      diagnostic,
    }),
  );
  return {
    predicateId: raw.predicateType,
    nodeId: raw.nodeId,
    command: raw.command ?? null,
    exitCode: raw.exitCode ?? null,
    diagnostic,
    artifactRefs: raw.artifactRefs ?? [],
    signatureHash: signature,
  };
}

/**
 * ProgressDetector: stop or replan when nothing changes.
 *
 * A repair attempt makes progress iff (a) any failure signature changed,
 * or (b) the workspace changed since the previous attempt. Repeating the
 * identical verifier input/output without a workspace mutation is
 * stagnation.
 */
export class ProgressDetector {
  private lastSignatures: ReadonlySet<string> = new Set();
  private readonly seenAcrossAttempts: ReadonlySet<string>[] = [];

  /**
   * Record one attempt's normalized failures and whether the workspace
   * changed since the previous attempt. Returns progress analysis.
   */
  recordAttempt(
    failures: readonly NormalizedFailure[],
    workspaceChanged: boolean,
  ): { readonly progressed: boolean; readonly repeatedAll: boolean } {
    const signatures = new Set(failures.map((failure) => failure.signatureHash));
    let repeatedAll =
      signatures.size > 0 && signatures.size === this.lastSignatures.size;
    if (repeatedAll) {
      for (const signature of signatures) {
        if (!this.lastSignatures.has(signature)) {
          repeatedAll = false;
          break;
        }
      }
    }
    const progressed = !repeatedAll || workspaceChanged;
    this.lastSignatures = signatures;
    this.seenAcrossAttempts.push(signatures);
    return { progressed, repeatedAll: repeatedAll && !workspaceChanged };
  }

  get attempts(): number {
    return this.seenAcrossAttempts.length;
  }
}

export type RepairDecision =
  | { readonly action: "repair"; readonly attemptNumber: number; readonly maxAttempts: number }
  | { readonly action: "stop"; readonly reason: StopReason };

export type StopReason =
  | "repair_budget_exhausted"
  | "no_progress_repeated_failure"
  | "actor_reports_blocker"
  | "requires_user_authority";

export interface RepairPolicyOptions {
  /** Maximum bounded repair turns per task completion proposal. */
  readonly maxRepairAttempts?: number;
  readonly now?: () => number;
}

export class VerificationRepairController {
  private readonly detector = new ProgressDetector();
  private readonly maxRepairAttempts: number;
  private repairAttemptsUsed = 0;

  constructor(options: RepairPolicyOptions = {}) {
    this.maxRepairAttempts = options.maxRepairAttempts ?? 2;
  }

  /**
   * Decide what happens after a verification evaluation that produced
   * failures. `workspaceChangedSinceLastAttempt` is derived from the world
   * state digest; the first evaluation after an actor turn is always
   * considered changed.
   */
  decideAfterFailure(input: {
    readonly failures: readonly NormalizedFailure[];
    readonly workspaceChangedSinceLastAttempt: boolean;
    readonly actorReportedBlocker: boolean;
    readonly requiresUserAuthority: boolean;
  }): RepairDecision {
    if (input.requiresUserAuthority || input.actorReportedBlocker) {
      return {
        action: "stop",
        reason: input.requiresUserAuthority
          ? "requires_user_authority"
          : "actor_reports_blocker",
      };
    }
    if (this.repairAttemptsUsed >= this.maxRepairAttempts) {
      return { action: "stop", reason: "repair_budget_exhausted" };
    }
    if (this.detector.attempts > 0) {
      const progress = this.detector.recordAttempt(
        input.failures,
        input.workspaceChangedSinceLastAttempt,
      );
      if (!progress.progressed) {
        return { action: "stop", reason: "no_progress_repeated_failure" };
      }
    } else {
      this.detector.recordAttempt(input.failures, true);
    }
    this.repairAttemptsUsed += 1;
    return {
      action: "repair",
      attemptNumber: this.repairAttemptsUsed,
      maxAttempts: this.maxRepairAttempts,
    };
  }

  get attemptsUsed(): number {
    return this.repairAttemptsUsed;
  }

  get observedEvaluations(): number {
    return this.detector.attempts;
  }
}

/**
 * Compile the repair directive injected as the next turn's volatile context:
 * failed claims, exact changed files, minimal diagnostic slices, and the
 * previously attempted fix with why it failed. Deterministic and bounded.
 */
export function buildRepairContext(input: {
  readonly failures: readonly NormalizedFailure[];
  readonly changedFiles: readonly string[];
  readonly previousAttemptSummary: string | null;
}): string {
  const sections: string[] = ["# Verification failed — repair required"];
  sections.push(
    input.failures
      .map(
        (failure, index) =>
          [
            `## Failure ${index + 1}: ${failure.nodeId}`,
            `- predicate: ${failure.predicateId}`,
            `- exit: ${failure.exitCode ?? "unknown"}`,
            failure.command !== null ? `- command: ${failure.command}` : null,
            "",
            "```",
            failure.diagnostic,
            "```",
          ]
            .filter((part): part is string => part !== null)
            .join("\n"),
      )
      .join("\n\n"),
  );
  if (input.changedFiles.length > 0) {
    sections.push(`## Files changed in this task\n${input.changedFiles.map((file) => `- ${file}`).join("\n")}`);
  }
  if (input.previousAttemptSummary !== null) {
    sections.push(
      `## Previous repair attempt\n${input.previousAttemptSummary.slice(0, 2_000)}\nFixing the same way will fail identically; change the hypothesis.`,
    );
  }
  return sections.join("\n\n").slice(0, 16_000);
}

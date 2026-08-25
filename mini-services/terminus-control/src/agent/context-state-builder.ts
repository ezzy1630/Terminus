import type { ContentHash, Rfc3339Timestamp, Uuid7 } from "@terminus/domain";
import type { TaskSnapshot, WorldStateSnapshot } from "@terminus/context-compiler";
import {
  deriveWorldSignals,
  emptyWorldSignals,
  type CompilerDiagnostic,
  type FailingTest,
  type LastCommandOutcome,
  type WorldSignals,
  type WorkspaceChange,
} from "./world-state.js";

/**
 * ContextStateBuilder (deep-audit Rank 1 / PR2).
 *
 * Computes the exact working-set state supplied to the context compiler
 * before every provider call: workspace identity, changed files, failing
 * tests with normalized diagnostics, last command outcome, verification
 * state, and environment identity. The compiler can only select or preserve
 * facts it actually receives — this builder is what stops the live loop
 * from feeding it empty collections.
 */

/** A settled episode observation in settlement order. */
export interface EpisodeObservation {
  readonly toolName: string;
  readonly resultJson: string;
}

export interface WorkspaceIdentity {
  readonly workspaceId: string;
  readonly rootUri: string;
  readonly trust: string;
}

export interface VerificationStateSummary {
  readonly status: "pending" | "passed" | "failed" | "blocked";
  readonly failedPredicateIds?: readonly string[];
  readonly planId?: string;
}

export interface EnvironmentIdentity {
  readonly sandboxProfileId: string;
  readonly backendId: string | null;
}

export interface ContextStateInput {
  readonly taskId: Uuid7;
  readonly contractVersion: number;
  readonly contractContentHash: ContentHash;
  readonly phase: string;
  readonly unknowns: readonly string[];
  readonly observedAt: Rfc3339Timestamp;
  readonly workspace: WorkspaceIdentity;
  readonly environment: EnvironmentIdentity;
  /** Episode observations for THIS turn, oldest → newest. */
  readonly episodeObservations: readonly EpisodeObservation[];
  /** Prior-turn verification failures, if any (drives repair context). */
  readonly priorVerificationFailures?: readonly string[];
}

export interface BuiltContextState {
  readonly taskSnapshot: Pick<
    TaskSnapshot,
    "changedFiles" | "failingTests" | "diagnostics"
  >;
  readonly worldStateSections: WorldStateSnapshot["sections"];
  readonly signals: WorldSignals;
  readonly worldStateDigest: string;
}

function digestOf(value: unknown): string {
  const json = JSON.stringify(value, (_key, v) =>
    typeof v === "bigint" ? String(v) : v,
  );
  // FNV-1a over the canonical JSON; a stable ordering digest is sufficient
  // for change detection of derived state.
  let hash = 0x811c9dc5;
  for (let i = 0; i < json.length; i += 1) {
    hash ^= json.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export class ContextStateBuilder {
  /**
   * Derive the full context state from durable observations.
   *
   * `episodeObservations` must be bounded by the caller (the turn runtime's
   * existing 16-episode model-visible window satisfies this).
   */
  build(input: ContextStateInput): BuiltContextState {
    const signals =
      input.episodeObservations.length === 0
        ? emptyWorldSignals()
        : deriveWorldSignals(
            input.episodeObservations.map(
              (observation) => [observation.toolName, observation.resultJson] as const,
            ),
          );

    const taskSnapshot = {
      changedFiles: signals.changedFiles,
      failingTests: signals.failingTests.map(
        (test: FailingTest) => `${test.id}: ${test.summary}`,
      ),
      diagnostics: signals.diagnostics.map((diagnostic: CompilerDiagnostic) => ({
        path: diagnostic.path ?? "<unknown>",
        message:
          diagnostic.line !== null
            ? `L${diagnostic.line}: ${diagnostic.message}`
            : diagnostic.message,
      })),
    };

    const worldStateSections: WorldStateSnapshot["sections"] = {
      request_phase: { phase: input.phase },
      workspace: {
        id: input.workspace.workspaceId,
        rootUri: input.workspace.rootUri,
        trust: input.workspace.trust,
      },
      changes:
        signals.workspaceChanges.length === 0
          ? null
          : {
              files: signals.changedFiles,
              detail: signals.workspaceChanges.map((change: WorkspaceChange) => ({
                path: change.path,
                operation: change.operation,
                new_sha256: change.newSha256,
              })),
            },
      last_command: signals.lastCommand,
      verification: {
        status: input.priorVerificationFailures?.length
          ? ("failed" as const)
          : ("pending" as const),
        ...(input.priorVerificationFailures?.length
          ? { failures: input.priorVerificationFailures }
          : {}),
      },
      environment: {
        sandbox_profile: input.environment.sandboxProfileId,
        backend: input.environment.backendId,
      },
    };

    return {
      taskSnapshot,
      worldStateSections,
      signals,
      worldStateDigest: digestOf({
        changedFiles: signals.changedFiles,
        failingTests: signals.failingTests.map((t) => t.id),
        diagnostics: signals.diagnostics.length,
        lastCommand: signals.lastCommand?.exitCode ?? null,
        verification: input.priorVerificationFailures ?? [],
      }),
    };
  }
}

export type { FailingTest, CompilerDiagnostic, LastCommandOutcome };

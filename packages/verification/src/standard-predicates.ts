/**
 * Standard predicate executors (§40.2). Effectful work is injected via
 * {@link PredicateCommandRunner} — this module never touches the filesystem
 * or process APIs directly (see packages/verification/AGENTS.md).
 */
import type { ArtifactRef, VerificationResult, Uuid7, Rfc3339Timestamp } from "@terminus/domain";
import { ValidationError, assertNever } from "@terminus/domain";
import type { NodeExecutorInput, PredicateExecutor } from "./registry.js";
import { PredicateRegistry } from "./registry.js";
import {
  ALL_PREDICATE_TYPES,
  PredicateType,
  parseNodeSpec,
  type PredicateType as PredicateTypeName,
} from "./node-spec.js";
import type { EvidenceArtifactWriter } from "./evidence.js";

export interface PredicateCommandRequest {
  readonly predicateType: PredicateTypeName;
  readonly command: string;
  readonly paths: readonly string[];
  readonly workspaceRevision: string;
  readonly environmentImageDigest: string | null;
  readonly signal: AbortSignal | null;
  readonly observations: Readonly<Record<string, unknown>>;
}

export interface PredicateCommandOutcome {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly observations?: Readonly<Record<string, unknown>> | undefined;
  readonly artifacts?: readonly ArtifactRef[] | undefined;
}

/** Injected runner — typically kernel Process/Job via the control plane. */
export interface PredicateCommandRunner {
  run(req: PredicateCommandRequest): Promise<PredicateCommandOutcome>;
}

export interface StandardPredicateDeps {
  readonly runner: PredicateCommandRunner;
  readonly idSource: () => Uuid7;
  readonly clock: () => Rfc3339Timestamp;
  readonly planId: () => Uuid7;
  readonly artifactWriter?: EvidenceArtifactWriter | undefined;
}

function defaultCommand(predicateType: PredicateTypeName, paths: readonly string[]): string {
  const pathArgs = paths.length > 0 ? paths.join(" ") : ".";
  switch (predicateType) {
    case "file_parses":
      return `terminus-predicate file_parses ${pathArgs}`;
    case "formatter_check":
      return `terminus-predicate formatter_check ${pathArgs}`;
    case "static_diagnostics":
      return `terminus-predicate static_diagnostics ${pathArgs}`;
    case "unit_test":
      return `terminus-predicate unit_test ${pathArgs}`;
    case "integration_test":
      return `terminus-predicate integration_test ${pathArgs}`;
    case "e2e_test":
      return `terminus-predicate e2e_test ${pathArgs}`;
    case "property_test":
      return `terminus-predicate property_test ${pathArgs}`;
    case "fuzz_test":
      return `terminus-predicate fuzz_test ${pathArgs}`;
    case "security_scanner":
      return `terminus-predicate security_scanner ${pathArgs}`;
    case "performance_threshold":
      return `terminus-predicate performance_threshold ${pathArgs}`;
    case "schema_compatibility":
      return `terminus-predicate schema_compatibility ${pathArgs}`;
    case "migration_dry_run":
      return `terminus-predicate migration_dry_run ${pathArgs}`;
    case "diff_policy":
      return `terminus-predicate diff_policy ${pathArgs}`;
    case "acceptance_query":
      return `terminus-predicate acceptance_query ${pathArgs}`;
    case "detached_review":
      return `terminus-predicate detached_review ${pathArgs}`;
    case "human_approval":
      return `terminus-predicate human_approval ${pathArgs}`;
    case "external_reconciliation":
      return `terminus-predicate external_reconciliation ${pathArgs}`;
    default:
      return assertNever(predicateType);
  }
}

function makeExecutor(
  predicateType: PredicateTypeName,
  deps: StandardPredicateDeps,
): PredicateExecutor {
  return {
    predicateType,
    async execute(input: NodeExecutorInput): Promise<VerificationResult> {
      if (input.signal?.aborted) {
        throw new ValidationError("predicate aborted", { predicateType });
      }
      const spec = parseNodeSpec(input.node.specification);
      const command = spec.command ?? defaultCommand(predicateType, spec.paths);
      const outcome = await deps.runner.run({
        predicateType,
        command,
        paths: spec.paths,
        workspaceRevision: input.workspaceRevision,
        environmentImageDigest: input.environmentImageDigest,
        signal: input.signal,
        observations: spec.observations,
      });
      const pass = outcome.exitCode === 0;
      const evidencePayload = new TextEncoder().encode(JSON.stringify({
        predicateType,
        command,
        paths: spec.paths,
        workspaceRevision: input.workspaceRevision,
        environmentImageDigest: input.environmentImageDigest,
        exitCode: outcome.exitCode,
        stdout: outcome.stdout,
        stderr: outcome.stderr,
        observations: outcome.observations ?? {},
      }));
      const artifacts = outcome.artifacts !== undefined
        ? outcome.artifacts
        : deps.artifactWriter
          ? [await deps.artifactWriter.write({
              bytes: evidencePayload,
              mediaType: "application/json",
              metadata: { purpose: "verification-result", predicateType, nodeId: input.node.id },
            })]
          : [];
      return {
        id: deps.idSource(),
        planId: deps.planId(),
        nodeId: input.node.id,
        status: pass ? "pass" : "fail",
        startedAt: deps.clock(),
        completedAt: deps.clock(),
        sourceRevision: input.workspaceRevision,
        environmentImageDigest: input.environmentImageDigest,
        commandOrQuery: command,
        exitCode: outcome.exitCode,
        structuredObservations: {
          stdout: outcome.stdout,
          stderr: outcome.stderr,
          ...(outcome.observations ?? {}),
        },
        artifacts,
        toolCallId: null,
        verifierVersion: "1.0.0",
        reasonIfSkipped: null,
        attempts: 1,
      };
    },
  };
}

export function registerStandardPredicates(
  registry: PredicateRegistry,
  deps: StandardPredicateDeps,
): PredicateRegistry {
  for (const t of ALL_PREDICATE_TYPES) {
    if (!registry.has(t)) {
      registry.register(makeExecutor(t, deps));
    }
  }
  return registry;
}

export function createStandardPredicateRegistry(deps: StandardPredicateDeps): PredicateRegistry {
  return registerStandardPredicates(new PredicateRegistry(), deps);
}

export { PredicateType };

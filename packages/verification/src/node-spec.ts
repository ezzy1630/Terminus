/**
 * Predicate type constants and node-spec parse/serialize helpers.
 * Extracted so binding / executors can import without cycling through the
 * engine module.
 */
import type { VerificationNode } from "@terminus/domain";
import { assertNever, ValidationError } from "@terminus/domain";

export const PredicateType = {
  FILE_PARSES: "file_parses",
  FORMATTER_CHECK: "formatter_check",
  STATIC_DIAGNOSTICS: "static_diagnostics",
  UNIT_TEST: "unit_test",
  INTEGRATION_TEST: "integration_test",
  E2E_TEST: "e2e_test",
  PROPERTY_TEST: "property_test",
  FUZZ_TEST: "fuzz_test",
  SECURITY_SCANNER: "security_scanner",
  PERFORMANCE_THRESHOLD: "performance_threshold",
  SCHEMA_COMPATIBILITY: "schema_compatibility",
  MIGRATION_DRY_RUN: "migration_dry_run",
  DIFF_POLICY: "diff_policy",
  ACCEPTANCE_QUERY: "acceptance_query",
  DETACHED_REVIEW: "detached_review",
  HUMAN_APPROVAL: "human_approval",
  EXTERNAL_RECONCILIATION: "external_reconciliation",
} as const;
export type PredicateType = (typeof PredicateType)[keyof typeof PredicateType];

export const ALL_PREDICATE_TYPES: readonly PredicateType[] = Object.freeze([
  "file_parses",
  "formatter_check",
  "static_diagnostics",
  "unit_test",
  "integration_test",
  "e2e_test",
  "property_test",
  "fuzz_test",
  "security_scanner",
  "performance_threshold",
  "schema_compatibility",
  "migration_dry_run",
  "diff_policy",
  "acceptance_query",
  "detached_review",
  "human_approval",
  "external_reconciliation",
]);

export function predicateTypeToNodeKind(t: PredicateType): VerificationNode["kind"] {
  switch (t) {
    case "file_parses":
    case "formatter_check":
    case "static_diagnostics":
    case "unit_test":
    case "integration_test":
    case "e2e_test":
    case "property_test":
    case "fuzz_test":
    case "security_scanner":
    case "performance_threshold":
    case "schema_compatibility":
    case "migration_dry_run":
    case "diff_policy":
    case "acceptance_query":
      return "command";
    case "detached_review":
      return "diff_rule";
    case "human_approval":
      return "human";
    case "external_reconciliation":
      return "external_query";
    default:
      return assertNever(t);
  }
}

export interface VerificationNodeSpec {
  readonly predicateType: PredicateType | null;
  readonly paths: readonly string[];
  readonly observations: Readonly<Record<string, unknown>>;
  /** Optional command/query override for command-kind predicates. */
  readonly command?: string | undefined;
}

export function parseNodeSpec(specification: string): VerificationNodeSpec {
  const trimmed = specification.trim();
  if (trimmed.startsWith("{")) {
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      const predicateTypeRaw = obj["predicateType"];
      const pathsRaw = obj["paths"];
      const observationsRaw = obj["observations"];
      const commandRaw = obj["command"];
      return {
        predicateType:
          predicateTypeRaw !== null &&
          predicateTypeRaw !== undefined &&
          typeof predicateTypeRaw === "string" &&
          ALL_PREDICATE_TYPES.includes(predicateTypeRaw as PredicateType)
            ? (predicateTypeRaw as PredicateType)
            : null,
        paths:
          Array.isArray(pathsRaw) && pathsRaw.every((p) => typeof p === "string")
            ? (pathsRaw as string[])
            : [],
        observations:
          observationsRaw !== null &&
          observationsRaw !== undefined &&
          typeof observationsRaw === "object" &&
          !Array.isArray(observationsRaw)
            ? (observationsRaw as Record<string, unknown>)
            : {},
        command: typeof commandRaw === "string" ? commandRaw : undefined,
      };
    } catch {
      return { predicateType: null, paths: [], observations: {} };
    }
  }
  return { predicateType: null, paths: [], observations: {}, command: trimmed.length > 0 ? trimmed : undefined };
}

export function serializeNodeSpec(spec: VerificationNodeSpec): string {
  return JSON.stringify({
    predicateType: spec.predicateType,
    paths: spec.paths,
    observations: spec.observations,
    ...(spec.command !== undefined ? { command: spec.command } : {}),
  });
}

export function requirePredicateType(specification: string): PredicateType {
  const t = parseNodeSpec(specification).predicateType;
  if (t === null) {
    throw new ValidationError("node specification lacks predicateType");
  }
  return t;
}

import type {
  AcceptanceCriterion,
  VerificationNode,
  Uuid7,
} from "@terminus/domain";
import {
  ALL_PREDICATE_TYPES,
  predicateTypeToNodeKind,
  PredicateType,
  serializeNodeSpec,
  type PredicateType as PredicateTypeName,
} from "./node-spec.js";

export type VerificationPlanMode = "incremental" | "admission";

export interface VerificationDerivationSignals {
  /** Workspace-relative files changed or implicated by the task. */
  readonly changedFiles: readonly string[];
  /** Repository configuration files and scoped instruction paths. */
  readonly projectFiles?: readonly string[] | undefined;
  /** Hashes of repository instructions injected into the current context. */
  readonly instructionHashes?: readonly string[] | undefined;
  /** Failure selectors carried forward from the previous verification run. */
  readonly failingTests?: readonly string[] | undefined;
  /** Diagnostics carried forward from the current working-set ledger. */
  readonly diagnostics?: readonly string[] | undefined;
  /** Repository-native commands that are safe to use as targeted checks. */
  readonly nativeTestCommands?: readonly string[] | undefined;
  /** Source paths that supplied the native verification recipes. */
  readonly nativeRecipeSources?: readonly string[] | undefined;
  /** Source path/version pairs for the native verification recipes. */
  readonly nativeRecipeSourceVersions?: readonly string[] | undefined;
  /** Bounded, revisioned repository-map observation from the kernel. */
  readonly repositoryMap?: RepositoryMapVerificationSignal | undefined;
  /** Paths known to be generated outputs or generated-code inputs. */
  readonly generatedPaths?: readonly string[] | undefined;
  /** Whether a governed UI/browser predicate is available in this runtime. */
  readonly uiComputerUseAvailable?: boolean | undefined;
}

export interface RepositoryMapVerificationSignal {
  readonly sourceVersion: string;
  readonly entryCount: number;
  readonly totalEntryCount: number;
  readonly omittedEntries: number;
  readonly continuationToken: string | null;
  readonly paths: readonly string[];
}

export interface VerificationPlanDerivationInput {
  readonly criteria: readonly AcceptanceCriterion[];
  readonly objective: string;
  readonly riskClass: "low" | "normal" | "high" | "critical";
  readonly mode: VerificationPlanMode;
  readonly signals: VerificationDerivationSignals;
  /**
   * Wall-clock budget the suite or task contract allows a single check.
   * Raises node timeouts above their class floor; never lowers them.
   */
  readonly timeoutSeconds?: number | undefined;
  readonly idSource: () => Uuid7;
}

export interface VerificationPlanDerivation {
  readonly nodes: readonly VerificationNode[];
  readonly completionExpression: string;
  readonly rationale: ReadonlyMap<string, readonly string[]>;
}

type NodeDraft = {
  readonly label: string;
  readonly predicateType: PredicateTypeName;
  readonly criterionId: string | null;
  readonly paths: readonly string[];
  readonly required: boolean;
  readonly dependsOn: readonly string[];
  readonly command?: string | undefined;
  readonly reasons: readonly string[];
};

const CODE_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".go",
  ".h",
  ".hpp",
  ".java",
  ".js",
  ".jsx",
  ".kt",
  ".m",
  ".mm",
  ".py",
  ".rb",
  ".rs",
  ".swift",
  ".ts",
  ".tsx",
  ".vue",
]);

const TYPED_EXTENSIONS = new Set([
  ".go",
  ".java",
  ".js",
  ".jsx",
  ".kt",
  ".rs",
  ".swift",
  ".ts",
  ".tsx",
]);

const TEST_FILE_PATTERN = /(^|[/_.-])(test|tests|spec|specs)([/_.-]|$)/i;
const MIGRATION_PATTERN = /(^|[/_.-])(migration|migrations|prisma)([/_.-]|$)|\.sql$/i;
const PROTOCOL_PATTERN = /(^|[/_.-])(openapi|proto|protobuf|schema|api)([/_.-]|$)/i;
const GENERATED_PATTERN = /(^|[/_.-])generated([/_.-]|$)|\.gen\.[^.]+$/i;
const UI_PATTERN = /(^|[/_.-])(app|apps|components|pages|ui|views)([/_.-]|$)|\.(css|html|scss|tsx|jsx|vue)$/i;
const SECURITY_PATTERN = /(auth|credential|secret|sandbox|permission|policy|security|token)/i;

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))].sort();
}

function extensionOf(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot < 0 ? "" : path.slice(dot).toLowerCase();
}

function slug(value: string): string {
  const result = value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return result.length > 0 ? result.slice(0, 48) : "check";
}

function firstPaths(signals: VerificationDerivationSignals): readonly string[] {
  const paths = uniqueSorted(signals.changedFiles);
  return paths.length > 0 ? paths : ["."];
}

function predicateFromHint(hint: string, hasUiPaths: boolean): {
  readonly predicateType: PredicateTypeName;
  readonly command: string | undefined;
  readonly reason: string;
} {
  const normalized = hint.trim().toLowerCase();
  const commandMatch = /^(?:command|test|run):\s*(.+)$/i.exec(hint.trim());
  if (commandMatch?.[1] !== undefined) {
    return {
      predicateType: PredicateType.UNIT_TEST,
      command: commandMatch[1].trim(),
      reason: "criterion supplied an explicit command",
    };
  }
  const predicateMatch = /^predicate:\s*([a-z_]+)$/i.exec(hint.trim());
  if (predicateMatch?.[1] !== undefined && ALL_PREDICATE_TYPES.includes(predicateMatch[1] as PredicateTypeName)) {
    return {
      predicateType: predicateMatch[1] as PredicateTypeName,
      command: undefined,
      reason: "criterion selected an explicit predicate",
    };
  }
  if (/\b(format|formatter|prettier|rustfmt)\b/.test(normalized)) {
    return { predicateType: PredicateType.FORMATTER_CHECK, command: undefined, reason: "criterion mentions formatting" };
  }
  if (/\b(typecheck|type-check|types|lint|diagnostic|compile)\b/.test(normalized)) {
    return { predicateType: PredicateType.STATIC_DIAGNOSTICS, command: undefined, reason: "criterion mentions static correctness" };
  }
  if (/\b(e2e|browser|visual|interaction|ui)\b/.test(normalized)) {
    return { predicateType: PredicateType.UI_E2E, command: undefined, reason: "criterion mentions UI and requires governed computer use" };
  }
  if (/\bintegration\b/.test(normalized)) {
    return { predicateType: PredicateType.INTEGRATION_TEST, command: undefined, reason: "criterion mentions integration behavior" };
  }
  if (/\b(migration|rollback|database)\b/.test(normalized)) {
    return { predicateType: PredicateType.MIGRATION_DRY_RUN, command: undefined, reason: "criterion mentions migration or database behavior" };
  }
  if (/\b(api|protocol|schema|compatib)/.test(normalized)) {
    return { predicateType: PredicateType.SCHEMA_COMPATIBILITY, command: undefined, reason: "criterion mentions API or schema compatibility" };
  }
  if (/\b(security|secret|credential|sandbox|permission|auth)/.test(normalized)) {
    return { predicateType: PredicateType.SECURITY_SCANNER, command: undefined, reason: "criterion mentions a security-sensitive behavior" };
  }
  if (/\b(property|invariant|generat)/.test(normalized)) {
    return { predicateType: PredicateType.PROPERTY_TEST, command: undefined, reason: "criterion mentions an invariant or generated case" };
  }
  if (hasUiPaths && /\b(screen|render|display|visual|interaction|frontend|desktop)\b/.test(normalized)) {
    return { predicateType: PredicateType.UI_E2E, command: undefined, reason: "UI paths and rendered behavior require governed computer use" };
  }
  return { predicateType: PredicateType.UNIT_TEST, command: undefined, reason: "criterion received the default native test predicate" };
}

/**
 * Per-node wall-clock budgets.
 *
 * Every predicate used to get 30 s (180 s for a handful), while the plan
 * routinely makes the repository's own `cargo test` / `bun run test` /
 * `pytest` recipe a *required* node. Those do not finish in 30 s in any real
 * repository, so admission was arithmetically impossible: the change was
 * correct, the check timed out, the task failed verification.
 *
 * The floors below are what a check of that class actually needs. A
 * suite/contract `timeoutSeconds` raises a node above its floor (bounded by
 * the class ceiling) but can never lower it — an operator budget must not
 * reintroduce a guaranteed timeout.
 */
export const TEST_PREDICATE_TIMEOUT_FLOOR_MS = 600_000;
export const STATIC_PREDICATE_TIMEOUT_FLOOR_MS = 120_000;
export const TEST_PREDICATE_TIMEOUT_CEILING_MS = 1_800_000;
export const STATIC_PREDICATE_TIMEOUT_CEILING_MS = 600_000;

/** Predicates that execute the repository's own suites. */
const TEST_CLASS_PREDICATES: ReadonlySet<string> = new Set([
  PredicateType.UNIT_TEST,
  PredicateType.INTEGRATION_TEST,
  PredicateType.E2E_TEST,
  PredicateType.UI_E2E,
  PredicateType.FUZZ_TEST,
  PredicateType.PROPERTY_TEST,
  PredicateType.SECURITY_SCANNER,
  PredicateType.MIGRATION_DRY_RUN,
  PredicateType.PERFORMANCE_THRESHOLD,
]);

export function timeoutFor(
  predicateType: PredicateTypeName,
  budgetSeconds?: number | undefined,
): number {
  const testClass = TEST_CLASS_PREDICATES.has(predicateType);
  const floor = testClass ? TEST_PREDICATE_TIMEOUT_FLOOR_MS : STATIC_PREDICATE_TIMEOUT_FLOOR_MS;
  const ceiling = testClass ? TEST_PREDICATE_TIMEOUT_CEILING_MS : STATIC_PREDICATE_TIMEOUT_CEILING_MS;
  if (budgetSeconds === undefined || !Number.isFinite(budgetSeconds) || budgetSeconds <= 0) return floor;
  return Math.min(ceiling, Math.max(floor, Math.round(budgetSeconds * 1_000)));
}

function makeNode(
  input: VerificationPlanDerivationInput,
  draft: NodeDraft,
  rationale: Map<string, readonly string[]>,
): VerificationNode {
  const id = `${slug(draft.label)}_${input.idSource()}`;
  const observation = {
    derivationVersion: "terminus.verification.plan.v1",
    mode: input.mode,
    objectivePresent: input.objective.trim().length > 0,
    uiComputerUseAvailable: input.signals.uiComputerUseAvailable === true,
    uiComputerUseRequired: draft.predicateType === PredicateType.UI_E2E,
    signalSummary: {
      changedFileCount: uniqueSorted(input.signals.changedFiles).length,
      projectFileCount: uniqueSorted(input.signals.projectFiles ?? []).length,
      instructionHashCount: uniqueSorted(input.signals.instructionHashes ?? []).length,
      failingTestCount: uniqueSorted(input.signals.failingTests ?? []).length,
      diagnosticCount: uniqueSorted(input.signals.diagnostics ?? []).length,
      nativeTestCommandCount: uniqueSorted(input.signals.nativeTestCommands ?? []).length,
      nativeRecipeSourceCount: uniqueSorted(input.signals.nativeRecipeSources ?? []).length,
      nativeRecipeSourceVersionCount: uniqueSorted(input.signals.nativeRecipeSourceVersions ?? []).length,
      repositoryMapAvailable: input.signals.repositoryMap !== undefined,
      repositoryMapEntryCount: input.signals.repositoryMap?.entryCount ?? 0,
      repositoryMapTotalEntryCount: input.signals.repositoryMap?.totalEntryCount ?? 0,
      repositoryMapOmittedEntryCount: input.signals.repositoryMap?.omittedEntries ?? 0,
      repositoryMapContinuationAvailable: input.signals.repositoryMap?.continuationToken !== null
        && input.signals.repositoryMap?.continuationToken !== undefined,
      generatedPathCount: uniqueSorted(input.signals.generatedPaths ?? []).length,
      uiComputerUseAvailable: input.signals.uiComputerUseAvailable === true,
      uiComputerUseRequired: draft.predicateType === PredicateType.UI_E2E,
    },
    selectionReasons: [...draft.reasons],
  };
  const specification = serializeNodeSpec({
    predicateType: draft.predicateType,
    paths: draft.paths,
    observations: observation,
    ...(draft.command === undefined ? {} : { command: draft.command }),
  });
  rationale.set(id, draft.reasons);
  return {
    id,
    kind: predicateTypeToNodeKind(draft.predicateType),
    required: draft.required,
    dependsOn: draft.dependsOn,
    specification,
    timeout: timeoutFor(draft.predicateType, input.timeoutSeconds),
    retryPolicy: { maxAttempts: 1, backoffMs: 0, flakeIdentity: null },
    acceptanceCriterionId: draft.criterionId,
  };
}

function auxiliaryDrafts(
  input: VerificationPlanDerivationInput,
  paths: readonly string[],
  signals: {
    readonly hasCode: boolean;
    readonly hasTypedCode: boolean;
    readonly hasTests: boolean;
    readonly hasMigration: boolean;
    readonly hasProtocol: boolean;
    readonly hasGenerated: boolean;
    readonly hasUi: boolean;
    readonly hasSecurity: boolean;
  },
): readonly NodeDraft[] {
  const required = input.mode === "admission";
  const drafts: NodeDraft[] = [];
  if (signals.hasCode || input.criteria.length === 0) {
    drafts.push({
      label: "parse",
      predicateType: PredicateType.FILE_PARSES,
      criterionId: null,
      paths,
      required,
      dependsOn: [],
      reasons: ["changed code or a criterion-free task requires a parse check"],
    });
  }
  if (signals.hasTypedCode) {
    drafts.push({
      label: "format",
      predicateType: PredicateType.FORMATTER_CHECK,
      criterionId: null,
      paths,
      required,
      dependsOn: [],
      reasons: ["typed-language changes make formatter drift relevant"],
    });
    drafts.push({
      label: "diagnostics",
      predicateType: PredicateType.STATIC_DIAGNOSTICS,
      criterionId: null,
      paths,
      required,
      dependsOn: [],
      reasons: ["typed-language or configuration changes make diagnostics relevant"],
    });
  } else if (signals.hasCode || input.criteria.length === 0) {
    drafts.push({
      label: "diagnostics",
      predicateType: PredicateType.STATIC_DIAGNOSTICS,
      criterionId: null,
      paths,
      required,
      dependsOn: [],
      reasons: ["code changes make static diagnostics relevant"],
    });
  }
  const nativeCommands = uniqueSorted(input.signals.nativeTestCommands ?? []);
  if (nativeCommands.length > 0) {
    for (const [index, command] of nativeCommands.entries()) {
      drafts.push({
        label: `native_test_${index + 1}`,
        predicateType: PredicateType.UNIT_TEST,
        criterionId: null,
        paths,
        required,
        dependsOn: [],
        command,
        reasons: ["repository supplied a native test recipe"],
      });
    }
  } else if (signals.hasTests || input.criteria.length === 0) {
    drafts.push({
      label: "targeted_tests",
      predicateType: PredicateType.UNIT_TEST,
      criterionId: null,
      paths,
      required,
      dependsOn: [],
      reasons: [
        signals.hasTests
          ? "changed paths include test ownership"
          : "criterion-free tasks receive a native unit-test check",
      ],
    });
  }
  if (signals.hasMigration) {
    drafts.push({
      label: "migration",
      predicateType: PredicateType.MIGRATION_DRY_RUN,
      criterionId: null,
      paths,
      required,
      dependsOn: [],
      reasons: ["database or migration paths are implicated"],
    });
  }
  if (signals.hasProtocol || signals.hasGenerated) {
    drafts.push({
      label: "compatibility",
      predicateType: PredicateType.SCHEMA_COMPATIBILITY,
      criterionId: null,
      paths,
      required,
      dependsOn: [],
      reasons: [
        signals.hasProtocol ? "API/protocol/schema paths are implicated" : "generated-code paths are implicated",
      ],
    });
  }
  if (signals.hasSecurity || input.riskClass === "high" || input.riskClass === "critical") {
    drafts.push({
      label: "security",
      predicateType: PredicateType.SECURITY_SCANNER,
      criterionId: null,
      paths,
      required,
      dependsOn: [],
      reasons: [
        signals.hasSecurity
          ? "changed paths include security-sensitive names"
          : `task risk class is ${input.riskClass}`,
      ],
    });
  }
  if (signals.hasUi) {
    drafts.push({
      label: "ui_e2e",
      predicateType: PredicateType.UI_E2E,
      criterionId: null,
      paths,
      required,
      dependsOn: [],
      reasons: [
        input.signals.uiComputerUseAvailable === true
          ? "UI paths changed and governed computer use is available"
          : "UI paths changed but governed computer use is unavailable; keep the verification node blocked",
      ],
    });
  }
  return drafts;
}

export function deriveVerificationNodes(
  input: VerificationPlanDerivationInput,
): VerificationPlanDerivation {
  const changedFiles = uniqueSorted(input.signals.changedFiles);
  const projectFiles = uniqueSorted(input.signals.projectFiles ?? []);
  const paths = firstPaths(input.signals);
  const allSignalPaths = [...changedFiles, ...projectFiles];
  const hasCode = allSignalPaths.some((path) => CODE_EXTENSIONS.has(extensionOf(path)));
  const hasTypedCode = allSignalPaths.some((path) => TYPED_EXTENSIONS.has(extensionOf(path)));
  const hasTests = allSignalPaths.some((path) => TEST_FILE_PATTERN.test(path))
    || (input.signals.failingTests ?? []).length > 0
    || (input.signals.nativeTestCommands ?? []).length > 0;
  const hasMigration = allSignalPaths.some((path) => MIGRATION_PATTERN.test(path));
  const hasProtocol = allSignalPaths.some((path) => PROTOCOL_PATTERN.test(path));
  const generatedPaths = uniqueSorted(input.signals.generatedPaths ?? []);
  const hasGenerated = generatedPaths.length > 0 || allSignalPaths.some((path) => GENERATED_PATTERN.test(path));
  const hasUi = allSignalPaths.some((path) => UI_PATTERN.test(path));
  const hasSecurity = allSignalPaths.some((path) => SECURITY_PATTERN.test(path));
  const auxiliary = auxiliaryDrafts(input, paths, {
    hasCode,
    hasTypedCode,
    hasTests,
    hasMigration,
    hasProtocol,
    hasGenerated,
    hasUi,
    hasSecurity,
  });
  const drafts: NodeDraft[] = [...auxiliary];
  for (const [index, criterion] of input.criteria.entries()) {
    const selectionText = criterion.verificationHint?.trim() || criterion.statement;
    const selected = predicateFromHint(selectionText, hasUi);
    const reasons = [
      selected.reason,
      ...(input.signals.failingTests?.length ? ["current failure selectors were available"] : []),
      ...(input.signals.diagnostics?.length ? ["current diagnostics were available"] : []),
    ];
    drafts.push({
      label: `criterion_${criterion.id || index + 1}`,
      predicateType: selected.predicateType,
      criterionId: criterion.id,
      paths,
      required: criterion.required,
      dependsOn: [],
      ...(selected.command === undefined ? {} : { command: selected.command }),
      reasons,
    });
  }
  if (drafts.length === 0) {
    drafts.push({
      label: "parse",
      predicateType: PredicateType.FILE_PARSES,
      criterionId: null,
      paths,
      required: true,
      dependsOn: [],
      reasons: ["no structured criteria were available; use the conservative baseline"],
    });
  }

  const rationale = new Map<string, readonly string[]>();
  const nodes: VerificationNode[] = [];
  let tailId: string | null = null;
  let previousCriterionId: string | null = null;
  const criterionIds: string[] = [];
  for (const draft of drafts) {
    const criterionDependencies = draft.criterionId !== null
      ? previousCriterionId !== null
        ? [previousCriterionId]
        : input.mode === "admission" && tailId !== null
          ? [tailId]
          : []
      : draft.dependsOn;
    const dependsOn = draft.criterionId !== null
      ? criterionDependencies
      : criterionDependencies.length > 0
        ? criterionDependencies
        : tailId === null
          ? []
          : [tailId];
    const node = makeNode(input, { ...draft, dependsOn }, rationale);
    nodes.push(node);
    if (draft.criterionId !== null) criterionIds.push(node.id);
    if (draft.criterionId === null) tailId = node.id;
    else previousCriterionId = node.id;
  }
  const requiredIds = nodes.filter((node) => node.required).map((node) => node.id);
  const expressionIds = requiredIds.length > 0 ? requiredIds : criterionIds;
  return {
    nodes,
    completionExpression: expressionIds.join(" && "),
    rationale,
  };
}

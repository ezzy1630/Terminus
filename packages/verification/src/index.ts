/**
 * @terminus/verification — verification DAG engine.
 *
 * Per SPEC §17, §40: VerificationPlan builder, VerificationNode types
 * (command/diagnostic/diff_rule/human/external_query), VerificationEngine with
 * evaluate(plan, workspaceRevision) that runs nodes respecting dependencies,
 * parallel where safe, with retry policy. CompletionRecord builder that
 * requires all mandatory acceptance predicates pass. Changed-code invalidation
 * (§40.5). Predicate type constants and registry (§40.2). Flaky-test policy
 * (§40.9).
 */
import type {
  VerificationPlan,
  VerificationNode,
  VerificationResult,
  VerificationResultStatus,
  CompletionRecord,
  ArtifactRef,
  Uuid7,
  Rfc3339Timestamp,
  ContentHash,
  Micros,
} from "@terminus/domain";
import { ValidationError } from "@terminus/domain";
import { parseNodeSpec } from "./node-spec.js";
import type { NodeExecutor, NodeExecutorInput, PredicateExecutor } from "./registry.js";
import { PredicateRegistry } from "./registry.js";

export {
  PredicateType,
  ALL_PREDICATE_TYPES,
  predicateTypeToNodeKind,
  parseNodeSpec,
  serializeNodeSpec,
  requirePredicateType,
  type VerificationNodeSpec,
} from "./node-spec.js";
export {
  PredicateRegistry,
  type NodeExecutor,
  type NodeExecutorInput,
  type PredicateExecutor,
} from "./registry.js";

// ────────────────────────── Plan builder ─────────────────────────────────────

export interface VerificationPlanBuilderInput {
  readonly id: Uuid7;
  readonly taskContractId: Uuid7;
  readonly taskContractVersion: number;
  readonly sourceRevision: string;
  readonly nodes: readonly VerificationNode[];
  readonly completionExpression: string;
}

export function buildVerificationPlan(input: VerificationPlanBuilderInput): VerificationPlan {
  // Validate DAG: no cycles, all dependsOn references exist.
  const ids = new Set(input.nodes.map((n) => n.id));
  for (const n of input.nodes) {
    for (const d of n.dependsOn) {
      if (!ids.has(d)) {
        throw new ValidationError(`node '${n.id}' depends on unknown node '${d}'`);
      }
    }
  }
  // Topological sort to detect cycles.
  const sorted = topoSort(input.nodes);
  if (sorted === null) {
    throw new ValidationError("verification plan has a cycle");
  }
  return {
    id: input.id,
    taskContractId: input.taskContractId,
    taskContractVersion: input.taskContractVersion,
    sourceRevision: input.sourceRevision,
    nodes: input.nodes,
    edges: input.nodes.flatMap((n) =>
      n.dependsOn.map((d) => ({ from: d, to: n.id, kind: "depends" as const })),
    ),
    completionExpression: input.completionExpression,
    createdAt: nowIso(),
  };
}

function nowIso(): Rfc3339Timestamp {
  return new Date().toISOString() as Rfc3339Timestamp;
}

function topoSort(nodes: readonly VerificationNode[]): readonly VerificationNode[] | null {
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const visited = new Map<string, "visiting" | "done">();
  const out: VerificationNode[] = [];
  const visit = (n: VerificationNode): boolean => {
    const state = visited.get(n.id);
    if (state === "done") return true;
    if (state === "visiting") return false;
    visited.set(n.id, "visiting");
    for (const d of n.dependsOn) {
      const dep = byId.get(d);
      if (dep && !visit(dep)) return false;
    }
    visited.set(n.id, "done");
    out.push(n);
    return true;
  };
  for (const n of nodes) if (!visit(n)) return null;
  return out;
}

// ────────────────────────── Engine ───────────────────────────────────────────

export interface VerificationEngineDeps {
  executorFor(kind: VerificationNode["kind"]): NodeExecutor;
  idSource: () => Uuid7;
  clock: () => Rfc3339Timestamp;
}

export interface EvaluationOptions {
  /**
   * Maximum number of nodes that may execute concurrently. Default 4. Ready
   * nodes (whose dependencies have all completed) are dispatched in parallel
   * up to this limit (§40.1).
   */
  readonly parallelism?: number | undefined;
  /** Environment image digest stamped onto every result for binding validity. */
  readonly environmentImageDigest?: string | null | undefined;
}

export interface EvaluationResult {
  readonly results: readonly VerificationResult[];
  readonly allRequiredPassed: boolean;
  readonly completionExpressionSatisfied: boolean;
  readonly blocked: readonly string[];
}

export class VerificationEngine {
  constructor(private readonly deps: VerificationEngineDeps) {}

  async evaluate(
    plan: VerificationPlan,
    workspaceRevision: string,
    signal: AbortSignal | null = null,
    options: EvaluationOptions = {},
  ): Promise<EvaluationResult> {
    const sorted = topoSort(plan.nodes);
    if (sorted === null) {
      throw new ValidationError("plan has cycle");
    }
    const parallelism = Math.max(1, options.parallelism ?? 4);
    const environmentImageDigest = options.environmentImageDigest ?? null;
    const results: VerificationResult[] = [];
    const blocked: string[] = [];
    const resultMap = new Map<string, VerificationResult>();
    const remaining = new Set(sorted.map((n) => n.id));
    const byId = new Map(sorted.map((n) => [n.id, n] as const));

    while (remaining.size > 0) {
      // Find ready nodes: dependencies all completed (have a result).
      const ready: VerificationNode[] = [];
      for (const id of remaining) {
        const node = byId.get(id)!;
        const depsReady = node.dependsOn.every((d) => resultMap.has(d));
        if (depsReady) ready.push(node);
      }
      if (ready.length === 0) {
        // No progress — should not happen given topo sort + dep blocking,
        // but break to avoid infinite loop.
        break;
      }
      // Dispatch up to `parallelism` ready nodes in parallel.
      const batch = ready.slice(0, parallelism);
      const batchResults = await Promise.all(
        batch.map((node) =>
          this.evaluateNode(node, plan, workspaceRevision, environmentImageDigest, signal, resultMap),
        ),
      );
      for (const r of batchResults) {
        results.push(r);
        resultMap.set(r.nodeId, r);
        if (r.status === "blocked") blocked.push(r.nodeId);
        remaining.delete(r.nodeId);
      }
    }

    const allRequiredPassed = plan.nodes
      .filter((n) => n.required)
      .every((n) => resultMap.get(n.id)?.status === "pass");
    const completionSatisfied = evaluateCompletionExpression(
      plan.completionExpression,
      resultMap,
    );
    return {
      results,
      allRequiredPassed,
      completionExpressionSatisfied: completionSatisfied,
      blocked,
    };
  }

  /**
   * Evaluates a single node, respecting dependency-blocked short-circuit and
   * the retry policy.
   */
  private async evaluateNode(
    node: VerificationNode,
    plan: VerificationPlan,
    workspaceRevision: string,
    environmentImageDigest: string | null,
    signal: AbortSignal | null,
    resultMap: ReadonlyMap<string, VerificationResult>,
  ): Promise<VerificationResult> {
    // Check dependencies: any failed/blocked/error dep blocks this node.
    // Required dependency failure fails the graph; optional deps still block
    // dependents (absence is explicit via status=blocked, never null).
    for (const d of node.dependsOn) {
      const r = resultMap.get(d);
      if (r && (r.status === "fail" || r.status === "error" || r.status === "blocked")) {
        const skipped: VerificationResult = {
          id: this.deps.idSource(),
          planId: plan.id,
          nodeId: node.id,
          status: "blocked",
          startedAt: this.deps.clock(),
          completedAt: this.deps.clock(),
          sourceRevision: workspaceRevision,
          environmentImageDigest,
          commandOrQuery: node.specification,
          exitCode: null,
          structuredObservations: {},
          artifacts: [],
          toolCallId: null,
          verifierVersion: "1.0.0",
          reasonIfSkipped: "dependency did not pass",
          attempts: 0,
        };
        return skipped;
      }
    }
    const executor = this.deps.executorFor(node.kind);
    let attempt = 0;
    let last: VerificationResult | null = null;
    while (attempt < node.retryPolicy.maxAttempts) {
      attempt++;
      try {
        const r = await executor.execute({
          node,
          workspaceRevision,
          environmentImageDigest,
          signal,
        });
        // Stamp binding fields if the executor omitted them.
        last = {
          ...r,
          sourceRevision: r.sourceRevision || workspaceRevision,
          environmentImageDigest: r.environmentImageDigest ?? environmentImageDigest,
          attempts: attempt,
        };
        if (last.status === "pass") return last;
        if (last.status === "fail" || last.status === "error") {
          continue;
        }
        return last;
      } catch (err) {
        const errorResult: VerificationResult = {
          id: this.deps.idSource(),
          planId: plan.id,
          nodeId: node.id,
          status: "error",
          startedAt: this.deps.clock(),
          completedAt: this.deps.clock(),
          sourceRevision: workspaceRevision,
          environmentImageDigest,
          commandOrQuery: node.specification,
          exitCode: null,
          structuredObservations: { error: err instanceof Error ? err.message : String(err) },
          artifacts: [],
          toolCallId: null,
          verifierVersion: "1.0.0",
          reasonIfSkipped: null,
          attempts: attempt,
        };
        last = errorResult;
        continue;
      }
    }
    if (last !== null) return last;
    return {
      id: this.deps.idSource(),
      planId: plan.id,
      nodeId: node.id,
      status: "error",
      startedAt: this.deps.clock(),
      completedAt: this.deps.clock(),
      sourceRevision: workspaceRevision,
      environmentImageDigest,
      commandOrQuery: node.specification,
      exitCode: null,
      structuredObservations: { error: "retries exhausted without result" },
      artifacts: [],
      toolCallId: null,
      verifierVersion: "1.0.0",
      reasonIfSkipped: null,
      attempts: attempt,
    };
  }

  /**
   * Build a CompletionRecord for a task. Requires all mandatory acceptance
   * predicates pass.
   */
  buildCompletionRecord(input: {
    readonly taskId: Uuid7;
    readonly contractVersion: number;
    readonly finalRevision: string;
    readonly criteria: readonly { readonly id: string; readonly status: "satisfied" | "unsatisfied" | "manual" | "unverifiable"; readonly evidence: readonly ArtifactRef[]; readonly reason: string | null }[];
    readonly verificationPlanId: Uuid7;
    readonly unresolvedRisks: readonly string[];
    readonly acceptedRisks: readonly string[];
    readonly externalEffects: readonly ArtifactRef[];
    readonly costMicros: Micros;
    readonly durationSeconds: number;
    readonly finalCheckpoint: ArtifactRef;
  }): CompletionRecord {
    const unsatisfied = input.criteria.filter(
      (c) => c.status === "unsatisfied",
    );
    if (unsatisfied.length > 0) {
      throw new ValidationError("cannot build completion record: criteria unsatisfied", {
        unsatisfied: unsatisfied.map((c) => c.id),
      });
    }
    return {
      taskId: input.taskId,
      contractVersion: input.contractVersion,
      finalRevision: input.finalRevision,
      status: "completed",
      criteria: input.criteria,
      verificationPlanId: input.verificationPlanId,
      unresolvedRisks: input.unresolvedRisks,
      acceptedRisks: input.acceptedRisks,
      externalEffects: input.externalEffects,
      costMicros: input.costMicros,
      durationSeconds: input.durationSeconds,
      finalCheckpoint: input.finalCheckpoint,
      generatedAt: this.deps.clock(),
    };
  }

  /**
   * Changed-code invalidation: returns the set of node IDs whose results are
   * invalidated by the given changed paths. Delegates to
   * {@link ChangedCodeInvalidator} which uses path-based matching against
   * `specification_json.paths` when available, falling back to conservative
   * "invalidate all non-human" behaviour when dependency data is missing.
   */
  invalidateForChangedPaths(
    plan: VerificationPlan,
    changedPaths: readonly string[],
    previousResults: readonly VerificationResult[],
  ): ReadonlySet<string> {
    const invalidator = new ChangedCodeInvalidator();
    return invalidator.invalidate(plan, {
      changedPaths,
      symbolDependencies: new Map(),
      testOwnership: new Map(),
      buildGraph: new Map(),
    });
    void previousResults;
  }
}

// ────────────────────────── Changed-code invalidation (§40.5) ────────────────

/**
 * Inputs to changed-code invalidation (§40.5). All inputs are optional; the
 * invalidator degrades gracefully to conservative behaviour when data is
 * missing.
 */
export interface ChangedCodeInvalidationInput {
  /** Workspace-relative paths changed since the previous verification run. */
  readonly changedPaths: readonly string[];
  /**
   * Map from symbol name → file paths that define or reference it. Used to
   * propagate changes: if a symbol's file changed, all nodes referencing that
   * symbol are invalidated.
   */
  readonly symbolDependencies: ReadonlyMap<string, readonly string[]>;
  /**
   * Map from test path → source paths it covers. If any covered source path
   * changed, the test's node is invalidated.
   */
  readonly testOwnership: ReadonlyMap<string, readonly string[]>;
  /**
   * Map from output path → input paths that produced it (build graph). If any
   * input changed, the output's node is invalidated.
   */
  readonly buildGraph: ReadonlyMap<string, readonly string[]>;
}

/**
 * Implements §40.5 changed-code invalidation. Uses path-based matching against
 * a node's `specification_json.paths` plus symbol/test/build-graph propagation.
 * When the dependency graph is uncertain (no paths declared), the invalidator
 * is conservative: it invalidates all non-human nodes.
 */
export class ChangedCodeInvalidator {
  invalidate(
    plan: VerificationPlan,
    input: ChangedCodeInvalidationInput,
  ): ReadonlySet<string> {
    const invalidated = new Set<string>();
    const changedSet = new Set(input.changedPaths);
    if (changedSet.size === 0) {
      return invalidated;
    }
    // Expand changed paths via symbol/test/build propagation.
    const expanded = new Set<string>(changedSet);
    for (const sym of input.symbolDependencies.keys()) {
      const files = input.symbolDependencies.get(sym) ?? [];
      if (files.some((f) => changedSet.has(f))) {
        // The symbol changed; invalidate all files referencing it.
        for (const f of files) expanded.add(f);
      }
    }
    for (const [testPath, covered] of input.testOwnership) {
      if (covered.some((c) => changedSet.has(c))) {
        expanded.add(testPath);
      }
    }
    for (const [out, srcs] of input.buildGraph) {
      if (srcs.some((s) => changedSet.has(s))) {
        expanded.add(out);
      }
    }

    let anyNodeHasPaths = false;
    for (const node of plan.nodes) {
      if (node.kind === "human") continue;
      const spec = parseNodeSpec(node.specification);
      if (spec.paths.length === 0) continue;
      anyNodeHasPaths = true;
      if (spec.paths.some((p) => expanded.has(p) || matchesAnyGlob(p, expanded))) {
        invalidated.add(node.id);
      }
    }
    // Conservative fallback: if no node declared paths, invalidate all non-human.
    if (!anyNodeHasPaths) {
      for (const node of plan.nodes) {
        if (node.kind !== "human") invalidated.add(node.id);
      }
    }
    return invalidated;
  }
}

function matchesAnyGlob(pattern: string, candidates: ReadonlySet<string>): boolean {
  // Simple `**` / `*` glob matcher.
  const re = globToRegExp(pattern);
  for (const c of candidates) {
    if (re.test(c)) return true;
  }
  return false;
}

function globToRegExp(pattern: string): RegExp {
  let out = "^";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        out += ".*";
        i++;
        if (pattern[i + 1] === "/") i++;
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else if (/[.+^${}()|[\]\\]/.test(c)) {
      out += "\\" + c;
    } else {
      out += c;
    }
  }
  out += "$";
  return new RegExp(out);
}

// ────────────────────────── Flaky-test policy (§40.9) ────────────────────────

/**
 * Policy for handling a flaky test (§40.9). A failing test is not automatically
 * retried until green; the policy records the known flake identity, the
 * historical rate, an independent rerun limit, whether the changed code is
 * related, and the final confidence.
 */
export interface FlakyTestPolicy {
  /** Stable identity for the known flake (test selector + revision salt). */
  readonly knownFlakeIdentity: string;
  /** Historical pass rate of this flake, in [0, 1]. */
  readonly historicalRate: number;
  /** Maximum independent reruns allowed before declaring failure. */
  readonly independentRerunLimit: number;
  /** Whether the changed code is plausibly related to the flake. */
  readonly isChangedCodeRelated: boolean;
  /**
   * Final confidence required to mark a flaky pass as satisfying. In [0, 1].
   * A high-risk criterion may require >0.95 confidence.
   */
  readonly finalConfidence: number;
}

export type FlakyEvaluationStatus = "pass" | "fail" | "flaky_pass";

export interface FlakyEvaluation {
  readonly status: FlakyEvaluationStatus;
  readonly confidence: number;
  readonly attempts: number;
  readonly reason: string;
}

/**
 * Evaluates a (possibly flaky) test result against a flaky-test policy.
 *
 * Rules (§40.9):
 * - If the result is a clean pass on the first attempt, status is `pass` with
 *   confidence 1.0.
 * - If the result fails and there is no known flake identity, status is `fail`.
 * - If the result fails after exhausting the rerun limit, status is `fail`.
 * - If the result eventually passes within the rerun limit, status is
 *   `flaky_pass` with confidence derived from the historical rate and the
 *   number of attempts. The confidence is `historicalRate^(attempts-1)` —
 *   each additional rerun needed reduces confidence.
 * - If `isChangedCodeRelated` is true, the confidence is halved: a flake that
 *   correlates with the change is suspect.
 * - If confidence falls below `finalConfidence`, the evaluation is downgraded
 *   to `fail` (the flaky pass does not satisfy the policy).
 *
 * All retries and outcomes remain visible: the caller records every attempt's
 * VerificationResult; this function only computes the final aggregate.
 */
export function evaluateFlaky(
  attempts: readonly VerificationResult[],
  policy: FlakyTestPolicy,
): FlakyEvaluation {
  if (attempts.length === 0) {
    return {
      status: "fail",
      confidence: 0,
      attempts: 0,
      reason: "no attempts recorded",
    };
  }
  const passed = attempts.filter((a) => a.status === "pass").length;
  const failed = attempts.filter((a) => a.status === "fail" || a.status === "error").length;

  if (passed > 0 && failed === 0) {
    return {
      status: "pass",
      confidence: 1,
      attempts: attempts.length,
      reason: "clean pass on every attempt",
    };
  }

  // We have at least one failure. Without a known flake identity, this is a
  // hard failure.
  if (policy.knownFlakeIdentity.length === 0) {
    return {
      status: "fail",
      confidence: 0,
      attempts: attempts.length,
      reason: "failure with no known flake identity — not a flake",
    };
  }

  // If we have at least one pass within the rerun limit, it's a flaky pass.
  if (passed > 0 && attempts.length <= policy.independentRerunLimit) {
    // Confidence: each rerun needed beyond the first multiplies the historical
    // rate. So 1 attempt = historicalRate, 2 attempts = historicalRate^2, etc.
    const baseConfidence = Math.pow(policy.historicalRate, attempts.length - 1);
    const confidence = policy.isChangedCodeRelated ? baseConfidence * 0.5 : baseConfidence;
    if (confidence >= policy.finalConfidence) {
      return {
        status: "flaky_pass",
        confidence,
        attempts: attempts.length,
        reason: `passed after ${attempts.length} attempt(s); confidence ${confidence.toFixed(3)}`,
      };
    }
    return {
      status: "fail",
      confidence,
      attempts: attempts.length,
      reason: `flaky pass but confidence ${confidence.toFixed(3)} below required ${policy.finalConfidence}`,
    };
  }

  // No pass at all, or rerun limit exhausted.
  return {
    status: "fail",
    confidence: 0,
    attempts: attempts.length,
    reason: `failed after ${attempts.length} attempt(s); rerun limit ${policy.independentRerunLimit}`,
  };
}

// ────────────────────────── Completion expression ────────────────────────────

/**
 * Evaluates a simple boolean expression of node IDs joined by `&&` and `||`
 * with optional `!` prefix. The plan's `completionExpression` uses node IDs as
 * atoms. Example: "parse && narrow_tests && acceptance_A && acceptance_B".
 */
export function evaluateCompletionExpression(
  expr: string,
  results: ReadonlyMap<string, VerificationResult>,
): boolean {
  // An empty / whitespace-only expression is trivially satisfied (no
  // completion requirements). This avoids forcing callers to always
  // supply an expression when they only care about `allRequiredPassed`.
  if (expr.trim().length === 0) return true;
  // Tokenize: split on `&&`, `||`, `!`, `(`, `)`, and whitespace.
  const tokens = tokenize(expr);
  const parser = new ExprParser(tokens, results);
  return parser.parseOr();
}

function tokenize(expr: string): readonly string[] {
  const out: string[] = [];
  let i = 0;
  while (i < expr.length) {
    const c = expr[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "&" && expr[i + 1] === "&") {
      out.push("&&");
      i += 2;
    } else if (c === "|" && expr[i + 1] === "|") {
      out.push("||");
      i += 2;
    } else if (c === "!") {
      out.push("!");
      i++;
    } else if (c === "(" || c === ")") {
      out.push(c);
      i++;
    } else {
      let j = i;
      while (j < expr.length && !/[\s&|!()]/.test(expr[j]!)) j++;
      // A lone `&` or `|` stops the atom scan without advancing, which would
      // loop forever emitting empty tokens. Only `&&` / `||` are grammar.
      if (j === i) {
        throw new ValidationError(
          `invalid character ${JSON.stringify(c)} in completion expression (use && and ||)`,
        );
      }
      out.push(expr.slice(i, j));
      i = j;
    }
  }
  return out;
}

class ExprParser {
  private pos = 0;
  constructor(
    private readonly tokens: readonly string[],
    private readonly results: ReadonlyMap<string, VerificationResult>,
  ) {}

  private peek(): string | null {
    return this.tokens[this.pos] ?? null;
  }
  private next(): string | null {
    return this.tokens[this.pos++] ?? null;
  }

  parseOr(): boolean {
    let v = this.parseAnd();
    while (this.peek() === "||") {
      this.next();
      const r = this.parseAnd();
      v = v || r;
    }
    return v;
  }

  parseAnd(): boolean {
    let v = this.parseUnary();
    while (this.peek() === "&&") {
      this.next();
      const r = this.parseUnary();
      v = v && r;
    }
    return v;
  }

  parseUnary(): boolean {
    if (this.peek() === "!") {
      this.next();
      return !this.parseUnary();
    }
    return this.parseAtom();
  }

  parseAtom(): boolean {
    const t = this.next();
    if (t === "(") {
      const v = this.parseOr();
      const close = this.next();
      if (close !== ")") throw new ValidationError("missing ) in completion expression");
      return v;
    }
    if (t === null) throw new ValidationError("unexpected end of completion expression");
    const r = this.results.get(t);
    return r?.status === "pass";
  }
}

export type {
  VerificationPlan,
  VerificationNode,
  VerificationResult,
  VerificationResultStatus,
  CompletionRecord,
  ArtifactRef,
  ContentHash,
};

// Sibling modules — re-exported after engine definitions to keep ESM init order safe.
export * from "./store.js";
export * from "./binding.js";
export * from "./completion-gate.js";
export * from "./standard-predicates.js";
export * from "./lifecycle.js";
export * from "./harness-verify.js";

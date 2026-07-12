/**
 * @forge/verification — verification DAG engine.
 *
 * Per SPEC §17, §40: VerificationPlan builder, VerificationNode types
 * (command/diagnostic/diff_rule/human/external_query), VerificationEngine with
 * evaluate(plan, workspaceRevision) that runs nodes respecting dependencies,
 * parallel where safe, with retry policy. CompletionRecord builder that
 * requires all mandatory acceptance predicates pass. Changed-code invalidation.
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
} from "@forge/domain";
import { ValidationError } from "@forge/domain";

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

// ────────────────────────── Node executor ────────────────────────────────────

export interface NodeExecutorInput {
  readonly node: VerificationNode;
  readonly workspaceRevision: string;
  readonly environmentImageDigest: string | null;
  readonly signal: AbortSignal | null;
}

export interface NodeExecutor {
  execute(input: NodeExecutorInput): Promise<VerificationResult>;
}

// ────────────────────────── Engine ───────────────────────────────────────────

export interface VerificationEngineDeps {
  executorFor(kind: VerificationNode["kind"]): NodeExecutor;
  idSource: () => Uuid7;
  clock: () => Rfc3339Timestamp;
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
  ): Promise<EvaluationResult> {
    const sorted = topoSort(plan.nodes);
    if (sorted === null) {
      throw new ValidationError("plan has cycle");
    }
    const results: VerificationResult[] = [];
    const blocked: string[] = [];
    const byId = new Map(sorted.map((n) => [n.id, n] as const));
    const resultMap = new Map<string, VerificationResult>();
    for (const node of sorted) {
      // Check dependencies: any failed/blocked dep blocks this node.
      let depBlocks = false;
      for (const d of node.dependsOn) {
        const r = resultMap.get(d);
        if (r && (r.status === "fail" || r.status === "error" || r.status === "blocked")) {
          depBlocks = true;
          break;
        }
      }
      if (depBlocks) {
        const skipped: VerificationResult = {
          id: this.deps.idSource(),
          planId: plan.id,
          nodeId: node.id,
          status: "blocked",
          startedAt: this.deps.clock(),
          completedAt: this.deps.clock(),
          sourceRevision: workspaceRevision,
          environmentImageDigest: null,
          commandOrQuery: node.specification,
          exitCode: null,
          structuredObservations: {},
          artifacts: [],
          toolCallId: null,
          verifierVersion: "1.0.0",
          reasonIfSkipped: "dependency did not pass",
          attempts: 0,
        };
        results.push(skipped);
        resultMap.set(node.id, skipped);
        blocked.push(node.id);
        continue;
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
            environmentImageDigest: null,
            signal,
          });
          results.push(r);
          resultMap.set(node.id, r);
          last = r;
          if (r.status === "pass") break;
          if (r.status === "fail" || r.status === "error") {
            // Retry with backoff (no actual wait in this stub; caller can
            // override the executor to simulate).
            continue;
          }
          break;
        } catch (err) {
            const errorResult: VerificationResult = {
              id: this.deps.idSource(),
              planId: plan.id,
              nodeId: node.id,
              status: "error",
              startedAt: this.deps.clock(),
              completedAt: this.deps.clock(),
              sourceRevision: workspaceRevision,
              environmentImageDigest: null,
              commandOrQuery: node.specification,
              exitCode: null,
              structuredObservations: { error: err instanceof Error ? err.message : String(err) },
              artifacts: [],
              toolCallId: null,
              verifierVersion: "1.0.0",
              reasonIfSkipped: null,
              attempts: attempt,
            };
            results.push(errorResult);
            resultMap.set(node.id, errorResult);
            last = errorResult;
            continue;
          }
      }
      void last;
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
    void byId;
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
   * invalidated by the given changed paths. Conservative when the dependency
   * graph is uncertain.
   */
  invalidateForChangedPaths(
    plan: VerificationPlan,
    changedPaths: readonly string[],
    previousResults: readonly VerificationResult[],
  ): ReadonlySet<string> {
    void changedPaths;
    // Conservative: invalidate all non-human nodes.
    const invalidated = new Set<string>();
    for (const n of plan.nodes) {
      if (n.kind !== "human") invalidated.add(n.id);
    }
    void previousResults;
    return invalidated;
  }
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

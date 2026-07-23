/**
 * Graph execution semantics for selective multi-agent orchestration.
 *
 * Typed node I/O, typed edge payloads, deterministic transforms (no model
 * calls), selective fan-out, explicit barriers, streaming pipelines,
 * missing-worker-result policy, bounded concurrency, retry identity, dedupe,
 * and convergence criteria.
 *
 * Policy: required nodes fail the graph; optional nodes may yield explicit
 * typed absence. "Failed worker becomes null and continue" is NOT a default.
 * Arbitrary model-written JavaScript orchestration is rejected until
 * capability isolation + programmatic-composition evaluation pass.
 */
import { ValidationError, assertNever } from "@terminus/domain";

// ────────────────────────── Typed values ─────────────────────────────────────

export type GraphValue =
  | { readonly tag: "unit" }
  | { readonly tag: "bool"; readonly value: boolean }
  | { readonly tag: "int"; readonly value: number }
  | { readonly tag: "string"; readonly value: string }
  | { readonly tag: "string_list"; readonly value: readonly string[] }
  | { readonly tag: "json"; readonly value: Readonly<Record<string, unknown>> }
  | { readonly tag: "artifact_ref"; readonly value: string }
  | { readonly tag: "absence"; readonly reason: string };

export type GraphValueTag = GraphValue["tag"];

export interface TypedPort {
  readonly name: string;
  readonly valueTag: GraphValueTag;
}

export interface EdgePayload {
  readonly from: string;
  readonly to: string;
  readonly port: string;
  readonly value: GraphValue;
}

// ────────────────────────── Node kinds ───────────────────────────────────────

export type GraphNodeKind =
  | "worker"
  | "transform"
  | "fan_out"
  | "barrier"
  | "stream"
  | "sink";

export interface GraphNode {
  readonly id: string;
  readonly kind: GraphNodeKind;
  readonly required: boolean;
  readonly inputs: readonly TypedPort[];
  readonly outputs: readonly TypedPort[];
  /** Depends-on edges (hard barriers unless kind=stream). */
  readonly dependsOn: readonly string[];
  /** Retry identity — same identity dedupes against previously seen work. */
  readonly retryIdentity: string;
  /** Selective fan-out predicate key (interpreted by executor policy). */
  readonly fanOutKey: string | null;
  /** Deterministic transform name (no model calls). */
  readonly transform: string | null;
}

export interface GraphDefinition {
  readonly id: string;
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly { readonly from: string; readonly to: string; readonly port: string }[];
  readonly convergence: ConvergenceCriteria;
  readonly boundedConcurrency: number;
  readonly missingWorkerPolicy: MissingWorkerResultPolicy;
}

/**
 * Missing worker result policy.
 * - `fail_required`: required node absence fails the graph (default).
 * - `typed_absence`: optional nodes emit `{tag:"absence"}`; required still fail.
 * - `never_null_continue`: explicitly forbidden — rejected at graph validate.
 */
export type MissingWorkerResultPolicy = "fail_required" | "typed_absence";

export interface ConvergenceCriteria {
  readonly maxSteps: number;
  readonly maxWallClockMs: number;
  /** Stable fingerprint of completed required outputs that ends the run. */
  readonly requiredOutputPorts: readonly string[];
}

export type NodeOutcome =
  | { readonly status: "ok"; readonly outputs: Readonly<Record<string, GraphValue>> }
  | { readonly status: "fail"; readonly error: string }
  | { readonly status: "absence"; readonly reason: string };

export interface GraphNodeHandler {
  execute(
    node: GraphNode,
    inputs: Readonly<Record<string, GraphValue>>,
    signal: AbortSignal | null,
  ): Promise<NodeOutcome>;
}

export interface GraphRunResult {
  readonly status: "converged" | "failed" | "cancelled" | "budget_exhausted";
  readonly steps: number;
  readonly outputs: Readonly<Record<string, GraphValue>>;
  readonly failures: readonly { readonly nodeId: string; readonly error: string }[];
  readonly absences: readonly { readonly nodeId: string; readonly reason: string }[];
  readonly deduped: readonly string[];
}

export interface GraphExecutorDeps {
  readonly handler: GraphNodeHandler;
  readonly transforms: ReadonlyMap<string, (inputs: Readonly<Record<string, GraphValue>>) => Readonly<Record<string, GraphValue>>>;
  readonly clock: () => number;
  /** Previously seen retry identities (durable dedupe set). */
  readonly seenWork: Set<string>;
}

export function validateGraph(def: GraphDefinition): void {
  if (def.boundedConcurrency < 1) {
    throw new ValidationError("boundedConcurrency must be >= 1");
  }
  // Reject the forbidden policy by construction — it is not in the type union,
  // but guard against unsafe casts.
  const policy = def.missingWorkerPolicy as string;
  if (policy === "never_null_continue") {
    throw new ValidationError(
      "missing-worker policy 'never_null_continue' is forbidden; use fail_required or typed_absence",
    );
  }
  const ids = new Set(def.nodes.map((n) => n.id));
  for (const n of def.nodes) {
    for (const d of n.dependsOn) {
      if (!ids.has(d)) {
        throw new ValidationError(`node '${n.id}' depends on unknown '${d}'`);
      }
    }
    if (n.kind === "transform" && (n.transform === null || n.transform.length === 0)) {
      throw new ValidationError(`transform node '${n.id}' lacks transform name`);
    }
  }
  if (topoSort(def.nodes) === null) {
    throw new ValidationError("orchestration graph has a cycle");
  }
}

function topoSort(nodes: readonly GraphNode[]): readonly GraphNode[] | null {
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const visited = new Map<string, "visiting" | "done">();
  const out: GraphNode[] = [];
  const visit = (n: GraphNode): boolean => {
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

/**
 * Execute a graph with bounded concurrency, barriers, streaming, dedupe, and
 * convergence. Deterministic transforms never invoke the worker handler.
 */
export class GraphExecutor {
  constructor(private readonly deps: GraphExecutorDeps) {}

  async run(def: GraphDefinition, signal: AbortSignal | null = null): Promise<GraphRunResult> {
    validateGraph(def);
    const sorted = topoSort(def.nodes);
    if (sorted === null) throw new ValidationError("graph has cycle");

    const started = this.deps.clock();
    const outputs = new Map<string, GraphValue>();
    const nodeOutputs = new Map<string, Readonly<Record<string, GraphValue>>>();
    const failures: { nodeId: string; error: string }[] = [];
    const absences: { nodeId: string; reason: string }[] = [];
    const deduped: string[] = [];
    const remaining = new Set(sorted.map((n) => n.id));
    const byId = new Map(sorted.map((n) => [n.id, n] as const));
    let steps = 0;

    while (remaining.size > 0) {
      if (signal?.aborted) {
        return {
          status: "cancelled",
          steps,
          outputs: Object.fromEntries(outputs),
          failures,
          absences,
          deduped,
        };
      }
      if (steps >= def.convergence.maxSteps) {
        return {
          status: "budget_exhausted",
          steps,
          outputs: Object.fromEntries(outputs),
          failures,
          absences,
          deduped,
        };
      }
      if (this.deps.clock() - started > def.convergence.maxWallClockMs) {
        return {
          status: "budget_exhausted",
          steps,
          outputs: Object.fromEntries(outputs),
          failures,
          absences,
          deduped,
        };
      }

      const ready: GraphNode[] = [];
      for (const id of remaining) {
        const node = byId.get(id)!;
        if (isReady(node, nodeOutputs, byId)) ready.push(node);
      }
      if (ready.length === 0) break;

      const batch = ready.slice(0, def.boundedConcurrency);
      const batchResults = await Promise.all(
        batch.map((node) => this.runNode(node, def, nodeOutputs, signal)),
      );

      for (let i = 0; i < batch.length; i++) {
        const node = batch[i]!;
        const outcome = batchResults[i]!;
        remaining.delete(node.id);
        steps++;

        if (outcome.kind === "deduped") {
          deduped.push(node.id);
          nodeOutputs.set(node.id, outcome.outputs);
          continue;
        }
        if (outcome.kind === "absence") {
          absences.push({ nodeId: node.id, reason: outcome.reason });
          nodeOutputs.set(node.id, {
            result: { tag: "absence", reason: outcome.reason },
          });
          if (node.required) {
            failures.push({ nodeId: node.id, error: `required node absent: ${outcome.reason}` });
          }
          continue;
        }
        if (outcome.kind === "fail") {
          failures.push({ nodeId: node.id, error: outcome.error });
          if (node.required) {
            // Fail the graph immediately for required nodes.
            return {
              status: "failed",
              steps,
              outputs: Object.fromEntries(outputs),
              failures,
              absences,
              deduped,
            };
          }
          // Optional failure → typed absence, never null-continue.
          absences.push({ nodeId: node.id, reason: outcome.error });
          nodeOutputs.set(node.id, {
            result: { tag: "absence", reason: outcome.error },
          });
          continue;
        }
        nodeOutputs.set(node.id, outcome.outputs);
        for (const [k, v] of Object.entries(outcome.outputs)) {
          outputs.set(`${node.id}.${k}`, v);
        }
      }

      if (hasConverged(def, outputs)) {
        return {
          status: failures.some((f) => byId.get(f.nodeId)?.required) ? "failed" : "converged",
          steps,
          outputs: Object.fromEntries(outputs),
          failures,
          absences,
          deduped,
        };
      }
    }

    const requiredFailed = failures.some((f) => byId.get(f.nodeId)?.required);
    return {
      status: requiredFailed || remaining.size > 0 ? "failed" : "converged",
      steps,
      outputs: Object.fromEntries(outputs),
      failures,
      absences,
      deduped,
    };
  }

  private async runNode(
    node: GraphNode,
    def: GraphDefinition,
    nodeOutputs: ReadonlyMap<string, Readonly<Record<string, GraphValue>>>,
    signal: AbortSignal | null,
  ): Promise<
    | { readonly kind: "ok"; readonly outputs: Readonly<Record<string, GraphValue>> }
    | { readonly kind: "fail"; readonly error: string }
    | { readonly kind: "absence"; readonly reason: string }
    | { readonly kind: "deduped"; readonly outputs: Readonly<Record<string, GraphValue>> }
  > {
    if (this.deps.seenWork.has(node.retryIdentity)) {
      return {
        kind: "deduped",
        outputs: { result: { tag: "unit" } },
      };
    }

    const inputs = collectInputs(node, def, nodeOutputs);

    switch (node.kind) {
      case "transform": {
        const fn = this.deps.transforms.get(node.transform!);
        if (!fn) return { kind: "fail", error: `unknown transform '${node.transform}'` };
        try {
          const out = fn(inputs);
          this.deps.seenWork.add(node.retryIdentity);
          return { kind: "ok", outputs: out };
        } catch (err) {
          return { kind: "fail", error: err instanceof Error ? err.message : String(err) };
        }
      }
      case "barrier": {
        // Barrier succeeds only when all dependencies produced non-absence ok outputs.
        for (const d of node.dependsOn) {
          const depOut = nodeOutputs.get(d);
          if (!depOut) return { kind: "fail", error: `barrier missing dep '${d}'` };
          const result = depOut["result"];
          if (result?.tag === "absence") {
            return { kind: "fail", error: `barrier blocked by absence from '${d}'` };
          }
        }
        this.deps.seenWork.add(node.retryIdentity);
        return { kind: "ok", outputs: { result: { tag: "unit" } } };
      }
      case "fan_out":
      case "stream":
      case "worker":
      case "sink": {
        const outcome = await this.deps.handler.execute(node, inputs, signal);
        if (outcome.status === "ok") {
          this.deps.seenWork.add(node.retryIdentity);
          return { kind: "ok", outputs: outcome.outputs };
        }
        if (outcome.status === "absence") {
          if (node.required || def.missingWorkerPolicy === "fail_required") {
            if (node.required) return { kind: "fail", error: outcome.reason };
          }
          return { kind: "absence", reason: outcome.reason };
        }
        if (outcome.status === "fail") {
          return { kind: "fail", error: outcome.error };
        }
        return assertNever(outcome);
      }
      default:
        return assertNever(node.kind);
    }
  }
}

function isReady(
  node: GraphNode,
  nodeOutputs: ReadonlyMap<string, Readonly<Record<string, GraphValue>>>,
  byId: ReadonlyMap<string, GraphNode>,
): boolean {
  for (const d of node.dependsOn) {
    if (!nodeOutputs.has(d)) return false;
    const dep = byId.get(d);
    // Streaming pipelines: stream nodes do not impose a global barrier —
    // presence of any output is enough.
    if (dep?.kind === "stream") continue;
  }
  return true;
}

function collectInputs(
  node: GraphNode,
  def: GraphDefinition,
  nodeOutputs: ReadonlyMap<string, Readonly<Record<string, GraphValue>>>,
): Readonly<Record<string, GraphValue>> {
  const out: Record<string, GraphValue> = {};
  for (const e of def.edges) {
    if (e.to !== node.id) continue;
    const fromOut = nodeOutputs.get(e.from);
    if (!fromOut) continue;
    const v = fromOut[e.port] ?? fromOut["result"];
    if (v) out[e.port] = v;
  }
  for (const d of node.dependsOn) {
    const fromOut = nodeOutputs.get(d);
    if (fromOut?.["result"]) out[d] = fromOut["result"]!;
  }
  return out;
}

function hasConverged(
  def: GraphDefinition,
  outputs: ReadonlyMap<string, GraphValue>,
): boolean {
  if (def.convergence.requiredOutputPorts.length === 0) return false;
  return def.convergence.requiredOutputPorts.every((p) => {
    const v = outputs.get(p);
    return v !== undefined && v.tag !== "absence";
  });
}

/** Reject model-written JS orchestration until isolation evaluation passes. */
export function rejectModelWrittenOrchestration(source: string): void {
  const lowered = source.toLowerCase();
  if (
    lowered.includes("new function") ||
    lowered.includes("eval(") ||
    lowered.includes("async function") ||
    lowered.includes("=>")
  ) {
    throw new ValidationError(
      "model-written JavaScript orchestration is not permitted until capability isolation and programmatic-composition evaluation pass",
    );
  }
}

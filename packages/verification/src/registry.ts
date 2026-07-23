/**
 * Predicate executor registry (§40.2).
 */
import { ValidationError } from "@terminus/domain";
import type { VerificationResult } from "@terminus/domain";
import type { VerificationNode } from "@terminus/domain";
import { parseNodeSpec, type PredicateType } from "./node-spec.js";

export interface NodeExecutorInput {
  readonly node: VerificationNode;
  readonly workspaceRevision: string;
  readonly environmentImageDigest: string | null;
  readonly signal: AbortSignal | null;
}

export interface NodeExecutor {
  execute(input: NodeExecutorInput): Promise<VerificationResult>;
}

export interface PredicateExecutor {
  readonly predicateType: PredicateType;
  execute(input: NodeExecutorInput): Promise<VerificationResult>;
}

export class PredicateRegistry {
  private readonly executors: Map<PredicateType, PredicateExecutor> = new Map();

  register(executor: PredicateExecutor): void {
    if (this.executors.has(executor.predicateType)) {
      throw new ValidationError(
        `predicate executor already registered for '${executor.predicateType}'`,
      );
    }
    this.executors.set(executor.predicateType, executor);
  }

  get(predicateType: PredicateType): PredicateExecutor | null {
    return this.executors.get(predicateType) ?? null;
  }

  require(predicateType: PredicateType): PredicateExecutor {
    const e = this.executors.get(predicateType);
    if (!e) {
      throw new ValidationError(
        `no executor registered for predicate '${predicateType}'`,
      );
    }
    return e;
  }

  list(): readonly PredicateExecutor[] {
    return [...this.executors.values()];
  }

  has(predicateType: PredicateType): boolean {
    return this.executors.has(predicateType);
  }

  toNodeExecutor(fallback: NodeExecutor): NodeExecutor {
    return {
      execute: async (input: NodeExecutorInput): Promise<VerificationResult> => {
        const spec = parseNodeSpec(input.node.specification);
        if (spec.predicateType) {
          const ex = this.get(spec.predicateType);
          if (ex) return ex.execute(input);
        }
        return fallback.execute(input);
      },
    };
  }
}

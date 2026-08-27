/**
 * Control-plane verification runtime — replaces synthetic always-pass
 * verification with a real DAG evaluate + completion gate.
 */
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import {
  AdmissionService,
  type CandidateAdmissionRepository,
  type CandidateBranch,
  type CandidateBranchMerger,
  type CandidateEffectLedger,
} from "@terminus/task-runtime";
import type {
  AcceptanceCriterion,
  Rfc3339Timestamp,
  Uuid7,
} from "@terminus/domain";
import {
  InMemoryVerificationStore,
  VerificationEngine,
  VerificationLifecycle,
  createStandardPredicateRegistry,
  criterionNode,
  type PredicateCommandRunner,
  type EvidenceArtifactWriter,
  type ClaimEvidenceGraph,
  type VerificationAttemptRecord,
  type PredicateType,
} from "@terminus/verification";
import type { KernelUdsClients } from "./kernel-uds.js";
import type {
  ProcessEvent,
  RequestContext,
} from "../../../packages/terminus-kernel-client/src/generated-ts-proto/terminus/kernel/v1/kernel.js";

function uuid(): Uuid7 {
  return randomUUID() as Uuid7;
}

function nowIso(): Rfc3339Timestamp {
  return new Date().toISOString() as Rfc3339Timestamp;
}

/** Dev/test runner: treats commands containing "fail" as failure. */
export const scriptedPredicateRunner: PredicateCommandRunner = {
  async run(req) {
    const fail =
      req.command.includes("fail") ||
      (typeof req.observations["forceFail"] === "boolean" && req.observations["forceFail"]);
    return {
      exitCode: fail ? 1 : 0,
      stdout: fail ? "FAIL" : "OK",
      stderr: "",
    };
  },
};

interface KernelCommandOutcome {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Run verification commands through the kernel ProcessService. The control
 * plane never receives a direct process-spawn escape hatch.
 */
export function createKernelPredicateRunner(
  clients: KernelUdsClients,
  baseContext: RequestContext,
  workspaceId: string,
): PredicateCommandRunner {
  return {
    run: (request) => runKernelPredicate(clients, baseContext, workspaceId, request),
  };
}

export async function resolveKernelEnvironmentDigest(
  clients: KernelUdsClients,
  signal?: AbortSignal | null,
): Promise<string> {
  if (signal?.aborted) throw new Error("environment digest resolution aborted");
  const info = await clients.info.GetInfo({});
  const descriptor = JSON.stringify({
    protocolVersion: info.protocolVersion,
    buildRevision: info.buildRevision,
    instanceId: info.instanceId,
    supportedBackends: [...info.supportedBackends].sort(),
    supportedServices: [...info.supportedServices].sort(),
  });
  return `sha256:${createHash("sha256").update(descriptor, "utf8").digest("hex")}`;
}

export async function resolveWorkspaceRevision(
  clients: KernelUdsClients,
  baseContext: RequestContext,
  workspaceId: string,
  signal?: AbortSignal | null,
): Promise<string> {
  const outcome = await runKernelCommand(clients, baseContext, workspaceId, "git", ["rev-parse", "HEAD"], signal ?? null);
  const revision = outcome.stdout.trim();
  if (outcome.exitCode !== 0 || !/^[0-9a-f]{40,64}$/i.test(revision)) {
    throw new Error(`workspace revision could not be established from git: ${outcome.stderr.trim()}`);
  }
  return `git:${revision}`;
}

async function runKernelPredicate(
  clients: KernelUdsClients,
  baseContext: RequestContext,
  workspaceId: string,
  request: Parameters<PredicateCommandRunner["run"]>[0],
): Promise<KernelCommandOutcome> {
  if (request.signal?.aborted) {
    throw new Error("verification predicate aborted before kernel start");
  }
  const parsed = parseCommand(request.command);
  const command = normalizePredicateCommand(request.predicateType, parsed.program, parsed.args, request.paths);
  return runKernelCommand(clients, baseContext, workspaceId, command.program, command.args, request.signal);
}

function normalizePredicateCommand(
  predicateType: string,
  program: string,
  args: readonly string[],
  paths: readonly string[],
): { readonly program: string; readonly args: readonly string[] } {
  if (program !== "terminus-predicate") {
    return { program, args };
  }
  const recipeByPredicate: Readonly<Record<string, string>> = {
    file_parses: "check",
    formatter_check: "check",
    static_diagnostics: "check",
    unit_test: "unit",
    integration_test: "integration",
    property_test: "fuzz-smoke",
    fuzz_test: "fuzz-smoke",
    security_scanner: "security",
    schema_compatibility: "codegen-check",
    migration_dry_run: "check",
    diff_policy: "check",
    performance_threshold: "check",
    e2e_test: "e2e",
  };
  const recipe = recipeByPredicate[predicateType];
  if (recipe === undefined) {
    throw new Error(`predicate '${predicateType}' requires an external verifier; no kernel command is defined`);
  }
  void paths;
  return { program: "just", args: [recipe] };
}

function parseCommand(command: string): { readonly program: string; readonly args: readonly string[] } {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (const character of command.trim()) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote !== null) {
      if (character === quote) quote = null;
      else current += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
    } else if (/\s/.test(character)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += character;
    }
  }
  if (escaped || quote !== null) throw new Error("verification command has an unterminated escape or quote");
  if (current.length > 0) tokens.push(current);
  const [program, ...args] = tokens;
  if (program === undefined) throw new Error("verification command is empty");
  return { program, args };
}

async function runKernelCommand(
  clients: KernelUdsClients,
  baseContext: RequestContext,
  workspaceId: string,
  program: string,
  args: readonly string[],
  signal: AbortSignal | null,
): Promise<KernelCommandOutcome> {
  if (signal?.aborted) throw new Error("verification command aborted before kernel start");
  const context: RequestContext = {
    ...baseContext,
    requestId: randomUUID(),
    idempotencyKey: `verification:${randomUUID()}`,
    workspaceId,
  };
  // The deterministic local harness explicitly opts into the kernel's
  // audited degraded backend on platforms without an enforced sandbox. A
  // production control plane keeps the enforced profile and therefore fails
  // closed when that backend is unavailable.
  const sandboxProfileId = process.env.TERMINUS_DEV === "1"
    ? "degraded-local"
    : "secure-local-default";
  const events = clients.process.Start({
    context,
    intent: {
      userIntentRef: "verification",
      taskContractHash: "",
      trustLabel: "trusted",
      confidentialityLabel: "workspace",
      taintSources: [],
      policyProfileId: "secure-local-default",
      expectedEffectClass: "execute_local",
    },
    command: {
      program,
      args: [...args],
      cwd: { workspaceId, relativePath: "." },
      publicEnv: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
      },
      secretCapabilityUris: [],
      timeout: { seconds: 1800, nanos: 0 },
      allocatePty: false,
      shell: undefined,
    },
    sandboxProfileId,
    outputPolicyId: "verification-bounded",
  });
  return new Promise<KernelCommandOutcome>((resolve, reject) => {
    let processId: string | null = null;
    const stdout: Uint8Array[] = [];
    const stderr: Uint8Array[] = [];
    let settled = false;
    let subscription: { readonly unsubscribe: () => void } | null = null;
    const onAbort = (): void => {
      if (settled) return;
      const currentProcessId = processId;
      if (currentProcessId !== null) {
        void clients.process.Cancel({ context, processId: currentProcessId, reason: "verification-aborted" }).catch(() => undefined);
      }
      finish(() => reject(new Error("verification command aborted")));
    };
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      subscription?.unsubscribe();
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    subscription = events.subscribe({
      next: (event: ProcessEvent) => {
        if (event.started !== undefined) processId = event.started.processId;
        if (event.stdout !== undefined) stdout.push(event.stdout.bytes);
        if (event.stderr !== undefined) stderr.push(event.stderr.bytes);
        if (event.exited !== undefined) {
          finish(() => resolve({
            exitCode: event.exited?.exitCode ?? 1,
            stdout: new TextDecoder().decode(concatBytes(stdout)),
            stderr: new TextDecoder().decode(concatBytes(stderr)),
          }));
        }
      },
      error: (error: unknown) => finish(() => reject(error instanceof Error ? error : new Error(String(error)))),
      complete: () => finish(() => reject(new Error("kernel process stream ended without an exit event"))),
    });
    if (signal !== null && signal !== undefined && !settled) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export interface VerificationRuntime {
  readonly lifecycle: VerificationLifecycle;
  readonly store: InMemoryVerificationStore;
}

export function createVerificationRuntime(
  runner: PredicateCommandRunner,
  artifactWriter?: EvidenceArtifactWriter,
): VerificationRuntime {
  let currentPlanId: Uuid7 = uuid();
  const store = new InMemoryVerificationStore();
  const registry = createStandardPredicateRegistry({
    runner,
    idSource: uuid,
    clock: nowIso,
    planId: () => currentPlanId,
    artifactWriter,
  });
  const executor = registry.toNodeExecutor();
  const engine = new VerificationEngine({
    executorFor: () => executor,
    idSource: uuid,
    clock: nowIso,
  });
  const lifecycle = new VerificationLifecycle({
    store,
    engine,
    idSource: uuid,
    clock: nowIso,
  });
  return {
    store,
    lifecycle: {
      createPlan: async (input) => {
        const plan = await lifecycle.createPlan(input);
        currentPlanId = plan.id;
        return plan;
      },
      evaluate: (planId, rev, digest, signal) => {
        currentPlanId = planId;
        return lifecycle.evaluate(planId, rev, digest, signal);
      },
      invalidateForChangedPaths: (planId, paths) =>
        lifecycle.invalidateForChangedPaths(planId, paths),
      complete: (input) => lifecycle.complete(input),
    } as VerificationLifecycle,
  };
}

export async function persistPlanToPrisma(
  db: PrismaClient | Prisma.TransactionClient,
  plan: {
    readonly id: string;
    readonly taskId: string;
    readonly contractVersion: number;
    readonly sourceRevision: string;
    readonly completionExpression: string;
    readonly planArtifact: string;
    readonly nodes: readonly {
      readonly id: string;
      readonly kind: string;
      readonly required: boolean;
      readonly specification: string;
      readonly timeout: number;
      readonly retryPolicy: unknown;
      readonly acceptanceCriterionId: string | null;
      readonly dependsOn: readonly string[];
    }[];
    readonly edges: readonly {
      readonly from: string;
      readonly to: string;
      readonly kind: string;
    }[];
  },
): Promise<void> {
  await db.verificationPlan.create({
    data: {
      id: plan.id,
      taskId: plan.taskId,
      contractVersion: plan.contractVersion,
      sourceRevision: plan.sourceRevision,
      completionExpression: plan.completionExpression,
      planArtifact: plan.planArtifact,
    },
  });
  for (const n of plan.nodes) {
    await db.verificationNode.create({
      data: {
        id: n.id,
        planId: plan.id,
        kind: n.kind,
        required: n.required,
        specificationJson: n.specification,
        timeoutMs: n.timeout,
        retryPolicyJson: JSON.stringify(n.retryPolicy),
        acceptanceCriterionId: n.acceptanceCriterionId,
        dependsOnJson: JSON.stringify(n.dependsOn),
      },
    });
  }
  for (const e of plan.edges) {
    await db.verificationEdge.create({
      data: {
        planId: plan.id,
        fromNodeId: e.from,
        toNodeId: e.to,
        kind: e.kind,
      },
    });
  }
}

export async function persistResultsToPrisma(
  db: PrismaClient | Prisma.TransactionClient,
  results: readonly {
    readonly id: string;
    readonly planId: string;
    readonly nodeId: string;
    readonly attempts: number;
    readonly status: string;
    readonly sourceRevision: string;
    readonly environmentImageDigest: string | null;
    readonly artifacts: readonly { readonly uri: string }[];
    readonly reasonIfSkipped: string | null;
    readonly startedAt?: string | undefined;
    readonly completedAt?: string | null | undefined;
  }[],
  attempts: readonly VerificationAttemptRecord[] = [],
): Promise<void> {
  const records = attempts.length > 0
    ? attempts.map((attempt) => ({
        id: attempt.id,
        planId: attempt.planId,
        nodeId: attempt.nodeId,
        attempts: attempt.attempt,
        status: attempt.status,
        sourceRevision: attempt.sourceRevision,
        environmentImageDigest: attempt.environmentImageDigest,
        artifacts: attempt.evidence,
        reasonIfSkipped: attempt.reason,
        startedAt: attempt.startedAt,
        completedAt: attempt.completedAt,
      }))
    : results;
  for (const r of records) {
    const attempt = Math.max(1, r.attempts);
    const data = {
      planId: r.planId,
      nodeId: r.nodeId,
      attempt,
      status: r.status,
      sourceRevision: r.sourceRevision,
      environmentDigest: r.environmentImageDigest ?? "unknown",
      evidenceArtifact: r.artifacts[0]?.uri ?? null,
      ...(r.startedAt === undefined ? {} : { startedAt: new Date(r.startedAt) }),
      ...(r.completedAt === undefined || r.completedAt === null ? {} : { completedAt: new Date(r.completedAt) }),
      reason: r.reasonIfSkipped,
    };
    const existing = await db.verificationResult.findFirst({
      where: { planId: r.planId, nodeId: r.nodeId, attempt },
      select: { id: true },
    });
    if (existing === null) {
      await db.verificationResult.create({ data: { id: r.id, ...data } });
    } else {
      await db.verificationResult.update({ where: { id: existing.id }, data });
    }
  }
}

export async function persistClaimEvidenceGraphToPrisma(
  db: PrismaClient | Prisma.TransactionClient,
  graph: ClaimEvidenceGraph,
): Promise<void> {
  for (const claim of graph.claims) {
    await db.claim.upsert({
      where: { id: claim.id },
      create: {
        id: claim.id,
        taskId: claim.taskId,
        statement: claim.statement,
        requiredEvidenceKind: claim.requiredEvidenceKind,
        status: claim.status,
        evidenceIdsJson: JSON.stringify(claim.evidenceIds),
        waivedRationale: claim.waivedRationale,
      },
      update: {
        statement: claim.statement,
        requiredEvidenceKind: claim.requiredEvidenceKind,
        status: claim.status,
        evidenceIdsJson: JSON.stringify(claim.evidenceIds),
        waivedRationale: claim.waivedRationale,
      },
    });
  }
  for (const item of graph.evidence) {
    if (item.sourceRevision === null) {
      throw new Error(`evidence ${item.id} has no source revision`);
    }
    const existing = await db.evidence.findUnique({ where: { id: item.id } });
    const artifactRef = item.artifactRef?.uri ?? null;
    const metadataJson = JSON.stringify(item.metadata);
    const observedAt = new Date(item.observedAt);
    if (existing !== null) {
      const unchanged = existing.claimId === item.claimId
        && existing.kind === item.kind
        && existing.summary === item.summary
        && existing.sourceRevision === item.sourceRevision
        && existing.environmentHash === item.environmentHash
        && existing.verifierResult === item.verifierResult
        && existing.artifactRef === artifactRef
        && existing.metadataJson === metadataJson
        && existing.observedAt.getTime() === observedAt.getTime();
      if (!unchanged) {
        throw new Error(`immutable evidence ${item.id} changed after persistence`);
      }
      continue;
    }
    await db.evidence.create({
      data: {
        id: item.id,
        claimId: item.claimId,
        kind: item.kind,
        summary: item.summary,
        sourceRevision: item.sourceRevision,
        environmentHash: item.environmentHash,
        verifierResult: item.verifierResult,
        artifactRef,
        metadataJson,
        observedAt,
      },
    });
  }
}

/**
 * Prisma-backed completion admission for the live control path. Verification
 * creates a candidate branch with no uncommitted effects; the merger still
 * re-reads the authoritative revision immediately before admitting it. Any
 * future candidate with effects must supply a real effect-ledger adapter.
 */
export function createPrismaCompletionAdmission(
  db: PrismaClient,
  getAuthoritativeRevision: () => Promise<string>,
): AdmissionService {
  const repository: CandidateAdmissionRepository = {
    async createCandidateBranch(branch) {
      await db.candidateBranch.create({
        data: {
          id: branch.branchId,
          taskId: branch.taskId,
          attemptId: branch.attemptId,
          actorPrincipal: branch.actorPrincipal,
          worktreePath: branch.worktreePath,
          epoch: branch.epoch,
          baseRevision: branch.baseRevision,
          headRevision: branch.headRevision,
          scopeDigest: branch.scopeDigest,
          effectIdsJson: JSON.stringify(branch.effectIds),
          proofJson: branch.proof === null ? null : JSON.stringify(branch.proof),
          status: branch.status,
        },
      });
      return branch;
    },
    async getCandidateBranch(branchId) {
      const row = await db.candidateBranch.findUnique({ where: { id: branchId } });
      return row === null ? null : candidateBranchFromRow(row);
    },
    async claimCandidateBranch(branchId, expectedEpoch) {
      return db.$transaction(async (tx) => {
        const claimed = await tx.candidateBranch.updateMany({
          where: { id: branchId, epoch: expectedEpoch, status: "OPEN" },
          data: { epoch: { increment: 1 }, status: "ADMITTING" },
        });
        if (claimed.count !== 1) return null;
        const row = await tx.candidateBranch.findUnique({ where: { id: branchId } });
        return row === null ? null : candidateBranchFromRow(row);
      });
    },
    async updateCandidateBranch(branch) {
      const updated = await db.candidateBranch.updateMany({
        where: { id: branch.branchId, epoch: branch.epoch - 1 },
        data: {
          epoch: branch.epoch,
          headRevision: branch.headRevision,
          proofJson: branch.proof === null ? null : JSON.stringify(branch.proof),
          status: branch.status,
        },
      });
      if (updated.count !== 1) throw new Error(`candidate branch ${branch.branchId} changed before durable admission update`);
      return branch;
    },
    async getEffectRecord() {
      return null;
    },
  };
  const ledger: CandidateEffectLedger = {
    async commitEffect(effectId) {
      throw new Error(`Prisma completion admission cannot commit unregistered effect '${effectId}'`);
    },
    async cancelEffect(effectId) {
      throw new Error(`Prisma completion admission cannot cancel unregistered effect '${effectId}'`);
    },
  };
  const merger: CandidateBranchMerger = {
    getAuthoritativeRevision,
    async merge(branch) {
      const authoritativeRevision = await getAuthoritativeRevision();
      if (authoritativeRevision !== branch.baseRevision) {
        throw new Error(`candidate branch '${branch.branchId}' changed before admission`);
      }
      return {
        mergeId: `completion-admission:${branch.branchId}`,
        authoritativeRevision,
      };
    },
  };
  return new AdmissionService(repository, ledger, undefined, merger);
}

function candidateBranchFromRow(row: {
  readonly id: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly actorPrincipal: string;
  readonly worktreePath: string;
  readonly epoch: number;
  readonly baseRevision: string;
  readonly headRevision: string;
  readonly scopeDigest: string;
  readonly effectIdsJson: string;
  readonly proofJson: string | null;
  readonly status: string;
}): CandidateBranch {
  const effectIds = JSON.parse(row.effectIdsJson) as unknown;
  const proof = row.proofJson === null ? null : JSON.parse(row.proofJson) as CandidateBranch["proof"];
  if (!Array.isArray(effectIds) || !effectIds.every((value): value is string => typeof value === "string")) {
    throw new Error(`candidate branch '${row.id}' has invalid effect IDs`);
  }
  if (
    row.status !== "OPEN"
    && row.status !== "ADMITTING"
    && row.status !== "ADMITTED"
    && row.status !== "REJECTED"
    && row.status !== "MANUAL_REVIEW"
  ) {
    throw new Error(`candidate branch '${row.id}' has invalid status '${row.status}'`);
  }
  return {
    branchId: row.id,
    taskId: row.taskId,
    attemptId: row.attemptId,
    actorPrincipal: row.actorPrincipal,
    worktreePath: row.worktreePath,
    epoch: row.epoch,
    baseRevision: row.baseRevision,
    headRevision: row.headRevision,
    scopeDigest: row.scopeDigest,
    effectIds,
    proof,
    status: row.status,
  };
}

export function defaultCriteriaNodes(
  criteria: readonly AcceptanceCriterion[],
): ReturnType<typeof criterionNode>[] {
  // VerificationNode.id is globally unique in the control-plane schema. A
  // repair creates a new plan for the same criteria, so criterion-derived
  // names must be namespaced per plan attempt rather than reused.
  const nodeId = (name: string): string => `${name}_${randomUUID()}`;
  if (criteria.length === 0) {
    const parseId = nodeId("parse");
    const diagnosticsId = nodeId("diagnostics");
    const narrowTestsId = nodeId("narrow_tests");
    return [
      criterionNode({
        id: parseId,
        criterionId: null,
        predicateType: "file_parses",
        paths: ["."],
        required: true,
      }),
      criterionNode({
        id: diagnosticsId,
        criterionId: null,
        predicateType: "static_diagnostics",
        paths: ["."],
        required: true,
        dependsOn: [parseId],
      }),
      criterionNode({
        id: narrowTestsId,
        criterionId: null,
        predicateType: "unit_test",
        paths: ["."],
        required: true,
        dependsOn: [diagnosticsId],
      }),
    ];
  }
  const nodeIds = criteria.map((criterion) => nodeId(`ac_${criterion.id}`));
  return criteria.map((c, i) => {
    const hint = c.verificationHint?.trim() ?? "";
    const command = hint.toLowerCase().startsWith("command:")
      ? hint.slice("command:".length).trim()
      : undefined;
    const predicateType: PredicateType = i === 0 ? "file_parses" : "unit_test";
    const id = nodeIds[i]!;
    const node = {
      id,
      criterionId: c.id,
      predicateType,
      paths: ["."],
      required: c.required,
      dependsOn: i === 0 ? [] : [nodeIds[i - 1]!],
    };
    return criterionNode(command === undefined ? node : { ...node, command });
  });
}

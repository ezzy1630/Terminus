/**
 * Control-plane verification runtime — replaces synthetic always-pass
 * verification with a real DAG evaluate + completion gate.
 */
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { canonicalJson } from "@terminus/context-ir";
import {
  AdmissionService,
  candidateBranchAdmissionOperationId,
  validateCandidateBranchMergeReceipt,
  type CandidateAdmissionRepository,
  type CandidateBranch,
  type CandidateBranchMergeReceipt,
  type CandidateBranchMergeReceiptQuery,
  type CandidateBranchMerger,
  type CandidateEffectLedger,
} from "@terminus/task-runtime";
import type {
  AcceptanceCriterion,
  ArtifactRef,
  Rfc3339Timestamp,
  VerificationNode,
  VerificationPlan,
  VerificationResult,
  Uuid7,
} from "@terminus/domain";
import { artifactRefSchema } from "@terminus/domain";
import {
  InMemoryVerificationStore,
  VerificationEngine,
  VerificationLifecycle,
  buildVerificationPlan,
  createStandardPredicateRegistry,
  deriveVerificationNodes,
  parseNodeSpec,
  type PredicateCommandOutcome,
  type PredicateCommandRunner,
  type EvidenceArtifactWriter,
  type ClaimEvidenceGraph,
  type VerificationAttemptRecord,
  type VerificationDerivationSignals,
  type VerificationPlanMode,
} from "@terminus/verification";
import type { KernelUdsClients } from "./kernel-uds.js";
import { kernelPublicEnv } from "./agent-tools.js";
import {
  REPOSITORY_SIGNAL_PATHS,
  type VerificationRunnerCatalog,
  type VerificationRunnerKind,
} from "./agent/repository-signals.js";
import { createKernelArtifactClient } from "./context-store.js";
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

function jsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value !== null && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      output[key] = jsonSafe(item);
    }
    return output;
  }
  return value;
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
  /**
   * Repository-derived commands (H3). Read lazily so the runner picks up the
   * signals discovered during the turn it is verifying. When it resolves to an
   * empty catalog every derived predicate reports `skipped`, never `fail`.
   */
  runnerCatalog: () => VerificationRunnerCatalog = () => ({}),
  /**
   * Host path of the workspace, so the repository's own tool directories
   * (`.venv/bin`, `node_modules/.bin`) resolve exactly as they do for the
   * agent's `exec`. Without it `python -m pytest` ran the host interpreter,
   * which has no pytest, and every derived check failed for the wrong reason.
   */
  workspaceRoot: string | null = null,
): PredicateCommandRunner {
  return {
    run: (request) => runKernelPredicate(clients, baseContext, workspaceId, request, runnerCatalog(), workspaceRoot),
  };
}

export async function resolveKernelEnvironmentDigest(
  clients: KernelUdsClients,
  signal?: AbortSignal | null,
): Promise<string> {
  if (signal?.aborted) throw new Error("environment digest resolution aborted");
  const info = await clients.info.GetInfo({});
  // `instanceId` is deliberately excluded. It changes on every kernel
  // restart, and a plan is bound to the digest, so including it meant any
  // restart while a task was VERIFYING permanently poisoned that task's
  // verification plan ("stale source or environment binding") with no way
  // back. What the digest must describe is the *environment* — the protocol,
  // the build, and the capabilities available — not which process instance
  // happened to answer.
  const descriptor = JSON.stringify({
    protocolVersion: info.protocolVersion,
    buildRevision: info.buildRevision,
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
  if (outcome.exitCode === 0 && /^[0-9a-f]{40,64}$/i.test(revision)) {
    const status = await runKernelCommand(
      clients,
      baseContext,
      workspaceId,
      "git",
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      signal ?? null,
    );
    if (status.exitCode !== 0) {
      throw new Error(`workspace revision could not establish git status: ${status.stderr.trim()}`);
    }
    if (status.stdout.length === 0) return `git:${revision}`;
    const entries = parseGitStatusPorcelain(status.stdout);
    const pathHashes = await hashChangedGitPaths(
      clients,
      baseContext,
      workspaceId,
      entries,
      signal ?? null,
    );
    return buildDirtyGitWorkspaceRevision(revision, entries, pathHashes);
  }
  const stderr = outcome.stderr.trim();
  if (!isNotAGitWorkspace(stderr)) {
    throw new Error(`workspace revision could not be established from git: ${stderr}`);
  }
  // A workspace with no repository (a freshly materialised fixture, a bare
  // directory a user opened) still needs a revision the verification plan
  // can bind to and re-check. A content hash over the tree is the honest
  // equivalent of a commit id: it changes exactly when the sources change.
  const tree = await runKernelCommand(
    clients,
    baseContext,
    workspaceId,
    "sh",
    ["-c", WORKSPACE_TREE_HASH_SCRIPT],
    signal ?? null,
  );
  const treeHash = tree.stdout.trim().split(/\s+/)[0] ?? "";
  if (tree.exitCode !== 0 || !/^[0-9a-f]{64}$/i.test(treeHash)) {
    throw new Error(
      `workspace revision could not be established: not a git repository, and the tree hash failed: ${tree.stderr.trim()}`,
    );
  }
  return `tree:${treeHash}`;
}

/** `git rev-parse` failure text that means "no repository here", not "git broke". */
export function isNotAGitWorkspace(stderr: string): boolean {
  return /not a git repository|no such file or directory.*\.git|must be run in a work tree/i.test(stderr);
}

const MAX_GIT_STATUS_BYTES = 512 * 1024;
const MAX_GIT_STATUS_PATHS = 4_096;
const MAX_GIT_PATH_BYTES = 8 * 1_024;
const MAX_GIT_HASH_BATCH_PATHS = 256;
const MAX_GIT_HASH_BATCH_ARG_BYTES = 32 * 1_024;
const MAX_GIT_HASH_OUTPUT_BYTES = 64 * 1_024;

export interface GitStatusEntry {
  readonly status: string;
  readonly path: string;
  readonly oldPath: string | null;
}

/**
 * Parse `git status --porcelain=v1 -z` without shell quoting. The NUL
 * framing is important: repository paths may contain spaces, quotes, and
 * newlines. Rename/copy records carry the old path in the following record.
 */
export function parseGitStatusPorcelain(output: string): readonly GitStatusEntry[] {
  if (new TextEncoder().encode(output).byteLength > MAX_GIT_STATUS_BYTES) {
    throw new Error("git status output exceeded the bounded workspace revision limit");
  }
  if (output.includes("\uFFFD")) {
    throw new Error("git status output was not valid UTF-8");
  }
  if (output.length === 0) return [];
  if (!output.endsWith("\0")) {
    throw new Error("git status output was not NUL terminated");
  }
  const records = output.slice(0, -1).split("\0");
  const entries: GitStatusEntry[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (record.length < 4 || record[2] !== " " || !/^[ MADRCU?!]{2}$/.test(record.slice(0, 2))) {
      throw new Error("git status output contained a malformed porcelain record");
    }
    const status = record.slice(0, 2);
    const path = record.slice(3);
    if (path.length === 0 || new TextEncoder().encode(path).byteLength > MAX_GIT_PATH_BYTES) {
      throw new Error("git status output contained an invalid or oversized path");
    }
    const isRenameOrCopy = status.includes("R") || status.includes("C");
    let oldPath: string | null = null;
    if (isRenameOrCopy) {
      const oldRecord = records[index + 1];
      if (oldRecord === undefined || oldRecord.length === 0) {
        throw new Error("git status rename/copy record was missing its old path");
      }
      if (new TextEncoder().encode(oldRecord).byteLength > MAX_GIT_PATH_BYTES) {
        throw new Error("git status output contained an oversized rename path");
      }
      oldPath = oldRecord;
      index += 1;
    }
    entries.push({ status, path, oldPath });
    if (entries.length > MAX_GIT_STATUS_PATHS) {
      throw new Error("git status output exceeded the bounded path limit");
    }
  }
  return entries;
}

/** Build a stable source identity from Git status and the current bytes. */
export function buildDirtyGitWorkspaceRevision(
  headRevision: string,
  entries: readonly GitStatusEntry[],
  pathHashes: ReadonlyMap<string, string | null>,
): string {
  const normalized = [...entries]
    .map((entry) => ({
      status: entry.status,
      path: entry.path,
      oldPath: entry.oldPath,
      sha256: pathHashes.get(entry.path) ?? null,
    }))
    .sort((left, right) => {
      const leftKey = `${left.path}\0${left.oldPath ?? ""}\0${left.status}`;
      const rightKey = `${right.path}\0${right.oldPath ?? ""}\0${right.status}`;
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
  const digest = createHash("sha256")
    .update(canonicalJson({ headRevision, entries: normalized }), "utf8")
    .digest("hex");
  return `git:${headRevision}:dirty:${digest}`;
}

async function hashChangedGitPaths(
  clients: KernelUdsClients,
  baseContext: RequestContext,
  workspaceId: string,
  entries: readonly GitStatusEntry[],
  signal: AbortSignal | null,
): Promise<ReadonlyMap<string, string | null>> {
  const pathHashes = new Map<string, string | null>();
  const pathsToHash = new Set<string>();
  for (const entry of entries) {
    // A deleted path has no current bytes. For a rename/copy, only the new
    // path is current; the old path remains part of the status digest.
    if (!entry.status.includes("D")) {
      pathsToHash.add(entry.path);
    }
    pathHashes.set(entry.path, null);
  }
  const paths = [...pathsToHash].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  let offset = 0;
  while (offset < paths.length) {
    const batch: string[] = [];
    let batchBytes = 0;
    for (const path of paths.slice(offset, offset + MAX_GIT_HASH_BATCH_PATHS)) {
      const pathBytes = new TextEncoder().encode(path).byteLength + 1;
      if (batch.length > 0 && batchBytes + pathBytes > MAX_GIT_HASH_BATCH_ARG_BYTES) break;
      batch.push(path);
      batchBytes += pathBytes;
    }
    if (batch.length === 0) {
      throw new Error("git changed-path hash batch could not fit the bounded argv limit");
    }
    const outcome = await runKernelCommand(
      clients,
      baseContext,
      workspaceId,
      "git",
      ["hash-object", "--no-filters", "--", ...batch],
      signal,
    );
    if (outcome.exitCode !== 0) {
      throw new Error(`workspace revision could not hash changed paths: ${outcome.stderr.trim()}`);
    }
    if (new TextEncoder().encode(outcome.stdout).byteLength > MAX_GIT_HASH_OUTPUT_BYTES) {
      throw new Error("git changed-path hash output exceeded the bounded workspace revision limit");
    }
    const hashes = outcome.stdout.trim().split(/\r?\n/).filter((hash) => hash.length > 0);
    if (hashes.length !== batch.length || hashes.some((hash) => !/^[0-9a-f]{40,64}$/i.test(hash))) {
      throw new Error("git changed-path hash output was malformed or incomplete");
    }
    batch.forEach((path, index) => pathHashes.set(path, hashes[index]!));
    // The byte cap can make a batch smaller than the path-count cap. Advance
    // by exactly what was sent, or paths between batches would be skipped.
    offset += batch.length;
  }
  return pathHashes;
}

/**
 * Content hash of every regular file in the workspace (excluding a `.git`
 * directory, should one appear later), with deterministic ordering. Runs
 * inside the sandbox with the caller's PATH, which always carries /usr/bin.
 */
export const WORKSPACE_TREE_HASH_SCRIPT =
  'find . -type f -not -path "./.git/*" -print0 | LC_ALL=C sort -z | xargs -0 shasum -a 256 | shasum -a 256';

/** Runner role that satisfies each derived predicate, in preference order. */
const RUNNER_KINDS_BY_PREDICATE: Readonly<Record<string, readonly VerificationRunnerKind[]>> = {
  file_parses: ["typecheck", "lint", "test"],
  formatter_check: ["format", "lint"],
  static_diagnostics: ["typecheck", "lint"],
  unit_test: ["unit_test", "test"],
  integration_test: ["integration_test", "test"],
  property_test: ["test"],
  fuzz_test: [],
  security_scanner: ["security"],
  schema_compatibility: ["codegen_check"],
  migration_dry_run: [],
  diff_policy: [],
  performance_threshold: [],
  e2e_test: ["e2e_test"],
};

/**
 * Baseline probes are useful when the repository implements them, but they
 * are not task acceptance predicates. If every required acceptance predicate
 * is runnable, an unavailable baseline probe must stay visible as an optional
 * skip instead of making an otherwise provable task impossible to admit.
 *
 * Risk-specific predicates are intentionally absent. A missing security,
 * migration, compatibility, performance, or UI verifier remains required and
 * therefore fails closed.
 */
const OPTIONAL_UNAVAILABLE_BASELINE_PREDICATES = new Set([
  "file_parses",
  "formatter_check",
  "static_diagnostics",
  "unit_test",
]);

type PredicateCommandResolution =
  | { readonly kind: "command"; readonly program: string; readonly args: readonly string[]; readonly source: string | null }
  | { readonly kind: "skipped"; readonly reason: string };

const describeRunnerCatalog = (catalog: VerificationRunnerCatalog): readonly string[] =>
  Object.values(catalog)
    .filter((runner): runner is NonNullable<typeof runner> => runner !== undefined)
    .map((runner) => `${runner.kind}=${runner.command} (${runner.sourcePath})`)
    .sort();

// skipcq: JS-R1005
const parseCommand = (command: string): { readonly program: string; readonly args: readonly string[] } => {
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
};

/**
 * Turn a node's declared command into something the kernel can run.
 *
 * An explicit command from the node specification is honored verbatim. The
 * `terminus-predicate <type>` placeholder is resolved against commands actually
 * detected in this repository; when nothing implements the role, the predicate
 * is `skipped` with the reason — a hardcoded `just <recipe>` fails every
 * repository without a justfile.
 */
// skipcq: JS-R1005
export const resolvePredicateCommand = (
  predicateType: string,
  program: string,
  args: readonly string[],
  catalog: VerificationRunnerCatalog,
): PredicateCommandResolution => {
  if (program !== "terminus-predicate") {
    return { kind: "command", program, args, source: null };
  }
  if (predicateType === "ui_e2e") {
    return {
      kind: "skipped",
      reason: "governed UI verification requires a configured computer-use verifier; no kernel command is defined",
    };
  }
  if (predicateType === "diff_policy") {
    return {
      kind: "command",
      program: "git",
      args: ["diff", "--check"],
      source: "terminus:diff-policy-v1",
    };
  }
  const kinds = RUNNER_KINDS_BY_PREDICATE[predicateType];
  if (kinds === undefined) {
    return {
      kind: "skipped",
      reason: `predicate '${predicateType}' requires an external verifier; no repository command implements it`,
    };
  }
  for (const kind of kinds) {
    const runner = catalog[kind];
    if (runner === undefined) continue;
    const parsed = parseCommand(runner.command);
    return {
      kind: "command",
      program: parsed.program,
      args: parsed.args,
      source: `${runner.kind}:${runner.sourcePath}`,
    };
  }
  const detected = describeRunnerCatalog(catalog);
  return {
    kind: "skipped",
    reason: detected.length === 0
      ? `no test runner detected in this repository for '${predicateType}' (looked for ${[...REPOSITORY_SIGNAL_PATHS].join(", ")})`
      : `no detected runner implements '${predicateType}' (needs one of ${kinds.join(", ")}; detected ${detected.join("; ")})`,
  };
};

async function runKernelPredicate(
  clients: KernelUdsClients,
  baseContext: RequestContext,
  workspaceId: string,
  request: Parameters<PredicateCommandRunner["run"]>[0],
  catalog: VerificationRunnerCatalog,
  workspaceRoot: string | null = null,
): Promise<PredicateCommandOutcome> {
  if (request.signal?.aborted) {
    throw new Error("verification predicate aborted before kernel start");
  }
  const parsed = parseCommand(request.command);
  const resolution = resolvePredicateCommand(request.predicateType, parsed.program, parsed.args, catalog);
  if (resolution.kind === "skipped") {
    return {
      exitCode: 0,
      stdout: "",
      stderr: "",
      status: "skipped",
      reasonIfSkipped: resolution.reason,
      observations: {
        requestedPaths: [...request.paths],
        detectedRunners: describeRunnerCatalog(catalog),
      },
    };
  }
  const outcome = await runKernelCommand(
    clients,
    baseContext,
    workspaceId,
    resolution.program,
    resolution.args,
    request.signal,
    request.timeoutMs,
    workspaceRoot,
  );
  return {
    ...outcome,
    observations: {
      // `paths` scope the node, not the runner: appending them as argv to a
      // repository-owned recipe would change what the recipe means. They are
      // recorded as evidence instead of silently dropped.
      requestedPaths: [...request.paths],
      resolvedCommand: [resolution.program, ...resolution.args].join(" "),
      ...(resolution.source === null ? {} : { runnerSource: resolution.source }),
      timeoutMs: request.timeoutMs,
    },
  };
}

function nodeCommandResolution(
  node: VerificationNode,
  catalog: VerificationRunnerCatalog,
): PredicateCommandResolution | null {
  const specification = parseNodeSpec(node.specification);
  if (specification.predicateType === null) return null;
  const command = specification.command ?? `terminus-predicate ${specification.predicateType}`;
  const parsed = parseCommand(command);
  return resolvePredicateCommand(
    specification.predicateType,
    parsed.program,
    parsed.args,
    catalog,
  );
}

/**
 * Select the applicable required baseline before the plan becomes immutable.
 * This never turns a skipped result into a pass: only criterion-free baseline
 * probes known to have no runner are made optional, and only when every
 * mandatory acceptance predicate has a concrete command to execute.
 */
export function selectApplicableVerificationRequirements(
  nodes: readonly VerificationNode[],
  catalog: VerificationRunnerCatalog,
): VerificationNode[] {
  const requiredCriteria = nodes.filter(
    (node) => node.required && node.acceptanceCriterionId !== null,
  );
  const allRequiredCriteriaRunnable = requiredCriteria.length > 0
    && requiredCriteria.every(
      (node) => nodeCommandResolution(node, catalog)?.kind === "command",
    );
  if (!allRequiredCriteriaRunnable) return [...nodes];

  return nodes.map((node) => {
    if (!node.required || node.acceptanceCriterionId !== null) return node;
    const predicateType = parseNodeSpec(node.specification).predicateType;
    if (
      predicateType === null
      || !OPTIONAL_UNAVAILABLE_BASELINE_PREDICATES.has(predicateType)
      || nodeCommandResolution(node, catalog)?.kind !== "skipped"
    ) {
      return node;
    }
    return { ...node, required: false };
  });
}

const DEFAULT_PREDICATE_TIMEOUT_MS = 30 * 60 * 1_000;

async function runKernelCommand(
  clients: KernelUdsClients,
  baseContext: RequestContext,
  workspaceId: string,
  program: string,
  args: readonly string[],
  signal: AbortSignal | null,
  timeoutMs: number = DEFAULT_PREDICATE_TIMEOUT_MS,
  workspaceRoot: string | null = null,
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
      // Exactly the environment the agent's own exec gets: the user's PATH
      // and HOME so toolchains resolve, deterministic colourless output, and
      // no secret-bearing variable. TMPDIR is not forwarded — the host's
      // points outside the sandbox and is denied; the kernel supplies a
      // writable one inside it.
      publicEnv: kernelPublicEnv(process.env, { workspaceRoot }),
      secretCapabilityUris: [],
      // The node's persisted budget, not a fixed 30-minute ceiling.
      timeout: {
        seconds: Math.max(1, Math.floor(timeoutMs / 1_000)),
        nanos: Math.max(0, Math.floor(timeoutMs % 1_000)) * 1_000_000,
      },
      allocatePty: false,
      shell: undefined,
      allowUnboundedTimeout: false,
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
      evaluate: (planId, rev, digest, signal, options) => {
        currentPlanId = planId;
        return lifecycle.evaluate(planId, rev, digest, signal, options);
      },
      invalidateForChangedPaths: (planId, paths) =>
        lifecycle.invalidateForChangedPaths(planId, paths),
      restorePlan: (input) => lifecycle.restorePlan(input),
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
    readonly environmentDigest: string | null;
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
      environmentDigest: plan.environmentDigest,
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

interface PersistedVerificationPlanRow {
  readonly id: string;
  readonly taskId: string;
  readonly contractVersion: number;
  readonly sourceRevision: string;
  readonly environmentDigest: string | null;
  readonly completionExpression: string;
  readonly createdAt: Date;
  readonly nodes: readonly {
    readonly id: string;
    readonly kind: string;
    readonly required: boolean;
    readonly specificationJson: string;
    readonly timeoutMs: number | null;
    readonly retryPolicyJson: string;
    readonly acceptanceCriterionId: string | null;
    readonly dependsOnJson: string;
  }[];
  readonly edges: readonly {
    readonly fromNodeId: string;
    readonly toNodeId: string;
    readonly kind: string;
  }[];
}

const VERIFICATION_NODE_KINDS = new Set<VerificationNode["kind"]>([
  "command",
  "diagnostic",
  "diff_rule",
  "human",
  "external_query",
]);

function parseRetryPolicy(value: unknown): VerificationNode["retryPolicy"] | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const maxAttempts = record.maxAttempts;
  const backoffMs = record.backoffMs;
  const flakeIdentity = record.flakeIdentity;
  if (
    typeof maxAttempts !== "number"
    || !Number.isInteger(maxAttempts)
    || maxAttempts < 1
    || typeof backoffMs !== "number"
    || !Number.isInteger(backoffMs)
    || backoffMs < 0
    || (flakeIdentity !== null && typeof flakeIdentity !== "string")
  ) return null;
  return {
    maxAttempts,
    backoffMs,
    flakeIdentity: flakeIdentity as string | null,
  };
}

function parseStringArray(value: unknown): readonly string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value as string[]
    : null;
}

function parseVerificationEdges(
  edges: readonly PersistedVerificationPlanRow["edges"][number][],
  nodes: readonly VerificationNode[],
): readonly VerificationPlan["edges"][number][] | null {
  const nodeById = new Map(nodes.map((node) => [node.id, node] as const));
  const seen = new Set<string>();
  const parsed: VerificationPlan["edges"][number][] = [];
  for (const edge of edges) {
    const kind = edge.kind === "depends"
      ? "depends" as const
      : edge.kind === "invalidates"
        ? "invalidates" as const
        : null;
    const from = nodeById.get(edge.fromNodeId);
    const to = nodeById.get(edge.toNodeId);
    if (kind === null || from === undefined || to === undefined) return null;
    const key = `${edge.fromNodeId}\u0000${edge.toNodeId}\u0000${kind}`;
    if (seen.has(key)) return null;
    seen.add(key);
    if (kind === "depends" && !to.dependsOn.includes(from.id)) return null;
    parsed.push({ from: from.id, to: to.id, kind });
  }
  for (const node of nodes) {
    for (const dependency of node.dependsOn) {
      if (!seen.has(`${dependency}\u0000${node.id}\u0000depends`)) return null;
    }
  }
  return parsed;
}

/** Rebuild a persisted plan while revalidating its DAG and expression. */
export function verificationPlanFromPrisma(
  row: PersistedVerificationPlanRow,
): VerificationPlan | null {
  const nodes: VerificationNode[] = [];
  for (const rowNode of row.nodes) {
    if (!VERIFICATION_NODE_KINDS.has(rowNode.kind as VerificationNode["kind"])) return null;
    const dependsOn = parseStringArray(safeJsonParse(rowNode.dependsOnJson));
    const retryPolicy = parseRetryPolicy(safeJsonParse(rowNode.retryPolicyJson));
    if (dependsOn === null || retryPolicy === null) return null;
    nodes.push({
      id: rowNode.id,
      kind: rowNode.kind as VerificationNode["kind"],
      required: rowNode.required,
      dependsOn,
      specification: rowNode.specificationJson,
      timeout: rowNode.timeoutMs ?? 30_000,
      retryPolicy,
      acceptanceCriterionId: rowNode.acceptanceCriterionId,
    });
  }
  const edges = parseVerificationEdges(row.edges, nodes);
  if (edges === null) return null;
  try {
    const validated = buildVerificationPlan({
      id: row.id as Uuid7,
      taskContractId: row.taskId as Uuid7,
      taskContractVersion: row.contractVersion,
      sourceRevision: row.sourceRevision,
      nodes,
      completionExpression: row.completionExpression,
    });
    return {
      ...validated,
      edges,
      createdAt: row.createdAt.toISOString() as Rfc3339Timestamp,
    };
  } catch {
    return null;
  }
}

function safeJsonParse(text: string): unknown {
  try { return JSON.parse(text) as unknown; } catch { return null; }
}

function parseObject(text: string): Readonly<Record<string, unknown>> | null {
  const value = safeJsonParse(text);
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function encodeArtifactRefs(artifacts: readonly ArtifactRef[]): string {
  return JSON.stringify(artifacts.map((artifact) => ({
    hash: artifact.hash,
    uri: artifact.uri,
    mediaType: artifact.mediaType,
    bytes: artifact.bytes.toString(),
  })));
}

function parseArtifactRefs(text: string): readonly ArtifactRef[] | null {
  const value = safeJsonParse(text);
  if (!Array.isArray(value)) return null;
  const artifacts: ArtifactRef[] = [];
  for (const item of value) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return null;
    const record = item as Record<string, unknown>;
    if (typeof record.bytes !== "string" || !/^\d+$/.test(record.bytes)) return null;
    let bytes: bigint;
    try { bytes = BigInt(record.bytes); } catch { return null; }
    const parsed = artifactRefSchema.safeParse({ ...record, bytes });
    if (!parsed.success) return null;
    artifacts.push(parsed.data);
  }
  return artifacts;
}

interface PersistedVerificationResultRow {
  readonly id: string;
  readonly planId: string;
  readonly nodeId: string;
  readonly attempt: number;
  readonly status: string;
  readonly sourceRevision: string;
  readonly environmentDigest: string;
  readonly exitCode: number | null;
  readonly commandOrQuery: string | null;
  readonly structuredObservationsJson: string | null;
  readonly artifactsJson: string | null;
  readonly verifierVersion: string | null;
  readonly evidenceArtifact: string | null;
  readonly toolCallId: string | null;
  readonly startedAt: Date;
  readonly completedAt: Date | null;
  readonly reason: string | null;
}

const VERIFICATION_RESULT_STATUSES = new Set<VerificationResult["status"]>([
  "pass",
  "fail",
  "error",
  "skipped",
  "blocked",
]);

/** Return null for legacy/thin rows that cannot safely satisfy a completion gate. */
export function verificationResultFromPrisma(
  row: PersistedVerificationResultRow,
): VerificationResult | null {
  if (
    row.commandOrQuery === null
    || row.structuredObservationsJson === null
    || row.artifactsJson === null
    || row.verifierVersion === null
    || row.environmentDigest === "unknown"
    || !VERIFICATION_RESULT_STATUSES.has(row.status as VerificationResult["status"])
  ) return null;
  const observations = parseObject(row.structuredObservationsJson);
  const artifacts = parseArtifactRefs(row.artifactsJson);
  if (observations === null || artifacts === null) return null;
  return {
    id: row.id as Uuid7,
    planId: row.planId as Uuid7,
    nodeId: row.nodeId,
    status: row.status as VerificationResult["status"],
    startedAt: row.startedAt.toISOString() as Rfc3339Timestamp,
    completedAt: row.completedAt?.toISOString() as Rfc3339Timestamp | null ?? null,
    sourceRevision: row.sourceRevision,
    environmentImageDigest: row.environmentDigest,
    commandOrQuery: row.commandOrQuery,
    exitCode: row.exitCode,
    structuredObservations: observations,
    artifacts,
    toolCallId: row.toolCallId as Uuid7 | null,
    verifierVersion: row.verifierVersion,
    reasonIfSkipped: row.reason,
    attempts: Math.max(1, row.attempt),
  };
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
    readonly artifacts: readonly ArtifactRef[];
    readonly commandOrQuery: string;
    readonly exitCode: number | null;
    readonly structuredObservations: Readonly<Record<string, unknown>>;
    readonly verifierVersion: string;
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
        commandOrQuery: attempt.commandOrQuery,
        exitCode: attempt.exitCode,
        structuredObservations: attempt.observations,
        verifierVersion: attempt.verifierVersion,
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
      exitCode: r.exitCode,
      commandOrQuery: r.commandOrQuery,
      structuredObservationsJson: JSON.stringify(jsonSafe(r.structuredObservations)),
      artifactsJson: encodeArtifactRefs(r.artifacts),
      verifierVersion: r.verifierVersion,
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
  mergeReceiptQuery?: CandidateBranchMergeReceiptQuery,
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
          mergeReceiptJson: branch.mergeReceipt == null ? null : JSON.stringify(branch.mergeReceipt),
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
          mergeReceiptJson: branch.mergeReceipt == null ? null : JSON.stringify(branch.mergeReceipt),
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
  return new AdmissionService(repository, ledger, undefined, merger, mergeReceiptQuery);
}

export function candidateBranchFromRow(row: {
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
  readonly mergeReceiptJson: string | null;
  readonly status: string;
}): CandidateBranch {
  const effectIds = JSON.parse(row.effectIdsJson) as unknown;
  const proof = row.proofJson === null ? null : JSON.parse(row.proofJson) as CandidateBranch["proof"];
  const mergeReceipt = row.mergeReceiptJson === null
    ? null
    : JSON.parse(row.mergeReceiptJson) as CandidateBranchMergeReceipt;
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
    mergeReceipt,
    status: row.status,
  };
}

/**
 * Load a candidate branch through the Prisma row mapper. Recovery paths use
 * this to validate trusted receipts against the durable row, including proof
 * bindings, before any state transition.
 */
export async function getPrismaCandidateBranch(
  db: Pick<PrismaClient, "candidateBranch">,
  branchId: string,
): Promise<CandidateBranch | null> {
  const row = await db.candidateBranch.findUnique({ where: { id: branchId } });
  return row === null ? null : candidateBranchFromRow(row);
}

/** Receipt body persisted as the immutable kernel artifact. The artifact
 * self-reference fields are derived from the ingested hash, never stored in
 * the body, so the binding is verifiable without recursion. */
type KernelMergeReceiptBody = Omit<
  CandidateBranchMergeReceipt,
  "receiptArtifactUri" | "receiptArtifactHash"
>;

/**
 * Observe the authoritative Git state through the kernel and produce a
 * trusted merge receipt. The adapter never issues a merge: it only reads the
 * exact-HEAD admission boundary (`git rev-parse HEAD` via the kernel) and
 * reports EXECUTED only when the authoritative workspace still carries the
 * exact candidate head revision. Any other revision proves the registered
 * candidate is no longer authoritative (NOT_EXECUTED); a kernel failure
 * throws so recovery retries instead of consuming ambiguity.
 */
export function createKernelGitMergeReceiptQuery(
  clients: KernelUdsClients,
  baseContext: RequestContext,
  workspaceId: string,
): CandidateBranchMergeReceiptQuery {
  return {
    async getMergeReceipt(branch) {
      const authoritativeRevision = await resolveWorkspaceRevision(
        clients,
        baseContext,
        workspaceId,
      );
      const executed = authoritativeRevision === branch.headRevision;
      return persistKernelMergeReceiptArtifact(clients, baseContext, branch, {
        status: executed ? "EXECUTED" : "NOT_EXECUTED",
        mergeId: executed
          ? `completion-admission:${branch.branchId}:${authoritativeRevision}`
          : null,
        authoritativeRevision: executed ? authoritativeRevision : null,
      });
    },
  };
}

async function persistKernelMergeReceiptArtifact(
  clients: KernelUdsClients,
  baseContext: RequestContext,
  branch: CandidateBranch,
  outcome: Pick<KernelMergeReceiptBody, "status" | "mergeId" | "authoritativeRevision">,
): Promise<CandidateBranchMergeReceipt> {
  if (branch.proof === null) {
    throw new Error(
      `candidate branch '${branch.branchId}' has no completion proof for trusted merge-receipt binding`,
    );
  }
  if (!/^sha256:[0-9a-f]{64}$/i.test(branch.scopeDigest)) {
    throw new Error(
      `candidate branch '${branch.branchId}' has no valid scope digest for trusted merge-receipt binding`,
    );
  }
  const body: KernelMergeReceiptBody = {
    status: outcome.status,
    operationId: candidateBranchAdmissionOperationId(branch.branchId),
    branchId: branch.branchId,
    taskId: branch.taskId,
    attemptId: branch.attemptId,
    actorPrincipal: branch.actorPrincipal,
    baseRevision: branch.baseRevision,
    candidateHeadRevision: branch.headRevision,
    scopeDigest: branch.scopeDigest,
    completionRecordDigest: branch.proof.completionRecordDigest,
    mergeId: outcome.mergeId,
    authoritativeRevision: outcome.authoritativeRevision,
  };
  const bytes = new TextEncoder().encode(canonicalJson(body));
  const artifactClient = createKernelArtifactClient(clients.artifacts, baseContext);
  const artifactMetadata = await artifactClient.ingest(bytes, { mediaType: "application/json" });
  const hex = /^sha256:([0-9a-f]{64})$/i.exec(artifactMetadata.hash)?.[1];
  if (hex === undefined) {
    throw new Error("kernel returned a non-SHA-256 artifact hash for the merge receipt");
  }
  const digest = hex.toLowerCase();
  return {
    ...body,
    receiptArtifactUri: `artifact://sha256/${digest}`,
    receiptArtifactHash: `sha256:${digest}`,
  };
}

export class TrustedBranchAlreadyResolvedError extends Error {
  constructor(readonly branchId: string) {
    super(`candidate branch ${branchId} was already resolved before trusted receipt recovery`);
    this.name = "TrustedBranchAlreadyResolvedError";
  }
}

export type TrustedBranchReceiptEvent = {
  readonly eventType: "recovery.reconciled" | "candidate_branch.recovery_manual_review";
  readonly aggregateType: "task";
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly payload: Readonly<Record<string, unknown>>;
};

/** Mirrors the control plane's transactional emit(payload, mutation) contract. */
export type TransactionalEventEmitter = <T>(
  event: TrustedBranchReceiptEvent,
  mutation: (tx: Prisma.TransactionClient) => Promise<T>,
) => Promise<unknown>;

export type TrustedBranchReceiptDisposition =
  | {
    readonly outcome: "ADMITTED";
    readonly branchId: string;
    readonly authoritativeRevision: string;
  }
  | { readonly outcome: "MANUAL_REVIEW"; readonly branchId: string }
  | { readonly outcome: "ALREADY_RESOLVED"; readonly branchId: string };

/**
 * Resolve one ADMITTING branch from a trusted external receipt. The receipt
 * is fetched (external I/O) before the transaction; inside one transaction
 * the receipt is re-validated against the fresh durable row, the branch CASes
 * to ADMITTED (executed) or MANUAL_REVIEW (retained negative receipt), and a
 * semantic recovery event commits with the same transaction. Executed
 * receipts never re-issue the merge and leave task/turn completion to the
 * existing prepared-completion-record recovery.
 */
export async function reconcileAdmittingBranchWithTrustedReceipt(
  db: PrismaClient,
  branchId: string,
  trustedReceiptQuery: CandidateBranchMergeReceiptQuery,
  emitTransactionally: TransactionalEventEmitter,
): Promise<TrustedBranchReceiptDisposition> {
  const branchRecord = await getPrismaCandidateBranch(db, branchId);
  if (branchRecord === null) {
    throw new Error(`candidate branch '${branchId}' disappeared during trusted receipt recovery`);
  }
  if (branchRecord.status !== "ADMITTING") {
    return { outcome: "ALREADY_RESOLVED", branchId };
  }

  const receipt = await trustedReceiptQuery.getMergeReceipt(branchRecord);
  const validated = validateCandidateBranchMergeReceipt(branchRecord, receipt);
  const executed = validated.status === "EXECUTED";

  await emitTransactionally(
    executed
      ? {
        eventType: "recovery.reconciled",
        aggregateType: "task",
        aggregateId: validated.taskId,
        correlationId: validated.taskId,
        idempotencyKey: `candidate-branch-receipt-recovery:${branchId}`,
        payload: {
          previous_state: "ADMITTING",
          state: "ADMITTED",
          reason: "trusted_merge_receipt_executed",
          branch_id: branchId,
          merge_id: validated.mergeId,
          authoritative_revision: validated.authoritativeRevision,
          receipt_artifact: validated.receiptArtifactUri,
          admission_operation_id: validated.operationId,
        },
      }
      : {
        eventType: "candidate_branch.recovery_manual_review",
        aggregateType: "task",
        aggregateId: validated.taskId,
        correlationId: validated.taskId,
        idempotencyKey: `candidate-branch-receipt-recovery:${branchId}`,
        payload: {
          task_id: validated.taskId,
          branch_id: branchId,
          previous_status: "ADMITTING",
          reason: `trusted_merge_receipt_${validated.status.toLowerCase()}`,
          admission_operation_id: validated.operationId,
          receipt_artifact: validated.receiptArtifactUri,
        },
      },
    async (tx) => {
      const current = await tx.candidateBranch.findUnique({
        where: { id: branchId },
        select: {
          id: true,
          taskId: true,
          attemptId: true,
          epoch: true,
          status: true,
          worktreePath: true,
          actorPrincipal: true,
          baseRevision: true,
          headRevision: true,
          scopeDigest: true,
          effectIdsJson: true,
          proofJson: true,
          mergeReceiptJson: true,
        },
      });
      if (
        current === null
        || current.status !== "ADMITTING"
        || current.epoch !== branchRecord.epoch
        || current.taskId !== branchRecord.taskId
      ) {
        throw new TrustedBranchAlreadyResolvedError(branchId);
      }
      // Re-validate against the fresh row inside the transaction so a racing
      // durable change fails closed instead of trusting a stale observation.
      validateCandidateBranchMergeReceipt(candidateBranchFromRow(current), validated);
      const updated = await tx.candidateBranch.updateMany({
        where: {
          id: branchId,
          taskId: current.taskId,
          epoch: current.epoch,
          status: "ADMITTING",
        },
        data: executed
          ? {
            status: "ADMITTED",
            epoch: { increment: 1 },
            headRevision: validated.authoritativeRevision!,
            mergeReceiptJson: JSON.stringify(validated),
          }
          : {
            status: "MANUAL_REVIEW",
            epoch: { increment: 1 },
            mergeReceiptJson: JSON.stringify(validated),
          },
      });
      if (updated.count !== 1) throw new TrustedBranchAlreadyResolvedError(branchId);
      if (!executed) {
        await tx.task.updateMany({
          where: { id: current.taskId, status: { in: ["ACTIVE", "VERIFYING"] } },
          data: {
            status: "BLOCKED",
            phase: "VERIFY",
            completedAt: null,
            terminalReasonJson: JSON.stringify({
              reason: "candidate_branch_admission_recovery_required",
              branch_id: branchId,
              attempt_id: current.attemptId,
              reconciliation_required: true,
            }),
          },
        });
      }
    },
  );

  return executed
    ? {
      outcome: "ADMITTED",
      branchId,
      authoritativeRevision: validated.authoritativeRevision!,
    }
    : { outcome: "MANUAL_REVIEW", branchId };
}

export function defaultCriteriaNodes(
  criteria: readonly AcceptanceCriterion[],
  options: {
    readonly objective?: string | undefined;
    readonly riskClass?: "low" | "normal" | "high" | "critical" | undefined;
    readonly mode?: VerificationPlanMode | undefined;
    readonly signals?: VerificationDerivationSignals | undefined;
    /** Repository commands observed for this exact source revision. */
    readonly runnerCatalog?: VerificationRunnerCatalog | undefined;
    /**
     * The task contract's wall-clock budget. Raises node timeouts above their
     * class floor (600 s tests / 120 s parse+lint); it can never lower one,
     * because a check that is guaranteed to time out is not a check.
     */
    readonly timeoutSeconds?: number | undefined;
  } = {},
): VerificationNode[] {
  const derivation = deriveVerificationNodes({
    criteria,
    objective: options.objective ?? "",
    riskClass: options.riskClass ?? "normal",
    mode: options.mode ?? "admission",
    signals: options.signals ?? { changedFiles: ["."] },
    ...(options.timeoutSeconds === undefined ? {} : { timeoutSeconds: options.timeoutSeconds }),
    idSource: uuid,
  });
  return selectApplicableVerificationRequirements(
    derivation.nodes,
    options.runnerCatalog ?? {},
  );
}

export interface RequiredVerificationSummary {
  readonly requiredNodeIds: readonly string[];
  readonly runnableRequiredNodeIds: readonly string[];
  readonly skippedRequiredNodeIds: readonly string[];
  readonly noRunnableChecks: boolean;
}

/**
 * Summarize required execution without conflating one explicit skip with an
 * entirely non-runnable plan. A plan has no runnable checks only when every
 * required node produced a justified `skipped` result.
 */
export function summarizeRequiredVerification(
  nodes: readonly VerificationNode[],
  results: readonly VerificationResult[],
): RequiredVerificationSummary {
  const resultByNodeId = new Map(results.map((result) => [result.nodeId, result]));
  const requiredNodeIds = nodes.filter((node) => node.required).map((node) => node.id);
  const skippedRequiredNodeIds = requiredNodeIds.filter(
    (nodeId) => resultByNodeId.get(nodeId)?.status === "skipped",
  );
  const runnableRequiredNodeIds = requiredNodeIds.filter((nodeId) => {
    const status = resultByNodeId.get(nodeId)?.status;
    return status === "pass" || status === "fail" || status === "error";
  });
  return {
    requiredNodeIds,
    runnableRequiredNodeIds,
    skippedRequiredNodeIds,
    noRunnableChecks:
      requiredNodeIds.length > 0
      && skippedRequiredNodeIds.length === requiredNodeIds.length,
  };
}

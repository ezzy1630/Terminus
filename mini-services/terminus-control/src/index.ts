/**
 * Terminus Control Plane mini-service.
 *
 * Per SPEC §5, §27: TypeScript control plane owns cognition and product
 * state — sessions, tasks, context compiler, providers, orchestration,
 * verification, memory, public API. It has NO ambient effect authority;
 * every privileged operation crosses the Rust kernel boundary via the
 * gateway (?XTransformPort=3040).
 *
 * This service exposes:
 *   - The full public API (SPEC §32) over HTTP/SSE on port 3050.
 *   - A realtime event bus streaming semantic events to clients.
 *   - The agent loop: context compile → provider attempt → tool settlement →
 *     verification → completion, all observable via events and manifests.
 *
 * The service uses Prisma (SQLite) for operational state, generated gRPC over
 * UDS for effects, and the @terminus/* packages for domain logic.
 *
 * Security (SPEC §30.5/§30.6/§30.8):
 *   - Every request except `GET /v1/system/health` MUST present a bearer
 *     token matching `TERMINUS_CONTROL_TOKEN`.
 *   - CORS is locked to the configured desktop origin
 *     (`TERMINUS_CONTROL_CORS_ORIGIN`, default `terminus://app`).
 *   - Mutating requests accept an `Idempotency-Key` header; replays with
 *     the same key+body return the cached response, replays with a
 *     different body return `IDEMPOTENCY_KEY_CONFLICT`.
 *   - SSE event IDs are monotonic (timestamp-prefixed) so `cursor` replay
 *     is ordered; stale cursors emit a `cursor_expired` event.
 *   - Before any mutating handler executes, an `authorized` audit record
 *     is logged with method, path, actor, task_id, trace_id, timestamp.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID, createHash, timingSafeEqual } from "node:crypto";
import { closeSync, writeSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  PrismaClient,
  type Approval as PrismaApproval,
  type IdempotencyRecord,
  type Session as PrismaSession,
  type Thread as PrismaThread,
  type Turn as PrismaTurn,
  type Prisma,
} from "@prisma/client";
import { firstValueFrom } from "rxjs";
import { globMatch } from "@terminus/task-runtime";
import { createKernelUdsClients, type KernelUdsClients } from "./kernel-uds.js";
import { createKernelArtifactClient, PrismaContextStore } from "./context-store.js";
import {
  executeLocalProviderCommand,
  parseLocalProviderCommand,
  type LocalProviderCommand,
} from "./provider-command.js";
import {
  configuredLocalProviderSnapshot,
  parseProviderConfigurationInput,
  parseProviderConfigurationUpdate,
  providerConfigurationCommand,
  providerConfigurationWire,
  PROVIDER_CONFIGURATION_ID,
  type ProviderConfigurationUpdate,
} from "./provider-config.js";
import {
  configuredGatewayModel,
  configuredGatewayProviderSnapshot,
  gatewayModelKey,
  gatewayProviderConfigurationWire,
  gatewayProviderConfigurationDeleteSchema,
  gatewaySecretUri,
  GATEWAY_PROVIDER_CONFIGURATION_ID,
  parseGatewayProviderConfigurationUpdate,
  type GatewayProviderConfigurationUpdate,
} from "./gateway-provider-config.js";
import {
  cachedProviderModels,
  describeConfiguredModel,
  discoverProviderModels,
  lastProviderModels,
  providerModelsWire,
  rememberProviderModels,
} from "./provider-models.js";
import { KernelGatewayClient } from "./gateway-kernel-client.js";
import {
  MAX_TOOL_MODEL_RESULT_BYTES,
  STANDALONE_TOOL_SCHEMAS,
  executeStandaloneTool,
  normalizedToolOperationHash,
  parseStandaloneToolCall,
  providerToolCallTranscript,
  providerToolResultTranscript,
  toolEffectMetadata,
  type ParsedStandaloneToolCall,
} from "./agent-tools.js";
import { errorResult, type ToolResult } from "@terminus/aci";
import {
  CapabilityOperationProto,
  PatchCommitMode,
  type RequestContext,
} from "../../../packages/terminus-kernel-client/src/generated-ts-proto/terminus/kernel/v1/kernel.js";
import {
  createVerificationRuntime,
  createKernelPredicateRunner,
  defaultCriteriaNodes,
  persistPlanToPrisma,
  persistResultsToPrisma,
  persistClaimEvidenceGraphToPrisma,
  createPrismaCompletionAdmission,
  resolveKernelEnvironmentDigest,
  resolveWorkspaceRevision,
} from "./verification-runtime.js";
import type {
  AcceptanceCriterion,
  Checkpoint,
  ContentHash,
  Episode,
  Micros,
  ModelKey,
  Rfc3339Timestamp,
  TokenCount,
} from "@terminus/domain";
import { generateUuid7, type Uuid7 } from "@terminus/domain";
import {
  authorizationInstanceSchema,
  artifactUriSchema,
  artifactRefSchema,
  contentHashSchema,
  claimSchema,
  decisionSchema,
  effectRecordSchema,
  evidenceSchema,
  questionSchema,
  riskSchema,
  workerLeaseSchema,
  taskAttemptSchema,
  budgetConsumptionSchema,
  taskContractV2Schema,
  taskV2Schema,
  workflowSchema,
  workflowNodeSchema,
  guardedEdgeSchema,
  nodeRunSchema,
  isEffectTransitionAllowed,
  isTaskV2Terminal,
  isTaskV2TransitionAllowed,
  isWorkflowTransitionAllowed,
  isNodeRunTransitionAllowed,
  isAttemptTransitionAllowed,
  isLeaseTransitionAllowed,
  missionSchema,
  nowTimestamp,
  ForgeError as DomainForgeError,
  organizationSchema,
  departmentSchema,
  operatorAgentSchema,
  agentRoomSchema,
  capabilityDirectoryEntrySchema,
  materialQuestionSchema,
  attentionAssessmentSchema,
  structuredInterventionSchema,
  causalStepSchema,
  causalReplayTraceSchema,
  counterfactualExperimentSchema,
  mobileSupervisionSessionSchema,
  acpContextInjectionSchema,
  uiObservationInputSchema,
  uiObservationSchema,
  computerUseActionSchema,
  semanticTargetVerificationSchema,
  uiEvidenceRecordSchema,
  browserDesktopPoolSchema,
  poolLeaseSchema,
  humanTakeoverSessionSchema,
  dataFlowPolicySchema,
  dataTransferAuditSchema,
  dataFlowCheckResultSchema,
  externalConnectorSpecSchema,
  connectorCallIntentSchema,
  connectorExecutionObservationSchema,
  connectorCallResultSchema,
  ambiguousSubmitReconciliationSchema,
  incidentProfileSpecSchema,
  incidentExecutionRecordSchema,
  researchProfileSpecSchema,
  researchProvenanceRecordSchema,
  type Claim,
  type Decision,
  type EffectRecord,
  type AuthorizationInstance,
  type Evidence,
  type Question,
  type Risk,
  type WorkerLease,
  type TaskAttempt,
  type BudgetConsumption,
  type Workflow,
  type WorkflowNode,
  type GuardedEdge,
  type NodeRun,
  type TaskContractV2,
  type TaskV2,
} from "@terminus/domain";
import { ARP_V2_COMMAND_TYPES, ARP_V2_EVENT_TYPES } from "@terminus/runtime-protocol";
import { z } from "zod";
import {
  checkpointContentSchema,
  compileContext,
  validateCheckpoint,
  type CheckpointContent,
  type RetrievalMethod,
  type RetrievalPipeline,
  type RetrievalQuery,
  type RetrievalResult,
  type ContextBudget,
  type TaskSnapshot,
  type ThreadSnapshot,
  type WorldStateSnapshot,
} from "@terminus/context-compiler";
import {
  canonicalJson,
  computeContentHash,
  type ContextDirective,
  type ContextEpochSnapshot,
  type ContextFragment,
} from "@terminus/context-ir";
import {
  LOCAL_MODEL_PROFILES,
  LocalRenderer,
} from "@terminus/provider-local";
import { GatewayRenderer, GatewayTransport, type GatewayModel } from "@terminus/provider-zen";
import { ANTHROPIC_MODEL_PROFILES } from "@terminus/provider-anthropic";
import { GOOGLE_MODEL_PROFILES } from "@terminus/provider-google";
import { OPENAI_MODEL_PROFILES } from "@terminus/provider-openai";
import { ContextStateBuilder } from "./agent/context-state-builder.js";
import { CodingTurnEngine } from "./agent/coding-turn-engine.js";
import {
  hydrateSearchHit,
  buildRepositoryMapFragment,
  type SearchHit,
  type WorkspaceFileReader,
} from "./agent/retrieval-hydrator.js";
import {
  VerificationRepairController,
  buildRepairContext,
  normalizeFailure,
  type RawVerificationFailure,
} from "./agent/verification-repair-controller.js";
import { HARD_MAX_STEPS, TurnBudget } from "./agent/turn-budget.js";
import type { ArtifactClient } from "@terminus/artifact-client";
import type {
  ModelCapabilitySnapshot,
  ProviderCapabilitySnapshot,
  ProviderResponse,
  ProviderResponseChunk,
  ProviderToolCallChunk,
  ProjectedResponse,
  RenderedProviderRequest,
  ConfidentialityPolicy,
} from "@terminus/provider-core";
import {
  compileSkill,
  compileWorkflowJson,
  compileWorkflowDraft,
  validateWorkflow,
} from "@terminus/workflow-compiler";
import {
  ProfileRegistry,
  PosteriorTracker,
  StageRouter,
  ProviderContinuationManager,
} from "@terminus/model-router";
import {
  ExpectedValueScheduler,
  CleanContextReviewer,
  StagnationSupervisor,
  CandidateWorkspaceManager,
  OrganizationDirectory,
  AttentionCoordinator,
  InterventionManager,
  CausalReplayEngine,
  BrowserDesktopPoolManager,
  ExternalConnectorLibrary,
  IncidentProfileRunner,
  ResearchProfileRunner,
} from "@terminus/orchestration";
import {
  ApprovalOperationV1,
  canonicalApprovalBinding,
  TrustedReceiptReferenceWire,
  V2_ENDPOINTS,
  type ApprovalOperationV1 as ApprovalOperationRecord,
} from "@terminus/public-api";
import {
  EffectSettlementService,
  EventSubscriptionService,
  ProviderSessionService,
  parseAllowedScope as parseProjectionAllowedScope,
  scopeExpansionResources as projectionScopeExpansionResources,
  TaskProjectionService,
  v2PathScopeProjection as projectionV2PathScopeProjection,
  ToolEpisodeService,
  TurnCoordinator,
  TurnAdmissionError,
  VerificationCoordinator,
  ProviderExecutionUnavailableError,
  ToolCycleBudgetExhaustedError,
  ToolPolicyDeniedError,
  type EffectAuthorizationInput,
  type EffectSettlementInput,
  type EffectUnknownInput,
  type ProviderAttemptResponseInput,
  type ProviderAttemptStartInput,
  type ProviderExecutionInput,
  type TaskProjectionContractRow,
  type TaskProjectionTaskRow,
  type TurnRow,
  type TurnTaskSnapshot,
  type VerificationTransitionInput,
} from "./services/index.js";

declare const __TERMINUS_CONTROL_BUILD_VERSION__: string;
declare const __TERMINUS_CONTROL_BUILD_COMMIT__: string;

// ────────────────────────── Configuration ──────────────────────────────────

const PORT = (() => {
  const configured = process.env.TERMINUS_CONTROL_PORT ?? "3050";
  if (!/^\d{1,5}$/.test(configured)) {
    throw new Error("TERMINUS_CONTROL_PORT must be an integer between 0 and 65535");
  }
  const parsed = Number(configured);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new Error("TERMINUS_CONTROL_PORT must be an integer between 0 and 65535");
  }
  return parsed;
})();
const CONTROL_READY_FD = (() => {
  const configured = process.env.TERMINUS_CONTROL_READY_FD;
  if (configured === undefined) return null;
  if (!/^(?:[3-9]|[1-9]\d)$/.test(configured)) {
    throw new Error("TERMINUS_CONTROL_READY_FD must be a descriptor between 3 and 99");
  }
  return Number(configured);
})();
const KERNEL_GRPC_SOCKET = process.env.TERMINUS_KERNEL_GRPC_SOCKET ?? "";
const KERNEL_CONTROL_BOOTSTRAP_TOKEN = process.env.TERMINUS_KERNEL_CONTROL_BOOTSTRAP_TOKEN ?? "";
const CONTROL_BUILD_VERSION = typeof __TERMINUS_CONTROL_BUILD_VERSION__ === "string"
  ? __TERMINUS_CONTROL_BUILD_VERSION__
  : "0.1.0";
const CONTROL_BUILD_COMMIT = typeof __TERMINUS_CONTROL_BUILD_COMMIT__ === "string"
  ? __TERMINUS_CONTROL_BUILD_COMMIT__
  : "dev";
const CONTROL_INSTANCE_NONCE = process.env.TERMINUS_CONTROL_INSTANCE_NONCE ?? randomUUID();
if (!/^[A-Za-z0-9_-]{32,128}$/.test(CONTROL_INSTANCE_NONCE)) {
  throw new Error("TERMINUS_CONTROL_INSTANCE_NONCE must contain 32..128 base64url characters");
}
const DESKTOP_PARENT_PID = (() => {
  const configured = process.env.TERMINUS_DESKTOP_PARENT_PID;
  if (configured === undefined) return null;
  if (!/^[1-9]\d*$/.test(configured)) {
    throw new Error("TERMINUS_DESKTOP_PARENT_PID must be a positive process ID");
  }
  const parsed = Number(configured);
  if (!Number.isSafeInteger(parsed) || parsed <= 1) {
    throw new Error("TERMINUS_DESKTOP_PARENT_PID must be a positive process ID greater than one");
  }
  return parsed;
})();
// SPEC §13.6 / §31.6: secrets are short-lived brokered capabilities, never
// environment-wide shared defaults. The control plane MUST fail closed if no
// token is configured. A well-known dev token is permitted ONLY when
// TERMINUS_DEV=1 is set, so a misconfigured production deployment cannot expose
// the privileged kernel with a publicly-known token.
const DEV_MODE = process.env.TERMINUS_DEV === "1";
function requireToken(envVar: string, devValue: string, label: string): string {
  const v = process.env[envVar];
  if (v && v.length > 0) return v;
  if (DEV_MODE) {
    console.warn(`[terminus-control] TERMINUS_DEV=1: using well-known dev ${label}. NOT for production.`);
    return devValue;
  }
  const msg = `[terminus-control] ${envVar} is required (set it, or set TERMINUS_DEV=1 for local dev).`;
  console.error(msg);
  throw new Error(msg);
}
const CONTROL_TOKEN = requireToken("TERMINUS_CONTROL_TOKEN", "terminus-control-dev-token", "control token");
const CONFIGURED_KERNEL_CAP_TOKEN = process.env.TERMINUS_KERNEL_CAP_TOKEN ?? "";
const CONFIGURED_KERNEL_MAINTENANCE_CAP_TOKEN = process.env.TERMINUS_KERNEL_MAINTENANCE_CAP_TOKEN
  ?? (DEV_MODE ? CONFIGURED_KERNEL_CAP_TOKEN : "");
// The packaged desktop shell uses a standard, secure custom origin. During
// local renderer development Vite serves from localhost:5173, so documented
// TERMINUS_DEV mode allows that exact origin instead.
const CONTROL_CORS_ORIGIN = process.env.TERMINUS_CONTROL_CORS_ORIGIN
  ?? (process.env.TERMINUS_DEV === "1" ? "http://localhost:5173" : "terminus://app");
// Platform-appropriate default SQLite location (replaces the leftover
// `/home/z/my-project/...` template path so the control plane starts
// out-of-the-box on any host).
const DEFAULT_DB_PATH = `file:${process.env.HOME ?? process.cwd()}/.local/share/terminus/terminus.db`;
// The documented DATABASE_URL sample uses `file:~/...`. The bun:sqlite
// migration runners expand `~` themselves, but Prisma treats it literally,
// which would fork the database into a literal "./~/..." directory. Expand a
// leading `~` (bare or after the URL scheme) so every consumer resolves the
// same file.
function expandTildeDbUrl(url: string): string {
  if (url === "~" || url.startsWith("~/")) {
    return `${process.env.HOME ?? process.cwd()}${url.slice(1)}`;
  }
  const schemeMatch = /^[a-z][a-z0-9+.-]*:(?:\/\/)?/.exec(url);
  const rest = schemeMatch === null ? url : url.slice(schemeMatch[0].length);
  if (rest !== "~" && !rest.startsWith("~/")) return url;
  if (schemeMatch !== null && schemeMatch[0].includes("//")) return url;
  const prefix = schemeMatch === null ? "" : schemeMatch[0];
  return `${prefix}${process.env.HOME ?? process.cwd()}${rest.slice(1)}`;
}
const DATABASE_URL = expandTildeDbUrl(process.env.DATABASE_URL ?? DEFAULT_DB_PATH);
const SERVER_PRINCIPAL = "terminus-control-bearer";
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_REQUEST_BYTES = 1_048_576;

const CORS_ALLOW_HEADERS =
  "authorization, content-type, idempotency-key, x-trace-id, traceparent, last-event-id, x-capability-token";
const CORS_ALLOW_METHODS = "GET, POST, PATCH, PUT, DELETE, OPTIONS";

const SUPPORTED_CAPABILITIES = [
  "sse_resume",
  "rich_approvals",
  "artifact_streaming",
  "idempotency",
  "tools_direct",
] as const;

const db = new PrismaClient({
  datasources: { db: { url: DATABASE_URL } },
});

const CONTROL_WRITER_LEASE_KEY = "terminus-control-writer";
const CONTROL_WRITER_INSTANCE = randomUUID();
const parsedWriterLeaseMs = Number(process.env.TERMINUS_CONTROL_WRITER_LEASE_MS ?? "15000");
const CONTROL_WRITER_LEASE_MS = Number.isFinite(parsedWriterLeaseMs)
  ? Math.max(2_000, Math.floor(parsedWriterLeaseMs))
  : 15_000;
let writerLease: { readonly fencingToken: number; expiresAt: Date; healthy: boolean } | null = null;
let writerLeaseHeartbeat: ReturnType<typeof setInterval> | null = null;

async function acquireControlWriterLease(): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + CONTROL_WRITER_LEASE_MS);
    const existing = await db.lease.findUnique({ where: { leaseKey: CONTROL_WRITER_LEASE_KEY } });
    if (!existing) {
      try {
        const created = await db.lease.create({
          data: {
            leaseKey: CONTROL_WRITER_LEASE_KEY,
            ownerInstance: CONTROL_WRITER_INSTANCE,
            fencingToken: 1,
            expiresAt,
            metadataJson: JSON.stringify({ role: "control-writer" }),
          },
        });
        writerLease = { fencingToken: created.fencingToken, expiresAt: created.expiresAt, healthy: true };
        return;
      } catch (error: unknown) {
        if (attempt === 3) throw error;
        continue;
      }
    }
    if (existing.ownerInstance !== CONTROL_WRITER_INSTANCE && existing.expiresAt > now) {
      throw new Error(
        `control writer lease is held by ${existing.ownerInstance} until ${existing.expiresAt.toISOString()}`,
      );
    }
    const fencingToken = existing.fencingToken + 1;
    const claimed = await db.lease.updateMany({
      where: {
        leaseKey: CONTROL_WRITER_LEASE_KEY,
        ownerInstance: existing.ownerInstance,
        fencingToken: existing.fencingToken,
        expiresAt: existing.expiresAt,
      },
      data: {
        ownerInstance: CONTROL_WRITER_INSTANCE,
        fencingToken,
        acquiredAt: now,
        expiresAt,
        metadataJson: JSON.stringify({ role: "control-writer" }),
      },
    });
    if (claimed.count === 1) {
      writerLease = { fencingToken, expiresAt, healthy: true };
      return;
    }
  }
  throw new Error("control writer lease changed repeatedly during acquisition");
}

async function renewControlWriterLease(): Promise<void> {
  const current = writerLease;
  if (!current?.healthy) return;
  const now = new Date();
  if (current.expiresAt <= now) {
    writerLease = { ...current, healthy: false };
    failControlWriterLease("control writer lease expired before renewal");
    return;
  }
  try {
    const expiresAt = new Date(now.getTime() + CONTROL_WRITER_LEASE_MS);
    const renewed = await db.lease.updateMany({
      where: {
        leaseKey: CONTROL_WRITER_LEASE_KEY,
        ownerInstance: CONTROL_WRITER_INSTANCE,
        fencingToken: current.fencingToken,
        expiresAt: { gt: now },
      },
      data: { expiresAt },
    });
    if (renewed.count !== 1) {
      writerLease = { ...current, healthy: false };
      failControlWriterLease("control writer lease was fenced by another owner");
      return;
    }
    writerLease = { fencingToken: current.fencingToken, expiresAt, healthy: true };
  } catch (error: unknown) {
    console.error("[terminus-control] writer lease heartbeat failed", error);
    if (writerLease && writerLease.expiresAt <= new Date()) {
      writerLease = { ...writerLease, healthy: false };
      failControlWriterLease("control writer lease expired after heartbeat failures");
    }
  }
}

function failControlWriterLease(reason: string): void {
  console.error(`[terminus-control] ${reason}; terminating the control process`);
  void shutdownControl().finally(() => process.exit(1));
}

function writerLeaseIsHealthy(): boolean {
  return writerLease?.healthy === true && writerLease.expiresAt > new Date();
}

class ControlWriterFencedError extends Error {
  constructor() {
    super("the control-plane writer lease changed or expired before the transaction committed");
    this.name = "ControlWriterFencedError";
  }
}

/**
 * Turn the advisory lease into a transaction fence. The conditional no-op
 * update both verifies the exact fencing token and acquires SQLite's writer
 * lock before any authoritative row or semantic event is changed. A former
 * writer therefore cannot commit after a replacement has claimed the lease.
 */
async function assertControlWriterLease(
  tx: Prisma.TransactionClient,
): Promise<void> {
  const current = writerLease;
  const checkedAt = new Date();
  if (!current?.healthy || current.expiresAt <= checkedAt) {
    if (current) writerLease = { ...current, healthy: false };
    throw new ControlWriterFencedError();
  }
  const fenced = await tx.lease.updateMany({
    where: {
      leaseKey: CONTROL_WRITER_LEASE_KEY,
      ownerInstance: CONTROL_WRITER_INSTANCE,
      fencingToken: current.fencingToken,
      expiresAt: { gt: checkedAt },
    },
    // This deliberately leaves the lease duration unchanged. Its purpose is
    // to establish write ownership for the enclosing transaction.
    data: { ownerInstance: CONTROL_WRITER_INSTANCE },
  });
  if (fenced.count !== 1) {
    writerLease = { ...current, healthy: false };
    throw new ControlWriterFencedError();
  }
}

async function writerTransaction<T>(
  mutation: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    await assertControlWriterLease(tx);
    return mutation(tx);
  });
}

async function releaseControlWriterLease(): Promise<void> {
  const current = writerLease;
  if (!current) return;
  await db.lease.updateMany({
    where: {
      leaseKey: CONTROL_WRITER_LEASE_KEY,
      ownerInstance: CONTROL_WRITER_INSTANCE,
      fencingToken: current.fencingToken,
    },
    data: { expiresAt: new Date() },
  });
  writerLease = { ...current, expiresAt: new Date(), healthy: false };
}

const kernelUds: KernelUdsClients | null = KERNEL_GRPC_SOCKET
  ? createKernelUdsClients(KERNEL_GRPC_SOCKET, "", KERNEL_CONTROL_BOOTSTRAP_TOKEN)
  : null;

let kernelBrokerCapabilityToken = CONFIGURED_KERNEL_CAP_TOKEN;
let kernelMaintenanceCapabilityToken = CONFIGURED_KERNEL_MAINTENANCE_CAP_TOKEN;
let kernelControlCapabilitiesExpireAtUnix =
  kernelBrokerCapabilityToken.length > 0 && kernelMaintenanceCapabilityToken.length > 0
    ? Number.MAX_SAFE_INTEGER
    : 0;
let kernelBootstrapInFlight: Promise<void> | null = null;

interface KernelTaskCapabilityScope {
  readonly sessionId: string;
  readonly taskId: string;
  readonly turnId: string;
  readonly workspaceId: string;
  readonly operationClasses: readonly CapabilityOperationProto[];
  readonly workspacePaths?: readonly string[];
  readonly networkDestinations?: readonly string[];
  readonly secretCapabilities?: readonly string[];
}

const NO_WORKSPACE_EFFECT_SCOPE = [".terminus/capabilities/no-workspace-effect"] as const;

function leastWorkspaceScope(paths: readonly string[]): readonly string[] {
  const unique = [...new Set(paths)];
  return unique.length > 0 ? unique : NO_WORKSPACE_EFFECT_SCOPE;
}

const kernelTaskCapabilityCache = new Map<string, {
  readonly token: string;
  readonly expiresAtUnix: number;
}>();

function requireKernelUds(): KernelUdsClients {
  if (!kernelUds) {
    throw new Error("TERMINUS_KERNEL_GRPC_SOCKET is required for privileged control-plane effects");
  }
  return kernelUds;
}

function baseKernelContext(input: {
  readonly sessionId: string;
  readonly taskId: string;
  readonly turnId: string;
  readonly workspaceId: string;
  readonly capabilityToken: string;
}): RequestContext {
  return {
    requestId: randomUUID(),
    idempotencyKey: randomUUID(),
    sessionId: input.sessionId,
    taskId: input.taskId,
    turnId: input.turnId,
    actorId: SERVER_PRINCIPAL,
    traceparent: "",
    capabilityToken: input.capabilityToken,
    workspaceId: input.workspaceId,
    deadline: undefined,
    resourceBudgets: undefined,
    policyVersion: "",
  };
}

async function initializeKernelControlCapabilities(): Promise<void> {
  const nowUnix = Math.floor(Date.now() / 1_000);
  if (
    kernelBrokerCapabilityToken.length > 0
    && kernelMaintenanceCapabilityToken.length > 0
    && kernelControlCapabilitiesExpireAtUnix > nowUnix + 30
  ) {
    return;
  }
  if (kernelBootstrapInFlight !== null) return kernelBootstrapInFlight;
  const clients = requireKernelUds();
  kernelBootstrapInFlight = (async () => {
    const capabilities = await clients.info.BootstrapControl({ principal: SERVER_PRINCIPAL });
    if (
      capabilities.brokerCapabilityToken.length === 0
      || capabilities.maintenanceCapabilityToken.length === 0
      || capabilities.expiresAtUnix <= Math.floor(Date.now() / 1_000)
    ) {
      throw new Error("kernel returned invalid standalone control capabilities");
    }
    kernelBrokerCapabilityToken = capabilities.brokerCapabilityToken;
    kernelMaintenanceCapabilityToken = capabilities.maintenanceCapabilityToken;
    kernelControlCapabilitiesExpireAtUnix = capabilities.expiresAtUnix;
    kernelTaskCapabilityCache.clear();
  })();
  try {
    await kernelBootstrapInFlight;
  } finally {
    kernelBootstrapInFlight = null;
  }
}

async function kernelBrokerContext(): Promise<RequestContext> {
  await initializeKernelControlCapabilities();
  return baseKernelContext({
    sessionId: "control",
    taskId: "control-broker",
    turnId: "broker",
    workspaceId: "*",
    capabilityToken: kernelBrokerCapabilityToken,
  });
}

async function kernelMaintenanceContext(): Promise<RequestContext> {
  await initializeKernelControlCapabilities();
  return baseKernelContext({
    sessionId: "control",
    taskId: "control-maintenance",
    turnId: "reconciliation",
    workspaceId: "*",
    capabilityToken: kernelMaintenanceCapabilityToken,
  });
}

function taskCapabilityCacheKey(scope: KernelTaskCapabilityScope): string {
  const sorted = (values: readonly string[] | undefined): readonly string[] =>
    [...(values ?? [])].sort((left, right) => left.localeCompare(right));
  return JSON.stringify({
    principal: SERVER_PRINCIPAL,
    sessionId: scope.sessionId,
    taskId: scope.taskId,
    workspaceId: scope.workspaceId,
    operationClasses: [...scope.operationClasses].sort((left, right) => left - right),
    workspacePaths: sorted(scope.workspacePaths),
    networkDestinations: sorted(scope.networkDestinations),
    secretCapabilities: sorted(scope.secretCapabilities),
  });
}

async function kernelTaskContext(scope: KernelTaskCapabilityScope): Promise<RequestContext> {
  for (const [label, value] of [
    ["session", scope.sessionId],
    ["task", scope.taskId],
    ["workspace", scope.workspaceId],
  ] as const) {
    if (value.length === 0 || value === "*") {
      throw new Error(`kernel ${label} capability binder must be concrete`);
    }
  }
  if (scope.operationClasses.length === 0) {
    throw new Error("kernel task capability requires at least one operation class");
  }

  let capabilityToken: string;
  if (DEV_MODE && CONFIGURED_KERNEL_CAP_TOKEN.length > 0) {
    capabilityToken = CONFIGURED_KERNEL_CAP_TOKEN;
  } else {
    await initializeKernelControlCapabilities();
    const cacheKey = taskCapabilityCacheKey(scope);
    const nowUnix = Math.floor(Date.now() / 1_000);
    const cached = kernelTaskCapabilityCache.get(cacheKey);
    if (cached && cached.expiresAtUnix > nowUnix + 30) {
      capabilityToken = cached.token;
    } else {
      const minted = await requireKernelUds().policies.MintTaskCapability({
        context: await kernelBrokerContext(),
        principal: SERVER_PRINCIPAL,
        sessionId: scope.sessionId,
        taskId: scope.taskId,
        workspaceId: scope.workspaceId,
        operationClasses: [...scope.operationClasses],
        workspacePaths: [...(scope.workspacePaths ?? NO_WORKSPACE_EFFECT_SCOPE)],
        networkDestinations: [...(scope.networkDestinations ?? [])],
        secretCapabilities: [...(scope.secretCapabilities ?? [])],
        ttlSeconds: 300,
      });
      if (minted.capabilityToken.length === 0 || minted.expiresAtUnix <= nowUnix) {
        throw new Error("kernel returned an invalid task capability");
      }
      capabilityToken = minted.capabilityToken;
      kernelTaskCapabilityCache.set(cacheKey, {
        token: capabilityToken,
        expiresAtUnix: minted.expiresAtUnix,
      });
    }
  }

  return baseKernelContext({
    sessionId: scope.sessionId,
    taskId: scope.taskId,
    turnId: scope.turnId,
    workspaceId: scope.workspaceId,
    capabilityToken,
  });
}

async function kernelContextForTask(
  taskId: string,
  turnId: string,
  operationClasses: readonly CapabilityOperationProto[],
  workspacePaths?: readonly string[],
): Promise<RequestContext> {
  const task = await db.task.findUnique({
    where: { id: taskId },
    select: {
      sessionId: true,
      activeContractVersion: true,
      session: { select: { workspaceId: true } },
    },
  });
  if (task === null) throw new Error(`task ${taskId} does not exist`);
  const pathOperations = new Set([
    CapabilityOperationProto.CAPABILITY_OPERATION_READ,
    CapabilityOperationProto.CAPABILITY_OPERATION_PATCH,
    CapabilityOperationProto.CAPABILITY_OPERATION_EXEC,
    CapabilityOperationProto.CAPABILITY_OPERATION_CODE_INTEL,
    CapabilityOperationProto.CAPABILITY_OPERATION_GIT,
  ]);
  const needsWorkspaceScope = operationClasses.some((operation) => pathOperations.has(operation));
  let boundedWorkspacePaths: readonly string[] = workspacePaths ?? NO_WORKSPACE_EFFECT_SCOPE;
  if (needsWorkspaceScope) {
    const contract = await db.taskContractVersion.findUnique({
      where: {
        task_id_version: {
          task_id: taskId,
          version: task.activeContractVersion,
        },
      },
      select: { allowedScopeJson: true },
    });
    if (contract === null) {
      throw new Error(`task ${taskId} has no active contract version ${task.activeContractVersion}`);
    }
    const allowedScope = v1AllowedScopeProjection(safeParse<unknown>(contract.allowedScopeJson, {}));
    const writeOnly = operationClasses.includes(CapabilityOperationProto.CAPABILITY_OPERATION_PATCH)
      || operationClasses.includes(CapabilityOperationProto.CAPABILITY_OPERATION_GIT);
    const allowedPaths = writeOnly
      ? allowedScope.write_paths
      : [...new Set([...allowedScope.read_paths, ...allowedScope.write_paths])];
    if (allowedPaths.length === 0) {
      throw new Error(`task ${taskId} contract grants no workspace paths for the requested operation`);
    }
    if (workspacePaths === undefined) {
      boundedWorkspacePaths = allowedPaths;
    } else {
      const denied = workspacePaths.find((path) => !allowedPaths.some((pattern) => globMatch(pattern, path)));
      if (denied !== undefined) {
        throw new Error(`task ${taskId} contract does not authorize workspace path ${denied}`);
      }
      boundedWorkspacePaths = workspacePaths;
    }
  }
  return kernelTaskContext({
    sessionId: task.sessionId,
    taskId,
    turnId,
    workspaceId: task.session.workspaceId,
    operationClasses,
    workspacePaths: boundedWorkspacePaths,
  });
}

interface KernelJobBinding {
  readonly context: RequestContext;
  readonly kernelJobId: string;
}

async function kernelBindingForJob(
  jobId: string,
  operationClasses: readonly CapabilityOperationProto[],
): Promise<KernelJobBinding | null> {
  const job = await db.job.findUnique({
    where: { id: jobId },
    select: {
      sessionId: true,
      taskId: true,
      processIdentityJson: true,
      session: { select: { workspaceId: true } },
    },
  });
  if (job === null || job.taskId === null || job.processIdentityJson === null) return null;
  const identity = safeParse<Record<string, unknown>>(job.processIdentityJson, {});
  const kernelJobId = identity.kernelJobId;
  if (typeof kernelJobId !== "string" || kernelJobId.length === 0) return null;
  const context = await kernelTaskContext({
    sessionId: job.sessionId,
    taskId: job.taskId,
    turnId: `job:${jobId}`,
    workspaceId: job.session.workspaceId,
    operationClasses,
  });
  return { context, kernelJobId };
}

function kernelIntent() {
  return {
    userIntentRef: "control-plane",
    taskContractHash: "",
    trustLabel: "trusted",
    confidentialityLabel: "workspace",
    taintSources: [],
    policyProfileId: "secure-local-default",
    expectedEffectClass: "",
  };
}

// ────────────────────────── Event bus ──────────────────────────────────────

interface EventBusSubscription {
  id: string;
  filter: (ev: StoredEvent) => boolean;
  push: (ev: StoredEvent) => void;
}

interface StoredEvent {
  eventId: string;
  eventType: string;
  schemaVersion: number;
  aggregateType: string;
  aggregateId: string;
  aggregateSequence: number;
  occurredAt: Date;
  actorJson: string;
  correlationId: string;
  causationId: string | null;
  idempotencyKey: string | null;
  payloadJson: string;
  artifactRefsJson: string;
  traceId: string | null;
}

type PendingStoredEvent = Omit<StoredEvent, "eventId" | "aggregateSequence">;

class EventBus {
  private subscriptions = new Map<string, EventBusSubscription>();
  private cursor = 0;
  private lastEventMillis = 0;
  private monotonicSeq = 0;
  private aggregateSequences = new Map<string, number>();
  private initialized = false;
  private publishTail: Promise<void> = Promise.resolve();

  /**
   * Restore the single aggregate sequence domain shared by v1 and v2
   * projections. History must be validated before the service accepts work.
   */
  initializeFromHistory(events: readonly Pick<StoredEvent, "eventId" | "aggregateType" | "aggregateId" | "aggregateSequence">[]): void {
    if (this.initialized) throw new Error("event bus history was initialized more than once");
    for (const event of events) {
      const key = `${event.aggregateType}:${event.aggregateId}`;
      const previous = this.aggregateSequences.get(key) ?? 0;
      if (event.aggregateSequence <= previous) {
        throw new Error(
          `semantic event sequence violation for ${key}: ${event.aggregateSequence} does not advance past ${previous} at ${event.eventId}`,
        );
      }
      this.aggregateSequences.set(key, event.aggregateSequence);
      const match = /^(\d{16})-(\d{8})$/.exec(event.eventId);
      if (match) {
        const millis = Number(match[1]);
        const sequence = Number(match[2]);
        if (millis > this.lastEventMillis || (millis === this.lastEventMillis && sequence >= this.monotonicSeq)) {
          this.lastEventMillis = millis;
          this.monotonicSeq = sequence + 1;
        }
      }
    }
    this.initialized = true;
  }

  /**
   * Monotonic, lexicographically-comparable event ID. SPEC §30.6 requires
   * `Last-Event-ID` replay to return a contiguous, ordered slice, so the
   * ID is `<16-digit-ms>-<8-digit-seq>` (zero-padded). String comparison
   * of two such IDs therefore yields chronological order.
   */
  private nextEventId(): string {
    const nowMillis = Date.now();
    if (nowMillis > this.lastEventMillis) {
      this.lastEventMillis = nowMillis;
      this.monotonicSeq = 0;
    }
    const ms = this.lastEventMillis.toString().padStart(16, "0");
    const seq = (this.monotonicSeq++).toString().padStart(8, "0");
    return `${ms}-${seq}`;
  }

  async publish(pending: PendingStoredEvent): Promise<StoredEvent> {
    return this.enqueuePublish(pending, async (event) => {
      await writerTransaction(async (tx) => {
        await tx.semanticEvent.create({ data: event });
      });
    });
  }

  async publishAtomically(
    pending: PendingStoredEvent,
    mutation: (tx: Prisma.TransactionClient, event: StoredEvent) => Promise<void>,
  ): Promise<StoredEvent> {
    return this.enqueuePublish(pending, async (event) => {
      await db.$transaction(async (tx) => {
        await assertControlWriterLease(tx);
        await tx.semanticEvent.create({ data: event });
        await mutation(tx, event);
      });
    });
  }

  private async enqueuePublish(
    pending: PendingStoredEvent,
    persist: (event: StoredEvent) => Promise<void>,
  ): Promise<StoredEvent> {
    const operation = this.publishTail.then(async () => {
      if (!this.initialized) throw new Error("event bus history is not initialized");
      const sequenceKey = `${pending.aggregateType}:${pending.aggregateId}`;
      const aggregateSequence = (this.aggregateSequences.get(sequenceKey) ?? 0) + 1;
      const ev: StoredEvent = {
        ...pending,
        eventId: this.nextEventId(),
        aggregateSequence,
      };
      // Never convert an arbitrary persistence failure into a success-shaped
      // in-memory event. Fan-out happens only after the durable write or
      // transaction commits.
      await persist(ev);
      this.aggregateSequences.set(sequenceKey, aggregateSequence);
      // Fan-out to subscribers only after the event is durable.
      for (const sub of this.subscriptions.values()) {
        try {
          if (sub.filter(ev)) sub.push(ev);
        } catch (error: unknown) {
          console.error(`[terminus-control] event subscriber ${sub.id} failed after durable commit`, error);
        }
      }
      this.cursor += 1;
      return ev;
    });
    this.publishTail = operation.then(() => undefined, () => undefined);
    return operation;
  }
  subscribe(filter: (ev: StoredEvent) => boolean, push: (ev: StoredEvent) => void): () => void {
    const id = randomUUID();
    this.subscriptions.set(id, { id, filter, push });
    return () => { this.subscriptions.delete(id); };
  }

  /** Replay the complete bounded cursor range in fixed-size pages. */
  async replay(
    sinceEventId: string,
    throughEventId: string,
    filter: (ev: StoredEvent) => boolean,
    push: (ev: StoredEvent) => void,
  ): Promise<void> {
    let cursor = sinceEventId;
    for (;;) {
      const rows = await db.semanticEvent.findMany({
        where: { eventId: { gt: cursor, lte: throughEventId } },
        orderBy: { eventId: "asc" },
        take: 1_000,
      }) as unknown as StoredEvent[];
      for (const event of rows) {
        if (filter(event)) push(event);
      }
      if (rows.length < 1_000) return;
      const next = rows.at(-1)?.eventId;
      if (!next || next <= cursor) {
        throw new Error("semantic event replay pagination did not advance");
      }
      cursor = next;
    }
  }

  async latestEventId(): Promise<string | null> {
    const latest = await db.semanticEvent.findFirst({
      orderBy: { eventId: "desc" },
      select: { eventId: true },
    });
    return latest?.eventId ?? null;
  }

  /**
   * Return the event ID of the oldest retained event, or null if none.
   * Used to detect stale SSE cursors (SPEC §30.6 CURSOR_EXPIRED).
   */
  async oldestEventId(): Promise<string | null> {
    const oldest = await db.semanticEvent.findFirst({
      orderBy: { eventId: "asc" },
      select: { eventId: true },
    });
    return oldest?.eventId ?? null;
  }

  async eventExists(eventId: string): Promise<boolean> {
    const event = await db.semanticEvent.findUnique({
      where: { eventId },
      select: { eventId: true },
    });
    return event !== null;
  }

  /**
   * Persist the last-sent event ID for a stream so the server can
   * reconstruct per-subscriber progress (SPEC §30.6, §45.5
   * EventStreamCursor table).
   */
  async persistCursor(streamName: string, lastEventId: string, lastSequence: number): Promise<void> {
    await writerTransaction(async (tx) => {
      await tx.eventStreamCursor.upsert({
        where: { streamName },
        create: { streamName, lastEventId, lastSequence },
        update: { lastEventId, lastSequence },
      });
    }).catch(() => {
      // best-effort; cursor persistence must not break the stream.
    });
  }
}

const bus = new EventBus();

const eventSubscriptionService = new EventSubscriptionService<StoredEvent>({
  subscribeLive: (filter, push) => bus.subscribe(filter, push),
  latestEventId: () => bus.latestEventId(),
  oldestEventId: () => bus.oldestEventId(),
  eventExists: (eventId) => bus.eventExists(eventId),
  replay: (since, through, filter, push) => bus.replay(since, through, filter, push),
  persistCursor: (streamName, lastEventId, lastSequence) => bus.persistCursor(streamName, lastEventId, lastSequence),
});

class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    let release: (() => void) | undefined;
    const turn = new Promise<void>((resolve) => { release = resolve; });
    const previous = this.tail;
    this.tail = previous.then(() => turn, () => turn);
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
    }
  }
}

const mutationMutex = new AsyncMutex();

function mutateAgentState<T>(operation: () => Promise<T>): Promise<T> {
  return mutationMutex.runExclusive(operation);
}

// Phase 8 Subsystems (SPEC §26, §27)
const profileRegistry = new ProfileRegistry([
  ...ANTHROPIC_MODEL_PROFILES,
  ...GOOGLE_MODEL_PROFILES,
  ...OPENAI_MODEL_PROFILES,
  ...LOCAL_MODEL_PROFILES,
]);
const posteriorTracker = new PosteriorTracker();
const stageRouter = new StageRouter(profileRegistry, posteriorTracker);
const evScheduler = new ExpectedValueScheduler();
const cleanReviewer = new CleanContextReviewer();
const stagnationSupervisor = new StagnationSupervisor();
const candidateWorkspaceManager = new CandidateWorkspaceManager();
const providerContinuationManager = new ProviderContinuationManager();

// Phase 9 Subsystems (SPEC §1, §4, §16, §29, §33)
const orgDirectory = new OrganizationDirectory();
const attentionCoordinator = new AttentionCoordinator();
const interventionManager = new InterventionManager();
const causalReplayEngine = new CausalReplayEngine();

// Phase 10 Subsystems (SPEC §25, §18.3, §17, §30)
const poolManager = new BrowserDesktopPoolManager();
const connectorLibrary = new ExternalConnectorLibrary();
const incidentRunner = new IncidentProfileRunner();
const researchRunner = new ResearchProfileRunner();
const acpContextSyncs = new Map<ContentHash, unknown>();

// Explicit coordinator-only pool. No browser or desktop execution backend is bundled.
poolManager.registerPool({
  poolId: "default-browser-pool",
  kind: "browser",
  sandboxTier: "tier2_hardened_container",
  capacity: 1,
  activeLeasesCount: 0,
  endpoint: "coordinator://unconfigured",
  healthStatus: "degraded",
  runtimeConfig: {
    reason: "No kernel-backed browser or desktop lease backend is configured",
  },
  executionSupport: "coordinator_only",
  enforcementStatus: "unverified",
});

incidentRunner.registerProfile({
  profileId: "default-incident-profile",
  organizationId: "default-org",
  departmentId: "incident-response",
  auditLevel: "forensic",
  maxActionTimeoutMs: 15000,
  mandatoryCompensation: true,
  allowedDiagnostics: ["collect_logs", "inspect_health", "capture_state"],
  autoEscalateOnFailure: true,
});

researchRunner.registerProfile({
  profileId: "default-research-profile",
  organizationId: "default-org",
  departmentId: "research",
  allowMultiSourceRetrieval: true,
  notebookSandboxEnabled: false,
  strictProvenanceTracking: true,
  citationFormat: "apa",
  maxSearchQueries: 5,
});


async function emit(params: {
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  actor?: { kind: string; id: string };
  correlationId?: string | undefined;
  causationId?: string | null | undefined;
  idempotencyKey?: string | null | undefined;
  payload: unknown;
  artifactRefs?: string[] | undefined;
  traceId?: string | null | undefined;
}, mutation?: (tx: Prisma.TransactionClient, event: StoredEvent) => Promise<void>): Promise<StoredEvent> {
  const pending: PendingStoredEvent = {
    schemaVersion: 1,
    eventType: params.eventType,
    aggregateType: params.aggregateType,
    aggregateId: params.aggregateId,
    occurredAt: new Date(),
    actorJson: JSON.stringify(params.actor ?? { kind: "system", id: "terminus-control" }),
    correlationId: params.correlationId ?? randomUUID(),
    causationId: params.causationId ?? null,
    idempotencyKey: params.idempotencyKey ?? null,
    payloadJson: JSON.stringify(params.payload),
    artifactRefsJson: JSON.stringify(params.artifactRefs ?? []),
    traceId: params.traceId ?? null,
  };
  if (mutation === undefined) {
    return bus.publish(pending);
  }
  return bus.publishAtomically(pending, mutation);
}

// ────────────────────────── Helpers ────────────────────────────────────────

function now(): Rfc3339Timestamp { return new Date().toISOString() as Rfc3339Timestamp; }

function uuid(): string { return randomUUID(); }

/** Extract the scope labels (top-level keys + path values) from an approval scope object. */
function scopeKeys(scope: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(scope)) {
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === "string" && entry.length > 0) out.push(`${key}:${entry}`);
      }
    } else if (typeof value === "string" && value.length > 0) {
      out.push(`${key}:${value}`);
    } else {
      out.push(key);
    }
  }
  return out;
}

function decodeApprovalOperation(approval: Pick<PrismaApproval, "operationHash" | "operationJson">): ApprovalOperationRecord | null {
  if (!approval.operationJson) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(approval.operationJson) as unknown;
  } catch {
    return null;
  }
  const parsed = ApprovalOperationV1.safeParse(raw);
  if (!parsed.success) return null;
  const computedHash = computeContentHash(canonicalApprovalBinding(parsed.data.binding));
  return constantTimeEqual(computedHash, approval.operationHash) ? parsed.data : null;
}

function approvalScope(approval: Pick<PrismaApproval, "operationHash" | "operationJson" | "scopeJson">): string[] {
  const operation = decodeApprovalOperation(approval);
  if (operation) {
    return [...new Set([
      ...operation.binding.resources,
      ...operation.binding.destinations,
      ...operation.binding.secret_scope.map((scope) => `secret:${scope}`),
    ])];
  }
  try {
    return scopeKeys(JSON.parse(approval.scopeJson) as Record<string, unknown>);
  } catch {
    return [];
  }
}

function approvalWire(approval: PrismaApproval): Record<string, unknown> {
  const operation = decodeApprovalOperation(approval);
  let riskClass = "unknown";
  if (operation) {
    riskClass = operation.binding.risk.class;
  } else {
    try {
      const parsedRisk = JSON.parse(approval.riskJson) as { class?: unknown };
      if (typeof parsedRisk.class === "string") riskClass = parsedRisk.class;
    } catch {
      // Legacy or corrupt rows remain visibly untrusted.
    }
  }
  return {
    id: approval.id,
    task_id: approval.taskId,
    operation_hash: approval.operationHash,
    binding: operation?.binding ?? null,
    display: operation?.display ?? null,
    status: approval.status,
    decision: approval.decision,
    // The standalone control plane can persist a denial. Allow decisions must
    // first be minted by the kernel-backed approval coordinator so the DB and
    // effect boundary cannot disagree about authorization.
    supported_decisions: ["deny_once"],
    risk: riskClass,
    scope: approvalScope(approval),
    use_limit: approval.useLimit,
    use_count: approval.useCount,
    expires_at: approval.expiresAt?.toISOString() ?? null,
    requested_at: approval.requestedAt.toISOString(),
    resolved_at: approval.resolvedAt?.toISOString() ?? null,
    rationale: approval.rationale,
  };
}

interface TaskContractHashInput {
  readonly version: number;
  readonly objective: string;
  readonly userOutcome: string | null;
  readonly nonGoals: readonly unknown[];
  readonly constraints: readonly unknown[];
  readonly assumptions: readonly unknown[];
  readonly unknowns: readonly unknown[];
  readonly allowedScope: unknown;
  readonly changePolicy: unknown;
}

function taskContractHash(input: TaskContractHashInput): ContentHash {
  return computeContentHash(canonicalJson(input));
}

const V1_MUTABLE_TASK_STATUSES = [
  "DRAFT",
  "ACTIVE",
  "NEEDS_USER_DECISION",
  "BLOCKED",
  "VERIFYING",
] as const;

const V1_ACTIVE_TURN_STATES = [
  "PENDING",
  "CONTEXT_COMPILING",
  "PROVIDER_RUNNING",
  "RESPONSE_VALIDATING",
  "TOOL_SETTLEMENT",
  "FINALIZING",
] as const;

const V1_NONTERMINAL_JOB_STATES = [
  "CREATED",
  "STARTING",
  "RUNNING",
  "STOPPING",
  "KILLING",
  "ORPHANED",
  "REATTACHED",
] as const;

function isNonterminalJobState(state: string): boolean {
  return V1_NONTERMINAL_JOB_STATES.some((candidate) => candidate === state);
}

function isMutableV1TaskStatus(status: string): boolean {
  return V1_MUTABLE_TASK_STATUSES.some((candidate) => candidate === status);
}

/** Per-request raw body cache so auth/idempotency/handler can all read it. */
const bodyCache = new WeakMap<IncomingMessage, Buffer>();

class RequestBodyTooLargeError extends Error {
  constructor(readonly observedBytes: number) {
    super(`request body exceeded ${MAX_REQUEST_BYTES} bytes`);
    this.name = "RequestBodyTooLargeError";
  }
}

function readRawBody(req: IncomingMessage): Promise<Buffer> {
  const cached = bodyCache.get(req);
  if (cached) return Promise.resolve(cached);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let rejected = false;
    req.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (rejected) return;
      if (bytes > MAX_REQUEST_BYTES) {
        rejected = true;
        chunks.length = 0;
        reject(new RequestBodyTooLargeError(bytes));
        return;
      }
      chunks.push(buffer);
    });
    req.on("error", reject);
    req.on("end", () => {
      if (rejected) return;
      const buf = Buffer.concat(chunks);
      bodyCache.set(req, buf);
      resolve(buf);
    });
  });
}

function jsonBody(req: IncomingMessage): Promise<unknown> {
  return readRawBody(req).then((buf) => {
    if (buf.length === 0) return {};
    try { return JSON.parse(buf.toString("utf8")); } catch (e) { throw e; }
  });
}

function sha256Hex(buf: Buffer): string {
  return "sha256:" + createHash("sha256").update(buf).digest("hex");
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function getTraceId(req: IncomingMessage): string {
  const tp = req.headers["traceparent"];
  if (typeof tp === "string" && tp.length > 0) return tp;
  const tid = req.headers["x-trace-id"];
  if (typeof tid === "string" && tid.length > 0) return tid;
  return randomUUID();
}

function checkAuth(req: IncomingMessage): boolean {
  const auth = req.headers.authorization;
  if (typeof auth !== "string") return false;
  if (!auth.startsWith("Bearer ")) return false;
  const token = auth.slice("Bearer ".length);
  return constantTimeEqual(token, CONTROL_TOKEN);
}

function isMutating(method: string | undefined): boolean {
  return method === "POST" || method === "PATCH" || method === "PUT" || method === "DELETE";
}

function auditAuthorized(
  req: IncomingMessage,
  url: URL,
  params: Record<string, string>,
  traceId: string,
): void {
  // SPEC §31.3 step 10 — log an `authorized` audit event before any effect.
  // `task_id` is only populated when the route is under /v1/tasks/:id (so
  // the value is genuinely a task ID, not a session/turn/job ID).
  const taskId = url.pathname.startsWith("/v1/tasks/") ? (params.id ?? null) : null;
  const log = {
    event: "authorized",
    method: req.method ?? "GET",
    path: url.pathname,
    actor: SERVER_PRINCIPAL,
    task_id: taskId,
    trace_id: traceId,
    timestamp: new Date().toISOString(),
  };
  console.log(JSON.stringify(log));
}

// ────────────────────────── Idempotency ────────────────────────────────────

/**
 * Per-response capture so the idempotency wrapper can store the exact
 * bytes the handler produced. Only attached for mutating routes.
 */
interface CapturedResponse {
  status: number;
  body: Buffer;
}

interface StoredIdempotencyResponseV1 {
  format: "terminus.idempotency.response.v1";
  status: number;
  bodyBase64: string;
}

const captureMap = new WeakMap<ServerResponse, CapturedResponse>();

function attachCapture(res: ServerResponse): void {
  captureMap.set(res, { status: 0, body: Buffer.alloc(0) });
}

function recordCapture(res: ServerResponse, status: number, body: Buffer): boolean {
  const cap = captureMap.get(res);
  if (!cap) return false;
  cap.status = status;
  cap.body = body;
  return true;
}

function popCapture(res: ServerResponse): CapturedResponse | null {
  const cap = captureMap.get(res);
  if (!cap) return null;
  captureMap.delete(res);
  return cap;
}

function decodeStoredIdempotencyResponse(value: unknown): CapturedResponse | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Partial<StoredIdempotencyResponseV1>;
  if (
    record.format !== "terminus.idempotency.response.v1" ||
    typeof record.status !== "number" ||
    !Number.isSafeInteger(record.status) ||
    record.status < 100 ||
    record.status > 599 ||
    typeof record.bodyBase64 !== "string"
  ) return null;
  return { status: record.status, body: Buffer.from(record.bodyBase64, "base64") };
}

function normalizedRequestHash(req: IncomingMessage, body: Buffer): string {
  const target = new URL(req.url ?? "/", "http://terminus.local");
  target.searchParams.sort();
  const query = target.searchParams.toString();
  const requestTarget = `${target.pathname}${query ? `?${query}` : ""}`;
  return sha256Hex(Buffer.concat([Buffer.from(requestTarget, "utf8"), Buffer.from([0]), body]));
}

/**
 * SPEC §30.5. For mutating requests with an `Idempotency-Key` header:
 *   - same key + same body → return cached response
 *   - same key + different body → return 409 IDEMPOTENCY_KEY_CONFLICT
 *   - new key → insert `pending`, run handler, store result as `completed`
 *
 * Returns `true` if the handler should run, `false` if a response has
 * already been sent (replay, conflict, or in-flight).
 *
 * When returning `true`, a capture is attached to `res`; the caller MUST
 * invoke `commitIdempotency(...)` after the handler completes.
 */
async function withIdempotency(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  traceId: string,
): Promise<boolean> {
  const keyHeader = req.headers["idempotency-key"];
  const key = Array.isArray(keyHeader) ? (keyHeader[0] ?? null) : keyHeader;
  if (typeof key !== "string" || key.trim().length === 0 || key.length > 255) {
    sendError(
      res,
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
      "mutating requests require a non-empty Idempotency-Key of at most 255 characters",
      "validation",
      { header: "Idempotency-Key", trace_id: traceId },
    );
    return false;
  }
  let buf: Buffer;
  try {
    buf = await readRawBody(req);
  } catch (error: unknown) {
    const tooLarge = error instanceof RequestBodyTooLargeError;
    sendError(res, tooLarge ? 413 : 400, tooLarge ? "REQUEST_BODY_TOO_LARGE" : "INVALID_REQUEST_BODY", tooLarge
      ? `request body exceeds the ${MAX_REQUEST_BYTES}-byte limit`
      : "request body could not be read", "validation", {
      error: String(error),
      trace_id: traceId,
      max_request_bytes: MAX_REQUEST_BYTES,
    });
    return false;
  }
  const hash = normalizedRequestHash(req, buf);

  let existing: IdempotencyRecord | null;
  try {
    existing = await db.idempotencyRecord.findUnique({
      where: {
        principal_method_idempotencyKey: {
          principal: SERVER_PRINCIPAL,
          method,
          idempotencyKey: key,
        },
      },
    });
  } catch (error: unknown) {
    sendError(res, 503, "IDEMPOTENCY_UNAVAILABLE", "idempotency storage is unavailable", "external_dependency", {
      idempotency_key: key,
      trace_id: traceId,
      error: String(error),
    });
    return false;
  }

  if (existing && existing.expiresAt.getTime() <= Date.now()) {
    try {
      await writerTransaction(async (tx) => {
        await tx.idempotencyRecord.delete({
          where: {
            principal_method_idempotencyKey: {
              principal: SERVER_PRINCIPAL,
              method,
              idempotencyKey: key,
            },
          },
        });
      });
      existing = null;
    } catch (error: unknown) {
      sendError(res, 503, "IDEMPOTENCY_UNAVAILABLE", "expired idempotency state could not be renewed", "external_dependency", {
        idempotency_key: key,
        trace_id: traceId,
        error: String(error),
      });
      return false;
    }
  }

  if (existing) {
    if (existing.requestHash !== hash) {
      sendError(
        res,
        409,
        "IDEMPOTENCY_KEY_CONFLICT",
        "idempotency key reused with a different request body",
        "conflict",
        { idempotency_key: key },
      );
      return false;
    }
    // Same key + same body → replay the stored response.
    if (existing.state === "completed") {
      if (existing.errorJson) {
        try {
          const err = JSON.parse(existing.errorJson) as {
            status: number; code: string; message: string; category: string;
            details?: Record<string, unknown>;
          };
          if (
            !Number.isInteger(err.status)
            || err.status < 400
            || err.status > 599
            || typeof err.code !== "string"
            || err.code.length === 0
            || typeof err.message !== "string"
            || typeof err.category !== "string"
          ) throw new Error("invalid stored idempotency error");
          sendError(res, err.status, err.code, err.message, err.category, err.details ?? {});
        } catch {
          sendError(
            res,
            409,
            "IDEMPOTENCY_REPLAY_INTEGRITY_FAILED",
            "the stored mutation outcome is corrupt and requires reconciliation",
            "unknown_settlement",
            { idempotency_key: key, reconciliation_required: true },
          );
        }
      } else {
        try {
          const artifact = existing.responseArtifact
            ? (JSON.parse(existing.responseArtifact) as unknown)
            : null;
          const stored = decodeStoredIdempotencyResponse(artifact);
          if (stored === null) throw new Error("invalid stored idempotency response");
          sendJsonBuffer(res, stored.status, stored.body);
        } catch {
          sendError(
            res,
            409,
            "IDEMPOTENCY_REPLAY_INTEGRITY_FAILED",
            "the stored mutation outcome is corrupt and requires reconciliation",
            "unknown_settlement",
            { idempotency_key: key, reconciliation_required: true },
          );
        }
      }
      return false;
    }
    // Still in-flight — ask the client to retry.
    sendError(
      res,
      409,
      "IDEMPOTENCY_IN_PROGRESS",
      "a request with the same idempotency key is still in-flight",
      "conflict",
      { idempotency_key: key, retry_after_ms: 500 },
    );
    return false;
  }

  // No prior record — insert pending, attach capture, let caller run handler.
  try {
    await writerTransaction(async (tx) => {
      await tx.idempotencyRecord.create({
        data: {
          principal: SERVER_PRINCIPAL,
          method,
          idempotencyKey: key,
          requestHash: hash,
          state: "pending",
          responseArtifact: null,
          errorJson: null,
          expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
        },
      });
    });
  } catch (error: unknown) {
    sendError(res, 503, "IDEMPOTENCY_UNAVAILABLE", "idempotency operation could not be reserved", "external_dependency", {
      idempotency_key: key,
      trace_id: traceId,
      error: String(error),
    });
    return false;
  }
  attachCapture(res);
  return true;
}

async function commitIdempotency(
  res: ServerResponse,
  method: string,
  key: string,
): Promise<CapturedResponse> {
  const cap = popCapture(res);
  if (!cap || cap.status < 100) {
    throw new Error("mutating handler completed without a captured JSON response");
  }
  const stored: StoredIdempotencyResponseV1 = {
    format: "terminus.idempotency.response.v1",
    status: cap.status,
    bodyBase64: cap.body.toString("base64"),
  };
  await writerTransaction(async (tx) => {
    await tx.idempotencyRecord.update({
      where: {
        principal_method_idempotencyKey: {
          principal: SERVER_PRINCIPAL,
          method,
          idempotencyKey: key,
        },
      },
      data: {
        state: "completed",
        responseArtifact: JSON.stringify(stored),
        errorJson: null,
      },
    });
  });
  return cap;
}

/** Convert crash-stranded reservations into explicit unknown settlements. */
async function reconcilePendingIdempotencyReservations(): Promise<number> {
  const outcome = await writerTransaction((tx) => tx.idempotencyRecord.updateMany({
    where: { state: "pending" },
    data: {
      state: "completed",
      responseArtifact: null,
      errorJson: JSON.stringify({
        status: 409,
        code: "IDEMPOTENCY_OUTCOME_UNKNOWN",
        message: "the previous process stopped before recording the mutation outcome",
        category: "unknown_settlement",
        details: { reconciliation_required: true },
      }),
    },
  }));
  return outcome.count;
}

// ────────────────────────── HTTP response helpers ─────────────────────────

function sendJsonBuffer(res: ServerResponse, status: number, buf: Buffer): void {
  const headers = {
    "content-type": "application/json",
    "content-length": String(buf.length),
    "access-control-allow-origin": CONTROL_CORS_ORIGIN,
    "access-control-allow-headers": CORS_ALLOW_HEADERS,
    "access-control-allow-methods": CORS_ALLOW_METHODS,
    "vary": "origin",
  };
  res.writeHead(status, headers);
  res.end(buf);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const buf = Buffer.from(JSON.stringify(body), "utf8");
  if (recordCapture(res, status, buf)) return;
  sendJsonBuffer(res, status, buf);
}

function logInternalError(operation: string, error: unknown): void {
  console.error(`[terminus-control] ${operation}`, error);
}

function sendError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  category: string,
  details: Record<string, unknown> = {},
): void {
  sendJson(res, status, {
    error: {
      code,
      message,
      retryable:
        category === "timeout" ||
        category === "external_dependency" ||
        category === "internal",
      category,
      details,
      suggested_action: null,
      trace_id: randomUUID(),
    },
  });
}

function domainErrorStatus(error: DomainForgeError): number {
  switch (error.category) {
    case "validation": return 400;
    case "not_found": return 404;
    case "conflict":
    case "approval_required":
    case "cancelled":
    case "unknown_settlement": return 409;
    case "permission":
    case "policy_denied": return 403;
    case "resource_exhausted":
    case "budget_exhausted": return 429;
    case "sandbox_unavailable":
    case "provider":
    case "external_dependency":
    case "timeout": return 503;
    case "integrity":
    case "internal": return 500;
  }
}

function sendCaughtError(res: ServerResponse, error: unknown): void {
  if (error instanceof ControlWriterFencedError) {
    sendError(
      res,
      503,
      "CONTROL_WRITER_FENCED",
      error.message,
      "external_dependency",
    );
    return;
  }
  if (error instanceof RequestBodyTooLargeError) {
    sendError(
      res,
      413,
      "REQUEST_BODY_TOO_LARGE",
      `request body exceeds the ${MAX_REQUEST_BYTES}-byte limit`,
      "validation",
      { max_request_bytes: MAX_REQUEST_BYTES, observed_bytes: error.observedBytes },
    );
    return;
  }
  if (error instanceof DomainForgeError) {
    sendJson(res, domainErrorStatus(error), error.toEnvelope());
    return;
  }
  if (error instanceof z.ZodError) {
    sendError(
      res,
      400,
      "VALIDATION_FAILED",
      "request or response did not satisfy the public v2 schema",
      "validation",
      { issues: error.issues },
    );
    return;
  }
  // Never echo an unhandled error's message to the client. Prisma failures in
  // particular render a multi-line dump carrying absolute source paths, line
  // numbers, the generated query shape, and column names — that is information
  // disclosure on a public route. The full error is logged against the same
  // trace_id the caller receives, so operators lose nothing.
  const traceId = randomUUID();
  console.error(`[terminus-control] unhandled request error trace_id=${traceId}`, error);
  sendError(
    res,
    500,
    "INTERNAL",
    "the control plane failed to complete this request",
    "internal",
    { trace_id: traceId },
  );
}

interface PageRequest {
  readonly cursor: string | null;
  readonly limit: number;
}

function parsePageRequest(req: IncomingMessage, res: ServerResponse, defaultLimit = 100): PageRequest | null {
  const url = new URL(req.url ?? "/", "http://terminus.local");
  const cursor = url.searchParams.get("cursor");
  const limitValue = url.searchParams.get("limit");
  if (cursor !== null && !/^[a-zA-Z0-9._:-]{1,255}$/.test(cursor)) {
    sendError(res, 400, "INVALID_CURSOR", "cursor was not a valid opaque collection cursor", "validation");
    return null;
  }
  if (limitValue !== null && !/^[1-9][0-9]*$/.test(limitValue)) {
    sendError(res, 400, "INVALID_PAGE_LIMIT", "limit must be a positive decimal integer", "validation");
    return null;
  }
  const requestedLimit = limitValue === null ? defaultLimit : Number(limitValue);
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit > 200) {
    sendError(res, 400, "INVALID_PAGINATION", "limit must be a safe integer no greater than 200", "validation");
    return null;
  }
  return { cursor, limit: requestedLimit };
}

function nextPageCursor<T extends { id: string }>(rows: readonly T[], limit: number): string | null {
  return rows.length > limit ? rows[limit - 1]?.id ?? null : null;
}

/** Validate the serialized public response, including bigint wire transforms. */
function sendV2Response(res: ServerResponse, status: number, schema: z.ZodType, value: unknown): void {
  const serialized = jsonSafe(value);
  sendJson(res, status, schema.parse(serialized));
}

// ────────────────────────── Approval decision reconciliation ───────────────

/**
 * SPEC §32.4. Accept BOTH naming conventions used across the codebase:
 *   - public-api: allow_once | allow_exact | allow_task_scope | deny_once |
 *                 deny_and_rule | stop_task
 *   - domain:     allow_once | allow_for_action | allow_for_task | deny_once |
 *                 deny_and_add_task_rule | stop_task
 * and map them to the canonical domain names. Unknown values return null.
 */
function normalizeApprovalDecision(raw: string): string | null {
  switch (raw) {
    case "allow_once":
      return "allow_once";
    case "allow_exact":
    case "allow_for_action":
      return "allow_for_action";
    case "allow_task_scope":
    case "allow_for_task":
      return "allow_for_task";
    case "deny_once":
      return "deny_once";
    case "deny_and_rule":
    case "deny_and_add_task_rule":
      return "deny_and_add_task_rule";
    case "stop_task":
      return "stop_task";
    default:
      return null;
  }
}

// ────────────────────────── ARP v2 canonical domain (SPEC §5–§16) ──────────

/**
 * Canonical ARP v2 aggregate store.
 *
 * Aggregates live in memory and are event-sourced through the semantic
 * event log (`semantic_events` rows with `schemaVersion = 2`): every
 * mutation emits a v2 envelope whose payload carries the full post-state
 * snapshot, and startup replays those rows to rebuild state across
 * restarts. This keeps the canonical domain durable without widening the
 * Prisma schema; dedicated v2 tables remain future work.
 *
 * Wire encoding: `Micros` bigint values are decimal strings in JSON
 * (JSON has no bigint); request bodies may send them as strings or
 * numbers and they are coerced back to bigint at this boundary.
 */

/** Deep transform: bigint → decimal string so JSON.stringify is total. */
function jsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = jsonSafe(v);
    return out;
  }
  return value;
}

const microsWireSchema = z.union([
  z.string().regex(/^\d+$/),
  z.number().int().nonnegative(),
]).transform((v) => BigInt(v));

/** Request-body contract schema: identical to the domain schema except that costMicros accepts JSON-safe input. */
const taskContractV2WireSchema = taskContractV2Schema.extend({
  constraints: taskContractV2Schema.shape.constraints.extend({ costMicros: microsWireSchema }),
});

const taskV2ReviveSchema = taskV2Schema.extend({ contract: taskContractV2WireSchema });
const artifactRefReviveSchema = artifactRefSchema.extend({ bytes: microsWireSchema });
const evidenceReviveSchema = evidenceSchema.extend({
  artifactRef: artifactRefReviveSchema.nullable(),
});
const budgetConsumptionReviveSchema = budgetConsumptionSchema.extend({
  consumedCostMicros: microsWireSchema,
  consumedInputTokens: microsWireSchema,
  consumedOutputTokens: microsWireSchema,
});

const arpV2ReplaySchemas = {
  task: taskV2ReviveSchema,
  effect: effectRecordSchema,
  authorization: authorizationInstanceSchema,
  claim: claimSchema,
  evidence: evidenceReviveSchema,
  question: questionSchema,
  decision: decisionSchema,
  workflow: workflowSchema,
  node_run: nodeRunSchema,
  lease: workerLeaseSchema,
  attempt: taskAttemptSchema,
  risk: riskSchema,
  budget: budgetConsumptionReviveSchema,
} as const satisfies Readonly<Record<string, z.ZodType>>;

interface ArpV2State {
  tasks: Map<string, TaskV2>;
  effects: Map<string, EffectRecord>;
  authorizations: Map<string, AuthorizationInstance>;
  claims: Map<string, Claim>;
  evidences: Map<string, Evidence>;
  questions: Map<string, Question>;
  decisions: Map<string, Decision>;
  workflows: Map<string, Workflow>;
  nodeRuns: Map<string, NodeRun>;
  workerLeases: Map<string, WorkerLease>;
  attempts: Map<string, TaskAttempt>;
  risks: Map<string, Risk>;
  budgets: Map<string, BudgetConsumption>;
}

const arpV2: ArpV2State = {
  tasks: new Map(),
  effects: new Map(),
  authorizations: new Map(),
  claims: new Map(),
  evidences: new Map(),
  questions: new Map(),
  decisions: new Map(),
  workflows: new Map(),
  nodeRuns: new Map(),
  workerLeases: new Map(),
  attempts: new Map(),
  risks: new Map(),
  budgets: new Map(),
};

function arpV2StoreFor(aggregateType: string): Map<string, unknown> | null {
  switch (aggregateType) {
    case "task": return arpV2.tasks as Map<string, unknown>;
    case "effect": return arpV2.effects as Map<string, unknown>;
    case "authorization": return arpV2.authorizations as Map<string, unknown>;
    case "claim": return arpV2.claims as Map<string, unknown>;
    case "evidence": return arpV2.evidences as Map<string, unknown>;
    case "question": return arpV2.questions as Map<string, unknown>;
    case "decision": return arpV2.decisions as Map<string, unknown>;
    case "workflow": return arpV2.workflows as Map<string, unknown>;
    case "node_run": return arpV2.nodeRuns as Map<string, unknown>;
    case "lease": return arpV2.workerLeases as Map<string, unknown>;
    case "attempt": return arpV2.attempts as Map<string, unknown>;
    case "risk": return arpV2.risks as Map<string, unknown>;
    case "budget": return arpV2.budgets as Map<string, unknown>;
    default: return null;
  }
}

/**
 * Emit a canonical ARP v2 envelope. The full post-state snapshot rides in
 * the payload so the event log alone reconstructs the aggregate store.
 */
async function emitV2(params: {
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  snapshot: unknown;
  idempotencyKey?: string | null;
  correlationId?: string | null;
  mutation?: ((tx: Prisma.TransactionClient, event: StoredEvent) => Promise<void>) | undefined;
}): Promise<void> {
  const pending: PendingStoredEvent = {
    schemaVersion: 2,
    eventType: params.eventType,
    aggregateType: params.aggregateType,
    aggregateId: params.aggregateId,
    occurredAt: new Date(),
    actorJson: JSON.stringify({ kind: "system", id: SERVER_PRINCIPAL }),
    correlationId: params.correlationId ?? params.aggregateId,
    causationId: null,
    idempotencyKey: params.idempotencyKey ?? null,
    // ARP v2 envelopes carry the aggregate post-state directly in payload.
    // Keeping a second { snapshot } wrapper makes the wire contract disagree
    // with the generated envelope schema and forces every consumer to guess.
    payloadJson: JSON.stringify(jsonSafe(params.snapshot)),
    artifactRefsJson: JSON.stringify([]),
    traceId: null,
  };
  if (params.mutation) {
    await bus.publishAtomically(pending, params.mutation);
  } else {
    await bus.publish(pending);
  }
}

/** Rebuild the in-memory v2 aggregates from the persisted event log. */
async function replayArpV2(): Promise<void> {
  const rows: Array<{
    eventId: string;
    schemaVersion: number;
    aggregateType: string;
    aggregateId: string;
    aggregateSequence: number;
    payloadJson: string;
  }> = [];
  let cursor: string | null = null;
  for (;;) {
    const page: Array<{
      eventId: string;
      schemaVersion: number;
      aggregateType: string;
      aggregateId: string;
      aggregateSequence: number;
      payloadJson: string;
    }> = await db.semanticEvent.findMany({
      orderBy: { eventId: "asc" },
      take: 1_000,
      ...(cursor === null ? {} : { cursor: { eventId: cursor }, skip: 1 }),
      select: {
        eventId: true,
        schemaVersion: true,
        aggregateType: true,
        aggregateId: true,
        aggregateSequence: true,
        payloadJson: true,
      },
    });
    rows.push(...page);
    if (page.length < 1_000) break;
    cursor = page.at(-1)?.eventId ?? null;
    if (cursor === null) throw new Error("ARP v2 replay pagination lost its continuation cursor");
  }
  bus.initializeFromHistory(rows);
  for (const row of rows) {
    if (row.schemaVersion !== 2) continue;
    const store = arpV2StoreFor(row.aggregateType);
    if (!store) continue;
    const schema = arpV2ReplaySchemas[row.aggregateType as keyof typeof arpV2ReplaySchemas];
    if (!schema) {
      console.error(`[terminus-control] ignored ARP v2 event ${row.eventId}: no schema for ${row.aggregateType}`);
      continue;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(row.payloadJson) as unknown;
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[terminus-control] ignored ARP v2 event ${row.eventId}: invalid JSON (${detail})`);
      continue;
    }
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      console.error(`[terminus-control] ignored ARP v2 event ${row.eventId}: missing aggregate snapshot`);
      continue;
    }
    // Accept the pre-contract wrapper during restart migration, but all new
    // events are emitted with the direct payload shape above.
    const snapshot = "snapshot" in payload
      ? (payload as { readonly snapshot: unknown }).snapshot
      : payload;
    const revived = schema.safeParse(snapshot);
    if (!revived.success) {
      const issues = revived.error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.join(".") || "snapshot"}: ${issue.message}`)
        .join("; ");
      console.error(`[terminus-control] ignored ARP v2 event ${row.eventId}: invalid ${row.aggregateType} snapshot (${issues})`);
      continue;
    }
    const snapshotRecord = revived.data as Readonly<Record<string, unknown>>;
    const snapshotId = row.aggregateType === "budget"
      ? snapshotRecord.taskId
      : snapshotRecord.id;
    if (snapshotId !== row.aggregateId) {
      console.error(
        `[terminus-control] ignored ARP v2 event ${row.eventId}: snapshot identity ${String(snapshotId)} does not match aggregate ${row.aggregateId}`,
      );
      continue;
    }
    const previous = store.get(row.aggregateId) as Readonly<Record<string, unknown>> | undefined;
    const previousVersion = previous?.version;
    const nextVersion = snapshotRecord.version;
    if (
      typeof previousVersion === "number"
      && typeof nextVersion === "number"
      && nextVersion <= previousVersion
    ) {
      console.error(
        `[terminus-control] ignored ARP v2 event ${row.eventId}: snapshot version ${nextVersion} does not advance past ${previousVersion}`,
      );
      continue;
    }
    store.set(row.aggregateId, revived.data);
  }
  console.log(`[terminus-control] arp-v2 replay: ${arpV2.tasks.size} tasks, ${arpV2.effects.size} effects, ${arpV2.claims.size} claims, ${arpV2.workflows.size} workflows, ${arpV2.workerLeases.size} leases`);
}

function v1TaskStatusToV2(status: string): TaskV2["status"] {
  switch (status) {
    case "DRAFT": return "DRAFT";
    case "ACTIVE": return "RUNNING";
    case "NEEDS_USER_DECISION": return "WAITING_USER";
    case "BLOCKED": return "BLOCKED";
    case "VERIFYING": return "VERIFYING";
    case "COMPLETED": return "COMPLETED";
    case "ABORTED": return "CANCELLED";
    case "FAILED":
    case "FAILED_VERIFICATION":
    case "BUDGET_EXHAUSTED":
    case "POLICY_DENIED":
      return "FAILED";
    default:
      return "BLOCKED";
  }
}

function v2TaskStatusToV1(status: TaskV2["status"]): {
  readonly status: string;
  readonly phase: string;
  readonly completedAt: Date | null;
} {
  switch (status) {
    case "DRAFT":
    case "READY":
      return { status: "DRAFT", phase: "INTAKE", completedAt: null };
    case "RUNNING":
      return { status: "ACTIVE", phase: "IMPLEMENT", completedAt: null };
    case "WAITING_USER":
    case "WAITING_AUTH":
      return { status: "NEEDS_USER_DECISION", phase: "IMPLEMENT", completedAt: null };
    case "WAITING_RESOURCE":
    case "PAUSED":
    case "BLOCKED":
      return { status: "BLOCKED", phase: "IMPLEMENT", completedAt: null };
    case "VERIFYING":
      return { status: "VERIFYING", phase: "VERIFY", completedAt: null };
    case "COMPLETED":
      return { status: "COMPLETED", phase: "COMPLETE", completedAt: new Date() };
    case "CANCELLED":
      return { status: "ABORTED", phase: "COMPLETE", completedAt: new Date() };
    case "PARTIAL":
    case "FAILED":
      return { status: "FAILED", phase: "COMPLETE", completedAt: new Date() };
  }
}

async function projectV2StatusIntoV1(
  tx: Prisma.TransactionClient,
  taskId: string,
  status: TaskV2["status"],
): Promise<void> {
  const v1Task = await tx.task.findUnique({
    where: { id: taskId },
    select: { id: true, status: true },
  });
  if (!v1Task) return;
  if (!isMutableV1TaskStatus(v1Task.status) && !v1AndV2StatusesAgree(v1Task.status, status)) {
    throw new Error(`terminal v1 task ${taskId} cannot be projected from ${v1Task.status} to ${status}`);
  }
  const projection = v2TaskStatusToV1(status);
  const updated = await tx.task.updateMany({
    where: { id: taskId, status: v1Task.status },
    data: {
      status: projection.status,
      phase: projection.phase,
      completedAt: projection.completedAt,
      terminalReasonJson: projection.completedAt === null
        ? null
        : JSON.stringify({ reason: `arp_v2_${status.toLowerCase()}` }),
    },
  });
  if (updated.count !== 1) {
    throw new Error(`v1 task ${taskId} changed during v2 status projection`);
  }
}

interface V1AllowedScopeProjection {
  readonly read_paths: readonly string[];
  readonly write_paths: readonly string[];
  readonly external_systems: readonly string[];
}

function v1AllowedScopeProjection(value: unknown): V1AllowedScopeProjection {
  return parseProjectionAllowedScope(value);
}

function scopeExpansionResources(
  previous: V1AllowedScopeProjection,
  next: V1AllowedScopeProjection,
): readonly string[] {
  return projectionScopeExpansionResources(previous, next);
}

function scopeLedgerRows(input: {
  readonly taskId: string;
  readonly contractVersion: number;
  readonly scope: V1AllowedScopeProjection;
  readonly source: string;
  readonly reason: string;
  readonly approvalId?: string | null;
}): Array<{
  id: string;
  taskId: string;
  contractVersion: number;
  resourceUri: string;
  accessClass: string;
  source: string;
  reason: string;
  approvalId: string | null;
}> {
  const row = (resourceUri: string, accessClass: string) => ({
    id: uuid(),
    taskId: input.taskId,
    contractVersion: input.contractVersion,
    resourceUri,
    accessClass,
    source: input.source,
    reason: input.reason,
    approvalId: input.approvalId ?? null,
  });
  return [
    ...input.scope.read_paths.map((path) => row(`workspace:${path}`, "read_allowed")),
    ...input.scope.write_paths.map((path) => row(`workspace:${path}`, "write_allowed")),
    ...input.scope.external_systems.map((system) => row(`external:${system}`, "external_effective")),
  ];
}

class TaskLineageAdmissionError extends Error {
  constructor(
    readonly reason: "thread_not_found" | "session_mismatch",
    readonly actualSessionId: string | null = null,
  ) {
    super(reason);
    this.name = "TaskLineageAdmissionError";
  }
}

function v2PathScopeProjection(contract: TaskContractV2): V1AllowedScopeProjection {
  return projectionV2PathScopeProjection(contract);
}

function derivedV2Authority(scope: V1AllowedScopeProjection): {
  readonly allowedEffectClasses: readonly string[];
  readonly authorityCeiling: readonly string[];
} {
  const allowedEffectClasses: string[] = [];
  const authorityCeiling: string[] = [];
  if (scope.read_paths.length > 0) {
    allowedEffectClasses.push("LOCAL_FS_READ");
    authorityCeiling.push("FS_READ");
  }
  if (scope.write_paths.length > 0) {
    allowedEffectClasses.push("LOCAL_FS_WRITE");
    authorityCeiling.push("FS_WRITE");
  }
  return { allowedEffectClasses, authorityCeiling };
}

async function projectV2ContractIntoV1(
  tx: Prisma.TransactionClient,
  taskId: string,
  contract: TaskContractV2,
): Promise<void> {
  const task = await tx.task.findUnique({
    where: { id: taskId },
    select: { activeContractVersion: true, status: true, budgetJson: true },
  });
  if (!task) return;
  const expected = task.activeContractVersion + 1;
  if (contract.version !== expected) {
    throw new Error(`v1 task ${taskId} requires contract version ${expected}`);
  }
  if (!isMutableV1TaskStatus(task.status)) {
    throw new Error(`terminal v1 task ${taskId} contract is immutable (${task.status})`);
  }
  const allowedScope = v2PathScopeProjection(contract);
  const previousContract = await tx.taskContractVersion.findUnique({
    where: {
      task_id_version: {
        task_id: taskId,
        version: task.activeContractVersion,
      },
    },
    select: { allowedScopeJson: true },
  });
  if (!previousContract) {
    throw new Error(`v1 task ${taskId} has no active contract version ${task.activeContractVersion}`);
  }
  const expansions = scopeExpansionResources(
    v1AllowedScopeProjection(safeParse<unknown>(previousContract.allowedScopeJson, {})),
    allowedScope,
  );
  if (expansions.length > 0) {
    throw new Error(`task scope expansion requires user approval: ${expansions.join(", ")}`);
  }
  const previousBudget = safeParse<Record<string, unknown>>(task.budgetJson, {});
  const budgetJson = JSON.stringify({
    model_micros: contract.constraints.costMicros.toString(),
    compute_seconds: contract.constraints.timeoutSeconds,
    wall_clock_seconds: contract.constraints.timeoutSeconds,
    human_approvals: numberOr(previousBudget.human_approvals, 20),
  });
  const v1Contract: TaskContractHashInput = {
    version: contract.version,
    objective: contract.mission,
    userOutcome: null,
    nonGoals: [],
    constraints: [...contract.constraints.security],
    assumptions: [],
    unknowns: [],
    allowedScope,
    changePolicy: { mayExpandScope: false, scopeExpansionRequiresUser: true },
  };
  const advanced = await tx.task.updateMany({
    where: {
      id: taskId,
      activeContractVersion: task.activeContractVersion,
      status: { in: [...V1_MUTABLE_TASK_STATUSES] },
    },
    data: {
      activeContractVersion: contract.version,
      budgetJson,
      scopeDigest: JSON.stringify(allowedScope),
    },
  });
  if (advanced.count !== 1) throw new Error(`task ${taskId} contract changed during v2 projection`);
  await tx.taskContractVersion.create({
    data: {
      task_id: taskId,
      version: contract.version,
      objective: contract.mission,
      userOutcome: null,
      nonGoalsJson: "[]",
      constraintsJson: JSON.stringify(contract.constraints.security),
      assumptionsJson: "[]",
      unknownsJson: "[]",
      allowedScopeJson: JSON.stringify(allowedScope),
      v2ProjectionJson: JSON.stringify(jsonSafe(contract)),
      changePolicyJson: JSON.stringify(v1Contract.changePolicy),
      contentHash: taskContractHash(v1Contract),
      createdBy: SERVER_PRINCIPAL,
    },
  });
  const ledgerRows = scopeLedgerRows({
    taskId,
    contractVersion: contract.version,
    scope: allowedScope,
    source: "v2_contract_projection",
    reason: "contract scope carried forward without expansion",
  });
  if (ledgerRows.length > 0) {
    await tx.scopeLedgerEntry.createMany({ data: ledgerRows });
  }
  for (const criterion of contract.acceptance) {
    await tx.acceptanceCriterion.create({
      data: {
        taskId,
        contractVersion: contract.version,
        criterionId: criterion.claimId,
        statement: criterion.statement,
        verificationHint: criterion.evidenceRequirement,
        required: true,
        status: "pending",
      },
    });
  }
}

function v1AndV2StatusesAgree(v1Status: string, v2Status: TaskV2["status"]): boolean {
  switch (v1Status) {
    case "DRAFT": return v2Status === "DRAFT" || v2Status === "READY";
    case "ACTIVE": return v2Status === "RUNNING";
    case "NEEDS_USER_DECISION": return v2Status === "WAITING_USER" || v2Status === "WAITING_AUTH";
    case "BLOCKED": return v2Status === "BLOCKED" || v2Status === "WAITING_RESOURCE" || v2Status === "PAUSED";
    case "VERIFYING": return v2Status === "VERIFYING";
    case "COMPLETED": return v2Status === "COMPLETED";
    case "ABORTED": return v2Status === "CANCELLED";
    case "FAILED":
    case "FAILED_VERIFICATION":
    case "BUDGET_EXHAUSTED":
    case "POLICY_DENIED":
      return v2Status === "FAILED" || v2Status === "PARTIAL";
    default:
      return false;
  }
}

function nonnegativeBigInt(value: unknown, fallback: bigint): bigint {
  const encoded = typeof value === "bigint" || typeof value === "number" || typeof value === "string"
    ? String(value)
    : "";
  return /^\d+$/.test(encoded) ? BigInt(encoded) : fallback;
}

type ConversationContextInput = Readonly<{ sessionId: string; threadId: string }>;

async function createV1TaskProjection(
  tx: Prisma.TransactionClient,
  task: TaskV2,
  context: ConversationContextInput,
): Promise<"created" | "existing" | "context_mismatch" | "thread_not_found"> {
  const thread = await tx.thread.findFirst({
    where: { id: context.threadId, sessionId: context.sessionId },
    select: { id: true },
  });
  if (!thread) return "thread_not_found";

  const existing = await tx.task.findUnique({
    where: { id: task.id },
    select: { sessionId: true, threadId: true },
  });
  if (existing) {
    return existing.sessionId === context.sessionId && existing.threadId === context.threadId
      ? "existing"
      : "context_mismatch";
  }

  const contract = task.contract;
  const allowedScope = v2PathScopeProjection(contract);
  const statusProjection = v2TaskStatusToV1(task.status);
  const v1Contract: TaskContractHashInput = {
    version: contract.version,
    objective: contract.mission,
    userOutcome: null,
    nonGoals: [],
    constraints: [...contract.constraints.security],
    assumptions: [],
    unknowns: [],
    allowedScope,
    changePolicy: { mayExpandScope: false, scopeExpansionRequiresUser: true },
  };
  await tx.task.create({
      data: {
        id: task.id,
        sessionId: context.sessionId,
        threadId: context.threadId,
        status: statusProjection.status,
        phase: statusProjection.phase,
        activeContractVersion: contract.version,
        riskClass: "normal",
        budgetJson: JSON.stringify({
          model_micros: contract.constraints.costMicros.toString(),
          compute_seconds: contract.constraints.timeoutSeconds,
          wall_clock_seconds: contract.constraints.timeoutSeconds,
          human_approvals: 20,
        }),
        scopeDigest: JSON.stringify(allowedScope),
        completedAt: statusProjection.completedAt,
        terminalReasonJson: statusProjection.completedAt === null
          ? null
          : JSON.stringify({ reason: `arp_v2_${task.status.toLowerCase()}` }),
      },
  });
  await tx.taskContractVersion.create({
      data: {
        task_id: task.id,
        version: contract.version,
        objective: contract.mission,
        userOutcome: null,
        nonGoalsJson: "[]",
        constraintsJson: JSON.stringify(contract.constraints.security),
        assumptionsJson: "[]",
        unknownsJson: "[]",
        allowedScopeJson: JSON.stringify(allowedScope),
        v2ProjectionJson: JSON.stringify(jsonSafe(contract)),
        changePolicyJson: JSON.stringify(v1Contract.changePolicy),
        contentHash: taskContractHash(v1Contract),
        createdBy: SERVER_PRINCIPAL,
      },
  });
  for (const criterion of contract.acceptance) {
    await tx.acceptanceCriterion.create({
        data: {
          taskId: task.id,
          contractVersion: contract.version,
          criterionId: criterion.claimId,
          statement: criterion.statement,
          verificationHint: criterion.evidenceRequirement,
          required: true,
          status: "pending",
        },
    });
  }
  return "created";
}

async function inspectV1TaskProjection(
  taskId: string,
  context: ConversationContextInput,
): Promise<"created" | "existing" | "context_mismatch" | "thread_not_found"> {
  const thread = await db.thread.findFirst({
    where: { id: context.threadId, sessionId: context.sessionId },
    select: { id: true },
  });
  if (!thread) return "thread_not_found";
  const existing = await db.task.findUnique({
    where: { id: taskId },
    select: { sessionId: true, threadId: true },
  });
  if (!existing) return "created";
  return existing.sessionId === context.sessionId && existing.threadId === context.threadId
    ? "existing"
    : "context_mismatch";
}

const taskProjectionService = new TaskProjectionService<Prisma.TransactionClient>({
  source: {
    readTask: async (taskId) => {
      const task = await db.task.findUnique({
        where: { id: taskId },
        select: {
          id: true,
          sessionId: true,
          threadId: true,
          status: true,
          activeContractVersion: true,
          budgetJson: true,
          createdAt: true,
          updatedAt: true,
          completedAt: true,
        },
      });
      return task as TaskProjectionTaskRow | null;
    },
    readContract: async (taskId, version) => {
      const contract = await db.taskContractVersion.findUnique({
        where: { task_id_version: { task_id: taskId, version } },
        include: { acceptanceCriteria: { orderBy: { criterionId: "asc" } } },
      });
      return contract as TaskProjectionContractRow | null;
    },
    listTaskIds: async () => (await db.task.findMany({ select: { id: true }, orderBy: { id: "asc" } })).map((task) => task.id),
  },
  store: {
    get: (taskId) => arpV2.tasks.get(taskId),
    set: (taskId, task) => { arpV2.tasks.set(taskId, task); },
    publish: async (event) => emitV2({
      eventType: event.eventType,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      snapshot: event.snapshot,
      correlationId: event.correlationId,
    }),
  },
  bridge: {
    createV1: (transaction, task, context) => createV1TaskProjection(transaction, task, context),
    inspectV1: (taskId, context) => inspectV1TaskProjection(taskId, context),
    projectStatus: (transaction, taskId, status) => projectV2StatusIntoV1(transaction, taskId, status),
    projectContract: (transaction, taskId, contract) => projectV2ContractIntoV1(transaction, taskId, contract),
  },
});

async function synchronizeV1TaskProjection(
  taskId: string,
  eventType = "task.v1_projection_recovered",
): Promise<{ readonly task: TaskV2; readonly changed: boolean }> {
  return taskProjectionService.synchronize(taskId, eventType);
}

async function reconcileV1TaskProjections(): Promise<number> {
  return taskProjectionService.reconcile();
}

const effectSettlementService = new EffectSettlementService<Prisma.TransactionClient>({
  appendEvent: async (event, mutation): Promise<void> => {
    await emit({
      eventType: event.eventType,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      correlationId: event.correlationId,
      payload: event.payload,
      artifactRefs: event.artifactRefs === undefined ? undefined : [...event.artifactRefs],
    }, mutation);
  },
  transaction: (tx) => ({
    authorize: async (input: EffectAuthorizationInput) => {
      await tx.policyDecision.create({
        data: {
          id: input.policyDecisionId,
          toolCallId: input.toolCallId,
          effectType: input.effectType,
          normalizedInputArtifact: input.argumentsArtifactUri,
          decision: "allow_with_constraints",
          ruleIdsJson: JSON.stringify(["task-contract.scope", "kernel.secure-local-default"]),
          constraintsJson: JSON.stringify({ workspace_id: input.workspaceId, resource_uri: input.resourceUri }),
          policyVersion: "secure-local-default:v1",
          explanation: "Task contract scope admitted; the kernel remains authoritative at dispatch.",
        },
      });
      await tx.sideEffect.create({
        data: {
          id: input.sideEffectId,
          toolCallId: input.toolCallId,
          effectType: input.effectType,
          resourceUri: input.resourceUri,
          idempotencyKey: input.idempotencyKey,
          state: "AUTHORIZED",
          reversibility: input.reversibility,
          requestArtifact: input.argumentsArtifactUri,
        },
      });
      await tx.toolCall.update({
        where: { id: input.toolCallId },
        data: { state: "AUTHORIZED", policyDecisionId: input.policyDecisionId },
      });
    },
    start: async (input: EffectAuthorizationInput) => {
      const startedAt = new Date();
      await tx.toolCall.update({ where: { id: input.toolCallId }, data: { state: "STARTED", startedAt } });
      await tx.sideEffect.update({ where: { id: input.sideEffectId }, data: { state: "STARTED", startedAt } });
    },
    markUnknown: async (input: EffectUnknownInput) => {
      await tx.toolCall.update({
        where: { id: input.toolCallId },
        data: {
          state: "UNKNOWN",
          settledAt: new Date(),
          resultStatus: "unknown",
          errorJson: JSON.stringify({ message: input.error, reconciliation_required: true }),
        },
      });
      await tx.sideEffect.update({
        where: { id: input.sideEffectId },
        data: { state: "MANUAL_REVIEW", reconciliationJson: JSON.stringify({ message: input.error, reconciliation_required: true }) },
      });
    },
    settle: async (input: EffectSettlementInput) => {
      const latestEpisode = await tx.episode.findFirst({
        where: { turnId: input.turnId },
        orderBy: { sequence: "desc" },
        select: { sequence: true },
      });
      const settledAt = new Date();
      await tx.toolCall.update({
        where: { id: input.toolCallId },
        data: {
          state: input.toolState,
          resultArtifact: input.resultArtifactUri,
          resultStatus: input.resultStatus,
          settledAt,
          errorJson: input.errorJson,
        },
      });
      if (input.sideEffectId !== null) {
        await tx.sideEffect.updateMany({
          where: { toolCallId: input.toolCallId, id: input.sideEffectId },
          data: { state: "SETTLED", evidenceArtifact: input.resultArtifactUri, settledAt },
        });
      }
      await tx.episode.createMany({
        data: [
          {
            id: uuid(),
            turnId: input.turnId,
            sequence: (latestEpisode?.sequence ?? 0) + 1,
            kind: "tool_call",
            modelVisible: true,
            contentArtifact: input.callTranscriptArtifactUri,
            toolCallId: input.toolCallId,
            sourceVersionsJson: JSON.stringify({ providerAttemptId: input.providerAttemptId }),
          },
          {
            id: uuid(),
            turnId: input.turnId,
            sequence: (latestEpisode?.sequence ?? 0) + 2,
            kind: "tool_result",
            modelVisible: true,
            contentArtifact: input.resultTranscriptArtifactUri,
            toolCallId: input.toolCallId,
            sourceVersionsJson: JSON.stringify({ result: input.resultTranscriptHash ?? input.resultTranscriptArtifactUri }),
          },
        ],
      });
      await tx.turn.update({ where: { id: input.turnId }, data: { state: "TOOL_SETTLEMENT" } });
    },
  }),
  mutate: mutateAgentState,
});

const turnCoordinator = new TurnCoordinator<Prisma.TransactionClient>({
  readTask: async (taskId) => {
    const task = await db.task.findUnique({ where: { id: taskId }, select: { id: true, threadId: true, status: true } });
    return task as TurnTaskSnapshot | null;
  },
  readTurn: async (turnId) => {
    const turn = await db.turn.findUnique({
      where: { id: turnId },
      select: {
        id: true,
        threadId: true,
        taskId: true,
        sequence: true,
        state: true,
        initiatingActor: true,
        startedAt: true,
        completedAt: true,
      },
    });
    return turn as TurnRow | null;
  },
  appendEvent: async (event, mutation): Promise<void> => {
    await emit({
      eventType: event.eventType,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      correlationId: event.correlationId,
      payload: event.payload,
      artifactRefs: event.artifactRefs === undefined ? undefined : [...event.artifactRefs],
    }, mutation);
  },
  transaction: (tx) => ({
    findTask: async (taskId) => {
      const task = await tx.task.findUnique({ where: { id: taskId }, select: { id: true, threadId: true, status: true } });
      return task as TurnTaskSnapshot | null;
    },
    findActiveTurn: async (taskId, activeStates) => tx.turn.findFirst({
      where: { taskId, state: { in: [...activeStates] } },
      orderBy: { sequence: "desc" },
      select: { id: true },
    }),
    findLatestSequence: async (threadId) => (await tx.turn.findFirst({
      where: { threadId },
      orderBy: { sequence: "desc" },
      select: { sequence: true },
    }))?.sequence ?? null,
    resumeTask: async (taskId, expectedStatus) => {
      const resumed = await tx.task.updateMany({ where: { id: taskId, status: expectedStatus }, data: { status: "ACTIVE" } });
      if (resumed.count !== 1) throw new TurnAdmissionError("state_changed");
    },
    createTurn: async (input) => {
      await tx.turn.create({
        data: {
          id: input.turnId,
          threadId: input.threadId,
          taskId: input.taskId,
          sequence: input.sequence,
          state: "PENDING",
          initiatingActor: input.initiatingActor,
          initiatingInputArtifact: input.inputArtifactUri,
        },
      });
    },
    createUserEpisode: async (input) => {
      await tx.episode.create({
        data: {
          id: uuid(),
          turnId: input.turnId,
          sequence: 1,
          kind: "user_message",
          modelVisible: true,
          contentArtifact: input.inputArtifactUri,
          sourceVersionsJson: JSON.stringify({ input: input.inputArtifactHash }),
        },
      });
    },
    interruptTurn: async (turnId, reason) => {
      const update = await tx.turn.updateMany({
        where: { id: turnId, state: { in: [...V1_ACTIVE_TURN_STATES] } },
        data: {
          state: "INTERRUPTED",
          completedAt: new Date(),
          terminalErrorJson: JSON.stringify({ reason }),
        },
      });
      if (update.count !== 1) throw new Error(`turn ${turnId} changed before atomic interruption`);
    },
  }),
  mutate: mutateAgentState,
  projectTask: async (taskId, eventType): Promise<void> => { await synchronizeV1TaskProjection(taskId, eventType); },
  activeTurnStates: V1_ACTIVE_TURN_STATES,
});

/** Serialize a stored event into an ARP v2 envelope for SSE consumers. */
function storedEventToEnvelopeV2(ev: StoredEvent): Record<string, unknown> {
  return {
    eventId: ev.eventId,
    eventType: ev.eventType,
    schemaVersion: 2,
    aggregateType: ev.aggregateType,
    aggregateId: ev.aggregateId,
    aggregateSequence: ev.aggregateSequence,
    occurredAt: ev.occurredAt instanceof Date ? ev.occurredAt.toISOString() : String(ev.occurredAt),
    actor: safeParse(ev.actorJson, { kind: "system", id: SERVER_PRINCIPAL }),
    correlationId: ev.correlationId,
    causationId: ev.causationId,
    idempotencyKey: ev.idempotencyKey,
    payload: safeParse(ev.payloadJson, {}),
    artifactRefs: safeParse(ev.artifactRefsJson, []),
    traceId: ev.traceId,
  };
}

/** Static registry served at GET /v2/system/schema-registry (mirrors tools/codegen/v2-schemas.ts). */
const V2_SCHEMA_REGISTRY_ENTRIES: ReadonlyArray<readonly [string, z.ZodType]> = [
  ["mission", missionSchema],
  ["task-contract-v2", taskContractV2Schema],
  ["task-v2", taskV2Schema],
  ["workflow-node", workflowNodeSchema],
  ["guarded-edge", guardedEdgeSchema],
  ["workflow", workflowSchema],
  ["node-run", nodeRunSchema],
  ["claim", claimSchema],
  ["evidence", evidenceSchema],
  ["authorization-instance", authorizationInstanceSchema],
  ["effect-record", effectRecordSchema],
  ["question", questionSchema],
  ["decision", decisionSchema],
  ["risk", riskSchema],
  ["worker-lease", workerLeaseSchema],
  ["task-attempt", taskAttemptSchema],
  ["budget-consumption", budgetConsumptionSchema],
  ["organization", organizationSchema],
  ["department", departmentSchema],
  ["operator-agent", operatorAgentSchema],
  ["agent-room", agentRoomSchema],
  ["capability-directory-entry", capabilityDirectoryEntrySchema],
  ["material-question", materialQuestionSchema],
  ["attention-assessment", attentionAssessmentSchema],
  ["structured-intervention", structuredInterventionSchema],
  ["causal-step", causalStepSchema],
  ["causal-replay-trace", causalReplayTraceSchema],
  ["counterfactual-experiment", counterfactualExperimentSchema],
  ["mobile-supervision-session", mobileSupervisionSessionSchema],
  ["acp-context-injection", acpContextInjectionSchema],
  ["ui-observation-input", uiObservationInputSchema],
  ["ui-observation", uiObservationSchema],
  ["computer-use-action", computerUseActionSchema],
  ["semantic-target-verification", semanticTargetVerificationSchema],
  ["ui-evidence-record", uiEvidenceRecordSchema],
  ["browser-desktop-pool", browserDesktopPoolSchema],
  ["pool-lease", poolLeaseSchema],
  ["human-takeover-session", humanTakeoverSessionSchema],
  ["data-flow-policy", dataFlowPolicySchema],
  ["data-transfer-audit", dataTransferAuditSchema],
  ["data-flow-check-result", dataFlowCheckResultSchema],
  ["external-connector-spec", externalConnectorSpecSchema],
  ["connector-call-intent", connectorCallIntentSchema],
  ["connector-execution-observation", connectorExecutionObservationSchema],
  ["connector-call-result", connectorCallResultSchema],
  ["ambiguous-submit-reconciliation", ambiguousSubmitReconciliationSchema],
  ["incident-profile-spec", incidentProfileSpecSchema],
  ["incident-execution-record", incidentExecutionRecordSchema],
  ["research-profile-spec", researchProfileSpecSchema],
  ["research-provenance-record", researchProvenanceRecordSchema],
];

// ────────────────────────── Route handlers ─────────────────────────────────

type Handler = (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => Promise<void>;

interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: Handler;
}

function route(method: string, path: string, handler: Handler): Route {
  const paramNames: string[] = [];
  const pattern = path.replace(/:([^/]+)/g, (_, n) => { paramNames.push(n); return "([^/]+)"; });
  return { method, pattern: new RegExp(`^${pattern}$`), paramNames, handler };
}

const checkpointRequestSchema = z.object({
  session_id: z.string().uuid(),
  thread_id: z.string().uuid(),
  task_id: z.string().uuid(),
}).strict();

const checkpointSequenceStateSchema = z.object({
  task: z.number().int().nonnegative(),
  turn: z.number().int().nonnegative(),
  sourceTurnId: z.string().uuid(),
  episodeRange: z.object({
    from: z.number().int().nonnegative(),
    to: z.number().int().nonnegative(),
  }).strict().refine((range) => range.from <= range.to, {
    message: "episode range must be ordered",
  }),
}).strict();

const routes: Route[] = [
  // ────────────────────────── /system ────────────────────────────────────
  route("GET", "/v1/system/health", async (_req, res) => {
    const kernelHealth = await requireKernelUds().info.Health({});
    sendJson(res, 200, {
      status: kernelHealth.state === "healthy" || kernelHealth.state === "ok" ? "ok" : "degraded",
      version: CONTROL_BUILD_VERSION,
      build_commit: CONTROL_BUILD_COMMIT,
      instance_id: CONTROL_INSTANCE_NONCE,
      uptime_seconds: process.uptime(),
      ready: kernelHealth.state === "healthy" || kernelHealth.state === "ok",
      kernel: kernelHealth,
    });
  }),
  route("POST", "/v1/system/initialize", async (req, res) => {
    // SPEC §30.3 — parse ClientHello, echo the intersection of supported
    // capabilities back as ServerHello.
    const body = await jsonBody(req) as {
      client?: { name?: string; version?: string } | undefined;
      protocol?: { major?: number; minor?: number } | undefined;
      capabilities?: string[] | undefined;
      experimental?: string[] | undefined;
    };
    const clientCaps = body.capabilities ?? [];
    const experimental = body.experimental ?? [];
    const supported = new Set<string>(SUPPORTED_CAPABILITIES);
    const intersection =
      clientCaps.length === 0
        ? [...SUPPORTED_CAPABILITIES]
        : clientCaps.filter((c) => supported.has(c));
    sendJson(res, 200, {
      server: {
        version: CONTROL_BUILD_VERSION,
        build_commit: CONTROL_BUILD_COMMIT,
        instance_id: CONTROL_INSTANCE_NONCE,
      },
      protocol: { major: 1, minor: 0 },
      client: body.client ?? null,
      capabilities: {
        supported: [...SUPPORTED_CAPABILITIES],
        intersection,
        experimental,
      },
      limits: { max_request_bytes: 1_048_576, max_sse_backlog: 10_000 },
    });
  }),

  // ────────────────────────── /workspaces ────────────────────────────────
  route("POST", "/v1/workspaces/open", async (req, res) => {
    const body = await jsonBody(req) as {
      root_uri: string; kind?: string; trust?: string; policy_profile_id?: string;
    };
    const kind = body.kind ?? "local_directory";
    if (kind !== "local_directory" && kind !== "local_git") {
      return sendError(res, 422, "WORKSPACE_KIND_UNSUPPORTED", "the standalone harness currently opens local directory or Git workspaces only", "validation");
    }
    const trust = body.trust ?? "untrusted";
    if (trust !== "trusted" && trust !== "untrusted" && trust !== "restricted") {
      return sendError(res, 422, "WORKSPACE_TRUST_INVALID", "workspace trust must be trusted, untrusted, or restricted", "validation");
    }
    let requestedPath: string;
    let normalizedRootUri: string;
    try {
      const rootUrl = new URL(body.root_uri);
      if (
        rootUrl.protocol !== "file:"
        || rootUrl.username.length > 0
        || rootUrl.password.length > 0
        || rootUrl.search.length > 0
        || rootUrl.hash.length > 0
      ) {
        throw new Error("root_uri must be a plain file URL");
      }
      requestedPath = fileURLToPath(rootUrl);
      if (!isAbsolute(requestedPath)) throw new Error("root_uri must resolve to an absolute path");
      normalizedRootUri = pathToFileURL(requestedPath).href;
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : "invalid file URL";
      return sendError(res, 422, "WORKSPACE_ROOT_INVALID", detail, "validation");
    }

    if (!kernelUds) {
      return sendError(
        res,
        503,
        "WORKSPACE_KERNEL_UNAVAILABLE",
        "opening a workspace requires the standalone kernel workspace coordinator",
        "external_dependency",
      );
    }
    let resolvedRoot: Awaited<ReturnType<KernelUdsClients["workspaces"]["ResolveRoot"]>>;
    try {
      resolvedRoot = await kernelUds.workspaces.ResolveRoot({
        context: await kernelBrokerContext(),
        rootUri: normalizedRootUri,
        candidateRoot: requestedPath,
      });
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : "kernel rejected the workspace root";
      return sendError(res, 422, "WORKSPACE_ROOT_REJECTED", detail, "validation");
    }
    const existingIdentity = await db.workspace.findFirst({
      where: {
        OR: [
          { rootUri: normalizedRootUri },
          { canonicalRoot: resolvedRoot.canonicalRoot },
        ],
      },
      orderBy: { createdAt: "asc" },
    });
    if (existingIdentity && (existingIdentity.trust !== trust || existingIdentity.kind !== kind)) {
      return sendError(
        res,
        409,
        "WORKSPACE_IDENTITY_CONFLICT",
        "the existing workspace identity has different kind or trust",
        "conflict",
      );
    }
    let registered: Awaited<ReturnType<KernelUdsClients["workspaces"]["Register"]>>;
    try {
      registered = await kernelUds.workspaces.Register({
        context: await kernelBrokerContext(),
        rootUri: normalizedRootUri,
        canonicalRoot: resolvedRoot.canonicalRoot,
        trust,
        remoteEnvironmentJson: "",
        kind,
        requestedWorkspaceId: existingIdentity?.id ?? "",
      });
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : "kernel rejected the workspace root";
      return sendError(res, 422, "WORKSPACE_ROOT_REJECTED", detail, "validation");
    }
    const canonicalExisting = await db.workspace.findUnique({
      where: { canonicalRoot: registered.canonicalRoot },
    });
    if (canonicalExisting && (canonicalExisting.trust !== registered.trust || canonicalExisting.kind !== kind)) {
      return sendError(
        res,
        409,
        "WORKSPACE_IDENTITY_CONFLICT",
        "the canonical workspace root already exists with different kind or trust",
        "conflict",
      );
    }
    if (canonicalExisting && canonicalExisting.id !== registered.id) {
      try {
        registered = await kernelUds.workspaces.Register({
          context: await kernelBrokerContext(),
          rootUri: registered.rootUri,
          canonicalRoot: registered.canonicalRoot,
          trust: registered.trust,
          remoteEnvironmentJson: "",
          kind,
          requestedWorkspaceId: canonicalExisting.id,
        });
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : "kernel could not preserve the existing workspace identity";
        return sendError(res, 409, "WORKSPACE_IDENTITY_CONFLICT", detail, "conflict");
      }
      if (registered.id !== canonicalExisting.id) {
        throw new Error("kernel did not preserve the authoritative workspace identity");
      }
    }
    const workspaceId = canonicalExisting?.id ?? registered.id;
    await emit({
      eventType: canonicalExisting ? "workspace.reopened" : "workspace.opened",
      aggregateType: "workspace",
      aggregateId: workspaceId,
      payload: { kind, trust: registered.trust },
    }, async (tx) => {
      if (canonicalExisting) {
        await tx.workspace.update({
          where: { id: canonicalExisting.id },
          data: { lastOpenedAt: new Date() },
        });
        return;
      }
      await tx.workspace.create({
        data: {
          id: registered.id,
          kind,
          rootUri: registered.rootUri,
          canonicalRoot: registered.canonicalRoot,
          trust: registered.trust,
          policyProfileId: body.policy_profile_id ?? "secure-local-default",
        },
      });
    });
    const ws = await db.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
    sendJson(res, 201, {
      id: ws.id, kind: ws.kind, root_uri: ws.rootUri, canonical_root: ws.canonicalRoot,
      trust: ws.trust, policy_profile_id: ws.policyProfileId,
      created_at: ws.createdAt.toISOString(), last_opened_at: ws.lastOpenedAt.toISOString(),
    });
  }),
  route("GET", "/v1/workspaces/:id", async (_req, res, params) => {
    const ws = await db.workspace.findUnique({ where: { id: String(params.id) } });
    if (!ws) return sendError(res, 404, "WORKSPACE_NOT_FOUND", "workspace not found", "not_found");
    sendJson(res, 200, {
      id: ws.id, kind: ws.kind, root_uri: ws.rootUri, canonical_root: ws.canonicalRoot,
      trust: ws.trust, policy_profile_id: ws.policyProfileId,
      created_at: ws.createdAt.toISOString(), last_opened_at: ws.lastOpenedAt.toISOString(),
    });
  }),

  // ────────────────────────── /sessions ──────────────────────────────────
  route("POST", "/v1/sessions", async (req, res) => {
    const body = await jsonBody(req) as {
      workspace_id: string; title: string;
      default_model_profile?: string; default_permission_profile?: string;
    };
    // A missing or unknown workspace is a caller error, not an internal one.
    // Without this the insert reached Prisma and surfaced as a retryable 500,
    // which is doubly wrong: retrying an unknown workspace never succeeds.
    if (typeof body.workspace_id !== "string" || body.workspace_id.length === 0) {
      return sendError(res, 422, "WORKSPACE_ID_REQUIRED", "workspace_id is required to create a session", "validation");
    }
    if (typeof body.title !== "string" || body.title.length === 0) {
      return sendError(res, 422, "SESSION_TITLE_REQUIRED", "title is required to create a session", "validation");
    }
    if (await db.workspace.findUnique({ where: { id: body.workspace_id }, select: { id: true } }) === null) {
      return sendError(res, 404, "WORKSPACE_NOT_FOUND", "workspace not found; open it before creating a session", "not_found");
    }
    const id = uuid();
    const rootThreadId = uuid();
    await emit({
      eventType: "session.created",
      aggregateType: "session",
      aggregateId: id,
      payload: {
        title: body.title,
        workspace_id: body.workspace_id,
        root_thread_id: rootThreadId,
      },
    }, async (tx) => {
      await tx.session.create({
        data: {
          id,
          workspaceId: body.workspace_id,
          ownerPrincipal: SERVER_PRINCIPAL,
          title: body.title,
          status: "active",
          defaultModelProfile: body.default_model_profile ?? "implementer",
          defaultPermissionProfile: body.default_permission_profile ?? "secure-local-default",
        },
      });
      await tx.thread.create({
        data: { id: rootThreadId, sessionId: id, status: "active" },
      });
      await tx.session.update({
        where: { id },
        data: { activeThreadId: rootThreadId },
      });
    });
    const [session, thread] = await Promise.all([
      db.session.findUniqueOrThrow({ where: { id } }),
      db.thread.findUniqueOrThrow({ where: { id: rootThreadId } }),
    ]);
    sendJson(res, 201, {
      id: session.id, workspace_id: session.workspaceId, owner_principal: session.ownerPrincipal,
      title: session.title, status: session.status,
      default_model_profile: session.defaultModelProfile,
      default_permission_profile: session.defaultPermissionProfile,
      active_thread_id: thread.id,
      created_at: session.createdAt.toISOString(), updated_at: session.updatedAt.toISOString(),
    });
  }),
  route("GET", "/v1/sessions/:id", async (_req, res, params) => {
    const s = await db.session.findUnique({ where: { id: String(params.id) } });
    if (!s) return sendError(res, 404, "SESSION_NOT_FOUND", "session not found", "not_found");
    sendJson(res, 200, {
      id: s.id, workspace_id: s.workspaceId, owner_principal: s.ownerPrincipal,
      title: s.title, status: s.status,
      default_model_profile: s.defaultModelProfile,
      default_permission_profile: s.defaultPermissionProfile,
      active_thread_id: s.activeThreadId,
      created_at: s.createdAt.toISOString(), updated_at: s.updatedAt.toISOString(),
    });
  }),
  route("GET", "/v1/sessions", async (req, res) => {
    const page = parsePageRequest(req, res);
    if (!page) return;
    const where = { status: { not: "deleted" } } as const;
    const [sessionRows, total] = await Promise.all([
      db.session.findMany({
        where,
        orderBy: { id: "asc" },
        ...(page.cursor ? { cursor: { id: page.cursor }, skip: 1 } : {}),
        take: page.limit + 1,
      }),
      db.session.count({ where }),
    ]);
    const sessions = sessionRows.slice(0, page.limit);
    sendJson(res, 200, {
      sessions: sessions.map((s) => ({
        id: s.id, workspace_id: s.workspaceId, owner_principal: s.ownerPrincipal,
        title: s.title, status: s.status,
        default_model_profile: s.defaultModelProfile,
        default_permission_profile: s.defaultPermissionProfile,
        active_thread_id: s.activeThreadId,
        created_at: s.createdAt.toISOString(), updated_at: s.updatedAt.toISOString(),
      })),
      total,
      next_cursor: nextPageCursor(sessionRows, page.limit),
    });
  }),
  // SPEC §32.2 — pause a session (liveness preserved; turns blocked).
  route("POST", "/v1/sessions/:id/pause", async (_req, res, params) => {
    const s = await db.session.findUnique({ where: { id: String(params.id) } });
    if (!s) return sendError(res, 404, "SESSION_NOT_FOUND", "session not found", "not_found");
    await emit({
      eventType: "session.paused",
      aggregateType: "session",
      aggregateId: s.id,
      payload: { previous_status: s.status, new_status: "paused" },
    }, async (tx) => {
      const changed = await tx.session.updateMany({
        where: { id: s.id, status: s.status },
        data: { status: "paused" },
      });
      if (changed.count !== 1) throw new Error(`session ${s.id} changed before pause`);
    });
    const updated = await db.session.findUniqueOrThrow({ where: { id: s.id } });
    sendJson(res, 200, {
      id: updated.id, workspace_id: updated.workspaceId, owner_principal: updated.ownerPrincipal,
      title: updated.title, status: updated.status,
      default_model_profile: updated.defaultModelProfile,
      default_permission_profile: updated.defaultPermissionProfile,
      active_thread_id: updated.activeThreadId,
      created_at: updated.createdAt.toISOString(), updated_at: updated.updatedAt.toISOString(),
    });
  }),
  route("POST", "/v1/sessions/:id/resume", async (_req, res, params) => {
    const s = await db.session.findUnique({ where: { id: String(params.id) } });
    if (!s) return sendError(res, 404, "SESSION_NOT_FOUND", "session not found", "not_found");
    await emit({
      eventType: "session.resumed",
      aggregateType: "session",
      aggregateId: s.id,
      payload: { previous_status: s.status, new_status: "active" },
    }, async (tx) => {
      const changed = await tx.session.updateMany({
        where: { id: s.id, status: s.status },
        data: { status: "active" },
      });
      if (changed.count !== 1) throw new Error(`session ${s.id} changed before resume`);
    });
    const updated = await db.session.findUniqueOrThrow({ where: { id: s.id } });
    sendJson(res, 200, {
      id: updated.id, workspace_id: updated.workspaceId, owner_principal: updated.ownerPrincipal,
      title: updated.title, status: updated.status,
      default_model_profile: updated.defaultModelProfile,
      default_permission_profile: updated.defaultPermissionProfile,
      active_thread_id: updated.activeThreadId,
      created_at: updated.createdAt.toISOString(), updated_at: updated.updatedAt.toISOString(),
    });
  }),

  // ────────────────────────── /threads ───────────────────────────────────
  route("POST", "/v1/threads", async (req, res) => {
    const body = await jsonBody(req) as { session_id: string; parent_thread_id?: string | null };
    const parentThreadId = body.parent_thread_id ?? null;
    if (parentThreadId !== null) {
      const parent = await db.thread.findUnique({ where: { id: parentThreadId } });
      if (parent === null) return sendError(res, 404, "THREAD_NOT_FOUND", "parent thread not found", "not_found");
      if (parent.sessionId !== body.session_id) {
        return sendError(res, 409, "THREAD_SESSION_MISMATCH", "parent thread belongs to a different session", "conflict");
      }
    }
    const id = uuid();
    await emit({
      eventType: "thread.created",
      aggregateType: "thread",
      aggregateId: id,
      correlationId: body.session_id,
      payload: { session_id: body.session_id, parent_thread_id: parentThreadId },
    }, async (tx) => {
      await tx.thread.create({
        data: {
          id,
          sessionId: body.session_id,
          parentThreadId,
          status: "active",
        },
      });
    });
    const t = await db.thread.findUniqueOrThrow({ where: { id } });
    sendJson(res, 201, { id: t.id, session_id: t.sessionId, created_at: t.createdAt.toISOString() });
  }),
  route("GET", "/v1/sessions/:id/threads", async (_req, res, params) => {
    const threads = await db.thread.findMany({
      where: { sessionId: String(params.id), status: { not: "deleted" } },
      orderBy: { createdAt: "asc" },
    });
    sendJson(res, 200, { threads });
  }),
  // SPEC §32.2 — fork a thread from an existing one (optionally from a
  // specific turn). The child thread shares the session and records its
  // parent + fork point.
  route("POST", "/v1/threads/:id/fork", async (req, res, params) => {
    const body = await jsonBody(req) as { from_turn_id?: string | null };
    const parent = await db.thread.findUnique({ where: { id: String(params.id) } });
    if (!parent) return sendError(res, 404, "THREAD_NOT_FOUND", "thread not found", "not_found");
    const fromTurn = body.from_turn_id ?? parent.headTurnId ?? null;
    if (fromTurn !== null) {
      const turn = await db.turn.findUnique({ where: { id: fromTurn }, select: { threadId: true } });
      if (turn === null) return sendError(res, 404, "TURN_NOT_FOUND", "fork turn not found", "not_found");
      if (turn.threadId !== parent.id) {
        return sendError(res, 409, "FORK_TURN_MISMATCH", "fork turn does not belong to the parent thread", "conflict");
      }
    }
    const childId = uuid();
    await emit({
      eventType: "thread.forked",
      aggregateType: "thread",
      aggregateId: childId,
      correlationId: parent.id,
      payload: { parent_thread_id: parent.id, from_turn_id: fromTurn },
    }, async (tx) => {
      await tx.thread.create({
        data: {
          id: childId,
          sessionId: parent.sessionId,
          parentThreadId: parent.id,
          forkedFromTurnId: fromTurn,
          status: "active",
        },
      });
    });
    const child = await db.thread.findUniqueOrThrow({ where: { id: childId } });
    sendJson(res, 201, {
      id: child.id, session_id: child.sessionId, parent_thread_id: child.parentThreadId,
      forked_from_turn_id: child.forkedFromTurnId, status: child.status,
      created_at: child.createdAt.toISOString(),
    });
  }),

  // ────────────────────────── /tasks ─────────────────────────────────────
  route("POST", "/v1/tasks", async (req, res) => {
    const body = await jsonBody(req) as {
      session_id: string; thread_id: string; objective: string;
      non_goals?: string[];
      acceptance_criteria?: Array<{ id: string; statement: string; verification_hint?: string | null; required?: boolean }>;
      allowed_scope?: { read_paths?: string[]; write_paths?: string[]; external_systems?: string[] };
      risk_class?: string;
    };
    if (typeof body.objective !== "string" || body.objective.trim().length === 0) {
      return sendError(res, 400, "TASK_OBJECTIVE_REQUIRED", "task objective must be a non-empty string", "validation");
    }
    const parsedCriteria = z.array(z.object({
      id: z.string().min(1).max(128),
      statement: z.string().min(1).max(4_096),
      verification_hint: z.string().max(4_096).nullable().optional(),
      required: z.boolean().optional(),
    }).strict()).max(100).safeParse(body.acceptance_criteria ?? []);
    if (!parsedCriteria.success) {
      return sendError(
        res,
        400,
        "TASK_ACCEPTANCE_CRITERIA_INVALID",
        "acceptance criteria did not satisfy the task contract schema",
        "validation",
        { issues: parsedCriteria.error.issues },
      );
    }
    const acceptanceCriteria = parsedCriteria.data.length > 0
      ? parsedCriteria.data
      : [{
          id: "requested-outcome",
          statement: `Requested outcome is implemented and supported by verification evidence: ${body.objective.trim()}`,
          verification_hint: null,
          required: true,
        }];
    if (new Set(acceptanceCriteria.map((criterion) => criterion.id)).size !== acceptanceCriteria.length) {
      return sendError(res, 400, "TASK_ACCEPTANCE_CRITERIA_DUPLICATE", "acceptance criterion ids must be unique", "validation");
    }
    if (!acceptanceCriteria.some((criterion) => criterion.required ?? true)) {
      return sendError(
        res,
        400,
        "TASK_REQUIRED_ACCEPTANCE_CRITERION_MISSING",
        "at least one acceptance criterion must be required",
        "validation",
      );
    }
    const id = uuid();
    const scope = body.allowed_scope ?? {};
    const normalizedScope = v1AllowedScopeProjection(scope);
    // Initial contract version 1.
    const initialContract: TaskContractHashInput = {
      version: 1,
      objective: body.objective,
      userOutcome: null,
      nonGoals: body.non_goals ?? [],
      constraints: [],
      assumptions: [],
      unknowns: [],
      allowedScope: normalizedScope,
      changePolicy: { mayExpandScope: false, scopeExpansionRequiresUser: true },
    };
    const initialContractHash = taskContractHash(initialContract);
    try {
      await emit({
        eventType: "task.created",
        aggregateType: "task", aggregateId: id,
        payload: { objective: body.objective, session_id: body.session_id, thread_id: body.thread_id },
      }, async (tx) => {
        const thread = await tx.thread.findUnique({
          where: { id: body.thread_id },
          select: { sessionId: true },
        });
        if (thread === null) throw new TaskLineageAdmissionError("thread_not_found");
        if (thread.sessionId !== body.session_id) {
          throw new TaskLineageAdmissionError("session_mismatch", thread.sessionId);
        }
        await tx.task.create({
          data: {
            id, sessionId: body.session_id, threadId: body.thread_id,
            status: "DRAFT", phase: "INTAKE", riskClass: body.risk_class ?? "normal",
            budgetJson: JSON.stringify({ model_micros: 5_000_000, compute_seconds: 600, wall_clock_seconds: 3600, human_approvals: 20 }),
            scopeDigest: JSON.stringify(normalizedScope),
          },
        });
        await tx.taskContractVersion.create({
          data: {
            task_id: id, version: 1,
            objective: body.objective, userOutcome: null,
            nonGoalsJson: JSON.stringify(body.non_goals ?? []),
            constraintsJson: "[]",
            assumptionsJson: "[]",
            unknownsJson: "[]",
            allowedScopeJson: JSON.stringify(normalizedScope),
            changePolicyJson: JSON.stringify({ mayExpandScope: false, scopeExpansionRequiresUser: true }),
            contentHash: initialContractHash,
            createdBy: SERVER_PRINCIPAL,
          },
        });
        for (const c of acceptanceCriteria) {
          await tx.acceptanceCriterion.create({
            data: {
              taskId: id, contractVersion: 1, criterionId: c.id,
              statement: c.statement, verificationHint: c.verification_hint ?? null,
              required: c.required ?? true, status: "pending",
            },
          });
        }
        const ledgerRows = scopeLedgerRows({
          taskId: id,
          contractVersion: 1,
          scope: normalizedScope,
          source: "user_contract",
          reason: "initial task contract scope",
        });
        if (ledgerRows.length > 0) {
          await tx.scopeLedgerEntry.createMany({ data: ledgerRows });
        }
      });
    } catch (error: unknown) {
      if (error instanceof TaskLineageAdmissionError) {
        if (error.reason === "thread_not_found") {
          return sendError(res, 404, "THREAD_NOT_FOUND", "thread not found", "not_found");
        }
        return sendError(
          res,
          409,
          "TASK_SESSION_THREAD_MISMATCH",
          "thread does not belong to the supplied session",
          "conflict",
          {
            supplied_session_id: body.session_id,
            thread_id: body.thread_id,
            actual_session_id: error.actualSessionId,
          },
        );
      }
      throw error;
    }
    const t = await db.task.findUniqueOrThrow({ where: { id } });
    await synchronizeV1TaskProjection(id, "task.created");
    sendJson(res, 201, {
      id: t.id, session_id: t.sessionId, thread_id: t.threadId,
      status: t.status, phase: t.phase,
      active_contract_version: t.activeContractVersion,
      risk_class: t.riskClass,
      created_at: t.createdAt.toISOString(), updated_at: t.updatedAt.toISOString(),
      completed_at: null,
      terminal_reason: null,
      contract: {
        version: 1,
        content_hash: initialContractHash,
        objective: body.objective,
        non_goals: body.non_goals ?? [],
        allowed_scope: {
          read_paths: normalizedScope.read_paths,
          write_paths: normalizedScope.write_paths,
          external_systems: normalizedScope.external_systems,
        },
      },
    });
  }),
  route("POST", "/v1/tasks/:id/start", async (_req, res, params) => {
    const taskId = String(params.id);
    const current = await db.task.findUnique({ where: { id: taskId } });
    if (!current) return sendError(res, 404, "TASK_NOT_FOUND", "task not found", "not_found");
    if (current.status !== "DRAFT") {
      return sendError(
        res,
        409,
        "TASK_START_STATE_CONFLICT",
        `task cannot start from ${current.status}`,
        "conflict",
        { task_id: taskId, status: current.status, allowed_status: "DRAFT" },
      );
    }
    const requiredCriteria = await db.acceptanceCriterion.count({
      where: {
        taskId,
        contractVersion: current.activeContractVersion,
        required: true,
      },
    });
    if (requiredCriteria === 0) {
      return sendError(
        res,
        409,
        "TASK_REQUIRED_ACCEPTANCE_CRITERION_MISSING",
        "task cannot start without at least one required acceptance criterion",
        "validation",
        { task_id: taskId, contract_version: current.activeContractVersion },
      );
    }
    const activatedEvent = await emit({
      eventType: "task.activated",
      aggregateType: "task", aggregateId: taskId,
      payload: { phase: "DISCOVER" },
    }, async (tx) => {
      const activated = await tx.task.updateMany({
        where: { id: taskId, status: "DRAFT" },
        data: { status: "ACTIVE", phase: "DISCOVER" },
      });
      if (activated.count !== 1) {
        throw new Error(`task ${taskId} changed before atomic activation`);
      }
    });
    const t = await db.task.findUnique({ where: { id: taskId } });
    if (!t) return sendError(res, 500, "TASK_START_LOST", "started task could not be reloaded", "integrity");
    await synchronizeV1TaskProjection(t.id, "task.running");
    sendJson(res, 200, {
      task_id: t.id, status: t.status,
      event_cursor: activatedEvent.eventId,
      links: {
        events: `/v1/events?task_id=${t.id}`,
        task: `/v1/tasks/${t.id}`,
      },
    });
  }),
  route("POST", "/v1/tasks/:id/cancel", async (req, res, params) => {
    const body = await jsonBody(req) as { reason?: string | null };
    const taskId = String(params.id);
    const current = await db.task.findUnique({ where: { id: taskId } });
    if (!current) return sendError(res, 404, "TASK_NOT_FOUND", "task not found", "not_found");
    if (!isMutableV1TaskStatus(current.status)) {
      return sendError(res, 409, "TASK_ALREADY_TERMINAL", `task is already terminal (${current.status})`, "conflict");
    }
    const activeTurn = await db.turn.findFirst({
      where: { taskId, state: { in: [...V1_ACTIVE_TURN_STATES] } },
      orderBy: { sequence: "desc" },
    });
    if (activeTurn) {
      return sendError(
        res,
        503,
        "TURN_CANCELLATION_COORDINATOR_UNAVAILABLE",
        "task cancellation requires interrupting its active turn through the cancellation coordinator",
        "external_dependency",
        { task_id: taskId, turn_id: activeTurn.id },
      );
    }
    await emit({
      eventType: "task.aborted",
      aggregateType: "task", aggregateId: taskId,
      payload: { reason: body.reason ?? "user_cancelled" },
    }, async (tx) => {
      const update = await tx.task.updateMany({
        where: { id: taskId, status: { in: [...V1_MUTABLE_TASK_STATUSES] } },
        data: {
          status: "ABORTED",
          completedAt: new Date(),
          terminalReasonJson: JSON.stringify({ reason: body.reason ?? "user_cancelled" }),
        },
      });
      if (update.count !== 1) throw new Error(`task ${taskId} changed before atomic cancellation`);
    });
    const t = await db.task.findUnique({
      where: { id: taskId },
      include: { contractVersions: { orderBy: { version: "desc" }, take: 1 } },
    });
    if (!t) return sendError(res, 500, "TASK_CANCEL_LOST", "cancelled task could not be reloaded", "integrity");
    await synchronizeV1TaskProjection(t.id, "task.cancelled");
    sendJson(res, 200, {
      id: t.id, session_id: t.sessionId, thread_id: t.threadId,
      status: t.status, phase: t.phase,
      active_contract_version: t.activeContractVersion,
      risk_class: t.riskClass,
      created_at: t.createdAt.toISOString(), updated_at: t.updatedAt.toISOString(),
      completed_at: t.completedAt?.toISOString() ?? null,
      terminal_reason: t.terminalReasonJson === null
        ? null
        : safeParse<Record<string, unknown> | null>(t.terminalReasonJson, null),
      contract: taskContractWire(t.contractVersions[0]),
    });
  }),
  // SPEC §32.2 — amend the task contract. Creates a new
  // TaskContractVersion and bumps `activeContractVersion` so consumers
  // always read the live contract.
  route("PATCH", "/v1/tasks/:id/contract", async (req, res, params) => {
    const body = await jsonBody(req) as {
      objective?: string;
      non_goals?: string[];
      allowed_scope?: { read_paths?: string[]; write_paths?: string[]; external_systems?: string[] };
      constraints?: unknown[];
      assumptions?: unknown[];
      unknowns?: unknown[];
      change_policy?: { mayExpandScope?: boolean; scopeExpansionRequiresUser?: boolean };
      rationale?: string | null;
    };
    const taskId = String(params.id);
    const task = await db.task.findUnique({ where: { id: taskId } });
    if (!task) return sendError(res, 404, "TASK_NOT_FOUND", "task not found", "not_found");
    if (!isMutableV1TaskStatus(task.status)) {
      return sendError(res, 409, "TASK_CONTRACT_TERMINAL", `terminal task contracts are immutable (${task.status})`, "conflict");
    }
    const prevVersion = task.activeContractVersion;
    const nextVersion = prevVersion + 1;
    const prevContract = await db.taskContractVersion.findUnique({
      where: { task_id_version: { task_id: task.id, version: prevVersion } },
    });
    if (!prevContract) {
      return sendError(
        res,
        409,
        "TASK_CONTRACT_MISSING",
        `active task contract version ${prevVersion} is missing`,
        "integrity",
      );
    }
    const prevScope = v1AllowedScopeProjection(safeParse<unknown>(prevContract.allowedScopeJson, {}));
    const nextScope = v1AllowedScopeProjection(body.allowed_scope ?? prevScope);
    const expansions = scopeExpansionResources(prevScope, nextScope);
    if (expansions.length > 0) {
      return sendError(
        res,
        409,
        "TASK_SCOPE_EXPANSION_APPROVAL_REQUIRED",
        "task scope expansion requires a trusted user approval before the contract can change",
        "permission",
        { task_id: taskId, contract_version: prevVersion, proposed_resources: expansions },
      );
    }
    const prevNonGoals = safeParse(prevContract.nonGoalsJson, []);
    const prevConstraints = safeParse(prevContract.constraintsJson, []);
    const prevAssumptions = safeParse(prevContract.assumptionsJson, []);
    const prevUnknowns = safeParse(prevContract.unknownsJson, []);
    const prevChangePolicy = safeParse(
      prevContract.changePolicyJson,
      { mayExpandScope: false, scopeExpansionRequiresUser: true },
    );
    const nextContract: TaskContractHashInput = {
      version: nextVersion,
      objective: body.objective ?? prevContract.objective,
      userOutcome: null,
      nonGoals: body.non_goals ?? prevNonGoals,
      constraints: body.constraints ?? prevConstraints,
      assumptions: body.assumptions ?? prevAssumptions,
      unknowns: body.unknowns ?? prevUnknowns,
      allowedScope: nextScope,
      changePolicy: body.change_policy ?? prevChangePolicy,
    };
    const conflictMessage = `task ${taskId} changed before atomic contract amendment`;
    try {
      await emit({
        eventType: "task.contract_amended",
        aggregateType: "task_contract_version",
        aggregateId: `${taskId}@${nextVersion}`,
        correlationId: taskId,
        payload: {
          task_id: taskId, previous_version: prevVersion, new_version: nextVersion,
          objective: nextContract.objective, rationale: body.rationale ?? null,
        },
      }, async (tx) => {
        const advance = await tx.task.updateMany({
          where: {
            id: taskId,
            activeContractVersion: prevVersion,
            status: { in: [...V1_MUTABLE_TASK_STATUSES] },
          },
          data: {
            activeContractVersion: nextVersion,
            scopeDigest: JSON.stringify(nextScope),
          },
        });
        if (advance.count !== 1) throw new Error(conflictMessage);
        await tx.taskContractVersion.create({
          data: {
            task_id: taskId,
            version: nextVersion,
            objective: nextContract.objective,
            userOutcome: null,
            nonGoalsJson: JSON.stringify(nextContract.nonGoals),
            constraintsJson: JSON.stringify(nextContract.constraints),
            assumptionsJson: JSON.stringify(nextContract.assumptions),
            unknownsJson: JSON.stringify(nextContract.unknowns),
            allowedScopeJson: JSON.stringify(nextScope),
            changePolicyJson: JSON.stringify(nextContract.changePolicy),
            contentHash: taskContractHash(nextContract),
            createdBy: SERVER_PRINCIPAL,
          },
        });
        const criteria = await tx.acceptanceCriterion.findMany({
          where: { taskId, contractVersion: prevVersion },
        });
        if (criteria.length > 0) {
          await tx.acceptanceCriterion.createMany({
            data: criteria.map((criterion) => ({
              taskId,
              contractVersion: nextVersion,
              criterionId: criterion.criterionId,
              statement: criterion.statement,
              verificationHint: criterion.verificationHint,
              required: criterion.required,
              status: "pending",
            })),
          });
        }
        const ledgerRows = scopeLedgerRows({
          taskId,
          contractVersion: nextVersion,
          scope: nextScope,
          source: "contract_amendment",
          reason: body.rationale ?? "contract amended without scope expansion",
        });
        if (ledgerRows.length > 0) {
          await tx.scopeLedgerEntry.createMany({ data: ledgerRows });
        }
      });
    } catch (error: unknown) {
      if (error instanceof Error && error.message === conflictMessage) {
        return sendError(res, 409, "TASK_CONTRACT_VERSION_CONFLICT", "task contract changed during amendment", "conflict");
      }
      throw error;
    }
    const newContract = await db.taskContractVersion.findUniqueOrThrow({
      where: { task_id_version: { task_id: taskId, version: nextVersion } },
    });
    const amendedTaskId = taskId;
    await synchronizeV1TaskProjection(amendedTaskId, "task.contract_updated");
    sendJson(res, 200, {
      task_id: amendedTaskId, version: newContract.version, objective: newContract.objective,
      non_goals: safeParse(newContract.nonGoalsJson, []),
      allowed_scope: safeParse(newContract.allowedScopeJson, {}),
      change_policy: safeParse(newContract.changePolicyJson, {}),
      content_hash: newContract.contentHash,
      created_by: newContract.createdBy,
      created_at: newContract.createdAt.toISOString(),
    });
  }),
  route("GET", "/v1/tasks/:id", async (_req, res, params) => {
    const t = await db.task.findUnique({
      where: { id: String(params.id) },
      include: { contractVersions: { orderBy: { version: "desc" }, take: 1 } },
    });
    if (!t) return sendError(res, 404, "TASK_NOT_FOUND", "task not found", "not_found");
    sendJson(res, 200, {
      id: t.id, session_id: t.sessionId, thread_id: t.threadId,
      status: t.status, phase: t.phase,
      active_contract_version: t.activeContractVersion,
      risk_class: t.riskClass,
      created_at: t.createdAt.toISOString(), updated_at: t.updatedAt.toISOString(),
      completed_at: t.completedAt?.toISOString() ?? null,
      terminal_reason: t.terminalReasonJson === null
        ? null
        : safeParse<Record<string, unknown> | null>(t.terminalReasonJson, null),
      contract: taskContractWire(t.contractVersions[0]),
    });
  }),
  /**
   * Artifact inventory for a task (SPEC §29.3): every CAS artifact
   * referenced by the task's provider attempts, episodes, verification
   * results, and plans. Offset-paginated; `next_cursor` is null on the
   * last page. Content itself is fetched via GET /v1/artifacts/:hash.
   */
  route("GET", "/v1/tasks/:id/artifacts", async (req, res, params) => {
    const taskId = String(params.id);
    const task = await db.task.findUnique({
      where: { id: taskId },
      select: {
        sessionId: true,
        session: { select: { workspaceId: true } },
      },
    });
    if (!task) return sendError(res, 404, "TASK_NOT_FOUND", "task not found", "not_found");
    const url = new URL(req.url ?? "/", "http://x");
    const limitRaw = Number(url.searchParams.get("limit") ?? 100);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 200) : 100;
    const skip = Math.max(0, Math.trunc(Number(url.searchParams.get("skip") ?? 0)) || 0);

    const [attempts, episodes, plans] = await Promise.all([
      db.providerAttempt.findMany({
        where: { turn: { is: { taskId } } },
        select: { requestArtifact: true, responseArtifact: true },
      }),
      db.episode.findMany({
        where: { turn: { is: { taskId } }, contentArtifact: { not: null } },
        select: { contentArtifact: true, kind: true },
      }),
      db.verificationPlan.findMany({
        where: { taskId },
        select: {
          planArtifact: true,
          results: { select: { evidenceArtifact: true } },
        },
      }),
    ]);

    // artifact://sha256/<hex> → sha256:<hex> (the CAS address form used by
    // GET /v1/artifacts/:hash). Unknown shapes are preserved verbatim so the
    // client can still surface them instead of silently dropping evidence.
    const toHash = (uri: string): string => {
      const m = /^artifact:\/\/sha256\/([0-9a-f]{64})$/.exec(uri);
      return m ? `sha256:${m[1]}` : uri;
    };

    type Entry = { hash: string; purpose: string; created_seq: number };
    const seen = new Map<string, Entry>();
    const add = (uri: string | null | undefined, purpose: string, seq: number): void => {
      if (!uri || typeof uri !== "string") return;
      const hash = toHash(uri);
      if (!seen.has(hash)) seen.set(hash, { hash, purpose, created_seq: seq });
    };
    attempts.forEach((a, i) => {
      add(a.requestArtifact, "provider_request", i);
      add(a.responseArtifact, "provider_response", i);
    });
    episodes.forEach((e, i) => add(e.contentArtifact, `episode:${e.kind}`, i));
    plans.forEach((p, i) => {
      add(p.planArtifact, "verification_plan", i);
      p.results.forEach((r, j) => add(r.evidenceArtifact, "verification_evidence", i * 1000 + j));
    });

    const all = [...seen.values()].sort((a, b) => a.created_seq - b.created_seq);
    const page = all.slice(skip, skip + limit);
    const artifactContext = await kernelTaskContext({
      sessionId: task.sessionId,
      taskId,
      turnId: "task-artifact-inventory",
      workspaceId: task.session.workspaceId,
      operationClasses: [CapabilityOperationProto.CAPABILITY_OPERATION_ARTIFACT_INGEST],
    });
    const metas = await Promise.all(page.map(async (entry) => {
      const bare = entry.hash.replace(/^sha256:/, "");
      let mediaType = "application/octet-stream";
      let sizeBytes: number | null = null;
      try {
        const meta = await requireKernelUds().artifacts.GetMetadata({
          context: artifactContext,
          sha256: bare,
        });
        if (meta.artifact) {
          if (meta.artifact.mediaType) mediaType = meta.artifact.mediaType;
          sizeBytes = meta.artifact.sizeBytes ?? null;
        }
      } catch {
        // Metadata is best-effort; the hash remains fetchable by the client.
      }
      return {
        hash: entry.hash,
        purpose: entry.purpose,
        media_type: mediaType,
        size_bytes: sizeBytes,
      };
    }));

    const nextSkip = skip + page.length;
    sendJson(res, 200, {
      task_id: taskId,
      artifacts: metas,
      total: all.length,
      next_cursor: nextSkip < all.length ? String(nextSkip) : null,
    });
  }),
  route("GET", "/v1/sessions/:id/tasks", async (req, res, params) => {
    const page = parsePageRequest(req, res);
    if (!page) return;
    const where = { sessionId: String(params.id) };
    const [taskRows, total] = await Promise.all([
      db.task.findMany({
        where,
        include: { contractVersions: { orderBy: { version: "desc" }, take: 1 } },
        orderBy: { id: "asc" },
        ...(page.cursor ? { cursor: { id: page.cursor }, skip: 1 } : {}),
        take: page.limit + 1,
      }),
      db.task.count({ where }),
    ]);
    const tasks = taskRows.slice(0, page.limit);
    sendJson(res, 200, {
      tasks: tasks.map((t) => ({
        id: t.id, session_id: t.sessionId, thread_id: t.threadId,
        status: t.status, phase: t.phase,
        active_contract_version: t.activeContractVersion,
        risk_class: t.riskClass,
        created_at: t.createdAt.toISOString(), updated_at: t.updatedAt.toISOString(),
        completed_at: t.completedAt?.toISOString() ?? null,
        terminal_reason: t.terminalReasonJson === null
          ? null
          : safeParse<Record<string, unknown> | null>(t.terminalReasonJson, null),
        contract: taskContractWire(t.contractVersions[0]),
      })),
      total,
      next_cursor: nextPageCursor(taskRows, page.limit),
    });
  }),

  // ────────────────────────── /turns ─────────────────────────────────────
  route("POST", "/v1/turns", async (req, res) => {
    const body = await jsonBody(req) as { thread_id: string; task_id: string; user_input: string };
    if (
      typeof body.thread_id !== "string"
      || typeof body.task_id !== "string"
      || typeof body.user_input !== "string"
    ) {
      return sendError(
        res,
        400,
        "TURN_INPUT_INVALID",
        "thread_id, task_id, and user_input are required strings",
        "validation",
      );
    }
    const id = uuid();
    // Perform cheap lineage/state checks before ingesting bytes. The same
    // invariants are checked again in the admission transaction because the
    // task can change while the kernel persists and links the artifact.
    const inputTask = await db.task.findUnique({
      where: { id: body.task_id },
      select: {
        sessionId: true,
        threadId: true,
        status: true,
        session: { select: { workspaceId: true } },
      },
    });
    if (inputTask === null) {
      return sendError(res, 404, "TASK_NOT_FOUND", "task not found", "not_found");
    }
    if (inputTask.threadId !== body.thread_id) {
      return sendError(
        res,
        409,
        "TASK_THREAD_MISMATCH",
        "task does not belong to the supplied thread",
        "conflict",
        {
          task_id: body.task_id,
          supplied_thread_id: body.thread_id,
          actual_thread_id: inputTask.threadId,
        },
      );
    }
    if (!["ACTIVE", "NEEDS_USER_DECISION", "BLOCKED"].includes(inputTask.status)) {
      return sendError(
        res,
        409,
        "TASK_TURN_STATE_CONFLICT",
        `task cannot accept a turn from ${inputTask.status}`,
        "conflict",
        { task_id: body.task_id, status: inputTask.status },
      );
    }
    const inputContext = await kernelTaskContext({
      sessionId: inputTask.sessionId,
      taskId: body.task_id,
      turnId: id,
      workspaceId: inputTask.session.workspaceId,
      operationClasses: [CapabilityOperationProto.CAPABILITY_OPERATION_ARTIFACT_INGEST],
    });
    const inputArtifacts = createKernelArtifactClient(requireKernelUds().artifacts, {
      ...inputContext,
      idempotencyKey: `turn-input:${id}`,
    });
    const inputArtifact = await inputArtifacts.ingest(
      new TextEncoder().encode(body.user_input),
      {
        mediaType: "text/plain;charset=utf-8",
        custom: {
          purpose: "turn-input",
          sessionId: inputTask.sessionId,
          taskId: body.task_id,
          turnId: id,
        },
      },
    );
    // Link before publishing any authoritative row or event that references
    // the bytes. A crash before admission leaves only a reclaimable orphan.
    await inputArtifacts.link(inputArtifact.hash, "turn", id, "initiating-input");
    const observedPrevious = await db.turn.findFirst({
      where: { threadId: body.thread_id },
      orderBy: { sequence: "desc" },
      select: { sequence: true },
    });
    const proposedSequence = (observedPrevious?.sequence ?? 0) + 1;
    let turn: TurnRow;
    try {
      const admitted = await turnCoordinator.admitUnderMutationLock({
        turnId: id,
        threadId: body.thread_id,
        taskId: body.task_id,
        sequence: proposedSequence,
        inputArtifactUri: inputArtifact.uri,
        inputArtifactHash: inputArtifact.hash,
        initiatingActor: SERVER_PRINCIPAL,
      });
      turn = admitted.turn;
    } catch (error: unknown) {
      if (!(error instanceof TurnAdmissionError)) throw error;
      if (error.reason === "task_not_found") {
        return sendError(res, 404, "TASK_NOT_FOUND", "task not found", "not_found");
      }
      if (error.reason === "thread_mismatch") {
        return sendError(
          res,
          409,
          "TASK_THREAD_MISMATCH",
          "task does not belong to the supplied thread",
          "conflict",
          { task_id: body.task_id, supplied_thread_id: body.thread_id, actual_thread_id: error.detail },
        );
      }
      if (error.reason === "state_conflict") {
        return sendError(
          res,
          409,
          "TASK_TURN_STATE_CONFLICT",
          `task cannot accept a turn from ${error.detail ?? "unknown"}`,
          "conflict",
          { task_id: body.task_id, status: error.detail },
        );
      }
      if (error.reason === "turn_active") {
        return sendError(
          res,
          409,
          "TASK_TURN_ALREADY_ACTIVE",
          "task already has a non-terminal turn",
          "conflict",
          { task_id: body.task_id, turn_id: error.detail },
        );
      }
      return sendError(
        res,
        409,
        "TASK_TURN_STATE_CONFLICT",
        error.reason === "sequence_changed"
          ? "thread changed before the turn could start"
          : "task changed before the turn could start",
        "conflict",
      );
    }
    // Kick off the agent loop asynchronously.
    agentLoop(id).catch((err) => {
      console.error("agent loop failed", err);
    });
    sendJson(res, 201, {
      id: turn.id, thread_id: turn.threadId, task_id: turn.taskId,
      sequence: turn.sequence, state: turn.state,
      initiating_actor: turn.initiatingActor,
      started_at: turn.startedAt?.toISOString() ?? null,
      completed_at: turn.completedAt?.toISOString() ?? null,
    });
  }),
  route("GET", "/v1/turns/:id", async (_req, res, params) => {
    const turn = await db.turn.findUnique({ where: { id: String(params.id) } });
    if (!turn) return sendError(res, 404, "TURN_NOT_FOUND", "turn not found", "not_found");
    sendJson(res, 200, {
      id: turn.id, thread_id: turn.threadId, task_id: turn.taskId,
      sequence: turn.sequence, state: turn.state,
      initiating_actor: turn.initiatingActor,
      started_at: turn.startedAt?.toISOString() ?? null,
      completed_at: turn.completedAt?.toISOString() ?? null,
      terminal_error: turn.terminalErrorJson === null
        ? null
        : safeParse<unknown>(turn.terminalErrorJson, null),
    });
  }),
  // SPEC §32.2 — interrupt a running turn. The agent loop checks turn
  // state between phases and stops at the next safe point.
  route("POST", "/v1/turns/:id/interrupt", async (req, res, params) => {
    const body = await jsonBody(req) as { reason?: string | null };
    let updated: TurnRow;
    try {
      updated = await turnCoordinator.interruptUnderMutationLock(String(params.id), body.reason ?? "user_interrupted");
    } catch (error: unknown) {
      if (!(error instanceof TurnAdmissionError)) throw error;
      if (error.reason === "task_not_found") {
        return sendError(res, 404, "TURN_NOT_FOUND", "turn not found", "not_found");
      }
      return sendError(
        res,
        409,
        "TURN_INTERRUPT_STATE_CONFLICT",
        `turn cannot be interrupted from ${error.detail ?? "unknown"}`,
        "conflict",
      );
    }
    sendJson(res, 200, {
      id: updated.id, thread_id: updated.threadId, task_id: updated.taskId,
      sequence: updated.sequence, state: updated.state,
      initiating_actor: updated.initiatingActor,
      started_at: updated.startedAt?.toISOString() ?? null,
      completed_at: updated.completedAt?.toISOString() ?? null,
    });
  }),

  // ────────────────────────── /events (SSE) ──────────────────────────────
  route("GET", "/v1/events", async (req, res) => {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "connection": "keep-alive",
      "access-control-allow-origin": CONTROL_CORS_ORIGIN,
      "access-control-allow-headers": CORS_ALLOW_HEADERS,
      "x-accel-buffering": "no",
    });
    res.flushHeaders();
    const url = new URL(req.url ?? "", "http://x");
    const cursor = url.searchParams.get("cursor");
    const taskId = url.searchParams.get("task_id");
    const sessionId = url.searchParams.get("session_id");

    const streamName = taskId ? `task:${taskId}` : sessionId ? `session:${sessionId}` : "global";
    const disconnect = new AbortController();

    const filter = (ev: StoredEvent) => {
      if (ev.schemaVersion !== 1) return false;
      if (taskId) {
        // Turn, provider, tool, verification, and completion events use the
        // task id as their correlation id. Their payloads intentionally do
        // not all duplicate it, so payload-only matching strands the desktop
        // after turn.started and drops the rest of the live trajectory.
        return ev.correlationId === taskId
          || (ev.aggregateType === "task" && ev.aggregateId === taskId)
          || (ev.payloadJson?.includes(taskId) ?? false);
      }
      if (sessionId) return ev.payloadJson?.includes(sessionId) ?? false;
      return true;
    };

    const subscription = await eventSubscriptionService.open({
      streamName,
      cursor,
      filter,
      onEvent: (event) => {
        res.write(`id: ${event.eventId}\nevent: ${event.eventType}\ndata: ${event.payloadJson}\n\n`);
      },
      onCursorExpired: ({ requestedCursor, oldestRetainedEventId }) => {
        const snapshotUrl = taskId
          ? `/v1/tasks/${taskId}`
          : sessionId
            ? `/v1/sessions/${sessionId}`
            : "/v1/sessions";
        const expiredPayload = JSON.stringify({
          type: "cursor_expired",
          cursor: requestedCursor,
          oldest_retained_event_id: oldestRetainedEventId,
          snapshot_url: snapshotUrl,
          message:
            "the requested cursor is older than the oldest retained event; " +
            "use the snapshot endpoint to reconcile state before resuming",
        });
        res.write(`id: ${oldestRetainedEventId}\nevent: cursor_expired\ndata: ${expiredPayload}\n\n`);
      },
      signal: disconnect.signal,
    });

    // Heartbeat every 15s.
    const heartbeat = setInterval(() => {
      try { res.write(`:heartbeat ${Date.now()}\n\n`); } catch { /* ignore */ }
    }, 15_000);

    req.on("close", () => {
      clearInterval(heartbeat);
      disconnect.abort();
      void subscription.close().catch((error: unknown) => {
        console.error("[terminus-control] failed to persist event stream cursor", error);
      });
    });
  }),

  // ────────────────────────── /context ───────────────────────────────────
  route("GET", "/v1/context/manifests/:id", async (_req, res, params) => {
    const m = await db.contextManifest.findUnique({
      where: { id: String(params.id) },
      include: { fragments: true },
    });
    if (!m) return sendError(res, 404, "MANIFEST_NOT_FOUND", "manifest not found", "not_found");
    sendJson(res, 200, {
      id: m.id, provider_attempt_id: m.providerAttemptId,
      compiler_version: m.compilerVersion, policy_version: m.policyVersion,
      epoch_id: m.epochId, provider_key: m.providerKey, model_key: m.modelKey,
      rendered_request_hash: m.renderedRequestHash,
      estimated_tokens: JSON.parse(m.estimatedTokensJson),
      cache_plan: JSON.parse(m.cachePlanJson),
      experiment: JSON.parse(m.experimentJson),
      created_at: m.createdAt.toISOString(),
      fragments: m.fragments.map((f) => ({
        id: f.id, kind: f.kind, source_uri: f.sourceUri, source_version: f.sourceVersion,
        authority: f.authority, priority: f.priority, trust: f.trust,
        confidentiality: f.confidentiality, injection_risk: f.injectionRisk,
        exactness: f.exactness, selected: f.selected, rendered_position: f.renderedPosition,
        estimated_tokens: f.estimatedTokens,
        selection_reason: f.selectionReason, omission_reason: f.omissionReason,
      })),
    });
  }),

  // ────────────────────────── /artifacts ─────────────────────────────────
  route("GET", "/v1/artifacts/:hash", async (req, res, params) => {
    const taskId = new URL(req.url ?? "/", "http://terminus.local").searchParams.get("task_id");
    if (taskId === null || taskId.length === 0) {
      return sendError(
        res,
        400,
        "ARTIFACT_TASK_REQUIRED",
        "task_id is required to enforce artifact ownership",
        "validation",
      );
    }
    try {
      const artifact = await requireKernelUds().artifacts.Get({
        context: await kernelContextForTask(
          taskId,
          "artifact-read",
          [CapabilityOperationProto.CAPABILITY_OPERATION_ARTIFACT_INGEST],
        ),
        sha256: String(params.hash),
      });
      const buf = artifact.content;
      res.writeHead(200, {
        "content-type": artifact.artifact?.mediaType ?? "application/octet-stream",
        "content-length": String(buf.length),
        "access-control-allow-origin": CONTROL_CORS_ORIGIN,
        "access-control-allow-headers": CORS_ALLOW_HEADERS,
      });
      res.end(buf);
    } catch (err) {
      logInternalError("artifact fetch failed", err);
      sendError(res, 500, "ARTIFACT_FETCH_FAILED", "artifact fetch failed", "internal");
    }
  }),
  route("GET", "/v1/artifacts/:hash/metadata", async (req, res, params) => {
    const taskId = new URL(req.url ?? "/", "http://terminus.local").searchParams.get("task_id");
    if (taskId === null || taskId.length === 0) {
      return sendError(
        res,
        400,
        "ARTIFACT_TASK_REQUIRED",
        "task_id is required to enforce artifact ownership",
        "validation",
      );
    }
    try {
      const meta = await requireKernelUds().artifacts.GetMetadata({
        context: await kernelContextForTask(
          taskId,
          "artifact-metadata",
          [CapabilityOperationProto.CAPABILITY_OPERATION_ARTIFACT_INGEST],
        ),
        sha256: String(params.hash),
      });
      sendJson(res, 200, meta.artifact ?? { sha256: String(params.hash) });
    } catch (err) {
      logInternalError("artifact metadata fetch failed", err);
      sendError(res, 500, "ARTIFACT_METADATA_FAILED", "artifact metadata fetch failed", "internal");
    }
  }),

  // ────────────────────────── /approvals ─────────────────────────────────
  route("POST", "/v1/approvals", async (_req, res) => {
    // ADR-0042: a bearer-authenticated public client cannot author approval
    // semantics or its own operation hash. The trusted policy broker creates
    // records from a validated tool call and normalized input artifact.
    sendError(
      res,
      503,
      "APPROVAL_BROKER_UNAVAILABLE",
      "public approval creation is disabled; a trusted policy-broker decision is required",
      "external_dependency",
      { required_boundary: "trusted_policy_broker" },
    );
  }),
  route("GET", "/v1/approvals", async (req, res) => {
    const page = parsePageRequest(req, res);
    if (!page) return;
    const url = new URL(req.url ?? "/", "http://terminus.local");
    const taskId = url.searchParams.get("task_id");
    const where = { status: "pending", ...(taskId ? { taskId } : {}) };
    const [approvalRows, total] = await Promise.all([
      db.approval.findMany({
        where,
        orderBy: { id: "asc" },
        ...(page.cursor ? { cursor: { id: page.cursor }, skip: 1 } : {}),
        take: page.limit + 1,
      }),
      db.approval.count({ where }),
    ]);
    const approvals = approvalRows.slice(0, page.limit);
    // Decoded, client-ready rows: risk/scope arrive as stored JSON strings
    // and would otherwise force every client to re-parse them.
    sendJson(res, 200, {
      approvals: approvals.map(approvalWire),
      total,
      next_cursor: nextPageCursor(approvalRows, page.limit),
    });
  }),
  route("POST", "/v1/approvals/:id/resolve", async (req, res, params) => {
    const body = await jsonBody(req) as {
      decision: string;
      operation_hash?: unknown;
      rationale?: string | null;
    };
    // SPEC §32.4 — accept BOTH naming conventions (public-api vs domain)
    // and map to canonical domain names.
    const canonical = normalizeApprovalDecision(body.decision);
    if (!canonical) {
      return sendError(
        res,
        400,
        "INVALID_APPROVAL_DECISION",
        `unsupported approval decision: ${body.decision}`,
        "validation",
        {
          accepted: [
            "allow_once", "allow_exact", "allow_for_action",
            "allow_task_scope", "allow_for_task",
            "deny_once", "deny_and_rule", "deny_and_add_task_rule",
            "stop_task",
          ],
          canonical_names: [
            "allow_once", "allow_for_action", "allow_for_task",
            "deny_once", "deny_and_add_task_rule", "stop_task",
          ],
        },
      );
    }
    if (typeof body.operation_hash !== "string" || body.operation_hash.length === 0) {
      return sendError(
        res,
        400,
        "APPROVAL_OPERATION_HASH_REQUIRED",
        "operation_hash is required to resolve an approval",
        "validation",
      );
    }
    const operationHash = body.operation_hash;
    if (canonical.startsWith("allow") || canonical === "deny_and_add_task_rule" || canonical === "stop_task") {
      return sendError(
        res,
        503,
        "APPROVAL_DECISION_COORDINATOR_UNAVAILABLE",
        canonical.startsWith("allow")
          ? `${canonical} requires the kernel-backed approval coordinator`
          : canonical === "stop_task"
            ? "stop_task requires the kernel-backed task cancellation coordinator"
            : "deny_and_add_task_rule requires the task policy-rule coordinator",
        "external_dependency",
        { decision: canonical },
      );
    }
    const approvalId = String(params.id);
    const current = await db.approval.findUnique({ where: { id: approvalId } });
    if (!current) return sendError(res, 404, "APPROVAL_NOT_FOUND", "approval not found", "not_found");
    if (!constantTimeEqual(current.operationHash, operationHash)) {
      return sendError(
        res,
        409,
        "APPROVAL_OPERATION_MISMATCH",
        "the approval no longer matches the exact operation shown to the client",
        "conflict",
      );
    }
    if (current.status !== "pending") {
      return sendError(res, 409, "APPROVAL_ALREADY_RESOLVED", "approval is no longer pending", "conflict");
    }
    const resolvedAt = new Date();
    if (current.expiresAt && current.expiresAt.getTime() <= resolvedAt.getTime()) {
      await emit({
        eventType: "approval.expired",
        aggregateType: "approval",
        aggregateId: current.id,
        correlationId: current.taskId,
        payload: { approval_id: current.id, task_id: current.taskId, expired_at: resolvedAt.toISOString() },
      }, async (tx) => {
        const expired = await tx.approval.updateMany({
          where: { id: approvalId, status: "pending" },
          data: { status: "expired" },
        });
        if (expired.count !== 1) throw new Error(`approval ${approvalId} changed before expiry settlement`);
      });
      return sendError(res, 410, "APPROVAL_EXPIRED", "approval expired before resolution", "conflict");
    }
    if (current.useCount >= current.useLimit) {
      return sendError(res, 409, "APPROVAL_USE_LIMIT_EXHAUSTED", "approval use limit is exhausted", "conflict");
    }
    const status = "denied";
    const conflictMessage = `approval ${approvalId} changed before atomic resolution`;
    try {
    await emit({
      eventType: "approval.resolved",
      aggregateType: "approval", aggregateId: current.id,
      correlationId: current.taskId,
      payload: {
        approval_id: current.id,
        task_id: current.taskId,
        operation_hash: current.operationHash,
        decision: canonical,
        raw_decision: body.decision,
        status,
        resolved_at: resolvedAt.toISOString(),
      },
    }, async (tx) => {
      const update = await tx.approval.updateMany({
        where: {
          id: approvalId,
          status: "pending",
          operationHash,
          useCount: { lt: current.useLimit },
          OR: [{ expiresAt: null }, { expiresAt: { gt: resolvedAt } }],
        },
        data: { status, decision: canonical, resolvedAt, resolvedBy: SERVER_PRINCIPAL, rationale: body.rationale ?? null },
      });
      if (update.count !== 1) throw new Error(conflictMessage);
    });
    } catch (error: unknown) {
      if (error instanceof Error && error.message === conflictMessage) {
        return sendError(
          res,
          409,
          "APPROVAL_RESOLUTION_CONFLICT",
          "approval changed while the decision was being applied",
          "conflict",
        );
      }
      throw error;
    }
    const a = await db.approval.findUniqueOrThrow({ where: { id: approvalId } });
    sendJson(res, 200, {
      ...approvalWire(a),
      decision: canonical,
      decision_aliases: {
        allow_once: ["allow_once"],
        allow_for_action: ["allow_for_action", "allow_exact"],
        allow_for_task: ["allow_for_task", "allow_task_scope"],
        deny_once: ["deny_once"],
        deny_and_add_task_rule: ["deny_and_rule", "deny_and_add_task_rule"],
        stop_task: ["stop_task"],
      },
    });
  }),

  // ────────────────────────── /jobs ──────────────────────────────────────
  route("GET", "/v1/jobs/:id", async (_req, res, params) => {
    const jobId = String(params.id);
    const persisted = await db.job.findUnique({ where: { id: jobId } });
    if (!persisted) return sendError(res, 404, "JOB_NOT_FOUND", "job not found", "not_found");
    const jobBinding = await kernelBindingForJob(
      jobId,
      [
        CapabilityOperationProto.CAPABILITY_OPERATION_EXEC,
        CapabilityOperationProto.CAPABILITY_OPERATION_JOB,
      ],
    );
    if (kernelUds && jobBinding !== null) {
      try {
        const state = await kernelUds.jobs.Get({
          context: jobBinding.context,
          jobId: jobBinding.kernelJobId,
        });
        return sendJson(res, 200, { ...state, jobId });
      } catch (error: unknown) {
        if (isNonterminalJobState(persisted.state)) {
          return sendError(
            res,
            503,
            "JOB_RECONCILIATION_UNAVAILABLE",
            "the kernel could not confirm the state of this non-terminal job",
            "external_dependency",
            {
              job_id: jobId,
              persisted_state: persisted.state,
              reconciliation_required: true,
              error: error instanceof Error ? error.message : String(error),
            },
          );
        }
      }
    }
    if (isNonterminalJobState(persisted.state)) {
      return sendError(
        res,
        409,
        "JOB_BINDING_UNAVAILABLE",
        "the non-terminal job has no kernel identity that can be reconciled",
        "unknown_settlement",
        { job_id: jobId, persisted_state: persisted.state, reconciliation_required: true },
      );
    }
    sendJson(res, 200, {
      id: persisted.id, state: persisted.state,
      started_at: persisted.startedAt?.toISOString() ?? null,
      settled_at: persisted.settledAt?.toISOString() ?? null,
      output_cursor: persisted.outputCursor,
    });
  }),
  route("POST", "/v1/jobs/:id/stop", async (req, res, params) => {
    const body = await jsonBody(req) as { reason?: string | null };
    const jobId = String(params.id);
    const binding = await kernelBindingForJob(
      jobId,
      [
        CapabilityOperationProto.CAPABILITY_OPERATION_EXEC,
        CapabilityOperationProto.CAPABILITY_OPERATION_JOB,
      ],
    );
    if (binding === null) return sendError(res, 409, "JOB_BINDING_UNAVAILABLE", "job has no settled kernel binding", "conflict");
    try {
      const r = await requireKernelUds().jobs.Stop({
        context: binding.context,
        jobId: binding.kernelJobId,
        reason: body.reason ?? "stopped",
      });
      const projectedState = r.state.toUpperCase();
      await emit({
        eventType: "job.stopped",
        aggregateType: "job",
        aggregateId: jobId,
        payload: { state: projectedState, reason: body.reason ?? "stopped" },
      }, async (tx) => {
        await tx.job.update({
          where: { id: jobId },
          data: {
            state: projectedState,
            ...(projectedState === "EXITED" || projectedState === "LOST"
              ? { settledAt: new Date() }
              : {}),
          },
        });
      });
      sendJson(res, 200, { ...r, jobId });
    } catch (err) {
      logInternalError("job stop failed", err);
      sendError(res, 500, "JOB_STOP_FAILED", "job stop failed", "internal");
    }
  }),
  // SPEC §32.2 — send input to a job's PTY. Forwards to the kernel
  // (POST /v1/jobs/:id/input) which owns the PTY.
  route("POST", "/v1/jobs/:id/input", async (req, res, params) => {
    const body = await jsonBody(req) as { input?: string; eof?: boolean };
    const jobId = String(params.id);
    const binding = await kernelBindingForJob(
      jobId,
      [
        CapabilityOperationProto.CAPABILITY_OPERATION_EXEC,
        CapabilityOperationProto.CAPABILITY_OPERATION_JOB,
      ],
    );
    if (binding === null) return sendError(res, 409, "JOB_BINDING_UNAVAILABLE", "job has no settled kernel binding", "conflict");
    try {
      const input = body.input ?? "";
      const r = await requireKernelUds().jobs.Input({
        context: binding.context,
        jobId: binding.kernelJobId,
        stdin: new TextEncoder().encode(input + (body.eof ? "\n" : "")),
      });
      sendJson(res, 200, { ...r, jobId });
    } catch (err) {
      logInternalError("job input failed", err);
      sendError(res, 500, "JOB_INPUT_FAILED", "job input failed", "internal");
    }
  }),

  // ────────────────────────── /verification ──────────────────────────────
  route("GET", "/v1/verification/plans/:id", async (_req, res, params) => {
    const p = await db.verificationPlan.findUnique({
      where: { id: String(params.id) },
      include: { nodes: true },
    });
    if (!p) return sendError(res, 404, "PLAN_NOT_FOUND", "plan not found", "not_found");
    sendJson(res, 200, {
      id: p.id, task_id: p.taskId, contract_version: p.contractVersion,
      source_revision: p.sourceRevision, completion_expression: p.completionExpression,
      nodes: p.nodes.map((n) => ({ id: n.id, kind: n.kind, required: n.required })),
    });
  }),

  // ────────────────────────── /tools (SPEC §32.1 resource group) ────────
  // List the ACI tool vocabulary (read, search, patch, exec, job, inspect,
  // capability). Direct invocation endpoints (/v1/tools/read, /v1/tools/exec)
  // are kept below for IDE/test use.
  route("GET", "/v1/tools", async (_req, res) => {
    sendJson(res, 200, {
      tools: [
        { id: "read", version: "v1", kind: "read", description: "Read a file from the workspace" },
        { id: "search", version: "v1", kind: "search", description: "Search code via FTS5/regex" },
        { id: "patch", version: "v1", kind: "patch", description: "Apply a structured patch" },
        { id: "exec", version: "v1", kind: "exec", description: "Run a sandboxed command" },
        { id: "job", version: "v1", kind: "job", description: "Start/stop/inspect a long-running job" },
        { id: "inspect", version: "v1", kind: "inspect", description: "Inspect workspace state" },
        { id: "capability", version: "v1", kind: "capability", description: "Activate or list capabilities" },
      ],
      default_profile: "secure-local-default",
    });
  }),
  route("POST", "/v1/tools/read", async (req, res) => {
    const body = await jsonBody(req) as { task_id: string; workspace_id: string; path: string };
    if (!body.task_id || !body.workspace_id || !body.path) {
      return sendError(res, 400, "DIRECT_TOOL_SCOPE_REQUIRED", "task_id, workspace_id, and path are required", "validation");
    }
    try {
      const context = await kernelContextForTask(
        body.task_id,
        "direct-read",
        [CapabilityOperationProto.CAPABILITY_OPERATION_READ],
        [body.path],
      );
      if (context.workspaceId !== body.workspace_id) {
        return sendError(res, 422, "TASK_WORKSPACE_MISMATCH", "task does not belong to workspace_id", "validation");
      }
      const r = await requireKernelUds().files.Read({
        context,
        intent: kernelIntent(),
        path: { workspaceId: body.workspace_id, relativePath: body.path },
        mode: "full", ranges: [], symbols: [], maxBytes: 32768, expectedSha256: "",
      });
      sendJson(res, 200, r);
    } catch (err) {
      logInternalError("file read failed", err);
      sendError(res, 500, "READ_FAILED", "file read failed", "internal");
    }
  }),
  route("POST", "/v1/tools/patch", async (req, res) => {
    const body = await jsonBody(req) as {
      task_id: string;
      workspace_id: string;
      path: string;
      expected_sha256: string;
      expected_utf8: string;
      replacement_utf8: string;
      commit_mode?: "preview" | "apply";
    };
    if (!body.task_id || !body.workspace_id || !body.path) {
      return sendError(res, 400, "DIRECT_TOOL_SCOPE_REQUIRED", "task_id, workspace_id, and path are required", "validation");
    }
    try {
      const context = await kernelContextForTask(
        body.task_id,
        "direct-patch",
        [CapabilityOperationProto.CAPABILITY_OPERATION_PATCH],
        [body.path],
      );
      if (context.workspaceId !== body.workspace_id) {
        return sendError(res, 422, "TASK_WORKSPACE_MISMATCH", "task does not belong to workspace_id", "validation");
      }
      const response = await requireKernelUds().patch.Apply({
        context,
        intent: kernelIntent(),
        transactionId: randomUUID(),
        baseline: {
          workspaceId: body.workspace_id,
          repositoryRevision: "no-vcs",
          dirtyDigest: "",
          sources: [{
            path: { workspaceId: body.workspace_id, relativePath: body.path },
            sha256: body.expected_sha256,
            repositoryRevision: "no-vcs",
          }],
        },
        edits: [{
          replaceExactText: {
            path: { workspaceId: body.workspace_id, relativePath: body.path },
            expectedSha256: body.expected_sha256,
            expectedUtf8: new TextEncoder().encode(body.expected_utf8),
            replacementUtf8: new TextEncoder().encode(body.replacement_utf8),
            requireUnique: true,
          },
        }],
        validationProfileId: "task-default",
        allowTransientInvalidState: false,
        commitMode: body.commit_mode === "preview"
          ? PatchCommitMode.PATCH_COMMIT_MODE_PREVIEW_ONLY
          : PatchCommitMode.PATCH_COMMIT_MODE_APPLY_TO_WORKTREE,
      });
      sendJson(res, 200, response);
    } catch (err) {
      logInternalError("patch failed", err);
      sendError(res, 500, "PATCH_FAILED", "patch failed", "internal");
    }
  }),
  route("POST", "/v1/tools/exec", async (req, res) => {
    const body = await jsonBody(req) as {
      task_id: string;
      workspace_id: string;
      program: string;
      args?: string[];
      cwd?: string;
      sandbox_profile_id?: string;
    };
    if (!body.task_id || !body.workspace_id || !body.program) {
      return sendError(res, 400, "DIRECT_TOOL_SCOPE_REQUIRED", "task_id, workspace_id, and program are required", "validation");
    }
    try {
      const context = await kernelContextForTask(
        body.task_id,
        "direct-exec",
        [CapabilityOperationProto.CAPABILITY_OPERATION_EXEC],
        [body.cwd ?? "."],
      );
      if (context.workspaceId !== body.workspace_id) {
        return sendError(res, 422, "TASK_WORKSPACE_MISMATCH", "task does not belong to workspace_id", "validation");
      }
      const events = requireKernelUds().process.Start({
        context,
        intent: kernelIntent(),
        command: {
          program: body.program,
          args: body.args ?? [],
          cwd: { workspaceId: body.workspace_id, relativePath: body.cwd ?? "." },
          publicEnv: {}, secretCapabilityUris: [], timeout: undefined,
          allocatePty: false, shell: undefined,
        },
        sandboxProfileId: body.sandbox_profile_id ?? "secure-local-default",
        outputPolicyId: "default",
      });
      const first = await firstValueFrom(events);
      const r = first.started
        ? { process_id: first.started.processId, job_id: first.started.jobId, resolved_executable: first.started.resolvedExecutable }
        : { process_id: "", job_id: "", resolved_executable: "" };
      sendJson(res, 200, r);
    } catch (err) {
      logInternalError("exec failed", err);
      sendError(res, 500, "EXEC_FAILED", "exec failed", "internal");
    }
  }),
  route("POST", "/v1/tools/job", async (req, res) => {
    const body = await jsonBody(req) as {
      task_id: string;
      workspace_id: string;
      program: string;
      args?: string[];
      cwd?: string;
      sandbox_profile_id?: string;
      durable?: boolean;
    };
    if (!body.task_id || !body.workspace_id || !body.program) {
      return sendError(res, 400, "DIRECT_TOOL_SCOPE_REQUIRED", "task_id, workspace_id, and program are required", "validation");
    }
    const controlJobId = uuid();
    let prepared = false;
    let kernelResult: Awaited<ReturnType<KernelUdsClients["jobs"]["Start"]>> | null = null;
    try {
      const context = await kernelContextForTask(
        body.task_id,
        "direct-job",
        [
          CapabilityOperationProto.CAPABILITY_OPERATION_EXEC,
          CapabilityOperationProto.CAPABILITY_OPERATION_JOB,
          CapabilityOperationProto.CAPABILITY_OPERATION_ARTIFACT_INGEST,
        ],
        [body.cwd ?? "."],
      );
      if (context.workspaceId !== body.workspace_id) {
        return sendError(res, 422, "TASK_WORKSPACE_MISMATCH", "task does not belong to workspace_id", "validation");
      }
      const command = {
        program: body.program,
        args: body.args ?? [],
        cwd: { workspaceId: body.workspace_id, relativePath: body.cwd ?? "." },
        publicEnv: {},
        secretCapabilityUris: [],
        timeout: undefined,
        allocatePty: false,
        shell: undefined,
      };
      const artifacts = createKernelArtifactClient(requireKernelUds().artifacts, {
        ...context,
        idempotencyKey: `job:${controlJobId}`,
      });
      const commandArtifact = await ingestJsonArtifact(
        artifacts,
        command,
        "job-command",
        { taskId: body.task_id, jobId: controlJobId },
      );
      const initialOutputArtifact = await artifacts.ingest(new Uint8Array(), {
        mediaType: "application/octet-stream",
        custom: { purpose: "job-output-initial", taskId: body.task_id, jobId: controlJobId },
      });
      const task = await db.task.findUnique({
        where: { id: body.task_id },
        select: { sessionId: true },
      });
      if (task === null) throw new Error(`task ${body.task_id} disappeared before job admission`);
      const environmentDigest = await resolveKernelEnvironmentDigest(requireKernelUds());
      await emit({
        eventType: "job.start_requested",
        aggregateType: "job",
        aggregateId: controlJobId,
        correlationId: body.task_id,
        payload: { task_id: body.task_id, workspace_id: body.workspace_id },
        artifactRefs: [commandArtifact.uri],
      }, async (tx) => {
        await tx.job.create({
          data: {
            id: controlJobId,
            sessionId: task.sessionId,
            taskId: body.task_id,
            state: "STARTING",
            commandArtifact: commandArtifact.uri,
            resolvedExecutable: null,
            cwdUri: `workspace://${body.workspace_id}/${body.cwd ?? "."}`,
            environmentDigest,
            sandboxId: body.sandbox_profile_id ?? "secure-local-default",
            processIdentityJson: null,
            resourceLimitsJson: "{}",
            outputArtifact: initialOutputArtifact.uri,
            outputCursor: 0,
            cleanupPolicyJson: JSON.stringify({ durable: body.durable ?? true }),
          },
        });
      });
      prepared = true;
      kernelResult = await requireKernelUds().jobs.Start({
        context,
        intent: kernelIntent(),
        command,
        sandboxProfileId: body.sandbox_profile_id ?? "secure-local-default",
        outputPolicyId: "default",
        durable: body.durable ?? true,
      });
      await emit({
        eventType: "job.started",
        aggregateType: "job",
        aggregateId: controlJobId,
        correlationId: body.task_id,
        payload: { kernel_job_id: kernelResult.jobId, process_id: kernelResult.processId },
      }, async (tx) => {
        const update = await tx.job.updateMany({
          where: { id: controlJobId, state: "STARTING" },
          data: {
            state: "RUNNING",
            resolvedExecutable: body.program,
            processIdentityJson: JSON.stringify({
              kernelJobId: kernelResult?.jobId,
              processId: kernelResult?.processId,
            }),
            startedAt: kernelResult?.startedAt ?? new Date(),
          },
        });
        if (update.count !== 1) throw new Error(`job ${controlJobId} changed before start settlement`);
      });
      sendJson(res, 201, { ...kernelResult, jobId: controlJobId });
    } catch (err) {
      logInternalError("job start failed", err);
      if (prepared) {
        const kernelJobId = kernelResult?.jobId;
        const processId = kernelResult?.processId;
        const settlementError = kernelResult === null
          ? "job start failed before kernel settlement"
          : "job start outcome is unknown and requires reconciliation";
        await emit({
          eventType: kernelResult === null ? "job.failed" : "job.orphaned",
          aggregateType: "job",
          aggregateId: controlJobId,
          correlationId: body.task_id,
          payload: { error: settlementError, kernel_job_id: kernelJobId ?? null },
        }, async (tx) => {
          await tx.job.update({
            where: { id: controlJobId },
            data: {
              state: kernelResult === null ? "LOST" : "ORPHANED",
              processIdentityJson: kernelResult === null
                ? null
                : JSON.stringify({ kernelJobId, processId }),
              exitJson: JSON.stringify({ error: settlementError, settlement: kernelResult === null ? "failed" : "unknown" }),
              settledAt: kernelResult === null ? new Date() : null,
            },
          });
        }).catch((settlementError: unknown) => {
          console.error("job start settlement failed", settlementError);
        });
      }
      sendError(
        res,
        kernelResult === null ? 500 : 409,
        kernelResult === null ? "JOB_START_FAILED" : "JOB_START_UNKNOWN",
        kernelResult === null
          ? "job start failed"
          : "job start outcome is unknown and requires reconciliation",
        kernelResult === null ? "internal" : "unknown_settlement",
        { job_id: controlJobId, reconciliation_required: kernelResult !== null },
      );
    }
  }),

  // ────────────────────────── /agents ────────────────────────────────────
  route("GET", "/v1/agents", async (_req, res) => {
    const agents = await db.agent.findMany({ orderBy: { createdAt: "desc" }, take: 50, include: { task: true } });
    sendJson(res, 200, { agents });
  }),

  // ────────────────────────── /memory ────────────────────────────────────
  route("GET", "/v1/memory", async (_req, res) => {
    const claims = await db.memoryClaim.findMany({
      where: { status: "active" },
      orderBy: { updatedAt: "desc" }, take: 50,
    });
    sendJson(res, 200, {
      enabled: false, // disabled by default per SPEC §39
      claims: claims.map((c) => ({
        id: c.id, kind: c.kind, statement: c.statement,
        confidence_ppm: c.confidencePpm, status: c.status,
        scope: JSON.parse(c.scopeJson), provenance: JSON.parse(c.provenanceJson),
        created_at: c.createdAt.toISOString(), updated_at: c.updatedAt.toISOString(),
      })),
    });
  }),

  // ────────────────────────── /evals ─────────────────────────────────────
  route("GET", "/v1/evals", async (_req, res) => {
    sendJson(res, 200, {
      suites: [
        { id: "tiny-bugfix", name: "Tiny bug fix", task_count: 12, description: "Small one-file fixes" },
        { id: "cross-file-feature", name: "Cross-file feature", task_count: 8, description: "Features spanning 2-5 files" },
        { id: "refactor", name: "Refactor", task_count: 6, description: "Behavior-preserving refactors" },
        { id: "test-generation", name: "Test generation", task_count: 10, description: "Generate tests for existing code" },
        { id: "build-failure", name: "Build failure", task_count: 5, description: "Diagnose and fix build failures" },
        { id: "security-sensitive", name: "Security-sensitive change", task_count: 4, description: "Auth/crypto/secret changes" },
      ],
      baselines: [
        { id: "terminus-minimal", name: "Terminus minimal mode", description: "Bash-only baseline (SPEC §3.7)" },
        { id: "terminus-full", name: "Terminus full mode", description: "All features enabled" },
      ],
      last_run: null,
    });
  }),

  // ────────────────────────── /configuration ─────────────────────────────
  route("GET", "/v1/configuration", async (_req, res) => {
    sendJson(res, 200, {
      terminus: { version: 1, log_level: "info" },
      kernel: { transport: "grpc+uds", socket: KERNEL_GRPC_SOCKET, required_protocol: "terminus.kernel.v1" },
      context: { compiler_version: "v1", evidence_coverage: true, memory: { enabled: false } },
      aci: { default_tools: ["read", "search", "patch", "exec", "job", "inspect", "capability"] },
      sandbox: { profile: "secure-local-default", backend: "local-restrictive" },
      orchestration: { default: "single_agent", scouts: { enabled: true, read_only: true }, writers: { enabled: true, max_parallel: 2 }, reviewer: { risk_triggered: true } },
      security: {
        control_plane_auth: "bearer_token",
        cors_origin: CONTROL_CORS_ORIGIN,
        idempotency: { enabled: true, ttl_seconds: IDEMPOTENCY_TTL_MS / 1000 },
        sse_cursors: { monotonic_event_ids: true, cursor_expired_events: true },
      },
    });
  }),

  // The local provider command is durable control-plane state. It contains
  // no credential material; execution remains exclusively kernel-brokered.
  route("GET", "/v1/provider-config", async (_req, res) => {
    const row = await db.providerConfiguration.findUnique({ where: { id: PROVIDER_CONFIGURATION_ID } });
    sendJson(res, 200, providerConfigurationWire(row));
  }),
  route("PUT", "/v1/provider-config", async (req, res) => {
    let input: ProviderConfigurationUpdate;
    try {
      input = parseProviderConfigurationUpdate(await jsonBody(req));
    } catch (error: unknown) {
      return sendError(
        res,
        400,
        "PROVIDER_CONFIGURATION_INVALID",
        error instanceof Error ? error.message : "provider configuration is invalid",
        "validation",
      );
    }
    const now = new Date();
    const values = {
      program: input.program,
      argsJson: JSON.stringify(input.args),
      model: input.model,
      timeoutSeconds: input.timeout_seconds,
      toolsEnabled: input.tools_enabled,
      updatedBy: SERVER_PRINCIPAL,
      updatedAt: now,
    };
    const row = await writerTransaction(async (tx) => {
      if (input.expected_revision === 0) {
        const current = await tx.providerConfiguration.findUnique({ where: { id: PROVIDER_CONFIGURATION_ID } });
        if (current !== null) return null;
        return tx.providerConfiguration.create({
          data: {
            id: PROVIDER_CONFIGURATION_ID,
            ...values,
            revision: 1,
            createdAt: now,
          },
        });
      }
      const updated = await tx.providerConfiguration.updateMany({
        where: { id: PROVIDER_CONFIGURATION_ID, revision: input.expected_revision },
        data: { ...values, revision: { increment: 1 } },
      });
      if (updated.count !== 1) return null;
      return tx.providerConfiguration.findUnique({ where: { id: PROVIDER_CONFIGURATION_ID } });
    });
    if (row === null) {
      return sendError(
        res,
        409,
        "PROVIDER_CONFIGURATION_CONFLICT",
        "provider configuration changed; reload it before saving",
        "conflict",
      );
    }
    sendJson(res, 200, providerConfigurationWire(row));
  }),

  /**
   * Models this installation can actually route to.
   *
   * Answers with an empty list rather than an error whenever discovery cannot
   * run — no gateway configured, no credential, gateway or catalogue
   * unreachable. A client that receives an empty inventory hides its model
   * picker; one that receives a 5xx has to decide whether to retry forever.
   * The reason travels in `error` either way so it can be surfaced.
   */
  route("GET", "/v1/provider-models", async (_req, res) => {
    const row = await db.gatewayProviderConfiguration.findUnique({
      where: { id: GATEWAY_PROVIDER_CONFIGURATION_ID },
    });
    if (row === null) {
      return sendJson(res, 200, providerModelsWire(null, "No OpenCode gateway is configured."));
    }
    if (!row.credentialConfigured) {
      return sendJson(res, 200, providerModelsWire(null, "The OpenCode gateway has no credential configured."));
    }
    const deployment = row.deployment === "go" ? "go" as const : "zen" as const;

    const fresh = cachedProviderModels(deployment, Date.now());
    if (fresh !== null) return sendJson(res, 200, providerModelsWire(fresh, null));

    try {
      const context = await kernelBrokerContext();
      const result = await discoverProviderModels({
        client: new KernelGatewayClient(requireKernelUds().connectors, context),
        deployment,
        secretUri: gatewaySecretUri(deployment),
        observedAt: now(),
      });
      rememberProviderModels(result, Date.now());
      sendJson(res, 200, providerModelsWire(result, null));
    } catch (error: unknown) {
      // A stale answer beats no answer: the set of reachable models changes
      // far more slowly than the gateway's availability.
      const message = error instanceof Error ? error.message : "model discovery failed";
      const stale = lastProviderModels(deployment);
      sendJson(res, 200, providerModelsWire(stale, message));
    }
  }),

  route("GET", "/v1/gateway-provider-config", async (_req, res) => {
    const row = await db.gatewayProviderConfiguration.findUnique({
      where: { id: GATEWAY_PROVIDER_CONFIGURATION_ID },
    });
    sendJson(res, 200, gatewayProviderConfigurationWire(row));
  }),
  route("PUT", "/v1/gateway-provider-config", async (req, res) => {
    let input: GatewayProviderConfigurationUpdate;
    try {
      input = parseGatewayProviderConfigurationUpdate(await jsonBody(req));
    } catch (error: unknown) {
      return sendError(
        res,
        400,
        "GATEWAY_PROVIDER_CONFIGURATION_INVALID",
        error instanceof Error ? error.message : "gateway provider configuration is invalid",
        "validation",
      );
    }
    const secretUri = gatewaySecretUri(input.deployment);
    const now = new Date();
    const row = await writerTransaction(async (tx) => {
      const current = await tx.gatewayProviderConfiguration.findUnique({
        where: { id: GATEWAY_PROVIDER_CONFIGURATION_ID },
      });
      if (current === null ? input.expected_revision !== 0 : current.revision !== input.expected_revision) {
        return null;
      }
      if (
        input.credential === undefined
        && (current === null || !current.credentialConfigured || current.secretUri !== secretUri)
      ) {
        throw new Error("a credential is required when configuring or changing the gateway deployment");
      }
      if (input.credential !== undefined) {
        const stored = await requireKernelUds().secrets.Store({
          context: { ...await kernelMaintenanceContext(), idempotencyKey: `gateway-secret:${input.expected_revision}:${input.deployment}` },
          capabilityUri: secretUri,
          value: new TextEncoder().encode(input.credential),
        });
        if (!stored.stored || stored.capabilityUri !== secretUri) {
          throw new Error("kernel did not confirm gateway credential storage");
        }
      }
      const data = {
        deployment: input.deployment,
        protocol: input.protocol,
        model: input.model,
        secretUri,
        credentialConfigured: input.credential !== undefined || current?.credentialConfigured === true,
        toolsEnabled: input.tools_enabled,
        freeModel: input.free_model,
        workspaceAccess: input.workspace_access,
        privacyTermsAdmitted: input.privacy_terms_admitted,
        privacyTermsVersion: input.privacy_terms_version,
        updatedBy: SERVER_PRINCIPAL,
        updatedAt: now,
      };
      if (current === null) {
        return tx.gatewayProviderConfiguration.create({
          data: { id: GATEWAY_PROVIDER_CONFIGURATION_ID, ...data, revision: 1, createdAt: now },
        });
      }
      return tx.gatewayProviderConfiguration.update({
        where: { id: GATEWAY_PROVIDER_CONFIGURATION_ID },
        data: { ...data, revision: { increment: 1 } },
      });
    }).catch((error: unknown) => {
      if (error instanceof Error && error.message.includes("credential is required")) return error;
      throw error;
    });
    if (row instanceof Error) {
      return sendError(res, 400, "GATEWAY_CREDENTIAL_REQUIRED", row.message, "validation");
    }
    if (row === null) {
      return sendError(
        res,
        409,
        "GATEWAY_PROVIDER_CONFIGURATION_CONFLICT",
        "gateway provider configuration changed; reload it before saving",
        "conflict",
      );
    }
    sendJson(res, 200, gatewayProviderConfigurationWire(row));
  }),
  route("DELETE", "/v1/gateway-provider-config", async (req, res) => {
    const parsed = gatewayProviderConfigurationDeleteSchema.safeParse(await jsonBody(req));
    if (!parsed.success) {
      return sendError(res, 400, "GATEWAY_PROVIDER_CONFIGURATION_INVALID", "expected_revision is required", "validation");
    }
    const result = await writerTransaction(async (tx) => {
      const current = await tx.gatewayProviderConfiguration.findUnique({
        where: { id: GATEWAY_PROVIDER_CONFIGURATION_ID },
      });
      if (current === null || current.revision !== parsed.data.expected_revision) return null;
      const deleted = await requireKernelUds().secrets.Delete({
        context: { ...await kernelMaintenanceContext(), idempotencyKey: `gateway-secret-delete:${current.revision}` },
        capabilityUri: current.secretUri,
      });
      if (deleted.stored || deleted.capabilityUri !== current.secretUri) {
        throw new Error("kernel did not confirm gateway credential deletion");
      }
      await tx.gatewayProviderConfiguration.delete({ where: { id: GATEWAY_PROVIDER_CONFIGURATION_ID } });
      return true;
    });
    if (result === null) {
      return sendError(res, 409, "GATEWAY_PROVIDER_CONFIGURATION_CONFLICT", "gateway configuration changed; reload before disconnecting", "conflict");
    }
    sendJson(res, 200, { configured: false, configuration: null });
  }),

  // ────────────────────────── /policies (SPEC §32.1 resource group) ─────
  // List sandbox profiles + command rules so clients can render the
  // policy surface without reading config files.
  route("GET", "/v1/policies", async (_req, res) => {
    sendJson(res, 200, {
      active: "secure-local-default",
      profiles: [
        {
          id: "secure-local-default",
          description: "Secure local development profile (SPEC §3.7 default).",
          sandbox: { backend: "local-restrictive", network: "deny_outbound", fs: "workspace_only" },
          command_rules: [
            { pattern: "rg", decision: "allow", scope: "read" },
            { pattern: "git status", decision: "allow", scope: "read" },
            { pattern: "git diff", decision: "allow", scope: "read" },
            { pattern: "git commit", decision: "prompt", scope: "write" },
            { pattern: "rm", decision: "deny" },
            { pattern: "curl", decision: "deny" },
            { pattern: "wget", decision: "deny" },
          ],
          secret_access: "prompt",
          network: "deny_outbound_by_default",
        },
        {
          id: "trusted-local-full",
          description: "Trusted local workspace with broader tool access (requires explicit trust).",
          sandbox: { backend: "local-permissive", network: "allow_loopback", fs: "workspace_only" },
          command_rules: [
            { pattern: "*", decision: "allow", scope: "read_write" },
          ],
          secret_access: "allow_with_audit",
          network: "allow_loopback",
        },
      ],
    });
  }),

  // Live sandbox enforcement report, proxied from the kernel (SPEC §13.4).
  // Clients must render degraded/unsupported controls honestly instead of
  // implying full enforcement.
  route("GET", "/v1/sandbox/report", async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const profileId = url.searchParams.get("profile_id") ?? "";
    const taskId = url.searchParams.get("task_id");
    if (taskId === null || taskId.length === 0) {
      return sendError(res, 400, "SANDBOX_TASK_REQUIRED", "task_id is required for a sandbox report", "validation");
    }
    const report = await requireKernelUds().sandbox.Report({
      context: await kernelContextForTask(
        taskId,
        "sandbox-report",
        [CapabilityOperationProto.CAPABILITY_OPERATION_SANDBOX],
      ),
      profileId,
    });
    const statusName = ["enforced", "degraded", "unsupported"][report.status] ?? "unsupported";
    sendJson(res, 200, {
      backend_id: report.backendId,
      status: statusName,
      enforced: [...report.enforced],
      degraded: [...report.degraded],
      unsupported: [...report.unsupported],
      notes: [...report.notes],
      ...(profileId ? { profile_id: profileId } : {}),
    });
  }),

  // ────────────────────────── /checkpoints (§29.5) ──────────────────────
  route("POST", "/v1/checkpoints", async (req, res) => {
    const parsed = checkpointRequestSchema.safeParse(await jsonBody(req));
    if (!parsed.success) {
      return sendError(
        res,
        400,
        "INVALID_CHECKPOINT_REQUEST",
        `invalid checkpoint request: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
        "validation",
      );
    }
    const body = parsed.data;
    const task = await db.task.findUnique({ where: { id: body.task_id } });
    if (!task) return sendError(res, 404, "TASK_NOT_FOUND", "checkpoint task not found", "not_found");
    if (task.sessionId !== body.session_id || task.threadId !== body.thread_id) {
      return sendError(
        res,
        409,
        "CHECKPOINT_LINEAGE_MISMATCH",
        "checkpoint session, thread, and task must identify the same persisted lineage",
        "conflict",
      );
    }
    const contractRow = await db.taskContractVersion.findUnique({
      where: {
        task_id_version: {
          task_id: task.id,
          version: task.activeContractVersion,
        },
      },
    });
    if (!contractRow) {
      return sendError(res, 409, "CHECKPOINT_SOURCE_UNAVAILABLE", "active task contract not found", "conflict");
    }
    const [criteriaRows, sourceTurn, approvalRows] = await Promise.all([
      db.acceptanceCriterion.findMany({
        where: { taskId: task.id, contractVersion: contractRow.version },
        orderBy: { criterionId: "asc" },
      }),
      db.turn.findFirst({
        where: { taskId: task.id, threadId: task.threadId },
        include: { episodes: { orderBy: { sequence: "asc" } } },
        orderBy: { sequence: "desc" },
      }),
      db.approval.findMany({
        where: { taskId: task.id },
        orderBy: { requestedAt: "asc" },
      }),
    ]);
    if (!sourceTurn) {
      return sendError(
        res,
        409,
        "CHECKPOINT_SOURCE_UNAVAILABLE",
        "a checkpoint requires at least one persisted task turn",
        "conflict",
      );
    }
    const contract = persistedTaskContract(task, contractRow, criteriaRows);
    const approvalState: Array<{
      readonly approvalId: string;
      readonly state: string;
      readonly operationHash: ContentHash;
    }> = [];
    for (const approval of approvalRows) {
      const operationHash = contentHashSchema.safeParse(approval.operationHash);
      if (!operationHash.success) {
        return sendError(
          res,
          409,
          "CHECKPOINT_SOURCE_INVALID",
          `approval ${approval.id} has no valid canonical operation hash`,
          "integrity",
        );
      }
      approvalState.push({
        approvalId: approval.id,
        state: approval.status,
        operationHash: operationHash.data,
      });
    }
    const effectState: NonNullable<CheckpointContent["effectState"]> = [...arpV2.effects.values()]
      .filter((effect) => effect.taskId === task.id)
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((effect) => ({
        effectId: effect.id,
        state: effect.state,
        idempotencyKey: effect.semanticIdempotencyKey,
      }));
    const episodeRange = checkpointEpisodeRange(sourceTurn.episodes);
    const sourceVersions = {
      [`task://${task.id}`]: contractRow.contentHash,
      [`turn://${sourceTurn.id}`]: `${sourceTurn.sequence}:${sourceTurn.state}`,
    };
    const requirementState = criteriaRows.map((criterion) => ({
      criterion,
      status: checkpointRequirementStatus(criterion.status),
    }));
    const completedSteps = requirementState
      .filter(({ status }) => status === "satisfied")
      .map(({ criterion }) => ({
        description: criterion.statement,
        evidenceArtifactHashes: [] as readonly ContentHash[],
      }));
    const pendingSteps = requirementState
      .filter(({ status }) => status !== "satisfied")
      .map(({ criterion }) => criterion.statement);
    const failures: CheckpointContent["failures"] = sourceTurn.terminalErrorJson === null
      ? []
      : [{
          description: checkpointFailureDescription(
            sourceTurn.terminalErrorJson,
            sourceTurn.state,
          ),
          artifactHash: null,
          resolved: false,
        }];
    const contentResult = checkpointContentSchema.safeParse({
      objective: contract.objective,
      completedSteps,
      pendingSteps,
      requirements: requirementState.map(({ criterion, status }) => ({
        id: criterion.criterionId,
        statement: criterion.statement,
        status,
        evidence: [],
      })),
      assumptions: contract.assumptions,
      unknowns: contract.unknowns,
      decisions: [],
      failures,
      openQuestions: contract.unknowns,
      sourceVersions,
      scope: contract.allowedScope,
      effectState,
      approvalState,
    });
    if (!contentResult.success) {
      return sendError(
        res,
        409,
        "CHECKPOINT_SOURCE_INVALID",
        `authoritative checkpoint state is not representable: ${contentResult.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
        "integrity",
      );
    }
    const content = contentResult.data;
    const validation = validateCheckpoint(content, contract, sourceVersions);
    if (!validation.valid) {
      return sendError(
        res,
        409,
        "CHECKPOINT_VALIDATION_FAILED",
        validation.violations.map((violation) => violation.description).join("; "),
        "integrity",
      );
    }
    const id = uuid();
    const checkpointContext = await kernelContextForTask(
      task.id,
      sourceTurn.id,
      [CapabilityOperationProto.CAPABILITY_OPERATION_ARTIFACT_INGEST],
    );
    const artifactClient = createKernelArtifactClient(requireKernelUds().artifacts, {
      ...checkpointContext,
      idempotencyKey: `checkpoint:${id}`,
    });
    const checkpointArtifact = await ingestJsonArtifact(
      artifactClient,
      content,
      "task-checkpoint",
      { sessionId: task.sessionId, taskId: task.id, turnId: sourceTurn.id },
    );
    const sequenceState = checkpointSequenceStateSchema.parse({
      task: contractRow.version,
      turn: sourceTurn.sequence,
      sourceTurnId: sourceTurn.id,
      episodeRange,
    });
    // Retain the content at the kernel before publishing even a hidden row.
    // Startup reconciliation removes a task-bound orphan if the process dies
    // before the PREPARED intent is durable.
    await artifactClient.link(checkpointArtifact.hash, "checkpoint", id, "content");
    const checkpoint = await writerTransaction((tx) => tx.checkpoint.create({
      data: {
        id,
        sessionId: task.sessionId,
        threadId: task.threadId,
        taskId: task.id,
        checkpointArtifact: checkpointArtifact.uri,
        schemaVersion: 1,
        lastCommittedSequencesJson: canonicalJson(sequenceState),
        activeContextEpochId: null,
        promotedInputCursor: null,
        unsettledToolCallsJson: "[]",
        activeJobsJson: "[]",
        workspaceRevision: null,
        dirtyStateDigest: null,
        unsettledEffectsJson: canonicalJson(effectState),
        artifactRefsJson: "[]",
        continuationJson: null,
        admissionState: "PREPARED",
      },
    }));
    await commitCheckpointPublication({
      id,
      threadId: task.threadId,
      taskId: task.id,
      artifactHash: checkpointArtifact.hash,
    });
    sendJson(res, 201, {
      id: checkpoint.id,
      session_id: checkpoint.sessionId,
      thread_id: checkpoint.threadId,
      task_id: checkpoint.taskId,
      checkpoint_artifact: checkpoint.checkpointArtifact,
      schema_version: checkpoint.schemaVersion,
      created_at: checkpoint.createdAt.toISOString(),
    });
  }),
  route("GET", "/v1/checkpoints/:id", async (_req, res, params) => {
    const cp = await db.checkpoint.findFirst({
      where: { id: String(params.id), admissionState: "COMMITTED" },
    });
    if (!cp) return sendError(res, 404, "CHECKPOINT_NOT_FOUND", "checkpoint not found", "not_found");
    sendJson(res, 200, {
      id: cp.id, session_id: cp.sessionId, thread_id: cp.threadId, task_id: cp.taskId,
      checkpoint_artifact: cp.checkpointArtifact, schema_version: cp.schemaVersion,
      last_committed_sequences: JSON.parse(cp.lastCommittedSequencesJson),
      active_context_epoch_id: cp.activeContextEpochId,
      promoted_input_cursor: cp.promotedInputCursor,
      unsettled_tool_calls: JSON.parse(cp.unsettledToolCallsJson),
      active_jobs: JSON.parse(cp.activeJobsJson),
      workspace_revision: cp.workspaceRevision,
      dirty_state_digest: cp.dirtyStateDigest,
      unsettled_effects: JSON.parse(cp.unsettledEffectsJson),
      artifact_refs: JSON.parse(cp.artifactRefsJson),
      continuation: cp.continuationJson ? JSON.parse(cp.continuationJson) : null,
      created_at: cp.createdAt.toISOString(),
    });
  }),
  route("GET", "/v1/sessions/:id/checkpoints", async (_req, res, params) => {
    const cps = await db.checkpoint.findMany({
      where: { sessionId: String(params.id), admissionState: "COMMITTED" },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    sendJson(res, 200, { checkpoints: cps.map((c) => ({ id: c.id, thread_id: c.threadId, task_id: c.taskId, created_at: c.createdAt.toISOString() })) });
  }),

  // ────────────────────────── /recovery (§29.5) ─────────────────────────
  route("POST", "/v1/system/recover", async (_req, res) => {
    // SPEC §29.5 startup recovery procedure:
    // 1. acquire the instance lease
    // 2. verify database integrity and migration state
    // 3. load non-terminal tasks and turns
    // 4. reconcile jobs with OS process/cgroup/job-object state
    // 5. reconcile write journals and patch transactions
    // 6. reconcile external side effects in STARTED or UNKNOWN
    // 7. mark provider attempts interrupted before a complete response
    // 8. restore active context epochs
    // 9. expose tasks as resumable, blocked, or requiring manual review
    // 10. emit a recovery report artifact
    const reportId = uuid();
    const startedAt = new Date();

    // Count non-terminal tasks and turns
    const nonTerminalTasks = await db.task.count({
      where: { status: { in: ["ACTIVE", "NEEDS_USER_DECISION", "BLOCKED", "VERIFYING", "DRAFT"] } },
    });
    const nonTerminalTurns = await db.turn.count({
      where: { state: { in: ["PENDING", "CONTEXT_COMPILING", "PROVIDER_RUNNING", "RESPONSE_VALIDATING", "TOOL_SETTLEMENT", "FINALIZING"] } },
    });

    const jobRecovery = await reconcileNonterminalJobs();

    // Reconcile external side effects in STARTED or UNKNOWN
    const unsettledEffects = await db.sideEffect.count({
      where: { state: { in: ["STARTED", "UNKNOWN"] } },
    });
    // Mark provider attempts interrupted in the same transaction as the
    // recovery report/event below.
    const interruptedAttempts = await db.providerAttempt.count({ where: { status: "running" } });

    const checkpointLinks = await reconcileCheckpointArtifactLinks();
    const checkpointAdmissions = await reconcilePreparedCheckpointAdmissions();

    // Verify integrity
    let integrityOk = true;
    try {
      const result = await db.$queryRaw<{ quick_check: string }[]>`PRAGMA quick_check`;
      integrityOk = result[0]?.quick_check === "ok";
    } catch { integrityOk = false; }

    await emit({
      eventType: "system.recovered",
      aggregateType: "recovery_report",
      aggregateId: reportId,
      payload: {
        non_terminal_tasks: nonTerminalTasks,
        non_terminal_turns: nonTerminalTurns,
        reconciled_jobs: jobRecovery.scanned,
        lost_jobs: jobRecovery.lost,
        manual_review_effects: unsettledEffects,
        interrupted_attempts: interruptedAttempts,
      },
    }, async (tx) => {
      if (unsettledEffects > 0) {
        await tx.sideEffect.updateMany({
          where: { state: { in: ["STARTED", "UNKNOWN"] } },
          data: { state: "MANUAL_REVIEW" },
        });
      }
      if (interruptedAttempts > 0) {
        await tx.providerAttempt.updateMany({
          where: { status: "running" },
          data: {
            status: "interrupted",
            completedAt: new Date(),
            errorJson: JSON.stringify({ reason: "process restart" }),
          },
        });
      }
      await tx.recoveryReport.create({
        data: {
          id: reportId,
          startedAt,
          completedAt: new Date(),
          instanceId: "terminus-control-dev",
          schemaVersion: 1,
          nonTerminalTasks,
          nonTerminalTurns,
          reconciledJobs: jobRecovery.scanned,
          lostJobs: jobRecovery.lost,
          reconciledEffects: 0,
          manualReviewEffects: unsettledEffects,
          integrityOk: integrityOk
            && checkpointLinks.failed.length === 0
            && checkpointLinks.quarantined.length === 0
            && checkpointAdmissions.failed.length === 0
            && checkpointAdmissions.quarantined.length === 0,
          detailsJson: JSON.stringify({ interruptedAttempts, jobRecovery, checkpointLinks, checkpointAdmissions }),
        },
      });
    });
    const report = await db.recoveryReport.findUniqueOrThrow({ where: { id: reportId } });

    sendJson(res, 200, {
      id: report.id,
      started_at: report.startedAt.toISOString(),
      completed_at: report.completedAt?.toISOString() ?? null,
      instance_id: report.instanceId,
      non_terminal_tasks: report.nonTerminalTasks,
      non_terminal_turns: report.nonTerminalTurns,
      lost_jobs: report.lostJobs,
      manual_review_effects: report.manualReviewEffects,
      integrity_ok: report.integrityOk,
      interrupted_attempts: interruptedAttempts,
      checkpoint_links: checkpointLinks,
      checkpoint_admissions: checkpointAdmissions,
    });
  }),

  // ────────────────────────── /export (§29.6) ───────────────────────────
  route("POST", "/v1/system/export", async (req, res) => {
    const body = await jsonBody(req) as { include_artifacts?: boolean; include_events?: boolean };
    // SPEC §29.6 portable export: manifest.json, state.sqlite.snapshot,
    // semantic-events.jsonl, artifacts/, workspace-manifest.json,
    // context-manifests/, verification/, README.md
    const exportId = uuid();
    const sessions = await db.session.findMany({ where: { status: { not: "deleted" } } });
    const tasks = await db.task.findMany({ where: { status: { not: "ABORTED" } }, include: { contractVersions: { orderBy: { version: "desc" }, take: 1 } } });
    const events = body.include_events === false ? [] : await db.semanticEvent.findMany({ orderBy: { occurredAt: "asc" }, take: 10000 });
    const manifests = await db.contextManifest.findMany({
      take: 1000,
      include: {
        fragments: true,
        providerAttempt: { include: { turn: { select: { taskId: true } } } },
      },
    });
    const verifications = await db.verificationPlan.findMany({ take: 500, include: { nodes: true, results: true } });
    const completionRecords = await db.completionRecord.findMany({ take: 500, orderBy: { generatedAt: "asc" } });
    const candidateBranches = await db.candidateBranch.findMany({ take: 500, orderBy: { createdAt: "asc" } });

    const exportPayload = {
      manifest: {
        format: "terminus-export-v1",
        exported_at: new Date().toISOString(),
        export_id: exportId,
        version: "0.1.0",
        counts: {
          sessions: sessions.length,
          tasks: tasks.length,
          events: events.length,
          manifests: manifests.length,
          verifications: verifications.length,
          completion_records: completionRecords.length,
          candidate_branches: candidateBranches.length,
        },
      },
      sessions: sessions.map((s) => ({
        id: s.id, workspace_id: s.workspaceId, title: s.title, status: s.status,
        created_at: s.createdAt.toISOString(), updated_at: s.updatedAt.toISOString(),
      })),
      tasks: tasks.map((t) => ({
        id: t.id, session_id: t.sessionId, status: t.status, phase: t.phase,
        objective: t.contractVersions[0]?.objective ?? null,
        created_at: t.createdAt.toISOString(), completed_at: t.completedAt?.toISOString() ?? null,
      })),
      events: events.map((e) => ({
        event_id: e.eventId, event_type: e.eventType, schema_version: e.schemaVersion,
        aggregate_type: e.aggregateType, aggregate_id: e.aggregateId,
        aggregate_sequence: e.aggregateSequence, occurred_at: e.occurredAt.toISOString(),
        payload: JSON.parse(e.payloadJson),
      })),
      context_manifests: manifests.map((m) => ({
        id: m.id, task_id: m.providerAttempt?.turn.taskId ?? null,
        provider_attempt_id: m.providerAttemptId,
        provider_key: m.providerKey, model_key: m.modelKey,
        compiler_version: m.compilerVersion, created_at: m.createdAt.toISOString(),
        epoch_id: m.epochId, rendered_request_hash: m.renderedRequestHash,
        estimated_tokens: safeParse<unknown>(m.estimatedTokensJson, null),
        cache_plan: safeParse<unknown>(m.cachePlanJson, null),
        fragments: m.fragments.map((f) => ({ kind: f.kind, selected: f.selected, authority: f.authority })),
      })),
      verification_plans: verifications.map((p) => ({
        id: p.id, task_id: p.taskId, completion_expression: p.completionExpression,
        contract_version: p.contractVersion, source_revision: p.sourceRevision,
        nodes: p.nodes.map((n) => ({ id: n.id, kind: n.kind, required: n.required })),
        results: p.results.map((r) => ({
          node_id: r.nodeId, status: r.status, source_revision: r.sourceRevision,
          environment_digest: r.environmentDigest, evidence_artifact: r.evidenceArtifact,
        })),
      })),
      completion_records: completionRecords.map((record) => ({
        id: record.id, task_id: record.taskId, contract_version: record.contractVersion,
        final_revision: record.finalRevision, status: record.status,
        criteria: safeParse<unknown[]>(record.criteriaJson, []),
        verification_plan_id: record.verificationPlanId,
        unresolved_risks: safeParse<unknown[]>(record.unresolvedRisksJson, []),
        accepted_risks: safeParse<unknown[]>(record.acceptedRisksJson, []),
        external_effects: safeParse<unknown[]>(record.externalEffectsJson, []),
        cost_micros: record.costMicros.toString(), duration_seconds: record.durationSeconds,
        final_checkpoint: safeParse<unknown>(record.finalCheckpointJson, null),
        generated_at: record.generatedAt.toISOString(),
      })),
      candidate_branches: candidateBranches.map((branch) => ({
        id: branch.id, task_id: branch.taskId, attempt_id: branch.attemptId,
        base_revision: branch.baseRevision, head_revision: branch.headRevision,
        scope_digest: branch.scopeDigest, status: branch.status,
        effect_ids: safeParse<unknown[]>(branch.effectIdsJson, []),
        proof: safeParse<unknown>(branch.proofJson ?? "null", null),
      })),
    };

    sendJson(res, 200, exportPayload);
  }),

  // ────────────────────────── /import (§29.6) ───────────────────────────
  route("POST", "/v1/system/import", async (req, res) => {
    const body = await jsonBody(req);
    const parsed = z.object({
      manifest: z.object({
        format: z.literal("terminus-export-v1"),
        export_id: z.string().min(1),
      }).passthrough(),
    }).passthrough().safeParse(body);
    if (!parsed.success) {
      return sendError(res, 400, "INVALID_EXPORT_FORMAT", "unsupported export format", "validation");
    }
    sendError(
      res,
      503,
      "EXTERNAL_DEPENDENCY_FAILED",
      "Portable import requires a trusted signed-export verifier and isolated validation store; no state was imported",
      "external_dependency",
      { exportId: parsed.data.manifest.export_id },
    );
  }),

  // ────────────────────────── /side-effects (§28.6) ─────────────────────
  route("GET", "/v1/side-effects", async (_req, res) => {
    const effects = await db.sideEffect.findMany({ orderBy: { startedAt: "desc" }, take: 100 });
    sendJson(res, 200, {
      side_effects: effects.map((e) => ({
        id: e.id,
        tool_call_id: e.toolCallId,
        effect_type: e.effectType,
        resource_uri: e.resourceUri,
        state: e.state,
        idempotency_key: e.idempotencyKey,
        reversibility: e.reversibility,
        evidence_artifact: e.evidenceArtifact,
        started_at: e.startedAt?.toISOString() ?? null,
        settled_at: e.settledAt?.toISOString() ?? null,
      })),
    });
  }),
  route("POST", "/v1/side-effects/:id/settle", async (req, res, params) => {
    const parsed = z.object({
      result: z.enum(["settled", "failed"]),
      reconciliationReceipt: TrustedReceiptReferenceWire,
    }).strict().safeParse(await jsonBody(req));
    if (!parsed.success) {
      return sendError(res, 400, "INVALID_SETTLEMENT", "a trusted reconciliation receipt reference is required", "validation");
    }
    const effectId = String(params.id);
    const effect = await db.sideEffect.findUnique({ where: { id: effectId } });
    if (!effect) return sendError(res, 404, "SIDE_EFFECT_NOT_FOUND", "side effect not found", "not_found");
    sendError(
      res,
      503,
      "EXTERNAL_DEPENDENCY_FAILED",
      "No trusted reconciliation-receipt verifier is configured; the side effect was not settled",
      "external_dependency",
      {
        effectId: effect.id,
        requestedResult: parsed.data.result,
        receiptArtifactUri: parsed.data.reconciliationReceipt.receiptArtifactRef.uri,
      },
    );
  }),

  // ────────────────────────── ARP v2 (/v2, SPEC §32) ─────────────────────
  route("GET", "/v2/system/health", async (_req, res) => {
    let kernelReady = false;
    try {
      const kernelHealth = await requireKernelUds().info.Health({});
      kernelReady = kernelHealth.state === "healthy" || kernelHealth.state === "ok";
    } catch {
      kernelReady = false;
    }
    const writerReady = writerLeaseIsHealthy();
    const ready = kernelReady && writerReady;
    sendJson(res, 200, {
      status: ready ? "ok" : "degraded",
      version: "0.1.0",
      protocolVersion: 2,
      uptimeSeconds: Math.floor(process.uptime()),
      ready,
      kernelReady,
      writerReady,
      writerFencingToken: writerLease?.fencingToken ?? null,
    });
  }),
  route("GET", "/v2/system/schema-registry", async (_req, res) => {
    const schemas: Record<string, unknown> = {};
    for (const [name, schema] of V2_SCHEMA_REGISTRY_ENTRIES) {
      schemas[name] = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" });
    }
    sendJson(res, 200, {
      protocolVersion: 2 as const,
      supportedEventTypes: [...ARP_V2_EVENT_TYPES],
      supportedCommandTypes: [...ARP_V2_COMMAND_TYPES],
      schemas: jsonSafe(schemas),
    });
  }),
  route("POST", "/v2/tasks", async (req, res) => {
    const parsed = z.object({
      missionId: z.string().nullable().default(null),
      organizationId: z.string().default("default-org"),
      departmentId: z.string().default("default-dept"),
      v1Context: z.object({
        sessionId: z.string().min(1),
        threadId: z.string().min(1),
      }).nullable().default(null),
      contract: taskContractV2WireSchema,
    }).safeParse(await jsonBody(req));
    if (!parsed.success) {
      return sendError(res, 400, "INVALID_TASK_CONTRACT", `invalid v2 task request: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, "validation");
    }
    const { missionId, organizationId, departmentId, v1Context, contract } = parsed.data;
    if (contract.mode === "interactive" && v1Context === null) {
      return sendError(
        res,
        409,
        "INTERACTIVE_TASK_REQUIRES_CONTEXT",
        "interactive tasks require an existing session and thread",
        "conflict",
      );
    }
    const nowIso = nowTimestamp();
    const task: TaskV2 = {
      id: uuid(),
      missionId,
      organizationId,
      departmentId,
      createdBy: SERVER_PRINCIPAL,
      conversationContext: v1Context === null ? null : {
        sessionId: v1Context.sessionId,
        threadId: v1Context.threadId,
        attachedAt: nowIso,
      },
      contract: contract as TaskContractV2,
      status: "DRAFT",
      version: 1,
      createdAt: nowIso,
      updatedAt: nowIso,
      completedAt: null,
    };
    if (v1Context !== null) {
      const projection = await taskProjectionService.inspectV1(task.id, v1Context);
      if (projection === "thread_not_found") {
        return sendError(
          res,
          409,
          "TASK_CONTEXT_MISMATCH",
          "v1 task context must name an existing thread in the supplied session",
          "conflict",
        );
      }
      if (projection === "context_mismatch") {
        return sendError(res, 409, "TASK_CONTEXT_MISMATCH", "task is already attached to another conversation", "conflict");
      }
    }
    await emitV2({
      eventType: "task.created",
      aggregateType: "task",
      aggregateId: task.id,
      snapshot: task,
      idempotencyKey: req.headers["idempotency-key"] as string | undefined ?? null,
      mutation: v1Context === null
        ? undefined
        : async (tx) => {
          const projection = await taskProjectionService.createV1(tx, task, v1Context);
          if (projection !== "created") {
            throw new Error(`v1 task projection changed during v2 creation (${projection})`);
          }
        },
    });
    arpV2.tasks.set(task.id, task);
    sendJson(res, 201, jsonSafe(task));
  }),
  route("GET", "/v2/tasks/:id", async (_req, res, params) => {
    const task = arpV2.tasks.get(String(params.id));
    if (!task) return sendError(res, 404, "TASK_NOT_FOUND", "v2 task not found", "not_found");
    sendJson(res, 200, jsonSafe(task));
  }),
  route("GET", "/v2/tasks", async (_req, res) => {
    const tasks = [...arpV2.tasks.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    sendJson(res, 200, { tasks: jsonSafe(tasks) });
  }),
  route("GET", "/v2/tasks/:id/conversation-context", async (_req, res, params) => {
    const id = String(params.id);
    const task = arpV2.tasks.get(id);
    if (!task) return sendError(res, 404, "TASK_NOT_FOUND", "v2 task not found", "not_found");
    const projection = await db.task.findUnique({
      where: { id },
      select: { sessionId: true, threadId: true, createdAt: true },
    });
    const context = projection === null ? null : {
      sessionId: projection.sessionId,
      threadId: projection.threadId,
      attachedAt: projection.createdAt.toISOString(),
    };
    sendJson(res, 200, context);
  }),
  route("POST", "/v2/tasks/:id/conversation-context", async (req, res, params) => {
    const id = String(params.id);
    const task = arpV2.tasks.get(id);
    if (!task) return sendError(res, 404, "TASK_NOT_FOUND", "v2 task not found", "not_found");
    const parsed = z.object({
      sessionId: z.string().min(1),
      threadId: z.string().min(1),
      expectedVersion: z.number().int().nonnegative().nullable().default(null),
    }).safeParse(await jsonBody(req));
    if (!parsed.success) {
      return sendError(res, 400, "INVALID_TASK_CONTEXT", `invalid task context: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, "validation");
    }
    if (parsed.data.expectedVersion !== null && parsed.data.expectedVersion !== task.version) {
      return sendError(res, 409, "VERSION_CONFLICT", `expected version ${parsed.data.expectedVersion} but task is at version ${task.version}`, "conflict");
    }
    if (task.conversationContext !== null && task.conversationContext !== undefined) {
      if (task.conversationContext.sessionId !== parsed.data.sessionId || task.conversationContext.threadId !== parsed.data.threadId) {
        return sendError(res, 409, "TASK_CONTEXT_MISMATCH", "task is already attached to another conversation", "conflict");
      }
      return sendJson(res, 200, jsonSafe(task));
    }
    const attachedAt = nowTimestamp();
    const context = { sessionId: parsed.data.sessionId, threadId: parsed.data.threadId, attachedAt };
    const projection = await taskProjectionService.inspectV1(task.id, context);
    if (projection === "thread_not_found") {
      return sendError(res, 409, "TASK_CONTEXT_MISMATCH", "task context must name an existing thread in the supplied session", "conflict");
    }
    if (projection === "context_mismatch") {
      return sendError(res, 409, "TASK_CONTEXT_MISMATCH", "task is already attached to another conversation", "conflict");
    }
    const updated: TaskV2 = {
      ...task,
      conversationContext: context,
      version: task.version + 1,
      updatedAt: attachedAt,
    };
    await emitV2({
      eventType: "task.conversation_context_attached",
      aggregateType: "task",
      aggregateId: id,
      snapshot: updated,
      correlationId: id,
      idempotencyKey: req.headers["idempotency-key"] as string | undefined ?? null,
      mutation: async (tx) => {
        const settled = await taskProjectionService.createV1(tx, task, context);
        if (settled !== "created" && settled !== "existing") {
          throw new Error(`v1 task projection changed during conversation attachment (${settled})`);
        }
      },
    });
    arpV2.tasks.set(id, updated);
    sendJson(res, 200, jsonSafe(updated));
  }),
  route("POST", "/v2/tasks/:id/transition", async (req, res, params) => {
    const id = String(params.id);
    const task = arpV2.tasks.get(id);
    if (!task) return sendError(res, 404, "TASK_NOT_FOUND", "v2 task not found", "not_found");
    const parsed = z.object({
      id: z.string().optional(),
      targetStatus: z.enum(["DRAFT", "READY", "RUNNING", "WAITING_USER", "WAITING_AUTH", "WAITING_RESOURCE", "PAUSED", "VERIFYING", "COMPLETED", "PARTIAL", "BLOCKED", "CANCELLED", "FAILED"]),
      expectedVersion: z.number().int().nonnegative().nullable().default(null),
      reason: z.string().nullable().default(null),
    }).safeParse(await jsonBody(req));
    if (!parsed.success) {
      return sendError(res, 400, "INVALID_TRANSITION_REQUEST", `invalid transition request: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, "validation");
    }
    const { targetStatus, expectedVersion, reason } = parsed.data;
    if (targetStatus === "COMPLETED") {
      return sendError(
        res,
        409,
        "COMPLETION_REQUIRES_ADMISSION",
        "tasks may reach COMPLETED only through verification and candidate admission",
        "policy",
      );
    }
    if (expectedVersion !== null && expectedVersion !== task.version) {
      return sendError(res, 409, "VERSION_CONFLICT", `expected version ${expectedVersion} but task is at version ${task.version}`, "conflict", { expected_version: expectedVersion, actual_version: task.version });
    }
    if (!isTaskV2TransitionAllowed(task.status, targetStatus)) {
      return sendError(res, 409, "ILLEGAL_TRANSITION", `illegal task transition ${task.status} -> ${targetStatus}`, "conflict", { from: task.status, to: targetStatus });
    }
    const terminal = targetStatus === "PARTIAL" || targetStatus === "CANCELLED" || targetStatus === "FAILED";
    const updated: TaskV2 = {
      ...task,
      status: targetStatus,
      version: task.version + 1,
      updatedAt: nowTimestamp(),
      completedAt: terminal ? nowTimestamp() : null,
    };
    await emitV2({
      eventType: `task.${targetStatus.toLowerCase()}`,
      aggregateType: "task",
      aggregateId: id,
      snapshot: updated,
      correlationId: id,
      mutation: async (tx) => {
        await taskProjectionService.projectStatus(tx, id, targetStatus);
      },
    });
    arpV2.tasks.set(id, updated);
    void reason;
    sendJson(res, 200, jsonSafe(updated));
  }),
  route("POST", "/v2/tasks/:id/contract", async (req, res, params) => {
    const id = String(params.id);
    const task = arpV2.tasks.get(id);
    if (!task) return sendError(res, 404, "TASK_NOT_FOUND", "v2 task not found", "not_found");
    const parsed = z.object({
      contract: taskContractV2WireSchema,
      expectedVersion: z.number().int().nonnegative().nullable().default(null),
    }).safeParse(await jsonBody(req));
    if (!parsed.success) {
      return sendError(res, 400, "INVALID_TASK_CONTRACT", `invalid contract update: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, "validation");
    }
    if (isTaskV2Terminal(task.status)) {
      return sendError(res, 409, "TASK_TERMINAL", `terminal task contracts are immutable (${task.status})`, "conflict");
    }
    if (parsed.data.expectedVersion !== null && parsed.data.expectedVersion !== task.version) {
      return sendError(res, 409, "VERSION_CONFLICT", `expected version ${parsed.data.expectedVersion} but task is at version ${task.version}`, "conflict");
    }
    const updated: TaskV2 = {
      ...task,
      contract: parsed.data.contract as TaskContractV2,
      version: task.version + 1,
      updatedAt: nowTimestamp(),
    };
    const bridgedTask = await db.task.findUnique({
      where: { id },
      select: { activeContractVersion: true, status: true },
    });
    if (bridgedTask && updated.contract.version !== bridgedTask.activeContractVersion + 1) {
      return sendError(
        res,
        409,
        "CONTRACT_VERSION_CONFLICT",
        `bridged v1 task requires contract version ${bridgedTask.activeContractVersion + 1}`,
        "conflict",
      );
    }
    if (bridgedTask && !isMutableV1TaskStatus(bridgedTask.status)) {
      return sendError(res, 409, "TASK_TERMINAL", `terminal v1 task contracts are immutable (${bridgedTask.status})`, "conflict");
    }
    await emitV2({
      eventType: "task.contract_updated",
      aggregateType: "task",
      aggregateId: id,
      snapshot: updated,
      correlationId: id,
      mutation: async (tx) => {
        await taskProjectionService.projectContract(tx, id, updated.contract);
      },
    });
    arpV2.tasks.set(id, updated);
    sendJson(res, 200, jsonSafe(updated));
  }),
  route("POST", "/v2/effects", async (req, res) => {
    const parsed = V2_ENDPOINTS.ProposeEffectV2.request.safeParse(await jsonBody(req));
    if (!parsed.success) {
      return sendError(res, 400, "INVALID_EFFECT_REQUEST", `invalid effect proposal: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, "validation");
    }
    const body = parsed.data;
    const task = arpV2.tasks.get(body.taskId);
    if (!task) {
      return sendError(res, 404, "TASK_NOT_FOUND", `v2 task ${body.taskId} not found`, "not_found");
    }
    if (isTaskV2Terminal(task.status)) {
      return sendError(res, 409, "TASK_TERMINAL", `terminal task cannot propose effects (${task.status})`, "conflict");
    }
    const existing = [...arpV2.effects.values()].find((e) => e.semanticIdempotencyKey === body.semanticIdempotencyKey);
    if (existing) {
      return sendV2Response(res, 200, V2_ENDPOINTS.ProposeEffectV2.response, existing);
    }
    const effect: EffectRecord = {
      id: uuid(),
      taskId: body.taskId,
      attemptId: body.attemptId,
      principal: SERVER_PRINCIPAL,
      connectorOrWorker: body.connectorOrWorker,
      intentType: body.intentType,
      canonicalParameters: body.canonicalParameters,
      resourceHandles: body.resourceHandles,
      effectClass: body.effectClass,
      semanticIdempotencyKey: body.semanticIdempotencyKey,
      authorizationId: null,
      policyDecisionId: null,
      state: "PROPOSED",
      uncertaintyReason: null,
      compensationRef: null,
      version: 0,
      createdAt: nowTimestamp(),
      settledAt: null,
    };
    await emitV2({
      eventType: "effect.proposed",
      aggregateType: "effect",
      aggregateId: effect.id,
      snapshot: effect,
      idempotencyKey: body.semanticIdempotencyKey,
      correlationId: effect.taskId,
    });
    arpV2.effects.set(effect.id, effect);
    sendV2Response(res, 201, V2_ENDPOINTS.ProposeEffectV2.response, effect);
  }),
  route("GET", "/v2/effects/:id", async (_req, res, params) => {
    const effect = arpV2.effects.get(String(params.id));
    if (!effect) return sendError(res, 404, "EFFECT_NOT_FOUND", "v2 effect not found", "not_found");
    sendJson(res, 200, jsonSafe(effect));
  }),
  route("GET", "/v2/effects", async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const taskId = url.searchParams.get("taskId");
    const all = [...arpV2.effects.values()]
      .filter((e) => !taskId || e.taskId === taskId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    sendJson(res, 200, { effects: jsonSafe(all) });
  }),
  route("POST", "/v2/effects/:id/transition", async (req, res, params) => {
    const id = String(params.id);
    const effect = arpV2.effects.get(id);
    if (!effect) return sendError(res, 404, "EFFECT_NOT_FOUND", "v2 effect not found", "not_found");
    const parsed = z.object({
      targetState: z.enum(["PROPOSED", "POLICY_CHECKED", "AUTHORIZATION_REQUIRED", "AUTHORIZED", "PREPARED", "DISPATCHED", "OBSERVED", "VALIDATED", "COMMITTED", "DENIED", "CANCELLED", "UNCERTAIN", "RECONCILING", "COMPENSATING", "COMPENSATED", "RESIDUE", "MANUAL_RECONCILE"]),
      expectedVersion: z.number().int().nonnegative().nullable().default(null),
      reason: z.string().nullable().default(null),
    }).safeParse(await jsonBody(req));
    if (!parsed.success) {
      return sendError(res, 400, "INVALID_TRANSITION_REQUEST", `invalid effect transition: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, "validation");
    }
    const { targetState, expectedVersion } = parsed.data;
    if (expectedVersion !== null && expectedVersion !== effect.version) {
      return sendError(res, 409, "VERSION_CONFLICT", `expected version ${expectedVersion} but effect is at version ${effect.version}`, "conflict", { expected_version: expectedVersion, actual_version: effect.version });
    }
    if (!isEffectTransitionAllowed(effect.state, targetState)) {
      return sendError(res, 409, "ILLEGAL_TRANSITION", `illegal effect transition ${effect.state} -> ${targetState}`, "conflict", { from: effect.state, to: targetState });
    }
    sendError(
      res,
      503,
      "EXTERNAL_DEPENDENCY_FAILED",
      "Effect advancement requires a verified policy, authorization, dispatch, observation, denial, or cancellation receipt; the standalone control plane did not change state",
      "external_dependency",
      { effectId: effect.id, from: effect.state, requestedState: targetState },
    );
  }),
  // Semantic alias: authorize an authorization-gated effect (POLICY_CHECKED |
  // AUTHORIZATION_REQUIRED → AUTHORIZED). Strict — no state skipping.
  route("POST", "/v2/effects/:id/authorize", async (req, res, params) => {
    const id = String(params.id);
    const effect = arpV2.effects.get(id);
    if (!effect) return sendError(res, 404, "EFFECT_NOT_FOUND", "v2 effect not found", "not_found");
    const body = await jsonBody(req);
    const parsed = V2_ENDPOINTS.AuthorizeEffectV2.request.safeParse({
      ...(typeof body === "object" && body !== null && !Array.isArray(body) ? body : {}),
      id,
    });
    if (!parsed.success) {
      return sendError(res, 400, "INVALID_AUTHORIZATION", "authorizationId is required", "validation");
    }
    if (effect.state !== "POLICY_CHECKED" && effect.state !== "AUTHORIZATION_REQUIRED") {
      return sendError(res, 409, "ILLEGAL_TRANSITION", `effect in state ${effect.state} cannot be authorized`, "conflict", { from: effect.state });
    }
    sendError(
      res,
      503,
      "EXTERNAL_DEPENDENCY_FAILED",
      "No durable policy/approval authorization broker is configured; the authorization reference was not consumed and the effect was not authorized",
      "external_dependency",
      { effectId: effect.id, authorizationId: parsed.data.authorizationId },
    );
  }),
  // Semantic alias: commit a validated effect (VALIDATED → COMMITTED). Strict.
  route("POST", "/v2/effects/:id/commit", async (req, res, params) => {
    const id = String(params.id);
    const effect = arpV2.effects.get(id);
    if (!effect) return sendError(res, 404, "EFFECT_NOT_FOUND", "v2 effect not found", "not_found");
    const body = await jsonBody(req);
    const parsed = V2_ENDPOINTS.CommitEffectV2.request.safeParse({
      ...(typeof body === "object" && body !== null && !Array.isArray(body) ? body : {}),
      id,
    });
    if (!parsed.success) {
      return sendError(res, 400, "INVALID_COMMIT_REQUEST", "a validation receipt artifact is required", "validation");
    }
    if (parsed.data.expectedVersion !== null && parsed.data.expectedVersion !== effect.version) {
      return sendError(res, 409, "VERSION_CONFLICT", `expected version ${parsed.data.expectedVersion} but effect is at version ${effect.version}`, "conflict");
    }
    if (effect.state !== "VALIDATED") {
      return sendError(res, 409, "ILLEGAL_TRANSITION", `effect in state ${effect.state} cannot be committed; it must reach VALIDATED first`, "conflict", { from: effect.state });
    }
    sendError(
      res,
      503,
      "EXTERNAL_DEPENDENCY_FAILED",
      "No trusted validation-receipt verifier is configured; the effect remains VALIDATED and was not committed",
      "external_dependency",
      {
        effectId: effect.id,
        validationReceiptArtifactUri: parsed.data.validationReceiptArtifactRef.uri,
      },
    );
  }),
  route("POST", "/v2/effects/:id/reconcile", async (req, res, params) => {
    const id = String(params.id);
    const effect = arpV2.effects.get(id);
    if (!effect) return sendError(res, 404, "EFFECT_NOT_FOUND", "v2 effect not found", "not_found");
    const body = await jsonBody(req);
    const parsed = V2_ENDPOINTS.ReconcileEffectV2.request.safeParse({
      ...(typeof body === "object" && body !== null && !Array.isArray(body) ? body : {}),
      id,
    });
    if (!parsed.success) {
      return sendError(res, 400, "INVALID_RECONCILIATION", "a trusted reconciliation receipt is required", "validation");
    }
    sendError(
      res,
      503,
      "EXTERNAL_DEPENDENCY_FAILED",
      "No trusted reconciliation-receipt verifier is configured; the effect state was not changed",
      "external_dependency",
      {
        effectId: effect.id,
        receiptArtifactUri: parsed.data.reconciliationReceipt.receiptArtifactRef.uri,
      },
    );
  }),
  route("POST", "/v2/authorizations", async (req, res) => {
    const parsed = z.object({
      taskId: z.string().min(1),
      taskVersion: z.number().int().nonnegative().default(1),
      effectClass: z.string().min(1),
      maxScope: z.array(z.string()).default([]),
      useLimit: z.number().int().positive().default(1),
      expiry: z.string().default(new Date(Date.now() + 300_000).toISOString()),
      approvalHash: z.string().nullable().default(null),
      humanApprovalId: z.string().nullable().default(null),
    }).safeParse(await jsonBody(req));
    if (!parsed.success) {
      return sendError(res, 400, "INVALID_AUTHORIZATION_REQUEST", `invalid authorization request: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, "validation");
    }
    sendError(
      res,
      503,
      "EXTERNAL_DEPENDENCY_FAILED",
      "Authorizations are created only by the durable policy/approval broker; public caller-authored authorization minting is disabled",
      "external_dependency",
      { taskId: parsed.data.taskId, effectClass: parsed.data.effectClass },
    );
  }),
  route("GET", "/v2/authorizations/:id", async (_req, res, params) => {
    const authz = arpV2.authorizations.get(String(params.id));
    if (!authz) return sendError(res, 404, "AUTHORIZATION_NOT_FOUND", "v2 authorization not found", "not_found");
    sendJson(res, 200, jsonSafe(authz));
  }),
  route("GET", "/v2/authorizations", async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const taskId = url.searchParams.get("taskId");
    const all = [...arpV2.authorizations.values()]
      .filter((a) => !taskId || a.taskId === taskId);
    sendJson(res, 200, { authorizations: jsonSafe(all) });
  }),
  route("POST", "/v2/authorizations/:id/consume", async (req, res, params) => {
    const id = String(params.id);
    const authz = arpV2.authorizations.get(id);
    if (!authz) return sendError(res, 404, "AUTHORIZATION_NOT_FOUND", "v2 authorization not found", "not_found");
    const parsed = z.object({
      taskId: z.string().min(1),
      taskVersion: z.number().int().nonnegative(),
      effectClass: z.string().min(1),
      approvalHash: z.string().nullable().default(null),
    }).safeParse(await jsonBody(req));
    if (!parsed.success) {
      return sendError(res, 400, "INVALID_CONSUME_REQUEST", "invalid consume request", "validation");
    }
    const { taskId, taskVersion, effectClass } = parsed.data;
    if (authz.taskId !== taskId) {
      return sendError(res, 403, "CROSS_TASK_REJECTED", `authorization ${id} is bound to task ${authz.taskId}`, "forbidden");
    }
    if (authz.taskVersion !== taskVersion) {
      return sendError(res, 409, "STALE_VERSION_REJECTED", `authorization ${id} is bound to task version ${authz.taskVersion}`, "conflict");
    }
    if (authz.effectClass !== effectClass && authz.effectClass !== "ADMIN") {
      return sendError(res, 403, "EFFECT_CLASS_MISMATCH", `authorization authorizes ${authz.effectClass}, requested ${effectClass}`, "forbidden");
    }
    sendError(
      res,
      503,
      "EXTERNAL_DEPENDENCY_FAILED",
      "Authorization consumption is performed only by the durable effect dispatcher with exact operation binding; no authorization was consumed",
      "external_dependency",
      { authorizationId: id, taskId, taskVersion, effectClass },
    );
  }),
  route("POST", "/v2/authorizations/:id/revoke", async (_req, res, params) => {
    const id = String(params.id);
    const authz = arpV2.authorizations.get(id);
    if (!authz) return sendError(res, 404, "AUTHORIZATION_NOT_FOUND", "v2 authorization not found", "not_found");
    sendError(
      res,
      503,
      "EXTERNAL_DEPENDENCY_FAILED",
      "Authorization revocation requires an attributable policy-broker principal; no authorization was changed",
      "external_dependency",
      { authorizationId: id, taskId: authz.taskId },
    );
  }),
  route("GET", "/v2/claims", async (req, res) => {
    const taskId = new URL(req.url ?? "", "http://terminus.local").searchParams.get("taskId");
    if (taskId !== null && !arpV2.tasks.has(taskId)) {
      return sendError(res, 404, "TASK_NOT_FOUND", `v2 task ${taskId} not found`, "not_found");
    }
    const claims = [...arpV2.claims.values()]
      .filter((claim) => taskId === null || claim.taskId === taskId)
      .map((claim) => jsonSafe(claim));
    sendJson(res, 200, { claims });
  }),
  route("POST", "/v2/claims", async (req, res) => {
    const parsed = z.object({
      taskId: z.string().min(1),
      statement: z.string().min(1),
      requiredEvidenceKind: z.string().min(1),
    }).safeParse(await jsonBody(req));
    if (!parsed.success) {
      return sendError(res, 400, "INVALID_CLAIM", `invalid claim: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, "validation");
    }
    const task = arpV2.tasks.get(parsed.data.taskId);
    if (!task) {
      return sendError(res, 404, "TASK_NOT_FOUND", `v2 task ${parsed.data.taskId} not found`, "not_found");
    }
    if (isTaskV2Terminal(task.status)) {
      return sendError(res, 409, "TASK_TERMINAL", `terminal task cannot create claims (${task.status})`, "conflict");
    }
    const nowIso = nowTimestamp();
    const claim: Claim = {
      id: uuid(),
      taskId: parsed.data.taskId,
      statement: parsed.data.statement,
      requiredEvidenceKind: parsed.data.requiredEvidenceKind,
      status: "PROPOSED",
      evidenceIds: [],
      waivedRationale: null,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    await emitV2({ eventType: "claim.proposed", aggregateType: "claim", aggregateId: claim.id, snapshot: claim, correlationId: claim.taskId });
    arpV2.claims.set(claim.id, claim);
    sendJson(res, 201, jsonSafe(claim));
  }),
  route("POST", "/v2/claims/:id/waive", async (req, res, params) => {
    const id = String(params.id);
    const claim = arpV2.claims.get(id);
    if (!claim) return sendError(res, 404, "CLAIM_NOT_FOUND", "v2 claim not found", "not_found");
    const parsed = z.object({ rationale: z.string().min(1) }).safeParse(await jsonBody(req));
    if (!parsed.success) {
      return sendError(res, 400, "INVALID_WAIVER", "a non-empty rationale is required to waive a claim", "validation");
    }
    const updated: Claim = { ...claim, status: "WAIVED", waivedRationale: parsed.data.rationale, updatedAt: nowTimestamp() };
    await emitV2({ eventType: "claim.waived", aggregateType: "claim", aggregateId: id, snapshot: updated, correlationId: claim.taskId });
    arpV2.claims.set(id, updated);
    sendJson(res, 200, jsonSafe(updated));
  }),
  route("GET", "/v2/evidence", async (req, res) => {
    const taskId = new URL(req.url ?? "", "http://terminus.local").searchParams.get("taskId");
    if (taskId !== null && !arpV2.tasks.has(taskId)) {
      return sendError(res, 404, "TASK_NOT_FOUND", `v2 task ${taskId} not found`, "not_found");
    }
    const claimIds = taskId === null
      ? null
      : new Set([...arpV2.claims.values()]
        .filter((claim) => claim.taskId === taskId)
        .map((claim) => claim.id));
    const evidence = [...arpV2.evidences.values()]
      .filter((item) => claimIds === null || claimIds.has(item.claimId))
      .map((item) => jsonSafe(item));
    sendJson(res, 200, { evidence });
  }),
  route("POST", "/v2/evidence", async (req, res) => {
    const parsed = V2_ENDPOINTS.RecordEvidenceV2.request.safeParse(await jsonBody(req));
    if (!parsed.success) {
      return sendError(res, 400, "INVALID_EVIDENCE", "a trusted verifier receipt reference is required", "validation");
    }
    const claim = arpV2.claims.get(parsed.data.claimId);
    if (!claim) return sendError(res, 404, "CLAIM_NOT_FOUND", `v2 claim ${parsed.data.claimId} not found`, "not_found");
    sendError(
      res,
      503,
      "EXTERNAL_DEPENDENCY_FAILED",
      "No trusted verifier-receipt validator is configured; evidence was not admitted and the claim remains unchanged",
      "external_dependency",
      {
        claimId: claim.id,
        verifierId: parsed.data.verifierId,
        verifierVersion: parsed.data.verifierVersion,
        receiptArtifactUri: parsed.data.receipt.receiptArtifactRef.uri,
      },
    );
  }),
  // ────────────────────────── /v2/workflows ─────────────────────────────────
  route("POST", "/v2/workflows", async (req, res) => {
    const parsed = z.object({
      taskId: z.string().min(1),
      nodes: z.array(workflowNodeSchema).min(1),
      edges: z.array(guardedEdgeSchema).default([]),
    }).safeParse(await jsonBody(req));
    if (!parsed.success) {
      return sendError(res, 400, "INVALID_WORKFLOW", `invalid workflow: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, "validation");
    }
    if (!arpV2.tasks.has(parsed.data.taskId)) {
      return sendError(res, 404, "TASK_NOT_FOUND", `v2 task ${parsed.data.taskId} not found`, "not_found");
    }
    const report = validateWorkflow({ nodes: parsed.data.nodes, edges: parsed.data.edges });
    if (!report.valid) {
      return sendError(res, 400, "WORKFLOW_VALIDATION_FAILED", `workflow failed static validation: ${report.errors.map((e) => e.message).join("; ")}`, "validation", { report });
    }
    const nowIso = nowTimestamp();
    const workflow: Workflow = {
      id: uuid(),
      version: 1,
      taskId: parsed.data.taskId,
      nodes: parsed.data.nodes,
      edges: parsed.data.edges,
      staticAnalysis: report,
      createdAt: nowIso,
    };
    await emitV2({ eventType: "workflow.created", aggregateType: "workflow", aggregateId: workflow.id, snapshot: workflow, correlationId: workflow.taskId });
    arpV2.workflows.set(workflow.id, workflow);
    sendJson(res, 201, jsonSafe(workflow));
  }),
  route("POST", "/v2/workflows/compile", async (req, res) => {
    const parsed = z.object({
      source: z.string().min(1),
      sourceKind: z.enum(["skill_markdown", "json_ir", "prose_spec"]).default("skill_markdown"),
      sourcePath: z.string().optional(),
      taskId: z.string().optional(),
      authorityCeiling: z.array(z.string()).optional(),
      mandatorySteps: z.array(z.string()).optional(),
      strictMode: z.boolean().default(false),
    }).safeParse(await jsonBody(req));
    if (!parsed.success) {
      return sendError(res, 400, "INVALID_COMPILE_REQUEST", "invalid compile parameters", "validation");
    }
    try {
      let result;
      if (parsed.data.sourceKind === "skill_markdown") {
        result = compileSkill(parsed.data.source, {
          sourcePath: parsed.data.sourcePath,
          taskId: parsed.data.taskId,
          authorityCeiling: parsed.data.authorityCeiling,
          mandatorySteps: parsed.data.mandatorySteps,
          strictMode: parsed.data.strictMode,
        });
      } else {
        result = compileWorkflowJson(parsed.data.source, {
          sourcePath: parsed.data.sourcePath,
          taskId: parsed.data.taskId,
          authorityCeiling: parsed.data.authorityCeiling,
          mandatorySteps: parsed.data.mandatorySteps,
          strictMode: parsed.data.strictMode,
        });
      }
      await emitV2({ eventType: "workflow.compiled", aggregateType: "workflow", aggregateId: result.workflow.id, snapshot: result.workflow, correlationId: result.workflow.taskId });
      arpV2.workflows.set(result.workflow.id, result.workflow);
      sendJson(res, 200, jsonSafe({ workflow: result.workflow, report: result.report }));
    } catch (err: unknown) {
      logInternalError("workflow compilation failed", err);
      return sendError(res, 400, "COMPILATION_FAILED", "workflow source failed validation", "validation");
    }
  }),
  route("POST", "/v2/workflows/validate", async (req, res) => {
    const parsed = z.object({
      nodes: z.array(workflowNodeSchema).min(1),
      edges: z.array(guardedEdgeSchema).default([]),
      authorityCeiling: z.array(z.string()).optional(),
      mandatorySteps: z.array(z.string()).optional(),
      strictMode: z.boolean().default(false),
    }).safeParse(await jsonBody(req));
    if (!parsed.success) {
      return sendError(res, 400, "INVALID_VALIDATE_REQUEST", "invalid validation payload", "validation");
    }
    const report = validateWorkflow({
      nodes: parsed.data.nodes,
      edges: parsed.data.edges,
      authorityCeiling: parsed.data.authorityCeiling,
      mandatorySteps: parsed.data.mandatorySteps,
    }, { strictMode: parsed.data.strictMode });
    sendJson(res, 200, jsonSafe(report));
  }),
  route("GET", "/v2/workflows/:id", async (_req, res, params) => {
    const wf = arpV2.workflows.get(String(params.id));
    if (!wf) return sendError(res, 404, "WORKFLOW_NOT_FOUND", "workflow not found", "not_found");
    sendJson(res, 200, jsonSafe(wf));
  }),
  route("GET", "/v2/workflows/:id/dag", async (_req, res, params) => {
    const wf = arpV2.workflows.get(String(params.id));
    if (!wf) return sendError(res, 404, "WORKFLOW_NOT_FOUND", "workflow not found", "not_found");
    const nodes = wf.nodes.map((n) => ({ id: n.id, kind: n.kind, owner: n.owner, effectClass: n.effectClass }));
    const edges = wf.edges.map((e) => ({ sourceNodeId: e.sourceNodeId, targetNodeId: e.targetNodeId, condition: e.condition }));
    sendJson(res, 200, jsonSafe({ workflowId: wf.id, nodes, edges }));
  }),
  route("GET", "/v2/workflows/:id/witness-paths", async (_req, res, params) => {
    const wf = arpV2.workflows.get(String(params.id));
    if (!wf) return sendError(res, 404, "WORKFLOW_NOT_FOUND", "workflow not found", "not_found");
    const witnessPaths = wf.staticAnalysis?.witnessPaths ?? [];
    sendJson(res, 200, jsonSafe({ workflowId: wf.id, witnessPaths }));
  }),
  route("POST", "/v2/workflows/:id/nodes/:nodeId/execute", async (req, res, params) => {
    const wf = arpV2.workflows.get(String(params.id));
    if (!wf) return sendError(res, 404, "WORKFLOW_NOT_FOUND", "workflow not found", "not_found");
    const node = wf.nodes.find((n) => n.id === params.nodeId);
    if (!node) return sendError(res, 404, "NODE_NOT_FOUND", `node ${params.nodeId} not found in workflow`, "not_found");
    const parsed = z.object({
      attemptId: z.string().min(1),
      inputs: z.record(z.string(), z.unknown()).default({}),
    }).safeParse(await jsonBody(req));
    if (!parsed.success) {
      return sendError(res, 400, "INVALID_NODE_EXECUTION", "invalid node execution request", "validation");
    }
    const nowIso = nowTimestamp();
    const nodeRun: NodeRun = {
      id: uuid(),
      workflowId: wf.id,
      nodeId: node.id,
      attemptId: parsed.data.attemptId,
      status: "RUNNING",
      inputs: { ...node.inputs, ...parsed.data.inputs },
      outputs: null,
      error: null,
      startedAt: nowIso,
      settledAt: null,
    };
    await emitV2({ eventType: "workflow.node_started", aggregateType: "node_run", aggregateId: nodeRun.id, snapshot: nodeRun, correlationId: wf.taskId });
    arpV2.nodeRuns.set(nodeRun.id, nodeRun);
    sendJson(res, 201, jsonSafe(nodeRun));
  }),
  route("POST", "/v2/workflows/:id/nodes/:nodeRunId/complete", async (req, res, params) => {
    const run = arpV2.nodeRuns.get(String(params.nodeRunId));
    if (!run) return sendError(res, 404, "NODE_RUN_NOT_FOUND", "node run not found", "not_found");
    if (!isNodeRunTransitionAllowed(run.status, "COMPLETED")) {
      return sendError(res, 409, "ILLEGAL_TRANSITION", `cannot transition node run from ${run.status} to COMPLETED`, "conflict");
    }
    const parsed = z.object({ outputs: z.record(z.string(), z.unknown()).default({}) }).safeParse(await jsonBody(req));
    if (!parsed.success) return sendError(res, 400, "INVALID_COMPLETION", "invalid completion outputs", "validation");
    const updated: NodeRun = { ...run, status: "COMPLETED", outputs: parsed.data.outputs, settledAt: nowTimestamp() };
    await emitV2({ eventType: "workflow.node_completed", aggregateType: "node_run", aggregateId: run.id, snapshot: updated, correlationId: run.workflowId });
    arpV2.nodeRuns.set(run.id, updated);
    sendJson(res, 200, jsonSafe(updated));
  }),
  route("POST", "/v2/workflows/:id/nodes/:nodeRunId/fail", async (req, res, params) => {
    const run = arpV2.nodeRuns.get(String(params.nodeRunId));
    if (!run) return sendError(res, 404, "NODE_RUN_NOT_FOUND", "node run not found", "not_found");
    if (!isNodeRunTransitionAllowed(run.status, "FAILED")) {
      return sendError(res, 409, "ILLEGAL_TRANSITION", `cannot transition node run from ${run.status} to FAILED`, "conflict");
    }
    const parsed = z.object({ error: z.string().min(1) }).safeParse(await jsonBody(req));
    if (!parsed.success) return sendError(res, 400, "INVALID_FAILURE", "error message is required", "validation");
    const updated: NodeRun = { ...run, status: "FAILED", error: parsed.data.error, settledAt: nowTimestamp() };
    await emitV2({ eventType: "workflow.node_failed", aggregateType: "node_run", aggregateId: run.id, snapshot: updated, correlationId: run.workflowId });
    arpV2.nodeRuns.set(run.id, updated);
    sendJson(res, 200, jsonSafe(updated));
  }),
  // ────────────────────────── /v2/leases ────────────────────────────────────
  route("POST", "/v2/leases/acquire", async (req, res) => {
    const parsed = z.object({
      taskId: z.string().min(1),
      workerId: z.string().min(1),
      ttlSeconds: z.number().int().positive().default(30),
    }).safeParse(await jsonBody(req));
    if (!parsed.success) return sendError(res, 400, "INVALID_LEASE_REQUEST", "invalid lease acquire payload", "validation");
    const { taskId, workerId, ttlSeconds } = parsed.data;
    if (!arpV2.tasks.has(taskId)) return sendError(res, 404, "TASK_NOT_FOUND", `task ${taskId} not found`, "not_found");

    // Monotonic fencing token per task
    let maxFencingToken = 0;
    for (const lease of arpV2.workerLeases.values()) {
      if (lease.taskId === taskId) {
        maxFencingToken = Math.max(maxFencingToken, lease.fencingToken);
        if (lease.status === "ACQUIRED" || lease.status === "RENEWED") {
          const fenced: WorkerLease = { ...lease, status: "FENCED" };
          await emitV2({ eventType: "lease.fenced", aggregateType: "lease", aggregateId: lease.id, snapshot: fenced, correlationId: taskId });
          arpV2.workerLeases.set(lease.id, fenced);
        }
      }
    }

    const now = new Date();
    const expires = new Date(now.getTime() + ttlSeconds * 1000);
    const newLease: WorkerLease = {
      id: uuid(),
      taskId,
      workerId,
      fencingToken: maxFencingToken + 1,
      status: "ACQUIRED",
      acquiredAt: now.toISOString() as Rfc3339Timestamp,
      expiresAt: expires.toISOString() as Rfc3339Timestamp,
      releasedAt: null,
      metadata: {},
    };
    await emitV2({ eventType: "lease.acquired", aggregateType: "lease", aggregateId: newLease.id, snapshot: newLease, correlationId: taskId });
    arpV2.workerLeases.set(newLease.id, newLease);
    sendJson(res, 201, jsonSafe(newLease));
  }),
  route("POST", "/v2/leases/renew", async (req, res) => {
    const parsed = z.object({
      leaseId: z.string().min(1),
      fencingToken: z.number().int().positive(),
      workerId: z.string().min(1),
      ttlSeconds: z.number().int().positive().default(30),
    }).safeParse(await jsonBody(req));
    if (!parsed.success) return sendError(res, 400, "INVALID_RENEW_REQUEST", "invalid lease renew payload", "validation");
    const { leaseId, fencingToken, workerId, ttlSeconds } = parsed.data;
    const lease = arpV2.workerLeases.get(leaseId);
    if (!lease) return sendError(res, 404, "LEASE_NOT_FOUND", "lease not found", "not_found");
    if (lease.workerId !== workerId || lease.fencingToken !== fencingToken) {
      return sendError(res, 409, "FENCING_ERROR", "worker or fencing token mismatch", "conflict");
    }
    if (!isLeaseTransitionAllowed(lease.status, "RENEWED")) {
      return sendError(res, 409, "ILLEGAL_TRANSITION", `cannot renew lease in status ${lease.status}`, "conflict");
    }
    const now = new Date();
    const expires = new Date(now.getTime() + ttlSeconds * 1000);
    const updated: WorkerLease = {
      ...lease,
      status: "RENEWED",
      expiresAt: expires.toISOString() as Rfc3339Timestamp,
    };
    await emitV2({ eventType: "lease.renewed", aggregateType: "lease", aggregateId: lease.id, snapshot: updated, correlationId: lease.taskId });
    arpV2.workerLeases.set(lease.id, updated);
    sendJson(res, 200, jsonSafe(updated));
  }),
  route("POST", "/v2/leases/release", async (req, res) => {
    const parsed = z.object({
      leaseId: z.string().min(1),
      fencingToken: z.number().int().positive(),
      workerId: z.string().min(1),
    }).safeParse(await jsonBody(req));
    if (!parsed.success) return sendError(res, 400, "INVALID_RELEASE_REQUEST", "invalid lease release payload", "validation");
    const { leaseId, fencingToken, workerId } = parsed.data;
    const lease = arpV2.workerLeases.get(leaseId);
    if (!lease) return sendError(res, 404, "LEASE_NOT_FOUND", "lease not found", "not_found");
    if (lease.workerId !== workerId || lease.fencingToken !== fencingToken) {
      return sendError(res, 409, "FENCING_ERROR", "worker or fencing token mismatch", "conflict");
    }
    const updated: WorkerLease = { ...lease, status: "RELEASED" };
    await emitV2({ eventType: "lease.released", aggregateType: "lease", aggregateId: lease.id, snapshot: updated, correlationId: lease.taskId });
    arpV2.workerLeases.set(lease.id, updated);
    sendJson(res, 200, jsonSafe(updated));
  }),
  route("GET", "/v2/leases/:taskId", async (_req, res, params) => {
    const active = [...arpV2.workerLeases.values()]
      .filter((l) => l.taskId === params.taskId && (l.status === "ACQUIRED" || l.status === "RENEWED"))
      .pop();
    if (!active) return sendError(res, 404, "NO_ACTIVE_LEASE", `no active lease for task ${params.taskId}`, "not_found");
    sendJson(res, 200, jsonSafe(active));
  }),
  // ────────────────────────── /v2/tasks/:id/attempts ────────────────────────
  route("POST", "/v2/tasks/:id/attempts/start", async (req, res, params) => {
    const taskId = String(params.id);
    const parsed = z.object({
      workerId: z.string().min(1),
      fencingToken: z.number().int().positive(),
    }).safeParse(await jsonBody(req));
    if (!parsed.success) return sendError(res, 400, "INVALID_ATTEMPT_REQUEST", "invalid start attempt payload", "validation");
    const { workerId, fencingToken } = parsed.data;
    const lease = [...arpV2.workerLeases.values()]
      .find((l) => l.taskId === taskId && l.workerId === workerId && l.fencingToken === fencingToken && (l.status === "ACQUIRED" || l.status === "RENEWED"));
    if (!lease) {
      return sendError(res, 403, "FENCING_ERROR", "worker does not hold active valid lease with matching fencing token", "auth");
    }
    const attempts = [...arpV2.attempts.values()].filter((a) => a.taskId === taskId);
    const attempt: TaskAttempt = {
      id: uuid(),
      taskId,
      attemptNumber: attempts.length + 1,
      workerId,
      fencingToken,
      status: "RUNNING",
      startedAt: nowTimestamp(),
      settledAt: null,
      error: null,
    };
    await emitV2({ eventType: "attempt.started", aggregateType: "attempt", aggregateId: attempt.id, snapshot: attempt, correlationId: taskId });
    arpV2.attempts.set(attempt.id, attempt);
    sendJson(res, 201, jsonSafe(attempt));
  }),
  route("POST", "/v2/tasks/:id/attempts/:attemptId/settle", async (req, res, params) => {
    const taskId = String(params.id);
    const attempt = arpV2.attempts.get(String(params.attemptId));
    if (!attempt) return sendError(res, 404, "ATTEMPT_NOT_FOUND", "attempt not found", "not_found");
    if (attempt.taskId !== taskId) {
      return sendError(res, 404, "ATTEMPT_NOT_FOUND", "attempt not found for task", "not_found");
    }
    const parsed = z.object({
      status: z.enum(["COMPLETED", "FAILED"]),
      error: z.string().nullable().default(null),
      workerId: z.string().min(1),
      fencingToken: z.number().int().positive(),
      settlementReceipt: TrustedReceiptReferenceWire,
    }).strict().safeParse(await jsonBody(req));
    if (!parsed.success) return sendError(res, 400, "INVALID_SETTLEMENT", "worker fencing and a trusted settlement receipt reference are required", "validation");
    if (attempt.workerId !== parsed.data.workerId || attempt.fencingToken !== parsed.data.fencingToken) {
      return sendError(res, 409, "FENCING_ERROR", "worker or fencing token mismatch", "conflict");
    }
    if (!isAttemptTransitionAllowed(attempt.status, parsed.data.status)) {
      return sendError(res, 409, "ILLEGAL_TRANSITION", `cannot transition attempt from ${attempt.status} to ${parsed.data.status}`, "conflict");
    }
    sendError(
      res,
      503,
      "EXTERNAL_DEPENDENCY_FAILED",
      "No trusted worker-settlement receipt verifier is configured; the attempt was not settled",
      "external_dependency",
      {
        attemptId: attempt.id,
        requestedStatus: parsed.data.status,
        receiptArtifactUri: parsed.data.settlementReceipt.receiptArtifactRef.uri,
      },
    );
  }),
  // ────────────────────────── /v2/questions ─────────────────────────────────
  route("POST", "/v2/questions", async (req, res) => {
    const parsed = z.object({
      taskId: z.string().min(1),
      prompt: z.string().min(1),
      options: z.array(z.string()).default([]),
    }).safeParse(await jsonBody(req));
    if (!parsed.success) return sendError(res, 400, "INVALID_QUESTION", "invalid question payload", "validation");
    const q: Question = {
      id: uuid(),
      taskId: parsed.data.taskId,
      prompt: parsed.data.prompt,
      options: parsed.data.options,
      selectedOption: null,
      rationale: null,
      status: "PENDING",
      createdAt: nowTimestamp(),
      resolvedAt: null,
    };
    await emitV2({ eventType: "question.asked", aggregateType: "question", aggregateId: q.id, snapshot: q, correlationId: q.taskId });
    arpV2.questions.set(q.id, q);
    sendJson(res, 201, jsonSafe(q));
  }),
  route("POST", "/v2/questions/:id/answer", async (req, res, params) => {
    const q = arpV2.questions.get(String(params.id));
    if (!q) return sendError(res, 404, "QUESTION_NOT_FOUND", "question not found", "not_found");
    const parsed = z.object({
      selectedOption: z.string().min(1),
      rationale: z.string().nullable().default(null),
    }).safeParse(await jsonBody(req));
    if (!parsed.success) return sendError(res, 400, "INVALID_ANSWER", "invalid question answer payload", "validation");
    const updated: Question = {
      ...q,
      selectedOption: parsed.data.selectedOption,
      rationale: parsed.data.rationale,
      status: "ANSWERED",
      resolvedAt: nowTimestamp(),
    };
    await emitV2({ eventType: "question.answered", aggregateType: "question", aggregateId: q.id, snapshot: updated, correlationId: q.taskId });
    arpV2.questions.set(q.id, updated);
    sendJson(res, 200, jsonSafe(updated));
  }),
  route("POST", "/v2/questions/:id/dismiss", async (_req, res, params) => {
    const q = arpV2.questions.get(String(params.id));
    if (!q) return sendError(res, 404, "QUESTION_NOT_FOUND", "question not found", "not_found");
    const updated: Question = { ...q, status: "DISMISSED", resolvedAt: nowTimestamp() };
    await emitV2({ eventType: "question.dismissed", aggregateType: "question", aggregateId: q.id, snapshot: updated, correlationId: q.taskId });
    arpV2.questions.set(q.id, updated);
    sendJson(res, 200, jsonSafe(updated));
  }),
  // ────────────────────────── /v2/decisions ─────────────────────────────────
  route("POST", "/v2/decisions", async (req, res) => {
    const parsed = z.object({
      taskId: z.string().min(1),
      statement: z.string().min(1),
      rationale: z.string().min(1),
      provenance: z.string().min(1),
      questionId: z.string().nullable().default(null),
      alternativesConsidered: z.array(z.string()).default([]),
    }).safeParse(await jsonBody(req));
    if (!parsed.success) return sendError(res, 400, "INVALID_DECISION", "invalid decision payload", "validation");
    const d: Decision = {
      id: uuid(),
      taskId: parsed.data.taskId,
      questionId: parsed.data.questionId,
      statement: parsed.data.statement,
      alternativesConsidered: parsed.data.alternativesConsidered,
      rationale: parsed.data.rationale,
      provenance: parsed.data.provenance,
      recordedAt: nowTimestamp(),
    };
    await emitV2({ eventType: "decision.recorded", aggregateType: "decision", aggregateId: d.id, snapshot: d, correlationId: d.taskId });
    arpV2.decisions.set(d.id, d);
    sendJson(res, 201, jsonSafe(d));
  }),
  // ────────────────────────── /v2/risks ─────────────────────────────────────
  route("POST", "/v2/risks", async (req, res) => {
    const parsed = z.object({
      taskId: z.string().min(1),
      riskClass: z.enum(["LOW", "NORMAL", "HIGH", "CRITICAL"]),
      statement: z.string().min(1),
      mitigation: z.string().nullable().default(null),
    }).safeParse(await jsonBody(req));
    if (!parsed.success) return sendError(res, 400, "INVALID_RISK", "invalid risk payload", "validation");
    const r: Risk = {
      id: uuid(),
      taskId: parsed.data.taskId,
      riskClass: parsed.data.riskClass,
      statement: parsed.data.statement,
      mitigation: parsed.data.mitigation,
      status: parsed.data.mitigation ? "MITIGATED" : "IDENTIFIED",
      recordedAt: nowTimestamp(),
    };
    await emitV2({ eventType: "risk.recorded", aggregateType: "risk", aggregateId: r.id, snapshot: r, correlationId: r.taskId });
    arpV2.risks.set(r.id, r);
    sendJson(res, 201, jsonSafe(r));
  }),
  route("POST", "/v2/risks/:id/mitigate", async (req, res, params) => {
    const r = arpV2.risks.get(String(params.id));
    if (!r) return sendError(res, 404, "RISK_NOT_FOUND", "risk not found", "not_found");
    const parsed = z.object({ mitigation: z.string().min(1) }).safeParse(await jsonBody(req));
    if (!parsed.success) return sendError(res, 400, "INVALID_MITIGATION", "mitigation text is required", "validation");
    const updated: Risk = { ...r, mitigation: parsed.data.mitigation, status: "MITIGATED" };
    await emitV2({ eventType: "risk.mitigated", aggregateType: "risk", aggregateId: r.id, snapshot: updated, correlationId: r.taskId });
    arpV2.risks.set(r.id, updated);
    sendJson(res, 200, jsonSafe(updated));
  }),
  // ────────────────────────── /v2/tasks/:id/budget ──────────────────────────
  route("POST", "/v2/tasks/:id/budget/consume", async (req, res, params) => {
    const taskId = String(params.id);
    const task = arpV2.tasks.get(taskId);
    if (!task) return sendError(res, 404, "TASK_NOT_FOUND", `task ${taskId} not found`, "not_found");
    const body = await jsonBody(req);
    const parsed = V2_ENDPOINTS.ConsumeBudgetV2.request.safeParse({
      ...(typeof body === "object" && body !== null && !Array.isArray(body) ? body : {}),
      id: taskId,
    });
    if (!parsed.success) return sendError(res, 400, "INVALID_BUDGET_CONSUMPTION", "invalid budget consumption delta", "validation");

    const current = arpV2.budgets.get(taskId) ?? {
      taskId,
      consumedCostMicros: 0n,
      consumedComputeSeconds: 0,
      consumedInputTokens: 0n,
      consumedOutputTokens: 0n,
      consumedApprovals: 0,
      lastUpdatedAt: nowTimestamp(),
    };
    const updated: BudgetConsumption = {
      taskId,
      consumedCostMicros: current.consumedCostMicros + BigInt(parsed.data.costMicros),
      consumedComputeSeconds: current.consumedComputeSeconds + parsed.data.computeSeconds,
      consumedInputTokens: current.consumedInputTokens + BigInt(parsed.data.inputTokens),
      consumedOutputTokens: current.consumedOutputTokens + BigInt(parsed.data.outputTokens),
      consumedApprovals: current.consumedApprovals + parsed.data.approvals,
      lastUpdatedAt: nowTimestamp(),
    };

    const costLimit = task.contract.constraints.costMicros;
    if (costLimit > 0n && updated.consumedCostMicros > costLimit) {
      await emitV2({
        eventType: "budget.exhausted",
        aggregateType: "budget",
        aggregateId: taskId,
        snapshot: updated,
        correlationId: taskId,
      });
      arpV2.budgets.set(taskId, updated);
      return sendError(res, 429, "BUDGET_EXHAUSTED", `cost budget exceeded: ${updated.consumedCostMicros} > ${costLimit}`, "rate_limit");
    }

    await emitV2({ eventType: "budget.consumed", aggregateType: "budget", aggregateId: taskId, snapshot: updated, correlationId: taskId });
    arpV2.budgets.set(taskId, updated);
    sendV2Response(res, 200, V2_ENDPOINTS.ConsumeBudgetV2.response, updated);
  }),
  route("GET", "/v2/tasks/:id/budget", async (_req, res, params) => {
    const taskId = String(params.id);
    V2_ENDPOINTS.GetTaskBudgetV2.request.parse({ id: taskId });
    const b = arpV2.budgets.get(taskId) ?? {
      taskId,
      consumedCostMicros: 0n,
      consumedComputeSeconds: 0,
      consumedInputTokens: 0n,
      consumedOutputTokens: 0n,
      consumedApprovals: 0,
      lastUpdatedAt: nowTimestamp(),
    };
    sendV2Response(res, 200, V2_ENDPOINTS.GetTaskBudgetV2.response, b);
  }),
  // ────────────────────────── /v2/models (Phase 8) ──────────────────────────
  route("GET", "/v2/models/profiles", async (req, res) => {
    const url = new URL(req.url ?? "", "http://x");
    const parsed = V2_ENDPOINTS.ListModelProfilesV2.request.safeParse({
      ...(url.searchParams.has("adapterRef")
        ? { adapterRef: url.searchParams.get("adapterRef") }
        : {}),
      ...(url.searchParams.has("confidentiality")
        ? { confidentiality: url.searchParams.get("confidentiality") }
        : {}),
    });
    if (!parsed.success) {
      return sendError(res, 400, "INVALID_PROFILE_FILTER", "invalid model profile filter", "validation");
    }

    let profiles = profileRegistry.listAll();
    const adapterRef = parsed.data?.adapterRef;
    if (adapterRef) {
      profiles = profiles.filter((profile) => profile.adapterRef === adapterRef);
    }
    const confidentiality = parsed.data?.confidentiality;
    if (confidentiality) {
      profiles = profiles.filter((profile) =>
        profile.allowedConfidentiality.includes(confidentiality),
      );
    }
    sendV2Response(res, 200, V2_ENDPOINTS.ListModelProfilesV2.response, { profiles });
  }),
  route("GET", "/v2/models/profiles/:id", async (_req, res, params) => {
    const profile = profileRegistry.getById(String(params.id));
    if (!profile) {
      return sendError(res, 404, "PROFILE_NOT_FOUND", `model profile ${params.id} not found`, "not_found");
    }
    sendV2Response(res, 200, V2_ENDPOINTS.GetModelProfileV2.response, profile);
  }),
  route("POST", "/v2/models/route", async (req, res) => {
    const parsed = V2_ENDPOINTS.RouteModelStageV2.request.safeParse(await jsonBody(req));
    if (!parsed.success) {
      return sendError(res, 400, "INVALID_ROUTE_REQUEST", `invalid route request: ${parsed.error.message}`, "validation");
    }
    const decision = stageRouter.route({
      stage: parsed.data.stage,
      confidentiality: parsed.data.confidentiality,
      requireOffline: parsed.data.requireOffline,
      ...(parsed.data.allowedAdapterRefs === undefined
        ? {}
        : { allowedAdapterRefs: parsed.data.allowedAdapterRefs }),
      ...(parsed.data.implementerModelFamilyRef === undefined
        ? {}
        : { implementerModelFamilyRef: parsed.data.implementerModelFamilyRef }),
    });
    sendV2Response(res, 200, V2_ENDPOINTS.RouteModelStageV2.response, decision);
  }),
  route("POST", "/v2/models/posterior/update", async (req, res) => {
    const parsed = V2_ENDPOINTS.UpdateModelPosteriorV2.request.safeParse(await jsonBody(req));
    if (!parsed.success) {
      return sendError(res, 400, "INVALID_OBSERVATION", `invalid observation: ${parsed.error.message}`, "validation");
    }
    const updated = posteriorTracker.recordObservation({
      ...parsed.data,
      costMicros: BigInt(parsed.data.costMicros),
    });
    sendV2Response(res, 200, V2_ENDPOINTS.UpdateModelPosteriorV2.response, updated);
  }),
  route("GET", "/v2/models/posterior/:modelKey", async (_req, res, params) => {
    const post = posteriorTracker.getOrCreate(String(params.modelKey));
    sendV2Response(res, 200, V2_ENDPOINTS.GetModelPosteriorV2.response, post);
  }),
  // ────────────────────────── /v2/orchestration (Phase 8) ───────────────────
  route("POST", "/v2/orchestration/ev-schedule", async (req, res) => {
    const parsed = z.object({
      parentTaskId: z.string().min(1),
      delegationId: z.string().min(1),
      reservationId: z.string().min(1),
      candidateObjective: z.string().min(1),
      separability: z.number().min(0).max(1),
      likelyFileOverlap: z.number().min(0).max(1),
      isWriteWork: z.boolean(),
      currentUncertainty: z.number().min(0).max(1),
      contextPressure: z.number().min(0).max(1),
      riskClass: z.enum(["low", "medium", "high", "critical"]),
      budgetRemainingRatio: z.number().min(0).max(1),
      activeWorkerCount: z.number().int().nonnegative(),
    }).safeParse(await jsonBody(req));
    if (!parsed.success) {
      return sendError(res, 400, "INVALID_SCHEDULE_REQUEST", `invalid EV schedule request: ${parsed.error.message}`, "validation");
    }
    const decision = evScheduler.evaluate({
      ...parsed.data,
      riskClass: parsed.data.riskClass === "medium" ? "normal" : parsed.data.riskClass,
    });
    sendJson(res, 200, jsonSafe(decision));
  }),
  route("POST", "/v2/orchestration/stagnation/check", async (req, res) => {
    const parsed = z.object({
      taskId: z.string().min(1),
      observations: z.array(z.object({
        turnIndex: z.number().int().nonnegative(),
        toolName: z.string(),
        toolArguments: z.string(),
        resultStatus: z.enum(["success", "error", "failed"]),
        readPath: z.string().optional(),
        readContentHash: z.string().optional(),
        patchPath: z.string().optional(),
        isRevert: z.boolean().optional(),
        diagnosticCount: z.number().int().nonnegative().optional(),
        strategyLabel: z.string().optional(),
        newEvidenceGathered: z.boolean().optional(),
        contextTokens: z.number().int().nonnegative().optional(),
        taskLedgerMilestoneReached: z.boolean().optional(),
        budgetBurnRatio: z.number().min(0).max(1),
        confidenceScore: z.number().min(0).max(1).optional(),
      })).default([]),
    }).safeParse(await jsonBody(req));
    if (!parsed.success) {
      return sendError(res, 400, "INVALID_STAGNATION_CHECK", `invalid stagnation check: ${parsed.error.message}`, "validation");
    }
    for (const obs of parsed.data.observations) {
      stagnationSupervisor.observe(
        obs as Parameters<StagnationSupervisor["observe"]>[0],
      );
    }
    const report = stagnationSupervisor.evaluate(parsed.data.taskId);
    sendJson(res, 200, jsonSafe(report));
  }),
  route("POST", "/v2/orchestration/review/clean", async (req, res) => {
    const parsed = V2_ENDPOINTS.EvaluateCleanReviewV2.request.safeParse(await jsonBody(req));
    if (!parsed.success) {
      return sendError(res, 400, "INVALID_CLEAN_REVIEW", `invalid clean review request: ${parsed.error.message}`, "validation");
    }
    const report = cleanReviewer.evaluateFindings(
      parsed.data.taskId,
      parsed.data.reviewerModelFamilyRef,
      parsed.data.implementerModelFamilyRef,
      parsed.data.findings.map((finding) => ({
        id: finding.id,
        path: finding.path,
        severity: finding.severity,
        title: finding.title,
        description: finding.description,
        ...(finding.line === undefined ? {} : { line: finding.line }),
        ...(finding.proposedRemediation === undefined
          ? {}
          : { proposedRemediation: finding.proposedRemediation }),
      })),
    );
    sendV2Response(res, 200, V2_ENDPOINTS.EvaluateCleanReviewV2.response, report);
  }),
  // ────────────────────────── Phase 9: Cockpit, Attention & Interventions ──────
  route("GET", "/v2/organizations", async (_req, res) => {
    sendJson(res, 200, jsonSafe({ organizations: orgDirectory.listOrganizations() }));
  }),
  route("GET", "/v2/departments", async (req, res) => {
    const url = new URL(req.url ?? "", "http://x");
    const orgId = url.searchParams.get("organizationId") ?? undefined;
    sendJson(res, 200, jsonSafe({ departments: orgDirectory.listDepartments(orgId) }));
  }),
  route("GET", "/v2/operators", async (req, res) => {
    const url = new URL(req.url ?? "", "http://x");
    const deptId = url.searchParams.get("departmentId") ?? undefined;
    sendJson(res, 200, jsonSafe({ operators: orgDirectory.listOperators(deptId) }));
  }),
  route("GET", "/v2/agent-rooms", async (req, res) => {
    const url = new URL(req.url ?? "", "http://x");
    const deptId = url.searchParams.get("departmentId") ?? undefined;
    sendJson(res, 200, jsonSafe({ rooms: orgDirectory.listRooms(deptId) }));
  }),
  route("GET", "/v2/capabilities/directory", async (_req, res) => {
    sendJson(res, 200, jsonSafe({ capabilities: orgDirectory.listCapabilities() }));
  }),
  route("POST", "/v2/capabilities/resolve", async (req, res) => {
    const parsed = z.object({
      capabilityId: z.string().min(1),
      category: z.string().optional(),
      resourceDomain: z.string().optional(),
      requiredAuthority: z.array(z.string()).optional(),
    }).safeParse(await jsonBody(req));
    if (!parsed.success) {
      return sendError(res, 400, "INVALID_CAPABILITY_REQUEST", `invalid capability request: ${parsed.error.message}`, "validation");
    }
    const result = orgDirectory.resolveCapability({
      capabilityId: parsed.data.capabilityId,
      ...(parsed.data.category === undefined ? {} : { category: parsed.data.category }),
      ...(parsed.data.resourceDomain === undefined
        ? {}
        : { resourceDomain: parsed.data.resourceDomain }),
      ...(parsed.data.requiredAuthority === undefined
        ? {}
        : { requiredAuthority: parsed.data.requiredAuthority }),
    });
    sendJson(res, 200, jsonSafe(result));
  }),
  route("GET", "/v2/attention/assess/:taskId", async (_req, res, params) => {
    const assessment = attentionCoordinator.assessTaskAttention(String(params.taskId));
    sendJson(res, 200, jsonSafe(assessment));
  }),
  route("GET", "/v2/attention/questions", async (req, res) => {
    const url = new URL(req.url ?? "", "http://x");
    const taskId = url.searchParams.get("taskId") ?? undefined;
    sendJson(res, 200, jsonSafe({ questions: attentionCoordinator.listPendingQuestions(taskId) }));
  }),
  route("POST", "/v2/attention/questions", async (req, res) => {
    const parsed = V2_ENDPOINTS.AskMaterialQuestionV2.request.safeParse(await jsonBody(req));
    if (!parsed.success) {
      return sendError(res, 400, "INVALID_MATERIAL_QUESTION", `invalid question: ${parsed.error.message}`, "validation");
    }
    sendError(
      res,
      503,
      "EXTERNAL_DEPENDENCY_FAILED",
      "No trusted attention-materiality assessor is configured; the question was not queued",
      "external_dependency",
      { taskId: parsed.data.taskId, trigger: parsed.data.trigger },
    );
  }),
  route("POST", "/v2/attention/questions/:id/resolve", async (req, res, params) => {
    const parsed = z.object({
      selectedOption: z.string().min(1),
    }).safeParse(await jsonBody(req));
    if (!parsed.success) {
      return sendError(res, 400, "INVALID_RESOLVE_REQUEST", `invalid resolve payload: ${parsed.error.message}`, "validation");
    }
    const result = attentionCoordinator.resolveQuestion(String(params.id), parsed.data.selectedOption);
    sendJson(res, 200, jsonSafe(result));
  }),
  route("POST", "/v2/interventions", async (req, res) => {
    const parsed = V2_ENDPOINTS.ProposeInterventionV2.request.safeParse(await jsonBody(req));
    if (!parsed.success) {
      return sendError(res, 400, "INVALID_INTERVENTION", `invalid intervention payload: ${parsed.error.message}`, "validation");
    }
    const intv = interventionManager.proposeIntervention({
      taskId: parsed.data.taskId,
      actorPrincipal: SERVER_PRINCIPAL,
      verb: parsed.data.verb,
      payload: parsed.data.payload,
      rationale: parsed.data.rationale,
      ...(parsed.data.attemptId === undefined ? {} : { attemptId: parsed.data.attemptId }),
      ...(parsed.data.targetEntityId === undefined
        ? {}
        : { targetEntityId: parsed.data.targetEntityId }),
    });
    sendV2Response(res, 200, V2_ENDPOINTS.ProposeInterventionV2.response, intv);
  }),
  route("POST", "/v2/interventions/:id/apply", async (_req, res, params) => {
    sendError(
      res,
      503,
      "SANDBOX_UNAVAILABLE",
      "No kernel-backed intervention executor is configured; the proposal was not applied",
      "sandbox_unavailable",
      { interventionId: String(params.id), supportLevel: "coordinator_only" },
    );
  }),
  route("GET", "/v2/interventions", async (req, res) => {
    const url = new URL(req.url ?? "", "http://x");
    const taskId = url.searchParams.get("taskId") ?? undefined;
    sendJson(res, 200, jsonSafe({ interventions: interventionManager.listInterventions(taskId) }));
  }),
  route("POST", "/v2/replay/traces", async (req, res) => {
    const input = V2_ENDPOINTS.CreateCausalTraceV2.request.parse(await jsonBody(req));
    const trace = causalReplayEngine.createTrace(
      input.taskId,
      input.attemptId,
      input.pinnedInputsHash,
    );
    sendV2Response(res, 201, V2_ENDPOINTS.CreateCausalTraceV2.response, trace);
  }),
  route("GET", "/v2/replay/traces/:taskId", async (_req, res, params) => {
    const trace = causalReplayEngine.getTraceForTask(String(params.taskId));
    sendV2Response(res, 200, V2_ENDPOINTS.GetCausalTraceV2.response, trace);
  }),
  route("POST", "/v2/replay/steps", async (req, res) => {
    const parsed = V2_ENDPOINTS.RecordCausalStepV2.request.safeParse(await jsonBody(req));
    if (!parsed.success) {
      return sendError(res, 400, "INVALID_REPLAY_STEP", `invalid replay step: ${parsed.error.message}`, "validation");
    }
    const updated = causalReplayEngine.recordStep(parsed.data.traceId, parsed.data.step);
    sendV2Response(res, 200, V2_ENDPOINTS.RecordCausalStepV2.response, updated);
  }),
  route("POST", "/v2/replay/traces/:traceId/diagnose", async (req, res, params) => {
    const input = V2_ENDPOINTS.DiagnoseCausalOmissionsV2.request.parse(await jsonBody(req));
    if (input.traceId !== params.traceId) {
      return sendError(res, 400, "VALIDATION_FAILED", "Causal trace path and body identities differ", "validation");
    }
    sendError(
      res,
      503,
      "EXTERNAL_DEPENDENCY_FAILED",
      "No evidence-producing omission evaluator is configured; no causal diagnostic was recorded",
      "external_dependency",
      { traceId: input.traceId, failureStepIndex: input.failureStepIndex },
    );
  }),
  route("POST", "/v2/replay/counterfactual", async (req, res) => {
    const parsed = V2_ENDPOINTS.RunCounterfactualV2.request.safeParse(await jsonBody(req));
    if (!parsed.success) {
      return sendError(res, 400, "INVALID_COUNTERFACTUAL", `invalid counterfactual payload: ${parsed.error.message}`, "validation");
    }
    const exp = causalReplayEngine.runCounterfactual(
      parsed.data.sourceTaskId,
      parsed.data.variationType,
      parsed.data.variationDetails,
    );
    sendV2Response(res, 200, V2_ENDPOINTS.RunCounterfactualV2.response, exp);
  }),
  route("GET", "/v2/mobile/sessions/:taskId", async (_req, res, params) => {
    sendError(
      res,
      503,
      "EXTERNAL_DEPENDENCY_FAILED",
      "No mobile supervision gateway is configured",
      "external_dependency",
      { taskId: params.taskId, supportLevel: "coordinator_only" },
    );
  }),
  route("POST", "/v2/mobile/sessions/:taskId/action", async (req, res, params) => {
    const parsed = z.object({
      action: z.enum(["pause", "resume", "approve_effect", "terminate", "request_review"]),
      effectId: z.string().optional(),
      rationale: z.string().optional(),
    }).safeParse(await jsonBody(req));
    if (!parsed.success) {
      return sendError(res, 400, "INVALID_MOBILE_ACTION", `invalid mobile action: ${parsed.error.message}`, "validation");
    }
    sendError(
      res,
      503,
      "EXTERNAL_DEPENDENCY_FAILED",
      "No mobile supervision gateway is configured; the action was not applied",
      "external_dependency",
      { taskId: params.taskId, action: parsed.data.action, supportLevel: "coordinator_only" },
    );
  }),
  route("POST", "/v2/ide/context-sync", async (req, res) => {
    const parsed = V2_ENDPOINTS.SyncAcpContextV2.request.safeParse(await jsonBody(req));
    if (!parsed.success) {
      return sendError(res, 400, "INVALID_IDE_CONTEXT", `invalid IDE context payload: ${parsed.error.message}`, "validation");
    }
    const contextHash = computeContentHash(canonicalJson(parsed.data));
    acpContextSyncs.set(contextHash, parsed.data);
    sendV2Response(res, 200, V2_ENDPOINTS.SyncAcpContextV2.response, {
      synced: true,
      contextHash,
      receivedDiagnostics: parsed.data.diagnostics.length,
      durability: "process_local",
    });
  }),
  // ────────────────────────── Phase 10: Computer Use & Agency ─────────────────
  // These routes expose pure/process-local coordinators. They never claim a
  // browser, desktop, clipboard, filesystem, or network effect without a
  // trusted backend receipt.
  route("POST", "/v2/computer/observe", async (req, res) => {
    const input = V2_ENDPOINTS.CreateUiObservationV2.request.parse(await jsonBody(req));
    sendError(
      res,
      503,
      "EXTERNAL_DEPENDENCY_FAILED",
      "No trusted UI observation receipt verifier is configured; the referenced observation was not admitted",
      "external_dependency",
      {
        taskId: input.taskId,
        sourceAdapterRef: input.receipt.sourceAdapterRef,
        receiptArtifactUri: input.receipt.receiptArtifactRef.uri,
        supportLevel: "coordinator_only",
      },
    );
  }),
  route("GET", "/v2/computer/observations/:id", async (_req, res, params) => {
    const { id } = V2_ENDPOINTS.GetUiObservationV2.request.parse({ id: params.id });
    sendError(
      res,
      503,
      "EXTERNAL_DEPENDENCY_FAILED",
      "No trusted UI observation store is configured",
      "external_dependency",
      { observationId: id, supportLevel: "coordinator_only" },
    );
  }),
  route("POST", "/v2/computer/verify-target", async (req, res) => {
    const input = V2_ENDPOINTS.VerifyUiTargetV2.request.parse(await jsonBody(req));
    sendError(
      res,
      503,
      "EXTERNAL_DEPENDENCY_FAILED",
      "Semantic target verification requires an admitted trusted observation; no observation verifier is configured",
      "external_dependency",
      { observationId: input.observationId, actionId: input.action.actionId },
    );
  }),
  route("POST", "/v2/computer/action", async (req, res) => {
    const input = V2_ENDPOINTS.DispatchComputerActionV2.request.parse(await jsonBody(req));
    sendError(
      res,
      503,
      "SANDBOX_UNAVAILABLE",
      "No trusted observation verifier or kernel-backed computer-use dispatcher is configured; no input was dispatched",
      "sandbox_unavailable",
      {
        actionId: input.action.actionId,
        observationId: input.observationId,
        supportLevel: "coordinator_only",
      },
    );
  }),
  route("POST", "/v2/computer/evidence", async (req, res) => {
    const input = V2_ENDPOINTS.RecordUiEvidenceV2.request.parse(await jsonBody(req));
    sendError(
      res,
      503,
      "EXTERNAL_DEPENDENCY_FAILED",
      "No trusted computer-use receipt verifier is configured; caller-authored UI evidence was not admitted",
      "external_dependency",
      {
        actionId: input.actionId,
        taskId: input.taskId,
        receiptArtifactUri: input.receipt.receiptArtifactRef.uri,
        supportLevel: "coordinator_only",
      },
    );
  }),
  route("GET", "/v2/computer/pools", async (_req, res) => {
    V2_ENDPOINTS.ListComputerPoolsV2.request.parse({});
    sendV2Response(res, 200, V2_ENDPOINTS.ListComputerPoolsV2.response, poolManager.listPools());
  }),
  route("POST", "/v2/computer/pools/:poolId/lease", async (req, res, params) => {
    const input = V2_ENDPOINTS.AcquirePoolLeaseV2.request.parse(await jsonBody(req));
    if (input.poolId !== params.poolId) {
      return sendError(res, 400, "VALIDATION_FAILED", "Pool path and body identities differ", "validation");
    }
    sendError(
      res,
      503,
      "SANDBOX_UNAVAILABLE",
      "No kernel-backed browser or desktop pool lease backend is configured; no lease was acquired",
      "sandbox_unavailable",
      { poolId: input.poolId, taskId: input.taskId, supportLevel: "coordinator_only" },
    );
  }),
  route("POST", "/v2/computer/pools/:poolId/leases/:leaseId/release", async (req, res, params) => {
    const input = V2_ENDPOINTS.ReleasePoolLeaseV2.request.parse(await jsonBody(req));
    if (input.poolId !== params.poolId || input.leaseId !== params.leaseId) {
      return sendError(res, 400, "VALIDATION_FAILED", "Pool lease path and body identities differ", "validation");
    }
    sendError(
      res,
      503,
      "SANDBOX_UNAVAILABLE",
      "No kernel-backed browser or desktop pool lease backend is configured; no lease was released",
      "sandbox_unavailable",
      { poolId: input.poolId, leaseId: input.leaseId, supportLevel: "coordinator_only" },
    );
  }),
  route("POST", "/v2/computer/takeover", async (req, res) => {
    const input = V2_ENDPOINTS.InitiateHumanTakeoverV2.request.parse(await jsonBody(req));
    sendError(
      res,
      503,
      "SANDBOX_UNAVAILABLE",
      "Human takeover requires a kernel-backed input-control handoff and a trusted observation; neither backend is configured",
      "sandbox_unavailable",
      { taskId: input.taskId, poolId: input.poolId, supportLevel: "coordinator_only" },
    );
  }),
  route("POST", "/v2/computer/takeover/:takeoverId/resume", async (req, res, params) => {
    const input = V2_ENDPOINTS.ResumeFromTakeoverV2.request.parse(await jsonBody(req));
    if (input.takeoverId !== params.takeoverId) {
      return sendError(res, 400, "VALIDATION_FAILED", "Takeover path and body identities differ", "validation");
    }
    sendError(
      res,
      503,
      "SANDBOX_UNAVAILABLE",
      "Autonomous resume requires a kernel-backed input-control handoff and a newly admitted trusted observation",
      "sandbox_unavailable",
      {
        takeoverId: input.takeoverId,
        observationId: input.newObservationId,
        supportLevel: "coordinator_only",
      },
    );
  }),
  route("POST", "/v2/data-flow/evaluate", async (req, res) => {
    const input = V2_ENDPOINTS.EvaluateDataFlowV2.request.parse(await jsonBody(req));
    sendError(
      res,
      503,
      "EXTERNAL_DEPENDENCY_FAILED",
      "No kernel DLP receipt verifier is configured; the data-flow decision was not admitted and the payload handle was not dereferenced",
      "external_dependency",
      {
        taskId: input.taskId,
        policyId: input.policyId,
        direction: input.direction,
        payloadHandleId: input.payloadHandle.objectId,
        dlpReceiptArtifactUri: input.dlpReceiptArtifactRef.uri,
        supportLevel: "coordinator_only",
      },
    );
  }),
  route("POST", "/v2/data-flow/quarantine", async (req, res) => {
    const input = V2_ENDPOINTS.QuarantineDownloadV2.request.parse(await jsonBody(req));
    sendError(
      res,
      503,
      "SANDBOX_UNAVAILABLE",
      "No kernel download quarantine backend is configured; no file was moved",
      "sandbox_unavailable",
      { taskId: input.taskId, fileName: input.fileName, supportLevel: "coordinator_only" },
    );
  }),
  route("POST", "/v2/computer/reconcile-submit", async (req, res) => {
    const input = V2_ENDPOINTS.ReconcileSubmitV2.request.parse(await jsonBody(req));
    sendError(
      res,
      503,
      "EXTERNAL_DEPENDENCY_FAILED",
      "No trusted settlement-probe verifier is configured; the ambiguous submit remains unresolved and must not be retried",
      "external_dependency",
      {
        effectId: input.effectId,
        previousObservationId: input.previousObservationId,
        postTimeoutObservationId: input.postTimeoutObservationId,
        settlementProbeReceiptArtifactUri: input.settlementProbeReceiptArtifactRef.uri,
        supportLevel: "coordinator_only",
      },
    );
  }),
  route("GET", "/v2/connectors", async (_req, res) => {
    V2_ENDPOINTS.ListConnectorsV2.request.parse({});
    sendV2Response(res, 200, V2_ENDPOINTS.ListConnectorsV2.response, connectorLibrary.listConnectors());
  }),
  route("POST", "/v2/connectors/:connectorId/call", async (req, res, params) => {
    const input = V2_ENDPOINTS.ExecuteConnectorCallV2.request.parse(await jsonBody(req));
    if (input.connectorId !== params.connectorId) {
      return sendError(res, 400, "VALIDATION_FAILED", "Connector path and body identities differ", "validation");
    }
    const result = await connectorLibrary.executeCall(input);
    sendV2Response(res, 200, V2_ENDPOINTS.ExecuteConnectorCallV2.response, result);
  }),
  route("POST", "/v2/profiles/incident/start", async (req, res) => {
    const input = V2_ENDPOINTS.StartIncidentTaskV2.request.parse(await jsonBody(req));
    const record = incidentRunner.startIncident(input.profileId, input.taskId, input.initialDiagnostics);
    sendV2Response(res, 201, V2_ENDPOINTS.StartIncidentTaskV2.response, record);
  }),
  route("POST", "/v2/profiles/research/start", async (req, res) => {
    const input = V2_ENDPOINTS.StartResearchTaskV2.request.parse(await jsonBody(req));
    const record = researchRunner.startResearch(input.profileId, input.taskId);
    sendV2Response(res, 201, V2_ENDPOINTS.StartResearchTaskV2.response, record);
  }),
  route("GET", "/v2/events", async (req, res) => {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "connection": "keep-alive",
      "access-control-allow-origin": CONTROL_CORS_ORIGIN,
      "access-control-allow-headers": CORS_ALLOW_HEADERS,
      "x-accel-buffering": "no",
    });
    res.flushHeaders();
    const url = new URL(req.url ?? "", "http://x");
    const cursor = url.searchParams.get("cursor");
    const taskId = url.searchParams.get("taskId");
    const aggregateType = url.searchParams.get("aggregateType");

    const filter = (ev: StoredEvent) => {
      if (ev.schemaVersion !== 2) return false;
      if (aggregateType && ev.aggregateType !== aggregateType) return false;
      if (taskId) {
        return ev.aggregateId === taskId
          || ev.correlationId === taskId
          || (ev.payloadJson.includes(taskId) && ev.aggregateType !== "evidence");
      }
      return true;
    };

    let lastEventId: string | null = cursor;
    let lastSequence = 0;
    let replaying = true;
    const buffered = new Map<string, StoredEvent>();
    const sent = new Set<string>();
    const writeEvent = (ev: StoredEvent) => {
      if (sent.has(ev.eventId)) return;
      res.write(`id: ${ev.eventId}\nevent: ${ev.eventType}\ndata: ${JSON.stringify(storedEventToEnvelopeV2(ev))}\n\n`);
      sent.add(ev.eventId);
      lastEventId = ev.eventId;
      lastSequence = ev.aggregateSequence;
    };
    const unsubscribe = bus.subscribe(filter, (ev) => {
      if (replaying) buffered.set(ev.eventId, ev);
      else writeEvent(ev);
    });
    const highWater = await bus.latestEventId();

    if (cursor) {
      const oldest = await bus.oldestEventId();
      if (oldest && cursor < oldest) {
        const payload = JSON.stringify({
          type: "cursor_expired",
          cursor,
          oldestRetainedEventId: oldest,
          snapshotUrl: taskId ? `/v2/tasks/${taskId}` : "/v2/tasks",
        });
        res.write(`id: ${oldest}\nevent: cursor_expired\ndata: ${payload}\n\n`);
        lastEventId = oldest;
      } else if (highWater) {
        await bus.replay(cursor, highWater, filter, writeEvent);
      }
    }

    for (const event of [...buffered.values()].sort((left, right) => left.eventId.localeCompare(right.eventId))) {
      writeEvent(event);
    }
    buffered.clear();
    replaying = false;

    const heartbeat = setInterval(() => {
      try { res.write(`:heartbeat ${Date.now()}\n\n`); } catch { /* ignore */ }
    }, 15_000);

    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
      if (lastEventId) {
        const streamName = taskId ? `v2:task:${taskId}` : aggregateType ? `v2:aggregate:${aggregateType}` : "v2:global";
        void bus.persistCursor(streamName, lastEventId, lastSequence);
      }
    });
  }),
];

/** JSON.parse with a fallback so a corrupt stored value never crashes the API. */
function safeParse<T>(text: string, fallback: T): T {
  try { return JSON.parse(text) as T; } catch { return fallback; }
}

function taskContractWire(row: {
  readonly version: number;
  readonly contentHash: string;
  readonly objective: string;
  readonly nonGoalsJson: string;
  readonly allowedScopeJson: string;
} | null | undefined): {
  readonly version: number;
  readonly content_hash: string;
  readonly objective: string;
  readonly non_goals: readonly string[];
  readonly allowed_scope: {
    readonly read_paths: readonly string[];
    readonly write_paths: readonly string[];
    readonly external_systems: readonly string[];
  };
} | null {
  if (!row) return null;
  const parsedScope = safeParse<unknown>(row.allowedScopeJson, {});
  const scope = parsedScope !== null && typeof parsedScope === "object" && !Array.isArray(parsedScope)
    ? parsedScope as Record<string, unknown>
    : {};
  return {
    version: row.version,
    content_hash: row.contentHash,
    objective: row.objective,
    non_goals: readStringArray(safeParse<unknown>(row.nonGoalsJson, [])),
    allowed_scope: {
      read_paths: readStringArray(scope.read_paths),
      write_paths: readStringArray(scope.write_paths),
      external_systems: readStringArray(scope.external_systems),
    },
  };
}

function readStringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function persistedTaskContract(
  task: {
    readonly id: string;
    readonly riskClass: string;
    readonly budgetJson: string;
  },
  contract: {
    readonly version: number;
    readonly objective: string;
    readonly userOutcome: string | null;
    readonly nonGoalsJson: string;
    readonly constraintsJson: string;
    readonly assumptionsJson: string;
    readonly unknownsJson: string;
    readonly allowedScopeJson: string;
    readonly changePolicyJson: string;
  },
  criteria: readonly {
    readonly criterionId: string;
    readonly statement: string;
    readonly verificationHint: string | null;
    readonly required: boolean;
  }[],
): TaskSnapshot["contract"] {
  const budget = safeParse<Record<string, unknown>>(task.budgetJson, {});
  const rawScope = safeParse<Record<string, unknown>>(contract.allowedScopeJson, {});
  return {
    id: task.id as TaskSnapshot["contract"]["id"],
    version: contract.version,
    objective: contract.objective,
    userOutcome: contract.userOutcome,
    nonGoals: safeParse<string[]>(contract.nonGoalsJson, []),
    acceptanceCriteria: criteria.map((criterion) => ({
      id: criterion.criterionId,
      statement: criterion.statement,
      verificationHint: criterion.verificationHint,
      required: criterion.required,
    })),
    constraints: safeParse<string[]>(contract.constraintsJson, []),
    assumptions: safeParse<string[]>(contract.assumptionsJson, []),
    unknowns: safeParse<string[]>(contract.unknownsJson, []),
    allowedScope: {
      readPaths: readStringArray(rawScope.read_paths ?? rawScope.readPaths),
      writePaths: readStringArray(rawScope.write_paths ?? rawScope.writePaths),
      externalSystems: readStringArray(rawScope.external_systems ?? rawScope.externalSystems),
    },
    riskClass: normalizeRiskClass(task.riskClass),
    budget: {
      modelMicros: BigInt(String(budget.model_micros ?? 5_000_000)) as Micros,
      computeSeconds: numberOr(budget.compute_seconds, 600),
      wallClockSeconds: numberOr(budget.wall_clock_seconds, 3_600),
      humanApprovals: numberOr(budget.human_approvals, 20),
    },
    changePolicy: safeParse(contract.changePolicyJson, {
      mayExpandScope: false,
      scopeExpansionRequiresUser: true,
    }),
  };
}

function checkpointRequirementStatus(
  status: string,
): CheckpointContent["requirements"][number]["status"] {
  if (status === "satisfied" || status === "passed" || status === "verified") return "satisfied";
  if (status === "unsatisfied" || status === "failed") return "unsatisfied";
  return "unverified";
}

interface CheckpointAdmissionRecoveryResult {
  readonly prepared: number;
  readonly recovered: readonly string[];
  readonly quarantined: readonly string[];
  readonly failed: readonly { id: string; error: string }[];
}

interface PreparedCheckpointAdmissionRow {
  readonly id: string;
  readonly taskId: string | null;
  readonly checkpointArtifact: string;
  readonly sessionId: string;
  readonly threadId: string;
  readonly lastCommittedSequencesJson: string;
  readonly createdAt: Date;
}

interface CheckpointPublication {
  readonly id: string;
  readonly threadId: string;
  readonly taskId: string;
  readonly artifactHash: ContentHash;
}

async function commitCheckpointPublication(publication: CheckpointPublication): Promise<void> {
  const existingEvent = await db.semanticEvent.findFirst({
    where: {
      eventType: "checkpoint.created",
      aggregateType: "checkpoint",
      aggregateId: publication.id,
    },
    select: { eventId: true },
  });
  if (existingEvent) {
    const committed = await writerTransaction((tx) => tx.checkpoint.updateMany({
      where: { id: publication.id, admissionState: "PREPARED" },
      data: { admissionState: "COMMITTED" },
    }));
    if (committed.count !== 1) {
      throw new Error(`checkpoint ${publication.id} publication state changed during recovery`);
    }
    return;
  }
  await emit({
    eventType: "checkpoint.created",
    aggregateType: "checkpoint",
    aggregateId: publication.id,
    correlationId: publication.taskId,
    payload: {
      thread_id: publication.threadId,
      task_id: publication.taskId,
      artifact_hash: publication.artifactHash,
    },
  }, async (tx) => {
    const committed = await tx.checkpoint.updateMany({
      where: { id: publication.id, admissionState: "PREPARED" },
      data: { admissionState: "COMMITTED" },
    });
    if (committed.count !== 1) {
      throw new Error(`checkpoint ${publication.id} admission changed before atomic publication`);
    }
  });
}

async function quarantinePreparedCheckpoint(id: string): Promise<void> {
  await writerTransaction((tx) => tx.checkpoint.updateMany({
    where: { id, admissionState: "PREPARED" },
    data: { admissionState: "QUARANTINED" },
  }));
}

function isTransientKernelFailure(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const code = "code" in error ? (error as { readonly code?: unknown }).code : undefined;
  return code === 4 || code === 14;
}

/**
 * Finish checkpoint admissions interrupted after the kernel retained exact
 * bytes but before event publication and row visibility committed atomically.
 */
async function reconcilePreparedCheckpointAdmissions(): Promise<CheckpointAdmissionRecoveryResult> {
  const recovered: string[] = [];
  const quarantined: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];
  let prepared = 0;
  let cursor: string | null = null;

  for (;;) {
    const rows: PreparedCheckpointAdmissionRow[] = await db.checkpoint.findMany({
      where: { admissionState: "PREPARED" },
      orderBy: { id: "asc" },
      take: 100,
      select: {
        id: true,
        taskId: true,
        checkpointArtifact: true,
        sessionId: true,
        threadId: true,
        lastCommittedSequencesJson: true,
        createdAt: true,
      },
      ...(cursor === null ? {} : { cursor: { id: cursor }, skip: 1 }),
    });
    prepared += rows.length;
    for (const row of rows) {
      if (row.taskId === null) {
        await quarantinePreparedCheckpoint(row.id);
        quarantined.push(row.id);
        continue;
      }
      const artifactUri = artifactUriSchema.safeParse(row.checkpointArtifact);
      if (!artifactUri.success) {
        await quarantinePreparedCheckpoint(row.id);
        quarantined.push(row.id);
        continue;
      }
      if (!kernelUds) {
        failed.push({ id: row.id, error: "kernel artifact service is unavailable" });
        continue;
      }
      const artifactHash = contentHashSchema.parse(
        `sha256:${artifactUri.data.slice("artifact://sha256/".length)}`,
      );
      const task = await db.task.findUnique({ where: { id: row.taskId } });
      if (!task || task.sessionId !== row.sessionId || task.threadId !== row.threadId) {
        await quarantinePreparedCheckpoint(row.id);
        quarantined.push(row.id);
        continue;
      }
      const contractRow = await db.taskContractVersion.findUnique({
        where: {
          task_id_version: {
            task_id: task.id,
            version: task.activeContractVersion,
          },
        },
      });
      if (!contractRow) {
        await quarantinePreparedCheckpoint(row.id);
        quarantined.push(row.id);
        continue;
      }
      const criteria = await db.acceptanceCriterion.findMany({
        where: { taskId: task.id, contractVersion: contractRow.version },
        orderBy: { criterionId: "asc" },
      });
      const contract = persistedTaskContract(task, contractRow, criteria);
      const recoveryContext = await kernelContextForTask(
        row.taskId,
        "checkpoint-admission-recovery",
        [CapabilityOperationProto.CAPABILITY_OPERATION_ARTIFACT_INGEST],
      );
      const artifactClient = createKernelArtifactClient(kernelUds.artifacts, {
        ...recoveryContext,
        idempotencyKey: `checkpoint-recovery:${row.id}`,
      });
      try {
        await loadValidatedCheckpoint({
          row,
          artifacts: artifactClient,
          contract,
          taskId: task.id,
          taskSourceVersion: contractRow.contentHash,
        });
        await artifactClient.link(artifactHash, "checkpoint", row.id, "content");
      } catch (error: unknown) {
        if (!isTransientKernelFailure(error)) {
          await quarantinePreparedCheckpoint(row.id);
          quarantined.push(row.id);
          continue;
        }
        failed.push({
          id: row.id,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      try {
        await commitCheckpointPublication({
          id: row.id,
          threadId: row.threadId,
          taskId: task.id,
          artifactHash,
        });
        recovered.push(row.id);
      } catch (error: unknown) {
        failed.push({
          id: row.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (rows.length < 100) break;
    cursor = rows.at(-1)?.id ?? null;
    if (cursor === null) throw new Error("checkpoint recovery lost its continuation cursor");
  }

  return { prepared, recovered, quarantined, failed };
}

interface CheckpointLinkRecoveryResult {
  readonly scanned: number;
  readonly removedOrphans: readonly string[];
  readonly deferredOrphans: readonly string[];
  readonly rebound: readonly string[];
  readonly requeued: readonly string[];
  readonly quarantined: readonly string[];
  readonly failed: readonly { id: string; error: string }[];
}

function kernelLinkCreatedAtMillis(value: string): number | null {
  const unix = /^(\d+)\.(\d+)\+00:00$/.exec(value);
  if (unix) {
    const seconds = Number(unix[1]);
    return Number.isFinite(seconds) ? seconds * 1_000 : null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function checkpointOrphanGraceMillis(): number {
  const configured = Number(process.env.TERMINUS_CHECKPOINT_ORPHAN_GRACE_MS ?? "300000");
  return Number.isFinite(configured) && configured >= 0 ? configured : 300_000;
}

async function reconcileCheckpointArtifactLinks(): Promise<CheckpointLinkRecoveryResult> {
  if (!kernelUds) {
    return {
      scanned: 0,
      removedOrphans: [],
      deferredOrphans: [],
      rebound: [],
      requeued: [],
      quarantined: [],
      failed: [{ id: "kernel", error: "kernel artifact service is unavailable" }],
    };
  }
  const removedOrphans: string[] = [];
  const deferredOrphans: string[] = [];
  const rebound: string[] = [];
  const requeued: string[] = [];
  const quarantined: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];
  const observedCheckpointIds = new Set<string>();
  let scanned = 0;
  let continuationToken = "";
  do {
    const page = await kernelUds.artifacts.ListCheckpointLinks({
      context: await kernelMaintenanceContext(),
      pageSize: 250,
      continuationToken,
    });
    for (const link of page.links) {
      scanned += 1;
      if (observedCheckpointIds.has(link.checkpointId)) {
        await writerTransaction((tx) => tx.checkpoint.updateMany({
          where: { id: link.checkpointId },
          data: { admissionState: "QUARANTINED" },
        }));
        quarantined.push(link.checkpointId);
        continue;
      }
      observedCheckpointIds.add(link.checkpointId);
      const row = await db.checkpoint.findUnique({
        where: { id: link.checkpointId },
        select: { id: true, taskId: true, checkpointArtifact: true, sessionId: true },
      });
      if (!row) {
        const createdAt = kernelLinkCreatedAtMillis(link.createdAt);
        const oldEnough = createdAt !== null
          && Date.now() - createdAt >= checkpointOrphanGraceMillis();
        if (!oldEnough) {
          deferredOrphans.push(link.checkpointId);
          continue;
        }
        try {
          const response = await kernelUds.artifacts.UnlinkCheckpoint({
            context: await kernelMaintenanceContext(),
            sha256: link.sha256,
            checkpointId: link.checkpointId,
            ownerTaskId: link.ownerTaskId,
          });
          if (!response.unlinked) throw new Error("kernel checkpoint link changed before unlink");
          removedOrphans.push(link.checkpointId);
        } catch (error: unknown) {
          failed.push({
            id: link.checkpointId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        continue;
      }
      const artifactUri = artifactUriSchema.safeParse(row.checkpointArtifact);
      const expectedHash = artifactUri.success
        ? `sha256:${artifactUri.data.slice("artifact://sha256/".length)}`
        : null;
      if (
        row.taskId === null
        || expectedHash !== link.sha256
        || (link.ownerTaskId.length > 0 && link.ownerTaskId !== row.taskId)
      ) {
        await writerTransaction((tx) => tx.checkpoint.update({
          where: { id: row.id },
          data: { admissionState: "QUARANTINED" },
        }));
        quarantined.push(row.id);
        continue;
      }
      if (link.ownerTaskId.length === 0) {
        try {
          const rebindContext = await kernelContextForTask(
            row.taskId,
            "checkpoint-link-reconciliation",
            [CapabilityOperationProto.CAPABILITY_OPERATION_ARTIFACT_INGEST],
          );
          const artifacts = createKernelArtifactClient(kernelUds.artifacts, {
            ...rebindContext,
            idempotencyKey: `checkpoint-link-rebind:${row.id}`,
          });
          const linkHash = contentHashSchema.parse(link.sha256);
          await artifacts.link(linkHash, "checkpoint", row.id, "content");
          rebound.push(row.id);
        } catch (error: unknown) {
          failed.push({
            id: row.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    const next = page.continuationToken;
    if (next.length > 0 && next === continuationToken) {
      throw new Error("kernel checkpoint-link pagination did not advance");
    }
    continuationToken = next;
  } while (continuationToken.length > 0);

  let checkpointCursor: string | null = null;
  for (;;) {
    const committed: Array<{ id: string; taskId: string | null }> = await db.checkpoint.findMany({
      where: { admissionState: "COMMITTED" },
      select: { id: true, taskId: true },
      orderBy: { id: "asc" },
      take: 500,
      ...(checkpointCursor === null ? {} : { cursor: { id: checkpointCursor }, skip: 1 }),
    });
    for (const checkpoint of committed) {
      if (observedCheckpointIds.has(checkpoint.id)) continue;
      const nextState = checkpoint.taskId === null ? "QUARANTINED" : "PREPARED";
      await writerTransaction((tx) => tx.checkpoint.updateMany({
        where: { id: checkpoint.id, admissionState: "COMMITTED" },
        data: { admissionState: nextState },
      }));
      if (nextState === "PREPARED") requeued.push(checkpoint.id);
      else quarantined.push(checkpoint.id);
    }
    if (committed.length < 500) break;
    checkpointCursor = committed.at(-1)?.id ?? null;
    if (checkpointCursor === null) throw new Error("checkpoint link recovery lost its continuation cursor");
  }

  return {
    scanned,
    removedOrphans,
    deferredOrphans,
    rebound,
    requeued,
    quarantined,
    failed,
  };
}

function checkpointFailureDescription(terminalErrorJson: string, state: string): string {
  const decoded = safeParse<unknown>(terminalErrorJson, null);
  if (decoded !== null && typeof decoded === "object" && !Array.isArray(decoded)) {
    const record = decoded as Record<string, unknown>;
    for (const key of ["message", "error", "reason"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim().length > 0) return value;
    }
  }
  return `Turn stopped in ${state}`;
}

function normalizeRiskClass(value: string): TaskSnapshot["contract"]["riskClass"] {
  return value === "low" || value === "high" || value === "critical" ? value : "normal";
}

function unconfiguredProviderSnapshot(observedAt: Rfc3339Timestamp): ProviderCapabilitySnapshot {
  return {
    providerId: "local",
    observedAt,
    source: "terminus-control/unconfigured-provider-v1",
    context: {
      advertisedTokens: 16_384,
      testedSafeTokens: 8_192,
      roleSupport: ["system", "user", "assistant", "tool"],
      imageInput: false,
      toolCalling: false,
      parallelToolCalls: false,
      structuredOutput: true,
    },
    continuation: {
      nativeId: false,
      crossRequest: false,
      compaction: true,
      compatibilityKey: "unconfigured-provider-v1",
    },
    caching: {
      mode: "explicit_breakpoints",
      exactPrefixRequired: true,
      minimumTokens: 0,
      ttlOptions: [],
      toolOrderSensitive: false,
      usageReporting: false,
    },
    reasoning: { supported: false, budgetControl: false, summaryAvailable: false },
    economics: {
      inputMicrosPerMillion: 0n as Micros,
      cachedInputMicrosPerMillion: 0n as Micros,
      outputMicrosPerMillion: 0n as Micros,
      reasoningAccounting: false,
    },
    reliability: {
      toolCallSuccess: 0,
      structuredOutputSuccess: 0,
      editCohortSuccess: 0,
      latencyPercentiles: { p50: 0, p99: 0 },
    },
    policy: {
      allowedConfidentiality: ["public", "workspace"],
      retentionMode: "local_only",
      region: null,
    },
  };
}

/** Execute the configured local provider exclusively through kernel Job RPC. */
async function executeGatewayProviderRequest(
  rendered: RenderedProviderRequest,
  gateway: { readonly model: GatewayModel; readonly secretUri: string },
  context: RequestContext,
): Promise<ProviderResponse> {
  const transport = new GatewayTransport({
    credentialBindingId: gateway.secretUri,
    models: [gateway.model],
    client: new KernelGatewayClient(requireKernelUds().connectors, context),
  });
  const chunks: ProviderResponseChunk[] = [];
  for await (const chunk of transport.stream(rendered.request, rendered.body, rendered.request.signal)) {
    chunks.push(chunk);
  }
  const providerError = chunks.find((chunk) => chunk.kind === "error");
  if (providerError?.kind === "error") {
    throw new Error(`${providerError.errorCode ?? "PROVIDER_ERROR"}: ${providerError.errorMessage ?? "gateway provider failed"}`);
  }
  return {
    providerId: rendered.providerId,
    model: rendered.model,
    chunks,
    observedAt: now(),
  };
}

const providerSessionService = new ProviderSessionService<Prisma.TransactionClient>({
  readTurnState: async (turnId) => (await db.turn.findUnique({ where: { id: turnId }, select: { state: true } }))?.state ?? null,
  appendEvent: async (event, mutation): Promise<void> => {
    await emit({
      eventType: event.eventType,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      correlationId: event.correlationId,
      payload: event.payload,
      artifactRefs: event.artifactRefs === undefined ? undefined : [...event.artifactRefs],
    }, mutation);
  },
  transaction: (tx) => ({
    startAttempt: async (input: ProviderAttemptStartInput) => {
      const turnUpdate = await tx.turn.updateMany({
        where: { id: input.turnId, state: "CONTEXT_COMPILING" },
        data: { state: "PROVIDER_RUNNING" },
      });
      if (turnUpdate.count !== 1) {
        throw new Error(`turn ${input.turnId} changed before provider attempt start`);
      }
      await tx.providerAttempt.create({
        data: {
          id: input.attemptId,
          turnId: input.turnId,
          attemptNumber: input.attemptNumber,
          providerId: input.providerId,
          modelKey: input.modelKey,
          capabilitySnapshotHash: input.capabilitySnapshotHash,
          contextManifestId: input.contextManifestId,
          requestArtifact: input.requestArtifact,
          status: "running",
        },
      });
      await tx.contextManifest.update({
        where: { id: input.contextManifestId },
        data: { providerAttemptId: input.attemptId },
      });
    },
    completeAttempt: async (input: ProviderAttemptResponseInput) => {
      const turnUpdate = await tx.turn.updateMany({
        where: { id: input.turnId, state: "PROVIDER_RUNNING" },
        data: { state: "RESPONSE_VALIDATING" },
      });
      if (turnUpdate.count !== 1) {
        throw new Error(`turn ${input.turnId} changed before provider response settlement`);
      }
      if (input.messageArtifact !== null && input.messageHash !== null) {
        const latestEpisode = await tx.episode.findFirst({
          where: { turnId: input.turnId },
          orderBy: { sequence: "desc" },
          select: { sequence: true },
        });
        await tx.episode.create({
          data: {
            id: uuid(),
            turnId: input.turnId,
            sequence: (latestEpisode?.sequence ?? 0) + 1,
            kind: "model_message",
            modelVisible: true,
            contentArtifact: input.messageArtifact,
            sourceVersionsJson: JSON.stringify({ providerAttemptId: input.attemptId, response: input.messageHash }),
          },
        });
      }
      await tx.providerAttempt.update({
        where: { id: input.attemptId },
        data: {
          status: "completed",
          responseArtifact: input.responseArtifact,
          completedAt: new Date(),
          usageJson: JSON.stringify(jsonSafe(input.usage)),
          costMicros: 0,
          nativeContinuationJson: input.continuationId === null
            ? null
            : JSON.stringify({ continuation_id: input.continuationId }),
        },
      });
    },
  }),
  mutate: mutateAgentState,
  executeLocal: async (input: ProviderExecutionInput) => {
    if (input.command === null) throw new ProviderExecutionUnavailableError(input.rendered.providerId);
    return executeLocalProviderCommand({
      clients: requireKernelUds(),
      context: input.context,
      workspaceId: input.workspaceId,
      command: input.command,
      rendered: input.rendered,
      signal: input.rendered.request.signal,
      devMode: DEV_MODE,
    });
  },
  executeGateway: async (input: ProviderExecutionInput) => {
    if (input.gateway === null) throw new ProviderExecutionUnavailableError(input.rendered.providerId);
    return executeGatewayProviderRequest(input.rendered, input.gateway, input.context);
  },
});

function makeContextBudget(
  provider: ProviderCapabilitySnapshot,
  taskBudget: TaskSnapshot["contract"]["budget"],
): ContextBudget {
  const hard = BigInt(provider.context.testedSafeTokens) as TokenCount;
  const output = 1024n as TokenCount;
  const reasoning = 0n as TokenCount;
  const toolResult = 512n as TokenCount;
  const recovery = 256n as TokenCount;
  const reserved = output + reasoning + toolResult + recovery;
  const optional = hard > reserved ? hard - reserved : 0n;
  return {
    modelAdvertisedTokens: BigInt(provider.context.advertisedTokens) as TokenCount,
    testedSafeTokens: hard,
    protocolOverheadTokens: 128n as TokenCount,
    exactContextTokens: 0n as TokenCount,
    optionalContextTarget: optional as TokenCount,
    expectedToolResultReserve: toolResult,
    outputReserve: output,
    reasoningReserve: reasoning,
    recoveryMargin: recovery,
    hardInputLimit: hard,
    hardCostMicros: taskBudget.modelMicros,
  };
}

const EMPTY_CONTEXT_HASH = ("sha256:" + "0".repeat(64)) as ContentHash;

interface EnsureContextEpochInput {
  readonly db: PrismaClient;
  readonly threadId: string;
  readonly taskId: string;
  readonly workspaceId: string;
  readonly provider: ProviderCapabilitySnapshot;
  readonly model: ModelCapabilitySnapshot;
  readonly worldState: WorldStateSnapshot;
  readonly artifacts: ArtifactClient;
}

/**
 * Creates or resumes the durable context epoch before compilation. The epoch
 * snapshot and baseline are kernel artifacts; Prisma stores only their URIs.
 */
async function ensureContextEpoch(
  input: EnsureContextEpochInput,
): Promise<ContextEpochSnapshot> {
  const observedActive = await input.db.contextEpoch.findFirst({
    where: { threadId: input.threadId, state: "active" },
    orderBy: { generation: "desc" },
  });
  if (
    observedActive !== null
    && observedActive.providerCompatibilityKey === input.provider.continuation.compatibilityKey
  ) {
    return {
      epochId: observedActive.id as ContextEpochSnapshot["epochId"],
      threadId: observedActive.threadId as ContextEpochSnapshot["threadId"],
      sequence: observedActive.generation,
      baselineHash: observedActive.baselineHash as ContentHash,
      provider: input.provider.providerId,
      model: input.model.modelKey,
      continuationId: null,
      startedAt: observedActive.createdAt.toISOString() as Rfc3339Timestamp,
    };
  }

  const snapshot = await ingestJsonArtifact(
    input.artifacts,
    {
      taskId: input.taskId,
      workspaceId: input.workspaceId,
      provider: input.provider.providerId,
      model: input.model.modelKey,
      sourceVersions: input.worldState.sourceVersions,
      sections: input.worldState.sections,
      observedAt: input.worldState.observedAt,
    },
    "context-epoch-snapshot",
    { taskId: input.taskId, workspaceId: input.workspaceId },
  );
  return mutateAgentState(async () => {
    const active = await input.db.contextEpoch.findFirst({
      where: { threadId: input.threadId, state: "active" },
      orderBy: { generation: "desc" },
    });
    if (active !== null && active.providerCompatibilityKey === input.provider.continuation.compatibilityKey) {
      return {
        epochId: active.id as ContextEpochSnapshot["epochId"],
        threadId: active.threadId as ContextEpochSnapshot["threadId"],
        sequence: active.generation,
        baselineHash: active.baselineHash as ContentHash,
        provider: input.provider.providerId,
        model: input.model.modelKey,
        continuationId: null,
        startedAt: active.createdAt.toISOString() as Rfc3339Timestamp,
      };
    }
    const latest = await input.db.contextEpoch.findFirst({
      where: { threadId: input.threadId },
      orderBy: { generation: "desc" },
    });
    const epochId = generateUuid7();
    const generation = (latest?.generation ?? 0) + 1;
    const createdAt = new Date();
    await input.db.$transaction(async (tx) => {
      await assertControlWriterLease(tx);
      if (active !== null) {
        await tx.contextEpoch.update({
          where: { id: active.id },
          data: {
            state: "sealed",
            sealedAt: createdAt,
            sealReason: "provider compatibility changed",
          },
        });
      }
      await tx.contextEpoch.create({
        data: {
          id: epochId,
          threadId: input.threadId,
          generation,
          providerCompatibilityKey: input.provider.continuation.compatibilityKey,
          baselineArtifact: snapshot.uri,
          baselineHash: EMPTY_CONTEXT_HASH,
          snapshotArtifact: snapshot.uri,
          state: "active",
        },
      });
      await tx.thread.update({
        where: { id: input.threadId },
        data: { activeContextEpochId: epochId },
      });
    });
    return {
      epochId,
      threadId: input.threadId as ContextEpochSnapshot["threadId"],
      sequence: generation,
      baselineHash: EMPTY_CONTEXT_HASH,
      provider: input.provider.providerId,
      model: input.model.modelKey,
      continuationId: null,
      startedAt: createdAt.toISOString() as Rfc3339Timestamp,
    };
  });
}

async function ingestJsonArtifact(
  artifacts: ArtifactClient,
  value: unknown,
  purpose: string,
  scope: Readonly<Record<string, unknown>>,
): Promise<Awaited<ReturnType<ArtifactClient["ingest"]>>> {
  return artifacts.ingest(
    new TextEncoder().encode(canonicalJson(value)),
    { mediaType: "application/json", custom: { purpose, ...scope } },
  );
}

function checkpointEpisodeRange(
  episodes: readonly { readonly sequence: number }[],
): { readonly from: number; readonly to: number } {
  if (episodes.length === 0) return { from: 0, to: 0 };
  return {
    from: episodes[0]?.sequence ?? 0,
    to: episodes.at(-1)?.sequence ?? 0,
  };
}

async function loadValidatedCheckpoint(input: {
  readonly row: {
    readonly id: string;
    readonly threadId: string;
    readonly taskId: string | null;
    readonly checkpointArtifact: string;
    readonly lastCommittedSequencesJson: string;
    readonly createdAt: Date;
  };
  readonly artifacts: ArtifactClient;
  readonly contract: TaskSnapshot["contract"];
  readonly taskId: string;
  readonly taskSourceVersion: string;
}): Promise<Checkpoint> {
  if (input.row.taskId !== input.taskId) {
    throw new Error(`checkpoint ${input.row.id} is not bound to task ${input.taskId}`);
  }
  const sequenceState = checkpointSequenceStateSchema.safeParse(
    safeParse<unknown>(input.row.lastCommittedSequencesJson, null),
  );
  if (!sequenceState.success) {
    throw new Error(`checkpoint ${input.row.id} has invalid committed-sequence metadata`);
  }
  if (sequenceState.data.task !== input.contract.version) {
    throw new Error(
      `checkpoint ${input.row.id} contract version ${sequenceState.data.task} does not match active version ${input.contract.version}`,
    );
  }
  const sourceTurn = await db.turn.findUnique({
    where: { id: sequenceState.data.sourceTurnId },
    include: { episodes: { orderBy: { sequence: "asc" } } },
  });
  if (
    sourceTurn === null
    || sourceTurn.taskId !== input.taskId
    || sourceTurn.threadId !== input.row.threadId
  ) {
    throw new Error(`checkpoint ${input.row.id} source turn lineage is unavailable`);
  }
  if (sourceTurn.sequence !== sequenceState.data.turn) {
    throw new Error(`checkpoint ${input.row.id} source turn sequence changed`);
  }
  const actualEpisodeRange = checkpointEpisodeRange(sourceTurn.episodes);
  if (
    actualEpisodeRange.from !== sequenceState.data.episodeRange.from
    || actualEpisodeRange.to !== sequenceState.data.episodeRange.to
  ) {
    throw new Error(`checkpoint ${input.row.id} source episode range changed`);
  }
  const currentSourceVersions = {
    [`task://${input.taskId}`]: input.taskSourceVersion,
    [`turn://${sourceTurn.id}`]: `${sourceTurn.sequence}:${sourceTurn.state}`,
  };
  const artifactUri = artifactUriSchema.safeParse(input.row.checkpointArtifact);
  if (!artifactUri.success) {
    throw new Error(`checkpoint ${input.row.id} has an invalid artifact URI`);
  }
  const artifactHash = contentHashSchema.parse(
    `sha256:${artifactUri.data.slice("artifact://sha256/".length)}`,
  );
  const bytes = await input.artifacts.get(artifactHash);
  const observedHash = computeContentHash(bytes);
  if (observedHash !== artifactHash) {
    throw new Error(
      `checkpoint ${input.row.id} artifact hash mismatch: expected ${artifactHash}, observed ${observedHash}`,
    );
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`checkpoint ${input.row.id} artifact is not valid UTF-8`, { cause: error });
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`checkpoint ${input.row.id} artifact is not valid JSON`, { cause: error });
  }
  const content = checkpointContentSchema.safeParse(decoded);
  if (!content.success) {
    throw new Error(
      `checkpoint ${input.row.id} artifact does not match CheckpointContent: ${content.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
    );
  }
  if (canonicalJson(content.data) !== text) {
    throw new Error(`checkpoint ${input.row.id} artifact is not canonically encoded`);
  }
  const expectedSourceKeys = Object.keys(currentSourceVersions).sort();
  const checkpointSourceKeys = Object.keys(content.data.sourceVersions).sort();
  if (
    expectedSourceKeys.length !== checkpointSourceKeys.length
    || expectedSourceKeys.some((key, index) => key !== checkpointSourceKeys[index])
  ) {
    throw new Error(`checkpoint ${input.row.id} does not contain the exact authoritative source set`);
  }
  const validation = validateCheckpoint(content.data, input.contract, currentSourceVersions);
  if (!validation.valid) {
    throw new Error(
      `checkpoint ${input.row.id} is invalid for the active task: ${validation.violations.map((violation) => violation.description).join("; ")}`,
    );
  }
  return {
    id: input.row.id as Checkpoint["id"],
    threadId: input.row.threadId as Checkpoint["threadId"],
    turnId: sequenceState.data.sourceTurnId as Checkpoint["turnId"],
    episodeRange: sequenceState.data.episodeRange,
    artifactHash,
    canonicalStateHash: artifactHash,
    summary: "Durable checkpoint validated from its immutable canonical artifact.",
    effectState: content.data.effectState,
    approvalState: content.data.approvalState,
    createdAt: input.row.createdAt.toISOString() as Rfc3339Timestamp,
  };
}

/** Kernel-backed code-intelligence retrieval for the live compiler path. */
function kernelRetrievalPipeline(
  clients: KernelUdsClients,
  baseContext: RequestContext,
  observedAt: Rfc3339Timestamp,
  modelKey: ModelKey,
  sessionId: string,
  taskId: string,
  workspaceId: string,
): RetrievalPipeline {
  const fileReader: WorkspaceFileReader = async ({ path, startLine, endLine }) => {
    try {
      const read = await clients.files.Read({
        context: {
          ...baseContext,
          requestId: randomUUID(),
          idempotencyKey: `code-hydrate:${randomUUID()}`,
        },
        intent: {
          userIntentRef: "retrieval-hydration",
          taskContractHash: "",
          trustLabel: "derived",
          confidentialityLabel: "workspace",
          taintSources: [],
          policyProfileId: "secure-local-default",
          expectedEffectClass: "read_local",
        },
        path: { workspaceId, relativePath: path },
        mode: "ranges",
        ranges: [{ startLine, endLine }],
        symbols: [],
        maxBytes: 48 * 1_024,
        expectedSha256: "",
      });
      return {
        content: new TextDecoder("utf-8", { fatal: false }).decode(read.modelProjectionUtf8),
        fileSha256: read.sourceVersion?.sha256 ?? null,
        totalLines: null,
      };
    } catch {
      // File unreadable (deleted/moved/unreadable since indexing): the
      // caller falls back to the metadata-only representation.
      return { content: null, fileSha256: null, totalLines: null };
    }
  };
  const retrieve = async (queries: readonly RetrievalQuery[]): Promise<readonly RetrievalResult[]> => {
    const results: RetrievalResult[] = [];
    const seen = new Set<string>();
    for (const query of queries) {
      const response = await clients.codeIntel.Search({
        context: {
          ...baseContext,
          requestId: randomUUID(),
          idempotencyKey: `code-search:${randomUUID()}`,
        },
        workspaceId,
        query: query.text,
        limit: 5,
      });
      if (response.truncated) {
        throw new Error(
          `code-intelligence retrieval truncated for query ${JSON.stringify(query.text)}${response.continuation === undefined ? " without a continuation token" : "; continuation RPC is unavailable"}`,
        );
      }
      for (const hit of response.results) {
        const id = `kernel-code:${hit.path}:${hit.line}:${hit.symbol}`;
        if (seen.has(id)) continue;
        seen.add(id);
        // Hydrate the hit into an actual source span before labeling it as
        // code context (deep-audit Rank 1 / PR3). Metadata-only fallback
        // preserves navigation value when the file cannot be read.
        const searchHit: SearchHit = {
          path: hit.path,
          line: hit.line,
          symbol: typeof hit.symbol === "string" && hit.symbol.length > 0 ? hit.symbol : null,
          method: hit.method,
        };
        const hydratedSpan = await hydrateSearchHit(searchHit, fileReader);
        const text = hydratedSpan?.fragmentText ?? [
          `# Code intelligence result`,
          `path: ${hit.path}`,
          `line: ${hit.line}`,
          `symbol: ${hit.symbol}`,
          `index method: ${hit.method}`,
          `(source span unavailable — request read for implementation)`,
        ].join("\n");
        const hash = computeContentHash(text);
        const fragment: ContextFragment = {
          id,
          kind: "code",
          contentRef: {
            hash,
            uri: `artifact://sha256/${hash.slice("sha256:".length)}` as ContextFragment["contentRef"]["uri"],
            mediaType: "text/plain",
            bytes: BigInt(new TextEncoder().encode(text).byteLength) as ContextFragment["contentRef"]["bytes"],
          },
          textContent: text,
          source: {
            uri: `workspace://${hit.path}`,
            producer: "terminus-kernel-code-intel",
            producerVersion: "v1",
            observedAt,
            observedBy: "kernel",
            evidenceRefs: [],
          },
          sourceVersion: null,
          authority: 55,
          priority: 55,
          trust: "derived",
          confidentiality: "workspace",
          injectionRisk: "low",
          exactness: "recoverable_by_reference",
          scope: {
            workspaceId: null,
            sessionId: sessionId as ContextFragment["scope"]["sessionId"],
            taskId: taskId as ContextFragment["scope"]["taskId"],
            pathPatterns: [hit.path],
          },
          freshness: { observedAt, sourceVersion: null, stale: false, staleReason: null },
          dependencies: [],
          invalidation: [{ kind: "file_changed", selector: hit.path }],
          estimatedTokens: { [modelKey]: Math.max(1, Math.ceil(text.length / 4)) },
          selectionFeatures: {
            relevance: query.suggestedMethods.includes(mapRetrievalMethod(hit.method)) ? 0.9 : 0.6,
            novelty: 0.7,
            coverage: 0.8,
            uncertaintyReduction: 0.7,
            riskReduction: 0.5,
            modelCompatibility: 1,
            redundancyPenalty: 0,
            injectionPenalty: 0,
          },
        };
        results.push({
          fragment,
          method: mapRetrievalMethod(hit.method),
          rawScore: 1,
          rerankedScore: 1,
          sourceVersion: hydratedSpan?.fileSha256 ?? null,
          reason: query.reason,
        });
      }
    }
    return results;
  };
  return {
    retrieve: (queries) => retrieve(queries),
    expandForGaps: (gaps) => retrieve(gaps.map((gap) => ({
      text: gap.requirement,
      reason: `evidence gap: ${gap.requirementId}`,
      suggestedMethods: ["lexical_bm25"],
    }))),
  };
}

function mapRetrievalMethod(method: string): RetrievalMethod {
  switch (method) {
    case "tree_sitter":
    case "lsp":
    case "graph":
      return method === "graph" ? "dependency_graph" : method;
    case "lexical_bm25":
      return method;
    default:
      return "lexical_bm25";
  }
}

interface AgentTaskTransition {
  readonly taskId: string;
  readonly expectedStatuses: readonly string[];
  readonly status: string;
  readonly phase: string;
  readonly completedAt: Date | null;
  readonly terminalReasonJson: string | null;
  readonly verificationPlanId?: string | null;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

async function transitionAgentTask(input: AgentTaskTransition): Promise<boolean> {
  return mutateAgentState(async () => {
    const current = await db.task.findUnique({
      where: { id: input.taskId },
      select: { status: true },
    });
    if (current === null || !input.expectedStatuses.includes(current.status)) return false;
    await emit({
      eventType: input.eventType,
      aggregateType: "task",
      aggregateId: input.taskId,
      correlationId: input.taskId,
      payload: input.payload,
    }, async (tx) => {
      const update = await tx.task.updateMany({
        where: { id: input.taskId, status: { in: [...input.expectedStatuses] } },
        data: {
          status: input.status,
          phase: input.phase,
          completedAt: input.completedAt,
          terminalReasonJson: input.terminalReasonJson,
          ...(input.verificationPlanId === undefined
            ? {}
            : { verificationPlanId: input.verificationPlanId }),
        },
      });
      if (update.count !== 1) throw new Error(`task ${input.taskId} changed during agent transition`);
    });
    await synchronizeV1TaskProjection(input.taskId, input.eventType);
    return true;
  });
}

const verificationCoordinator = new VerificationCoordinator<Prisma.TransactionClient>({
  readTask: async (taskId) => db.task.findUnique({ where: { id: taskId }, select: { status: true } }),
  appendEvent: async (event, mutation): Promise<void> => {
    await emit({
      eventType: event.eventType,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      correlationId: event.correlationId,
      payload: event.payload,
      artifactRefs: event.artifactRefs === undefined ? undefined : [...event.artifactRefs],
    }, mutation);
  },
  updateTask: async (tx, input: VerificationTransitionInput, expectedStatuses) => {
    const update = await tx.task.updateMany({
      where: { id: input.taskId, status: { in: [...expectedStatuses] } },
      data: {
        status: input.status,
        phase: input.phase,
        completedAt: input.completedAt,
        terminalReasonJson: input.terminalReasonJson,
        ...(input.verificationPlanId === undefined ? {} : { verificationPlanId: input.verificationPlanId }),
      },
    });
    if (update.count !== 1) throw new Error(`task ${input.taskId} changed during verification transition`);
  },
  mutate: mutateAgentState,
  projectTask: async (taskId, eventType): Promise<void> => { await synchronizeV1TaskProjection(taskId, eventType); },
});

class AmbiguousToolSettlementError extends Error {
  constructor(readonly toolCallId: string, message: string) {
    super(message);
    this.name = "AmbiguousToolSettlementError";
  }
}

interface StandaloneToolSettlementInput {
  readonly callChunk: ProviderToolCallChunk;
  readonly providerAttemptId: string;
  readonly turnId: string;
  readonly taskId: string;
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly contractVersion: number;
  readonly contractHash: string;
  readonly artifactClient: ArtifactClient;
}

async function settleStandaloneProviderTool(
  input: StandaloneToolSettlementInput,
): Promise<void> {
  const call = parseStandaloneToolCall(input.callChunk);
  const toolCallId = uuid();
  const operationHash = normalizedToolOperationHash({
    taskId: input.taskId,
    contractVersion: input.contractVersion,
    call,
  });
  const effect = toolEffectMetadata(call);
  const argumentsText = canonicalJson(call.arguments);
  const argumentsArtifact = await input.artifactClient.ingest(
    new TextEncoder().encode(argumentsText),
    { mediaType: "application/json", custom: { purpose: "tool-arguments", toolCallId } },
  );
  const callTranscriptText = canonicalJson(providerToolCallTranscript(call));
  const callTranscriptArtifact = await input.artifactClient.ingest(
    new TextEncoder().encode(callTranscriptText),
    { mediaType: "application/json", custom: { purpose: "tool-call-transcript", toolCallId } },
  );
  await input.artifactClient.link(argumentsArtifact.hash, "tool_call", toolCallId, "arguments");
  await input.artifactClient.link(callTranscriptArtifact.hash, "tool_call", toolCallId, "provider-transcript");

  await mutateAgentState(() => emit({
    eventType: "tool.proposed",
    aggregateType: "tool_call",
    aggregateId: toolCallId,
    correlationId: input.taskId,
    payload: {
      turn_id: input.turnId,
      provider_attempt_id: input.providerAttemptId,
      provider_call_id: call.providerCallId,
      tool_id: call.toolId,
      tool_version: call.toolVersion,
      normalized_operation_hash: operationHash,
    },
    artifactRefs: [argumentsArtifact.uri, callTranscriptArtifact.uri],
  }, async (tx) => {
    await tx.toolCall.create({
      data: {
        id: toolCallId,
        turnId: input.turnId,
        providerAttemptId: input.providerAttemptId,
        toolId: call.toolId,
        toolVersion: call.toolVersion,
        argumentsArtifact: argumentsArtifact.uri,
        normalizedOperationHash: operationHash,
        state: "PROPOSED",
      },
    });
  }));

  const existingEffect = await db.sideEffect.findUnique({
    where: { effectType_idempotencyKey: { effectType: effect.effectType, idempotencyKey: operationHash } },
    select: { id: true, state: true },
  });
  if (existingEffect !== null) {
    const policyDecisionId = await denyStandaloneTool({
      input,
      call,
      toolCallId,
      argumentsArtifactUri: argumentsArtifact.uri,
      effectType: effect.effectType,
      ruleId: "standalone.semantic-idempotency",
      explanation: `Semantic operation already exists as effect ${existingEffect.id} in state ${existingEffect.state}`,
    });
    const result = {
      ...errorResult("Terminus rejected a duplicate semantic operation", {
        toolCallId,
        traceId: input.turnId,
        status: "denied",
        summary: "Duplicate semantic operation was not dispatched",
      }),
      policyDecisionId,
    };
    await persistSettledToolResult({
      input,
      call,
      toolCallId,
      callTranscriptArtifactUri: callTranscriptArtifact.uri,
      sideEffectId: null,
      result,
    });
    return;
  }

  let context: RequestContext;
  try {
    context = await kernelContextForTask(
      input.taskId,
      input.turnId,
      [call.toolId === "read"
        ? CapabilityOperationProto.CAPABILITY_OPERATION_READ
        : call.toolId === "patch"
          ? CapabilityOperationProto.CAPABILITY_OPERATION_PATCH
          : CapabilityOperationProto.CAPABILITY_OPERATION_EXEC],
      [call.toolId === "exec" ? call.arguments.cwd : call.arguments.path],
    );
  } catch (error: unknown) {
    const explanation = error instanceof Error ? error.message : String(error);
    const policyDecisionId = await denyStandaloneTool({
      input,
      call,
      toolCallId,
      argumentsArtifactUri: argumentsArtifact.uri,
      effectType: effect.effectType,
      ruleId: "task-contract.scope",
      explanation,
    });
    const result = {
      ...errorResult(explanation, {
        toolCallId,
        traceId: input.turnId,
        status: "denied",
        summary: "Task contract denied the tool call",
      }),
      policyDecisionId,
    };
    await persistSettledToolResult({
      input,
      call,
      toolCallId,
      callTranscriptArtifactUri: callTranscriptArtifact.uri,
      sideEffectId: null,
      result,
    });
    return;
  }

  const policyDecisionId = uuid();
  const sideEffectId = generateUuid7();
  await effectSettlementService.authorize({
    taskId: input.taskId,
    toolCallId,
    sideEffectId,
    policyDecisionId,
    effectType: effect.effectType,
    argumentsArtifactUri: argumentsArtifact.uri,
    resourceUri: effect.resourceUri,
    reversibility: effect.reversibility,
    idempotencyKey: operationHash,
    workspaceId: input.workspaceId,
  });
  await effectSettlementService.start({
    taskId: input.taskId,
    toolCallId,
    sideEffectId,
    policyDecisionId,
    effectType: effect.effectType,
    argumentsArtifactUri: argumentsArtifact.uri,
    resourceUri: effect.resourceUri,
    reversibility: effect.reversibility,
    idempotencyKey: operationHash,
    workspaceId: input.workspaceId,
  });

  let result: ToolResult<unknown>;
  try {
    result = await executeStandaloneTool({
      clients: requireKernelUds(),
      context: { ...context, idempotencyKey: operationHash },
      workspaceId: input.workspaceId,
      call,
      internalToolCallId: toolCallId,
      sideEffectId,
      policyDecisionId,
      traceId: input.turnId,
      contractHash: input.contractHash,
      devMode: DEV_MODE,
    });
  } catch (error: unknown) {
    if (call.toolId !== "read") {
      const message = error instanceof Error ? error.message : String(error);
      await effectSettlementService.markUnknown({
        taskId: input.taskId,
        toolCallId,
        sideEffectId,
        error: message,
      });
      throw new AmbiguousToolSettlementError(toolCallId, `Tool ${call.toolId} lost settlement certainty: ${message}`);
    }
    const message = error instanceof Error ? error.message : String(error);
    result = {
      ...errorResult(message, {
        toolCallId,
        traceId: input.turnId,
        summary: `Read failed: ${message}`,
      }),
      policyDecisionId,
    };
  }

  await persistSettledToolResult({
    input,
    call,
    toolCallId,
    callTranscriptArtifactUri: callTranscriptArtifact.uri,
    sideEffectId,
    result,
  });
}

async function denyStandaloneTool(input: {
  readonly input: StandaloneToolSettlementInput;
  readonly call: ParsedStandaloneToolCall;
  readonly toolCallId: string;
  readonly argumentsArtifactUri: string;
  readonly effectType: string;
  readonly ruleId: string;
  readonly explanation: string;
}): Promise<string> {
  const policyDecisionId = uuid();
  await mutateAgentState(() => emit({
    eventType: "tool.denied",
    aggregateType: "tool_call",
    aggregateId: input.toolCallId,
    correlationId: input.input.taskId,
    payload: {
      provider_call_id: input.call.providerCallId,
      policy_decision_id: policyDecisionId,
      rule_id: input.ruleId,
      explanation: input.explanation,
    },
    artifactRefs: [input.argumentsArtifactUri],
  }, async (tx) => {
    await tx.policyDecision.create({
      data: {
        id: policyDecisionId,
        toolCallId: input.toolCallId,
        effectType: input.effectType,
        normalizedInputArtifact: input.argumentsArtifactUri,
        decision: "deny",
        ruleIdsJson: JSON.stringify([input.ruleId]),
        constraintsJson: "{}",
        policyVersion: "secure-local-default:v1",
        explanation: input.explanation,
      },
    });
    await tx.toolCall.update({
      where: { id: input.toolCallId },
      data: { state: "DENIED", policyDecisionId, settledAt: new Date(), resultStatus: "denied" },
    });
  }));
  return policyDecisionId;
}

async function persistSettledToolResult(input: {
  readonly input: StandaloneToolSettlementInput;
  readonly call: ParsedStandaloneToolCall;
  readonly toolCallId: string;
  readonly callTranscriptArtifactUri: string;
  readonly sideEffectId: string | null;
  readonly result: ToolResult<unknown>;
}): Promise<void> {
  const fullResultText = canonicalJson(input.result);
  const fullResultArtifact = await input.input.artifactClient.ingest(
    new TextEncoder().encode(fullResultText),
    { mediaType: "application/json", custom: { purpose: "tool-result", toolCallId: input.toolCallId } },
  );
  await input.input.artifactClient.link(fullResultArtifact.hash, "tool_call", input.toolCallId, "result");
  const resultRecord = z.record(z.string(), z.unknown()).parse(JSON.parse(fullResultText) as unknown);
  const fullResultBytes = new TextEncoder().encode(fullResultText).byteLength;
  const projectedResult = fullResultBytes <= MAX_TOOL_MODEL_RESULT_BYTES
    ? resultRecord
    : z.record(z.string(), z.unknown()).parse(JSON.parse(canonicalJson({
        ...input.result,
        data: null,
        summary: `${input.result.summary} Full result: ${fullResultArtifact.uri}`,
        artifacts: [
          ...input.result.artifacts,
          {
            uri: fullResultArtifact.uri,
            mediaType: fullResultArtifact.mediaType,
            bytes: Number(fullResultArtifact.bytes),
            hash: fullResultArtifact.hash,
          },
        ],
        truncation: {
          occurred: true,
          reason: `tool result exceeded ${MAX_TOOL_MODEL_RESULT_BYTES} model bytes`,
          continuation: fullResultArtifact.uri,
        },
      })) as unknown);
  const resultTranscriptText = canonicalJson(providerToolResultTranscript(input.call, projectedResult));
  if (new TextEncoder().encode(resultTranscriptText).byteLength > MAX_TOOL_MODEL_RESULT_BYTES) {
    throw new Error("bounded tool result transcript still exceeds the model-result limit");
  }
  const resultTranscriptArtifact = await input.input.artifactClient.ingest(
    new TextEncoder().encode(resultTranscriptText),
    { mediaType: "application/json", custom: { purpose: "tool-result-transcript", toolCallId: input.toolCallId } },
  );
  await input.input.artifactClient.link(resultTranscriptArtifact.hash, "tool_call", input.toolCallId, "provider-result-transcript");

  const toolState = input.result.status === "denied"
    ? "DENIED"
    : input.result.status === "success" || input.result.status === "partial"
      ? "SETTLED"
      : "FAILED";
  await effectSettlementService.settle({
    taskId: input.input.taskId,
    turnId: input.input.turnId,
    providerAttemptId: input.input.providerAttemptId,
    toolCallId: input.toolCallId,
    sideEffectId: input.sideEffectId,
    providerCallId: input.call.providerCallId,
    status: input.result.status,
    resultStatus: input.result.status,
    toolState,
    summary: input.result.summary,
    callTranscriptArtifactUri: input.callTranscriptArtifactUri,
    resultArtifactUri: fullResultArtifact.uri,
    resultTranscriptArtifactUri: resultTranscriptArtifact.uri,
    resultTranscriptHash: resultTranscriptArtifact.hash,
    errorJson: toolState === "SETTLED" ? null : JSON.stringify({ summary: input.result.summary }),
    truncation: input.result.truncation,
  });
}

// ────────────────────────── Agent loop ─────────────────────────────────────

/**
 * Pair settled episodes into ordered `[toolName, resultJson]` observations
 * for world-state derivation. A tool_result observation inherits the tool
 * name of its immediately preceding tool_call episode.
 */
function buildEpisodeObservations(
  episodes: readonly { readonly kind: string; readonly contentRef: ContentHash | null }[],
  content: ReadonlyMap<ContentHash, string>,
): { readonly toolName: string; readonly resultJson: string }[] {
  const observations: { readonly toolName: string; readonly resultJson: string }[] = [];
  let pendingToolName: string | null = null;
  for (const episode of episodes) {
    const body = episode.contentRef === null ? null : content.get(episode.contentRef);
    if (body === undefined || body === null) continue;
    if (episode.kind === "tool_call") {
      try {
        const parsed: unknown = JSON.parse(body);
        if (
          typeof parsed === "object" && parsed !== null &&
          typeof (parsed as Record<string, unknown>).tool_name === "string"
        ) {
          pendingToolName = (parsed as { tool_name?: unknown }).tool_name as string;
        }
      } catch {
        pendingToolName = null;
      }
    } else if (episode.kind === "tool_result" && pendingToolName !== null) {
      observations.push({ toolName: pendingToolName, resultJson: body });
      pendingToolName = null;
    }
  }
  return observations;
}

/**
 * The agent loop: compile context → provider attempt → tool settlement →
 * verification → completion. Each step emits semantic events so the UI can
 * observe the full trajectory.
 *
 * Context compilation can run locally. Provider execution cannot proceed
 * until a kernel-brokered transport is configured; the missing boundary is
 * reported as a blocked task and never replaced by a synthetic response.
 */
async function agentLoop(turnId: string): Promise<void> {
  const turn = await db.turn.findUnique({
    where: { id: turnId },
    include: {
      task: { include: { contractVersions: { orderBy: { version: "desc" }, take: 1 } } },
      thread: { include: { session: { include: { workspace: true } } } },
    },
  });
  if (!turn) return;
  try {
    // 1. CONTEXT_COMPILING
    const enteredContextCompilation = await mutateAgentState(async () => {
      const current = await db.turn.findUnique({ where: { id: turnId }, select: { state: true } });
      if (current?.state !== "PENDING") return false;
      await emit({
        eventType: "turn.context_compiling",
        aggregateType: "turn", aggregateId: turnId,
        correlationId: turn.taskId ?? undefined,
        payload: { phase: "context_compiling" },
      }, async (tx) => {
        const update = await tx.turn.updateMany({
          where: { id: turnId, state: "PENDING" },
          data: { state: "CONTEXT_COMPILING", startedAt: new Date() },
        });
        if (update.count !== 1) throw new Error(`turn ${turnId} changed before context compilation`);
      });
      return true;
    });
    if (!enteredContextCompilation) return;
    const task = turn.task;
    const contractRow = task?.contractVersions[0];
    if (task === null || contractRow === undefined) {
      throw new Error(`turn ${turnId} has no active task contract`);
    }
    const criteriaRows = await db.acceptanceCriterion.findMany({
      where: { taskId: task.id, contractVersion: contractRow.version },
      orderBy: { criterionId: "asc" },
    });
    const contract = persistedTaskContract(task, contractRow, criteriaRows);
    const taskSnapshot: TaskSnapshot = {
      taskId: task.id as TaskSnapshot["taskId"],
      contract,
      phase: task.phase,
      changedFiles: [],
      failingTests: [],
      diagnostics: [],
      unknowns: safeParse<string[]>(contractRow.unknownsJson, []),
    };

    const workspace = turn.thread.session.workspace;
    const artifactContext: RequestContext = {
      ...await kernelTaskContext({
        sessionId: turn.thread.sessionId,
        taskId: task.id,
        turnId,
        workspaceId: workspace.id,
        operationClasses: [
          CapabilityOperationProto.CAPABILITY_OPERATION_ARTIFACT_INGEST,
          CapabilityOperationProto.CAPABILITY_OPERATION_CODE_INTEL,
        ],
        workspacePaths: leastWorkspaceScope([
          ...contract.allowedScope.readPaths,
          ...contract.allowedScope.writePaths,
        ]),
      }),
      sessionId: turn.thread.sessionId,
      taskId: task.id,
      turnId,
      workspaceId: workspace.id,
      idempotencyKey: `context:${turnId}`,
    };
    const artifactClient = createKernelArtifactClient(requireKernelUds().artifacts, artifactContext);
    const inputArtifactUri = artifactUriSchema.parse(turn.initiatingInputArtifact);
    const inputArtifactHash = contentHashSchema.parse(
      `sha256:${inputArtifactUri.slice("artifact://sha256/".length)}`,
    );
    const inputBytes = await artifactClient.get(inputArtifactHash);
    if (inputBytes.byteLength > MAX_REQUEST_BYTES) {
      throw new Error(`turn input artifact exceeds the ${MAX_REQUEST_BYTES}-byte admission limit`);
    }
    const userInput = new TextDecoder("utf-8", { fatal: true }).decode(inputBytes);

    const worldState: WorldStateSnapshot = {
      observedAt: now(),
      sourceVersions: {
        [`task://${task.id}`]: contractRow.contentHash,
        [`workspace://${workspace.id}`]: workspace.lastOpenedAt.toISOString(),
        "policy://secure-local-default": "v1",
      },
      sections: {
        request: { text: userInput, artifact: inputArtifactUri },
        task: { id: task.id, status: task.status, phase: task.phase, contractVersion: contractRow.version },
        workspace: { id: workspace.id, rootUri: workspace.rootUri, trust: workspace.trust },
        verification: { status: "pending", acceptanceCriteria: criteriaRows.map((criterion) => criterion.criterionId) },
        memory: { enabled: false, reason: "memory precision/harm gate not promoted" },
      },
    };
    const checkpointRow = await db.checkpoint.findFirst({
      where: { threadId: turn.threadId, taskId: task.id, admissionState: "COMMITTED" },
      orderBy: { createdAt: "desc" },
    });
    const checkpoint: Checkpoint | null = checkpointRow === null
      ? null
      : await loadValidatedCheckpoint({
          row: checkpointRow,
          artifacts: artifactClient,
          contract,
          taskId: task.id,
          taskSourceVersion: contractRow.contentHash,
        });
    const providerConfiguration = await db.providerConfiguration.findUnique({
      where: { id: PROVIDER_CONFIGURATION_ID },
    });
    const gatewayProviderConfiguration = await db.gatewayProviderConfiguration.findUnique({
      where: { id: GATEWAY_PROVIDER_CONFIGURATION_ID },
    });
    const localProviderCommand = providerConfiguration === null
      ? parseLocalProviderCommand(process.env.TERMINUS_LOCAL_PROVIDER_COMMAND_JSON)
      : providerConfigurationCommand(providerConfiguration);
    const localToolsEnabled = localProviderCommand?.toolsEnabled ?? false;
    const localProvider = providerConfiguration === null
      ? (localProviderCommand === null
          ? unconfiguredProviderSnapshot(now())
          : configuredLocalProviderSnapshot(
              {
                program: localProviderCommand.program,
                args: [...localProviderCommand.args],
                model: localProviderCommand.model,
                timeout_seconds: localProviderCommand.timeoutSeconds,
                tools_enabled: localToolsEnabled,
              },
              1,
              now(),
            ))
      : configuredLocalProviderSnapshot(
          parseProviderConfigurationInput({
            program: providerConfiguration.program,
            args: JSON.parse(providerConfiguration.argsJson) as unknown,
            model: providerConfiguration.model,
            timeout_seconds: providerConfiguration.timeoutSeconds,
            tools_enabled: providerConfiguration.toolsEnabled,
          }),
          providerConfiguration.revision,
          now(),
        );
    const localModel: ModelCapabilitySnapshot = {
      modelKey: localProviderCommand?.model ?? ("local/unconfigured" as ModelKey),
      providerId: localProvider.providerId,
      snapshot: localProvider,
      observedAt: localProvider.observedAt,
    };
    const gatewayModel = gatewayProviderConfiguration === null
      ? null
      : configuredGatewayModel(
          gatewayProviderConfiguration,
          now(),
          // Cache-only: the turn path never triggers discovery, so a cold
          // cache costs accuracy on a metadata field rather than latency and
          // a new failure mode on every turn.
          describeConfiguredModel(
            gatewayProviderConfiguration.deployment === "go" ? "go" : "zen",
            gatewayProviderConfiguration.model,
          ),
        );
    const selectedProvider = gatewayModel === null
      ? localProvider
      : configuredGatewayProviderSnapshot(
          gatewayModel,
          gatewayProviderConfiguration?.revision ?? 0,
          gatewayProviderConfiguration?.workspaceAccess ?? false,
          gatewayProviderConfiguration?.privacyTermsAdmitted ?? false,
          gatewayProviderConfiguration?.privacyTermsVersion ?? null,
        );
    const selectedModel: ModelCapabilitySnapshot = gatewayModel === null
      ? localModel
      : {
          modelKey: gatewayModelKey(gatewayModel),
          providerId: selectedProvider.providerId,
          snapshot: selectedProvider,
          observedAt: selectedProvider.observedAt,
        };
    const selectedRenderer = gatewayModel === null
      ? new LocalRenderer()
      : new GatewayRenderer([gatewayModel]);
    const toolsEnabled = gatewayModel === null
      ? (localProviderCommand?.toolsEnabled ?? false)
      : gatewayModel.toolCalling;
    const contextBudget = makeContextBudget(selectedProvider, taskSnapshot.contract.budget);
    const threadSnapshot: ThreadSnapshot = {
      threadId: turn.threadId as ThreadSnapshot["threadId"],
      sessionId: turn.thread.sessionId as ThreadSnapshot["sessionId"],
      activeContextEpochId: turn.thread.activeContextEpochId as ThreadSnapshot["activeContextEpochId"],
    };
    const contextStore = new PrismaContextStore(
      db,
      artifactClient,
      { sessionId: task.sessionId, taskId: task.id, turnId, workspaceId: workspace.id },
      mutateAgentState,
      assertControlWriterLease,
    );
    const toolEpisodeService = new ToolEpisodeService({
      store: {
        listModelVisibleEpisodes: async (episodeTurnId) => db.episode.findMany({
          where: { turnId: episodeTurnId, modelVisible: true },
          orderBy: { sequence: "asc" },
          take: 16,
        }),
        readArtifact: (hash) => artifactClient.get(hash as ContentHash),
      },
      settleCall: async (toolInput) => settleStandaloneProviderTool({
        callChunk: toolInput.call,
        providerAttemptId: toolInput.providerAttemptId,
        turnId: toolInput.turnId,
        taskId: toolInput.taskId,
        sessionId: toolInput.sessionId,
        workspaceId: toolInput.workspaceId,
        contractVersion: toolInput.contractVersion,
        contractHash: toolInput.contractHash,
        artifactClient: toolInput.artifactClient,
      }),
    });
    const toolEpisodeSession = toolEpisodeService.startTurn();
    // Rank 3: bounded verify–repair–admit policy for this completion proposal.
    const verificationRepairController = new VerificationRepairController({
      maxRepairAttempts:
        Number.parseInt(process.env.TERMINUS_MAX_REPAIR_ATTEMPTS ?? "", 10) || 2,
    });
    let latestChangedFiles: readonly string[] = [];
    const contextEpoch = await ensureContextEpoch({
      db,
      threadId: turn.threadId,
      taskId: task.id,
      workspaceId: workspace.id,
      provider: selectedProvider,
      model: selectedModel,
      worldState,
      artifacts: artifactClient,
    });
    const confidentialityPolicy: ConfidentialityPolicy = {
      allowedProviders: {
        public: [selectedProvider.providerId],
        workspace: selectedProvider.policy.allowedConfidentiality.includes("workspace")
          ? [selectedProvider.providerId]
          : [],
        secret_adjacent: [],
        secret: [],
      },
    };
    const compileProviderContext = async () => {
      const recent = await toolEpisodeService.loadModelVisibleEpisodes(turnId);
      // Prior-turn verification failures become first-class repair inputs.
      const lastFailedPlan = await db.verificationPlan.findFirst({
        where: { taskId: task.id },
        orderBy: { createdAt: "desc" },
        include: { results: { where: { status: { in: ["fail", "error"] } } } },
      });
      const priorVerificationFailures = (lastFailedPlan?.results ?? [])
        .map((result) => `${result.nodeId}: ${result.reason ?? result.status}`);
      // Rank 1 (PR2): derive authoritative working-set state from settled
      // episodes instead of passing empty collections to the compiler.
      const contextState = new ContextStateBuilder().build({
        taskId: task.id as never,
        contractVersion: contractRow.version,
        contractContentHash: contractRow.contentHash as ContentHash,
        phase: task.phase,
        unknowns: safeParse<string[]>(contractRow.unknownsJson, []),
        observedAt: worldState.observedAt,
        workspace: {
          workspaceId: workspace.id,
          rootUri: workspace.rootUri,
          trust: workspace.trust,
        },
        environment: {
          sandboxProfileId: DEV_MODE ? "degraded-local" : "secure-local-default",
          backendId: null,
        },
        episodeObservations: buildEpisodeObservations(recent.episodes, recent.content),
        priorVerificationFailures,
      });
      latestChangedFiles = [...contextState.taskSnapshot.changedFiles];
      const effectiveTaskSnapshot: TaskSnapshot = {
        ...taskSnapshot,
        changedFiles: contextState.taskSnapshot.changedFiles,
        failingTests: contextState.taskSnapshot.failingTests,
        diagnostics: contextState.taskSnapshot.diagnostics,
      };
      const effectiveWorldState: WorldStateSnapshot = {
        ...worldState,
        sections: { ...worldState.sections, ...contextState.worldStateSections },
      };
      const compiled = await compileContext({
        task: effectiveTaskSnapshot,
        thread: threadSnapshot,
        provider: selectedProvider,
        model: selectedModel,
        epoch: contextEpoch,
        worldState: effectiveWorldState,
        recentEpisodes: recent.episodes,
        episodeContent: recent.content,
        checkpoint,
        userDirectives: [] as readonly ContextDirective[],
        activeCapabilities: toolsEnabled
          ? STANDALONE_TOOL_SCHEMAS.map((tool) => ({ id: tool.id, version: tool.version }))
          : [],
        budget: contextBudget,
        experimentAssignments: [],
        renderer: selectedRenderer,
        confidentialityPolicy,
        toolSchemas: toolsEnabled ? STANDALONE_TOOL_SCHEMAS : [],
        compactionPolicy: { enabled: false, targetTokens: Number(contextBudget.optionalContextTarget) },
        store: contextStore,
        retrievalPipeline: kernelRetrievalPipeline(
          requireKernelUds(),
          artifactContext,
          worldState.observedAt,
          selectedModel.modelKey,
          task.sessionId,
          task.id,
          workspace.id,
        ),
        signal: null,
      });
      const requestArtifact = compiled.renderedRequestArtifact;
      if (requestArtifact === null) throw new Error("context store did not persist rendered provider request");
      const baselineArtifact = await ingestJsonArtifact(
        artifactClient,
        {
          epochId: contextEpoch.epochId,
          stablePrefixHash: compiled.manifest.cachePlan.stablePrefixHash,
          fragments: compiled.manifest.fragments.map((fragment) => ({
            id: fragment.fragmentId,
            hash: fragment.artifactHash,
          })),
        },
        "context-epoch-baseline",
        { taskId: task.id, turnId, workspaceId: workspace.id },
      );
      await mutateAgentState(() => emit({
        eventType: "context.manifest_persisted",
        aggregateType: "context_manifest",
        aggregateId: compiled.manifest.id,
        correlationId: turn.taskId ?? undefined,
        payload: {
          turn_id: turnId,
          fragment_count: compiled.manifest.fragments.length,
          provider: selectedProvider.providerId,
          model: selectedModel.modelKey,
          total_estimated_tokens: compiled.totalEstimatedTokens,
          omitted_count: compiled.omitted.length,
        },
        artifactRefs: [requestArtifact.uri],
      }, async (tx) => {
        await tx.contextEpoch.update({
          where: { id: contextEpoch.epochId },
          data: {
            baselineHash: compiled.manifest.cachePlan.stablePrefixHash,
            baselineArtifact: baselineArtifact.uri,
          },
        });
      }));
      return { compiled, requestArtifact };
    };

    let finalText: string | null = null;
    let finalResponseArtifactUri: string | null = null;
    // Rank 1/Rank 2: run the bounded coding loop through the extracted
    // engine — adaptive budgets replace the fixed four-cycle ceiling, and
    // multi-call responses are batched (reads parallel-safe, writes ordered).
    const sideEffectClassOf = (toolName: string): string =>
      STANDALONE_TOOL_SCHEMAS.find((tool) => tool.id === toolName)?.sideEffectClass ?? "external";
    let lastResponseArtifactUri: string | null = null;
    let currentProjected: ProjectedResponse | null = null;
    const toolSettlementEnteredFor = new Set<string>();
    const manifestIdByAttempt = new Map<string, Uuid7>();
    const engine = new CodingTurnEngine({
      budget: {
        maxSteps: Number.parseInt(process.env.TERMINUS_TURN_MAX_STEPS ?? "", 10) || HARD_MAX_STEPS,
        hardMaxSteps: HARD_MAX_STEPS,
      },
      newId: uuid,
      sideEffectClassOf,
      compileContext: async () => {
        const { compiled, requestArtifact } = await compileProviderContext();
        return {
          rendered: compiled.rendered,
          requestArtifactUri: requestArtifact.uri,
          contextManifestId: compiled.manifest.id as string,
          providerCapabilityHash: compiled.manifest.providerCapabilityHash as string,
        };
      },
      beginAttempt: async ({ attemptId, attemptNumber, compiled }) => {
        manifestIdByAttempt.set(attemptId, compiled.contextManifestId as Uuid7);
        return providerSessionService.beginAttempt({
          attemptId,
          turnId,
          taskId: task.id,
          attemptNumber,
          providerId: selectedProvider.providerId,
          modelKey: selectedModel.modelKey,
          capabilitySnapshotHash: compiled.providerCapabilityHash,
          contextManifestId: compiled.contextManifestId,
          requestArtifact: compiled.requestArtifactUri,
        });
      },
      executeProvider: async ({ attemptId, compiled }) => {
        const providerContext: RequestContext = {
          ...await kernelTaskContext({
            sessionId: turn.thread.sessionId,
            taskId: task.id,
            turnId,
            workspaceId: workspace.id,
            operationClasses: gatewayModel === null
              ? [
                  CapabilityOperationProto.CAPABILITY_OPERATION_EXEC,
                  CapabilityOperationProto.CAPABILITY_OPERATION_JOB,
                  CapabilityOperationProto.CAPABILITY_OPERATION_ARTIFACT_INGEST,
                ]
              : [
                  CapabilityOperationProto.CAPABILITY_OPERATION_SECRET,
                  CapabilityOperationProto.CAPABILITY_OPERATION_NETWORK,
                  CapabilityOperationProto.CAPABILITY_OPERATION_ARTIFACT_INGEST,
                ],
            workspacePaths: gatewayModel === null
              ? leastWorkspaceScope([
                  ...contract.allowedScope.readPaths,
                  ...contract.allowedScope.writePaths,
                ])
              : [],
            networkDestinations: gatewayModel === null ? [] : ["opencode.ai:443"],
            secretCapabilities: gatewayModel === null
              ? []
              : [gatewaySecretUri(gatewayModel.deployment)],
          }),
          idempotencyKey: `provider:${attemptId}`,
        };
        return providerSessionService.execute({
          rendered: compiled.rendered,
          command: localProviderCommand,
          gateway: gatewayModel === null
            ? null
            : { model: gatewayModel, secretUri: gatewaySecretUri(gatewayModel.deployment) },
          context: providerContext,
          workspaceId: workspace.id,
        });
      },
      settleResponse: async ({ attemptId, response }) => {
        const midTurn = await db.turn.findUnique({ where: { id: turnId }, select: { state: true } });
        if (midTurn?.state === "INTERRUPTED") {
          return {
            projected: {
              text: "",
              toolCalls: [],
              reasoning: null,
              continuationId: null,
              finishReason: "cancelled",
            } satisfies ProjectedResponse,
            interrupted: true,
          };
        }
        const projected = await selectedRenderer.projectResponse(response);
        const usage = selectedRenderer.extractUsage(response);
        const responseArtifactMeta = await artifactClient.ingest(
          new TextEncoder().encode(canonicalJson(response)),
          {
            mediaType: "application/json",
            custom: { purpose: "provider-response", providerAttemptId: attemptId },
          },
        );
        const messageArtifactMeta = projected.text.length === 0
          ? null
          : await artifactClient.ingest(
              new TextEncoder().encode(projected.text),
              {
                mediaType: "text/plain",
                custom: { purpose: "provider-message", providerAttemptId: attemptId },
              },
            );
        const observedManifestId = manifestIdByAttempt.get(attemptId);
        if (observedManifestId === undefined) {
          throw new Error(`provider attempt ${attemptId} has no context manifest`);
        }
        await contextStore.recordObservation(observedManifestId, {
          responseArtifact: responseArtifactMeta.uri,
          usage: jsonSafe(usage),
          projectedFinishReason: projected.finishReason,
        });
        await providerSessionService.settleResponse({
          attemptId,
          turnId,
          taskId: task.id,
          responseArtifact: responseArtifactMeta.uri,
          messageArtifact: messageArtifactMeta?.uri ?? null,
          messageHash: messageArtifactMeta?.hash ?? null,
          usage: jsonSafe(usage),
          finishReason: projected.finishReason,
          continuationId: projected.continuationId,
        });
        lastResponseArtifactUri = responseArtifactMeta.uri;
        currentProjected = projected;
        if (projected.toolCalls.length === 0) {
          // Close the provider/tool phase for observers on a final response.
          await mutateAgentState(() => emit({
            eventType: "turn.tool_settlement",
            aggregateType: "turn",
            aggregateId: turnId,
            correlationId: task.id,
            payload: { provider_attempt_id: attemptId, tool_calls: 0 },
          }));
        }
        return { projected, interrupted: false };
      },
      settleToolCall: async ({ call, attemptNumber, attemptId }) => {
        if (!toolsEnabled) {
          throw new ToolPolicyDeniedError("Provider emitted a tool call while standalone tools were disabled");
        }
        if (!toolSettlementEnteredFor.has(attemptId)) {
          toolSettlementEnteredFor.add(attemptId);
          const count = currentProjected?.toolCalls.length ?? 0;
          await mutateAgentState(() => emit({
            eventType: "turn.tool_settlement",
            aggregateType: "turn",
            aggregateId: turnId,
            correlationId: task.id,
            payload: { provider_attempt_id: attemptId, tool_calls: count },
          }, async (tx) => {
            const update = await tx.turn.updateMany({
              where: { id: turnId, state: "RESPONSE_VALIDATING" },
              data: { state: "TOOL_SETTLEMENT" },
            });
            if (update.count !== 1) throw new Error(`turn ${turnId} changed before tool settlement`);
          }));
        }
        await toolEpisodeSession.settle({
          call,
          attemptNumber,
          providerAttemptId: attemptId,
          turnId,
          taskId: task.id,
          sessionId: turn.thread.sessionId,
          workspaceId: workspace.id,
          contractVersion: contractRow.version,
          contractHash: contractRow.contentHash,
          artifactClient,
        });
        // Stagnation tracking over normalized operations.
        try {
          const parsedCall = parseStandaloneToolCall(call);
          engine.budget.recordOperation(
            normalizedToolOperationHash({ taskId: task.id, contractVersion: contractRow.version, call: parsedCall }),
            parsedCall.toolId !== "read",
          );
        } catch {
          // Unparseable calls are refused by settlement itself.
        }
      },
    });
    const stop = await engine.run();
    switch (stop.kind) {
      case "interrupted":
        return;
      case "budget_exhausted":
        throw new ToolCycleBudgetExhaustedError(`Adaptive turn budget stopped the loop: ${stop.reason}`);
      case "policy_denied":
        throw new ToolPolicyDeniedError(stop.message);
      case "no_final_response":
        throw new ToolCycleBudgetExhaustedError("Provider turn ended without a final response");
      case "final":
        finalText = stop.text;
        finalResponseArtifactUri = lastResponseArtifactUri;
        break;
    }

    if (finalText === null || finalResponseArtifactUri === null) {
      throw new ToolCycleBudgetExhaustedError("Provider turn ended without a final response");
    }

    // 5. FINALIZING
    await mutateAgentState(() => emit({
      eventType: "turn.finalizing",
      aggregateType: "turn", aggregateId: turnId,
      correlationId: turn.taskId ?? undefined,
      payload: { phase: "finalizing" },
    }, async (tx) => {
      const update = await tx.turn.updateMany({
        where: { id: turnId, state: "RESPONSE_VALIDATING" },
        data: { state: "FINALIZING" },
      });
      if (update.count !== 1) throw new Error(`turn ${turnId} changed before finalizing`);
    }));

    // 6. COMPLETED
    const summaryCodePoints = Array.from(finalText);
    const summaryTruncated = summaryCodePoints.length > 200;
    const summary = summaryCodePoints.slice(0, 200).join("");
    await mutateAgentState(() => emit({
      eventType: "turn.completed",
      aggregateType: "turn", aggregateId: turnId,
      correlationId: turn.taskId ?? undefined,
      payload: {
        state: "COMPLETED",
        summary,
        summary_truncated: summaryTruncated,
        continuation: summaryTruncated ? finalResponseArtifactUri : null,
      },
      artifactRefs: [finalResponseArtifactUri],
    }, async (tx) => {
      const update = await tx.turn.updateMany({
        where: { id: turnId, state: "FINALIZING" },
        data: { state: "COMPLETED", completedAt: new Date() },
      });
      if (update.count !== 1) throw new Error(`turn ${turnId} changed before completion settlement`);
    }));

    // If the task has a status of ACTIVE, advance it through VERIFY → COMPLETE.
    if (turn.taskId) {
      const task = await db.task.findUnique({ where: { id: turn.taskId } });
      if (task && task.status === "ACTIVE") {
        const enteredVerification = await verificationCoordinator.begin(task.id);
        if (!enteredVerification) return;
        // Real verification DAG + completion gate (M8). Verification commands,
        // source identity, environment identity, and evidence all cross the
        // kernel/artifact boundary; no local always-pass fallback is allowed.
        const verificationClients = requireKernelUds();
        const verificationBaseContext: RequestContext = {
          ...await kernelTaskContext({
            sessionId: turn.thread.sessionId,
            taskId: task.id,
            turnId,
            workspaceId: workspace.id,
            operationClasses: [
              CapabilityOperationProto.CAPABILITY_OPERATION_EXEC,
              CapabilityOperationProto.CAPABILITY_OPERATION_JOB,
            ],
            workspacePaths: leastWorkspaceScope([
              ...contract.allowedScope.readPaths,
              ...contract.allowedScope.writePaths,
            ]),
          }),
          sessionId: turn.thread.sessionId,
          taskId: task.id,
          turnId,
          workspaceId: workspace.id,
        };
        const verificationArtifactWriter = {
          write: async (input: {
            readonly bytes: Uint8Array;
            readonly mediaType: string;
            readonly metadata: Readonly<Record<string, unknown>>;
          }) => {
            const artifact = await artifactClient.ingest(input.bytes, {
              mediaType: input.mediaType,
              custom: input.metadata,
            });
            return artifactClient.toArtifactRef(artifact);
          },
        };
        const runtime = createVerificationRuntime(
          createKernelPredicateRunner(verificationClients, verificationBaseContext, workspace.id),
          verificationArtifactWriter,
        );
        const contractRows = await db.acceptanceCriterion.findMany({
          where: {
            taskId: task.id,
            contractVersion: task.activeContractVersion,
          },
        });
        const criteria: AcceptanceCriterion[] = contractRows.map((c) => ({
          id: c.criterionId,
          statement: c.statement,
          verificationHint: c.verificationHint,
          required: c.required,
        }));
        const nodes = defaultCriteriaNodes(criteria);
        const completionExpression = nodes.map((n) => n.id).join(" && ");
        const sourceRevision = await resolveWorkspaceRevision(
          verificationClients,
          verificationBaseContext,
          workspace.id,
        );
        const environmentDigest = await resolveKernelEnvironmentDigest(verificationClients);
        const plan = await runtime.lifecycle.createPlan({
          taskContractId: task.id as never,
          taskContractVersion: task.activeContractVersion,
          sourceRevision,
          criteria,
          nodes,
          completionExpression,
        });
        const planArtifact = await ingestJsonArtifact(
          artifactClient,
          {
            plan,
            criteria,
          },
          "verification-plan",
          { taskId: task.id, workspaceId: workspace.id },
        );
        await mutateAgentState(() => db.$transaction(async (tx) => {
          await assertControlWriterLease(tx);
          await persistPlanToPrisma(tx, {
            id: plan.id,
            taskId: task.id,
            contractVersion: plan.taskContractVersion,
            sourceRevision: plan.sourceRevision,
            completionExpression: plan.completionExpression,
            planArtifact: planArtifact.uri,
            nodes: plan.nodes.map((n) => ({
              id: n.id,
              kind: n.kind,
              required: n.required,
              specification: n.specification,
              timeout: n.timeout,
              retryPolicy: n.retryPolicy,
              acceptanceCriterionId: n.acceptanceCriterionId,
              dependsOn: n.dependsOn,
            })),
            edges: plan.edges,
          });
        }));

        const evaluation = await runtime.lifecycle.evaluate(
          plan.id,
          sourceRevision,
          environmentDigest,
          null,
        );
        const attempts = await runtime.store.listAttempts(plan.id);
        const evidenceGraph = await runtime.store.getEvidenceGraph(plan.id);
        const allPassed =
          evaluation.allRequiredPassed && evaluation.completionExpressionSatisfied;
        await mutateAgentState(async () => {
          await db.$transaction(async (tx) => {
            await assertControlWriterLease(tx);
            await persistResultsToPrisma(tx, evaluation.results, attempts);
            if (evidenceGraph !== null) {
              await persistClaimEvidenceGraphToPrisma(tx, evidenceGraph);
            }
          });
          for (const r of evaluation.results) {
            await emit({
              eventType: r.status === "pass" ? "verification.node_passed" : "verification.node_failed",
              aggregateType: "verification_result",
              aggregateId: r.id,
              correlationId: task.id,
              payload: { node_id: r.nodeId, status: r.status },
            });
          }
          await emit({
            eventType: "verification.plan_completed",
            aggregateType: "verification_plan",
            aggregateId: plan.id,
            correlationId: task.id,
            payload: { status: allPassed ? "all_passed" : "failed" },
          });
        });

        if (!allPassed) {
          // Rank 3: normalize failures into durable repair inputs and run
          // the bounded repair decision instead of terminating at the first
          // verification failure.
          const failedResults = evaluation.results.filter(
            (result) => result.status === "fail" || result.status === "error",
          );
          const nodeById = new Map(plan.nodes.map((node) => [node.id, node]));
          const normalizedFailures = failedResults.map((result) =>
            normalizeFailure({
              nodeId: result.nodeId,
              predicateType: nodeById.get(result.nodeId)?.kind ?? "command",
              command: result.commandOrQuery,
              exitCode: result.exitCode,
              output: JSON.stringify(result.structuredObservations),
              artifactRefs: result.artifacts
                .map((artifact) => String(artifact?.uri ?? ""))
                .filter((uri) => uri.length > 0),
            }),
          );
          const repairDecision = verificationRepairController.decideAfterFailure({
            failures: normalizedFailures,
            workspaceChangedSinceLastAttempt: true,
            actorReportedBlocker: false,
            requiresUserAuthority: false,
          });
          if (repairDecision.action === "repair") {
            const directive = buildRepairContext({
              failures: normalizedFailures,
              changedFiles: latestChangedFiles,
              previousAttemptSummary:
                repairDecision.attemptNumber > 1
                  ? `Repair attempt ${repairDecision.attemptNumber - 1} changed the failure set; see verification results for plan ${plan.id}.`
                  : null,
            });
            const directiveArtifact = await ingestJsonArtifact(
              artifactClient,
              { directive, failures: normalizedFailures, attempt: repairDecision.attemptNumber },
              "verification-repair-directive",
              { taskId: task.id, planId: plan.id, workspaceId: workspace.id },
            );
            await verificationCoordinator.scheduleRepair(task.id, {
              attemptNumber: repairDecision.attemptNumber,
              directiveArtifactUri: directiveArtifact.uri,
              failedNodeIds: normalizedFailures.map((failure) => failure.nodeId),
            });
            return;
          }
          await verificationCoordinator.fail(task.id, {
            reason: "required_predicates_failed",
            blocked: evaluation.blocked,
            repair_stop_reason:
              repairDecision.action === "stop" ? repairDecision.reason : undefined,
            failure_signatures: normalizedFailures.map((failure) => failure.signatureHash),
          });
          return;
        }

        const finalCheckpoint = await ingestJsonArtifact(
          artifactClient,
          {
            taskId: task.id,
            planId: plan.id,
            sourceRevision,
            environmentDigest,
            results: evaluation.results,
            claims: evidenceGraph?.claims ?? [],
          },
          "verification-completion",
          { taskId: task.id, workspaceId: workspace.id },
        );
        try {
          const completionRecord = await runtime.lifecycle.complete({
            taskId: task.id as never,
            planId: plan.id,
            criteria,
            findings: [],
            sourceRevision,
            environmentImageDigest: environmentDigest,
            expiresAt: null,
            unresolvedRisks: [],
            acceptedRisks: [],
            externalEffects: [],
            costMicros: 0n as Micros,
            durationSeconds: 0,
            finalCheckpoint: artifactClient.toArtifactRef(finalCheckpoint),
          });

          // The verification runtime keeps a process-local copy for its
          // lifecycle API. Persist the same immutable record before admission
          // so restart/export consumers never have to trust that copy.
          const completionData = {
            id: `completion:${task.id}`,
            taskId: task.id,
            contractVersion: completionRecord.contractVersion,
            finalRevision: completionRecord.finalRevision,
            status: completionRecord.status,
            criteriaJson: canonicalJson(completionRecord.criteria),
            verificationPlanId: completionRecord.verificationPlanId,
            unresolvedRisksJson: canonicalJson(completionRecord.unresolvedRisks),
            acceptedRisksJson: canonicalJson(completionRecord.acceptedRisks),
            externalEffectsJson: canonicalJson(completionRecord.externalEffects),
            costMicros: completionRecord.costMicros,
            durationSeconds: completionRecord.durationSeconds,
            finalCheckpointJson: canonicalJson(completionRecord.finalCheckpoint),
            generatedAt: new Date(completionRecord.generatedAt),
          };
          await mutateAgentState(async () => {
            const existing = await db.completionRecord.findUnique({ where: { taskId: task.id } });
            if (existing === null) {
              await db.completionRecord.create({ data: completionData });
              return;
            }
            const immutableFieldsMatch = existing.id === completionData.id
              && existing.contractVersion === completionData.contractVersion
              && existing.finalRevision === completionData.finalRevision
              && existing.status === completionData.status
              && existing.criteriaJson === completionData.criteriaJson
              && existing.verificationPlanId === completionData.verificationPlanId
              && existing.unresolvedRisksJson === completionData.unresolvedRisksJson
              && existing.acceptedRisksJson === completionData.acceptedRisksJson
              && existing.externalEffectsJson === completionData.externalEffectsJson
              && existing.costMicros === completionData.costMicros
              && existing.durationSeconds === completionData.durationSeconds
              && existing.finalCheckpointJson === completionData.finalCheckpointJson
              && existing.generatedAt.getTime() === completionData.generatedAt.getTime();
            if (!immutableFieldsMatch) {
              throw new Error("completion record already exists with different immutable content");
            }
          });

          if (evidenceGraph === null) {
            throw new Error("completion admission requires a persisted claim/evidence graph");
          }
          const candidateBranchId = `completion:${task.id}:${plan.id}`;
          const requiredClaimIds = new Set(
            criteria.filter((criterion) => criterion.required).map((criterion) => `claim:${task.id}:${criterion.id}`),
          );
          const claims = evidenceGraph.claims
            .filter(
              (claim): claim is Claim & { readonly status: "SATISFIED" | "WAIVED" } =>
                claim.status === "SATISFIED" || claim.status === "WAIVED",
            )
            .map((claim) => ({
              claimId: claim.id,
              status: claim.status,
              evidence: evidenceGraph.evidence
                .filter((evidence) => evidence.claimId === claim.id)
                .map((evidence) => {
                  if (evidence.artifactRef === null || evidence.sourceRevision === null || evidence.environmentHash === null) {
                    throw new Error(`claim '${claim.id}' has incomplete admission evidence`);
                  }
                  return {
                    evidenceId: evidence.id,
                    artifactUri: evidence.artifactRef.uri,
                    artifactHash: evidence.artifactRef.hash,
                    sourceRevision: evidence.sourceRevision,
                    environmentImageDigest: evidence.environmentHash,
                    verifierResult: "pass" as const,
                  };
                }),
            }))
            .filter((claim) => requiredClaimIds.has(claim.claimId) || claim.status === "SATISFIED");
          const completionRecordDigest = computeContentHash(
            new TextEncoder().encode(canonicalJson(completionRecord)),
          );
          const admission = createPrismaCompletionAdmission(
            db,
            () => resolveWorkspaceRevision(verificationClients, verificationBaseContext, workspace.id),
          );
          await admission.registerCandidateBranch({
            branchId: candidateBranchId,
            taskId: task.id,
            attemptId: turnId,
            actorPrincipal: "agent:verification-runtime",
            worktreePath: workspace.rootUri,
            epoch: 1,
            baseRevision: sourceRevision,
            headRevision: sourceRevision,
            scopeDigest: computeContentHash(task.scopeDigest),
            effectIds: [],
            proof: {
              verificationPlanId: plan.id,
              completionRecordDigest,
              sourceRevision,
              environmentImageDigest: environmentDigest,
              completionExpressionSatisfied: true,
              claims,
            },
            status: "OPEN",
          });
          await admission.admitBranch({
            branchId: candidateBranchId,
            taskId: task.id,
            attemptId: turnId,
            actorPrincipal: "agent:verification-runtime",
            reviewerPrincipal: "principal:verification-reviewer",
            requiredClaimsSatisfied: [...requiredClaimIds],
          });
        } catch (gateErr) {
          await verificationCoordinator.fail(task.id, {
            reason: "completion_gate_denied",
            error: String(gateErr),
          });
          return;
        }

        await verificationCoordinator.complete(task.id, plan.id);
      }
    }
  } catch (err) {
    console.error("agentLoop error", err);
    const providerUnavailable = err instanceof ProviderExecutionUnavailableError;
    const ambiguousToolSettlement = err instanceof AmbiguousToolSettlementError;
    const policyDenied = err instanceof ToolPolicyDeniedError;
    const budgetExhausted = err instanceof ToolCycleBudgetExhaustedError;
    const blockedError = providerUnavailable || ambiguousToolSettlement || policyDenied || budgetExhausted;
    const terminalTurnState = policyDenied
      ? "POLICY_DENIED"
      : budgetExhausted
        ? "BUDGET_EXHAUSTED"
        : ambiguousToolSettlement
          ? "INTERRUPTED"
          : "FAILED";
    const terminalTurnEvent = policyDenied
      ? "turn.policy_denied"
      : budgetExhausted
        ? "turn.budget_exhausted"
        : ambiguousToolSettlement
          ? "turn.interrupted"
          : "turn.failed";
    const failureCode = providerUnavailable
      ? "PROVIDER_TRANSPORT_UNAVAILABLE"
      : policyDenied
        ? "TOOL_POLICY_DENIED"
        : budgetExhausted
          ? "TOOL_BUDGET_EXHAUSTED"
          : ambiguousToolSettlement
            ? "TOOL_SETTLEMENT_UNKNOWN"
            : "PROVIDER_EXECUTION_FAILED";
    await mutateAgentState(async () => {
      const currentTurn = await db.turn.findUnique({
        where: { id: turnId },
        select: { state: true },
      });
      const mayFailTurn = currentTurn !== null
        && !["COMPLETED", "INTERRUPTED", "FAILED", "BUDGET_EXHAUSTED", "POLICY_DENIED"].includes(currentTurn.state);
      if (mayFailTurn) {
        await emit({
          eventType: terminalTurnEvent,
          aggregateType: "turn", aggregateId: turnId,
          correlationId: turn.taskId ?? undefined,
          payload: { error: String(err) },
        }, async (tx) => {
          await tx.providerAttempt.updateMany({
            where: { turnId, status: "running" },
            data: {
              status: "failed",
              completedAt: new Date(),
              errorJson: JSON.stringify({
                code: failureCode,
                message: String(err),
              }),
            },
          });
          const update = await tx.turn.updateMany({
            where: {
              id: turnId,
              state: { notIn: ["COMPLETED", "INTERRUPTED", "FAILED", "BUDGET_EXHAUSTED", "POLICY_DENIED"] },
            },
            data: {
              state: terminalTurnState,
              completedAt: new Date(),
              terminalErrorJson: JSON.stringify({ message: String(err) }),
            },
          });
          if (update.count !== 1) throw new Error(`turn ${turnId} changed during failure settlement`);
        });
      } else {
        await writerTransaction((tx) => tx.providerAttempt.updateMany({
          where: { turnId, status: "running" },
          data: {
            status: "failed",
            completedAt: new Date(),
            errorJson: JSON.stringify({
              code: failureCode,
              message: String(err),
            }),
          },
        }));
      }

      if (turn.taskId === null) return;
      const failedTaskId = turn.taskId;
      const failedTask = await db.task.findUnique({
        where: { id: failedTaskId },
        select: { status: true },
      });
      if (failedTask?.status !== "ACTIVE" && failedTask?.status !== "VERIFYING") return;
      const status = blockedError
        ? "BLOCKED"
        : failedTask.status === "VERIFYING"
          ? "FAILED_VERIFICATION"
          : "FAILED";
      const eventType = blockedError ? "task.blocked" : "task.failed";
      await emit({
        eventType,
        aggregateType: "task",
        aggregateId: failedTaskId,
        correlationId: failedTaskId,
        payload: {
          status,
          error: String(err),
          reason: providerUnavailable
            ? "provider_transport_unavailable"
            : ambiguousToolSettlement
              ? "tool_settlement_unknown"
              : policyDenied
                ? "tool_policy_denied"
                : budgetExhausted
                  ? "tool_budget_exhausted"
                  : "agent_loop_error",
        },
      }, async (tx) => {
        const update = await tx.task.updateMany({
          where: { id: failedTaskId, status: failedTask.status },
          data: {
            status,
            phase: failedTask.status === "VERIFYING" ? "VERIFY" : "IMPLEMENT",
            completedAt: blockedError ? null : new Date(),
            terminalReasonJson: JSON.stringify({
              reason: providerUnavailable
                ? "provider_transport_unavailable"
                : ambiguousToolSettlement
                  ? "tool_settlement_unknown"
                  : policyDenied
                    ? "tool_policy_denied"
                    : budgetExhausted
                      ? "tool_budget_exhausted"
                : failedTask.status === "VERIFYING"
                  ? "verification_runtime_error"
                  : "agent_loop_error",
              error: String(err),
            }),
          },
        });
        if (update.count !== 1) throw new Error(`task ${failedTaskId} changed during failure settlement`);
      });
      await synchronizeV1TaskProjection(failedTaskId, eventType);
    });
  }
}

interface JobRecoverySummary {
  readonly scanned: number;
  readonly lost: number;
  readonly live: number;
  readonly exited: number;
}

/** Reconcile every durable non-terminal job against the kernel before ready. */
async function reconcileNonterminalJobs(): Promise<JobRecoverySummary> {
  const jobs = await db.job.findMany({
    where: { state: { in: [...V1_NONTERMINAL_JOB_STATES] } },
    orderBy: { id: "asc" },
    select: { id: true, state: true },
  });
  let lost = 0;
  let live = 0;
  let exited = 0;
  for (const job of jobs) {
    let kernelState: string | null = null;
    let reconciliationError: string | null = null;
    try {
      const binding = await kernelBindingForJob(
        job.id,
        [
          CapabilityOperationProto.CAPABILITY_OPERATION_EXEC,
          CapabilityOperationProto.CAPABILITY_OPERATION_JOB,
        ],
      );
      if (binding === null) {
        reconciliationError = "job has no settled kernel binding";
      } else {
        const observed = await requireKernelUds().jobs.Get({
          context: binding.context,
          jobId: binding.kernelJobId,
        });
        kernelState = observed.state.toLowerCase();
      }
    } catch (error: unknown) {
      reconciliationError = error instanceof Error ? error.message : String(error);
    }

    const nextState = kernelState === "running"
      ? "RUNNING"
      : kernelState === "queued"
        ? "STARTING"
        : kernelState === "exited"
          ? "EXITED"
          : "LOST";
    if (nextState === "LOST") lost += 1;
    else if (nextState === "EXITED") exited += 1;
    else live += 1;
    const settledAt = nextState === "LOST" || nextState === "EXITED"
      ? new Date()
      : null;
    await emit({
      eventType: "job.reconciled",
      aggregateType: "job",
      aggregateId: job.id,
      payload: {
        previous_state: job.state,
        state: nextState,
        kernel_state: kernelState,
        reconciliation_error: reconciliationError,
      },
    }, async (tx) => {
      const updated = await tx.job.updateMany({
        where: { id: job.id, state: job.state },
        data: {
          state: nextState,
          settledAt,
          ...(nextState === "LOST"
            ? {
                exitJson: JSON.stringify({
                  reason: "kernel_job_not_recoverable",
                  reconciliation_error: reconciliationError,
                }),
              }
            : {}),
        },
      });
      if (updated.count !== 1) {
        throw new Error(`job ${job.id} changed during startup reconciliation`);
      }
    });
  }
  return { scanned: jobs.length, lost, live, exited };
}

/**
 * Resume turns only before context/provider work began. Every later active
 * phase is interrupted and its unsettled effects are made explicit so a
 * restart can never duplicate provider or tool effects.
 */
async function recoverActiveAgentTurns(): Promise<number> {
  const active = await db.turn.findMany({
    where: { state: { in: [...V1_ACTIVE_TURN_STATES] } },
    orderBy: { id: "asc" },
    select: {
      id: true,
      taskId: true,
      threadId: true,
      sequence: true,
      state: true,
      initiatingInputArtifact: true,
      episodes: {
        where: { sequence: 1, kind: "user_message" },
        take: 1,
        select: { contentArtifact: true, sourceVersionsJson: true },
      },
    },
  });
  for (const turn of active) {
    if (turn.state !== "PENDING") {
      const interruptedAt = new Date();
      await emit({
        eventType: "turn.recovery_interrupted",
        aggregateType: "turn",
        aggregateId: turn.id,
        correlationId: turn.taskId ?? undefined,
        payload: {
          previous_state: turn.state,
          state: "INTERRUPTED",
          reason: "process_restart_after_work_began",
          reconciliation_required: true,
        },
      }, async (tx) => {
        await tx.providerAttempt.updateMany({
          where: { turnId: turn.id, status: "running" },
          data: {
            status: "interrupted",
            completedAt: interruptedAt,
            errorJson: JSON.stringify({ reason: "process_restart" }),
          },
        });
        await tx.toolCall.updateMany({
          where: {
            turnId: turn.id,
            state: { in: ["STARTED", "UNKNOWN", "RECONCILING"] },
          },
          data: {
            state: "UNKNOWN",
            settledAt: interruptedAt,
            resultStatus: "unknown_settlement",
            errorJson: JSON.stringify({ reason: "process_restart", reconciliation_required: true }),
          },
        });
        await tx.toolCall.updateMany({
          where: {
            turnId: turn.id,
            state: {
              in: [
                "PROPOSED",
                "VALIDATED",
                "POLICY_EVALUATED",
                "AUTHORIZED",
                "APPROVAL_PENDING",
              ],
            },
          },
          data: {
            state: "CANCELLED",
            settledAt: interruptedAt,
            resultStatus: "cancelled",
            errorJson: JSON.stringify({ reason: "process_restart_before_effect_start" }),
          },
        });
        await tx.sideEffect.updateMany({
          where: {
            toolCall: { turnId: turn.id },
            state: { in: ["STARTED", "UNKNOWN", "RECONCILING"] },
          },
          data: {
            state: "MANUAL_REVIEW",
            reconciliationJson: JSON.stringify({ reason: "process_restart", reconciliation_required: true }),
          },
        });
        const interrupted = await tx.turn.updateMany({
          where: { id: turn.id, state: turn.state },
          data: {
            state: "INTERRUPTED",
            completedAt: interruptedAt,
            terminalErrorJson: JSON.stringify({
              reason: "process_restart_after_work_began",
              previous_state: turn.state,
              reconciliation_required: true,
            }),
          },
        });
        if (interrupted.count !== 1) {
          throw new Error(`active turn ${turn.id} changed during startup recovery`);
        }
        if (turn.taskId !== null) {
          await tx.task.updateMany({
            where: { id: turn.taskId, status: { in: ["ACTIVE", "VERIFYING"] } },
            data: {
              status: "BLOCKED",
              phase: "IMPLEMENT",
              completedAt: null,
              terminalReasonJson: JSON.stringify({
                reason: "startup_reconciliation_required",
                turn_id: turn.id,
                previous_turn_state: turn.state,
              }),
            },
          });
        }
      });
      if (turn.taskId !== null) {
        await synchronizeV1TaskProjection(turn.taskId, "turn.recovery_interrupted");
      }
      continue;
    }
    const started = await db.semanticEvent.findFirst({
      where: {
        eventType: "turn.started",
        aggregateType: "turn",
        aggregateId: turn.id,
      },
      orderBy: { eventId: "desc" },
      select: { payloadJson: true, artifactRefsJson: true },
    });
    const payload = started === null
      ? null
      : safeParse<Record<string, unknown> | null>(started.payloadJson, null);
    const artifactRefs = started === null
      ? []
      : safeParse<unknown[]>(started.artifactRefsJson, []);
    const inputUri = artifactUriSchema.safeParse(turn.initiatingInputArtifact);
    const expectedHash = inputUri.success
      ? `sha256:${inputUri.data.slice("artifact://sha256/".length)}`
      : null;
    const episode = turn.episodes[0];
    const episodeSources = episode === undefined
      ? null
      : safeParse<Record<string, unknown> | null>(episode.sourceVersionsJson, null);
    const valid = payload !== null
      && payload.task_id === turn.taskId
      && payload.thread_id === turn.threadId
      && payload.sequence === turn.sequence
      && inputUri.success
      && payload.input_artifact === inputUri.data
      && payload.input_hash === expectedHash
      && artifactRefs.includes(inputUri.data)
      && episode?.contentArtifact === inputUri.data
      && episodeSources?.input === expectedHash;
    if (!valid) {
      await emit({
        eventType: "turn.failed",
        aggregateType: "turn",
        aggregateId: turn.id,
        correlationId: turn.taskId ?? undefined,
        payload: { reason: "missing_or_invalid_admitted_input" },
      }, async (tx) => {
        const failed = await tx.turn.updateMany({
          where: { id: turn.id, state: "PENDING" },
          data: {
            state: "FAILED",
            completedAt: new Date(),
            terminalErrorJson: JSON.stringify({ reason: "missing_or_invalid_admitted_input" }),
          },
        });
        if (failed.count !== 1) throw new Error(`pending turn ${turn.id} changed during startup recovery`);
      });
      continue;
    }
    await agentLoop(turn.id);
  }
  return active.length;
}

// ────────────────────────── HTTP server ────────────────────────────────────

/**
 * Request dispatch pipeline:
 *   1. CORS preflight (OPTIONS) → 204.
 *   2. Public health endpoint (GET /v1/system/health) → no auth.
 *   3. Bearer-token auth check (SPEC §30.8) → 401 on mismatch.
 *   4. Route lookup.
 *   5. Audit log `authorized` event before mutating handlers (SPEC §31.3 step 10).
 *   6. Idempotency wrap for mutating methods (SPEC §30.5).
 *   7. Handler execution.
 *   8. Idempotency commit (persist response artifact).
 */
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");

  // 1. CORS preflight.
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": CONTROL_CORS_ORIGIN,
      "access-control-allow-headers": CORS_ALLOW_HEADERS,
      "access-control-allow-methods": CORS_ALLOW_METHODS,
      "access-control-max-age": "600",
      "vary": "origin",
    });
    res.end();
    return;
  }

  // 2. Public health endpoint.
  if (req.method === "GET" && url.pathname === "/v1/system/health") {
    try {
      const kernelHealth = await requireKernelUds().info.Health({});
      const writerReady = writerLeaseIsHealthy();
      const kernelReady = kernelHealth.state === "healthy" || kernelHealth.state === "ok";
      sendJson(res, 200, {
        status: kernelReady && writerReady ? "ok" : "degraded",
        version: CONTROL_BUILD_VERSION,
        build_commit: CONTROL_BUILD_COMMIT,
        instance_id: CONTROL_INSTANCE_NONCE,
        uptime_seconds: process.uptime(),
        ready: kernelReady && writerReady,
        kernel: kernelHealth,
        writer: writerLease === null ? { healthy: false } : {
          healthy: writerReady,
          fencing_token: writerLease.fencingToken,
          expires_at: writerLease.expiresAt.toISOString(),
        },
      });
    } catch (err) {
      logInternalError("health handler failed", err);
      if (!res.headersSent) {
        sendError(res, 500, "INTERNAL", "health check failed", "internal");
      }
    }
    return;
  }

  // 3. Auth check.
  if (!checkAuth(req)) {
    sendError(res, 401, "UNAUTHENTICATED", "missing or invalid bearer token", "auth", {
      hint: "send 'Authorization: Bearer <TERMINUS_CONTROL_TOKEN>'",
    });
    return;
  }

  const traceId = getTraceId(req);

  // 4. Route lookup.
  let matchedRoute: Route | null = null;
  const matchedParams: Record<string, string> = {};
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = r.pattern.exec(url.pathname);
    if (!m) continue;
    matchedRoute = r;
    // Malformed percent-encoding (e.g. /v1/tasks/%zz) must degrade to a
    // 404-style miss, not throw an unhandled rejection that kills the
    // server: decodeURIComponent throws URIError on invalid sequences, and
    // this loop runs outside the handler try/catch below.
    try {
      r.paramNames.forEach((n, i) => { matchedParams[n] = decodeURIComponent(m[i + 1] ?? ""); });
    } catch {
      matchedRoute = null;
      break;
    }
    break;
  }

  if (!matchedRoute) {
    sendError(res, 404, "NOT_FOUND", `no route for ${req.method} ${url.pathname}`, "not_found");
    return;
  }

  // 5. Audit log before effects.
  if (isMutating(req.method)) {
    auditAuthorized(req, url, matchedParams, traceId);
  }

  const mut = isMutating(req.method);
  const dispatch = async () => {
    if (mut && !writerLeaseIsHealthy()) {
      sendError(
        res,
        503,
        "CONTROL_WRITER_FENCED",
        "the control-plane writer lease is unavailable or expired",
        "external_dependency",
      );
      return;
    }

    // 6. Idempotency wrap (mutating only).
    let idempotencyKey: string | null = null;
    if (mut) {
      const keyHeader = req.headers["idempotency-key"];
      idempotencyKey = Array.isArray(keyHeader) ? (keyHeader[0] ?? null) : (keyHeader ?? null);
      const proceed = await withIdempotency(req, res, matchedRoute.method, traceId);
      if (!proceed) return;
    }

    // 7. Handler execution.
    try {
      await matchedRoute.handler(req, res, matchedParams);
    } catch (err) {
      console.error("handler error", err);
      if (!res.headersSent) {
        sendCaughtError(res, err);
      }
    }

    // 8. Persist the exact response before exposing it to the client. If the
    // reservation cannot be completed, settlement is ambiguous: fail closed
    // instead of returning success without a replay guarantee.
    if (mut && idempotencyKey) {
      try {
        const captured = await commitIdempotency(res, matchedRoute.method, idempotencyKey);
        sendJsonBuffer(res, captured.status, captured.body);
      } catch (err) {
        console.error("idempotency commit error", err);
        // `commitIdempotency` removes the capture before persistence, so this
        // error bypasses capture and reaches the caller immediately.
        if (!res.headersSent) {
          sendError(
            res,
            500,
            "IDEMPOTENCY_COMMIT_FAILED",
            "the mutation may have settled, but its replay record could not be committed",
            "unknown_settlement",
            { idempotency_key: idempotencyKey, reconciliation_required: true },
          );
        }
      }
    }
  };

  if (mut) await mutationMutex.runExclusive(dispatch);
  else await dispatch();
});

// Replay and reconcile authoritative state before accepting public requests.
// Starting an empty success-shaped store after a database error would make
// task identity and approvals diverge across clients.
requireKernelUds();
await initializeKernelControlCapabilities();
await acquireControlWriterLease();
writerLeaseHeartbeat = setInterval(() => {
  void renewControlWriterLease();
}, Math.max(1_000, Math.floor(CONTROL_WRITER_LEASE_MS / 3)));
const reconciledIdempotencyReservations = await reconcilePendingIdempotencyReservations();
await replayArpV2();
const jobRecovery = await reconcileNonterminalJobs();
const repairedTaskProjections = await reconcileV1TaskProjections();
const checkpointLinkRecovery = await reconcileCheckpointArtifactLinks();
const checkpointAdmissionRecovery = await reconcilePreparedCheckpointAdmissions();
const recoveredActiveTurns = await recoverActiveAgentTurns();
if (checkpointLinkRecovery.failed.length > 0 || checkpointAdmissionRecovery.failed.length > 0) {
  throw new Error(
    `checkpoint recovery could not settle: ${checkpointLinkRecovery.failed.length} link failures, ${checkpointAdmissionRecovery.failed.length} admission failures`,
  );
}
if (repairedTaskProjections > 0) {
  console.log(`[terminus-control] repaired ${repairedTaskProjections} v1/v2 task projections`);
}
if (reconciledIdempotencyReservations > 0) {
  console.log(
    `[terminus-control] reconciled ${reconciledIdempotencyReservations} unknown idempotency settlement(s)`,
  );
}
if (jobRecovery.scanned > 0) {
  console.log(
    `[terminus-control] job recovery: ${jobRecovery.scanned} scanned, ${jobRecovery.lost} lost, ${jobRecovery.live} live, ${jobRecovery.exited} exited`,
  );
}
if (checkpointAdmissionRecovery.prepared > 0) {
  console.log(
    `[terminus-control] checkpoint admission recovery: ${checkpointAdmissionRecovery.recovered.length} recovered, ${checkpointAdmissionRecovery.quarantined.length} quarantined, ${checkpointAdmissionRecovery.failed.length} pending`,
  );
}
if (recoveredActiveTurns > 0) {
  console.log(`[terminus-control] reconciled ${recoveredActiveTurns} active turn(s)`);
}
if (
  checkpointLinkRecovery.scanned > 0
  || checkpointLinkRecovery.removedOrphans.length > 0
  || checkpointLinkRecovery.requeued.length > 0
) {
  console.log(
    `[terminus-control] checkpoint link recovery: ${checkpointLinkRecovery.scanned} scanned, ${checkpointLinkRecovery.removedOrphans.length} orphans removed, ${checkpointLinkRecovery.requeued.length} rows requeued, ${checkpointLinkRecovery.quarantined.length} quarantined`,
  );
}

// The Electron preload and desktop documentation use the IPv4 loopback URL
// (`http://127.0.0.1:3050`). Binding explicitly keeps that documented local
// transport reachable on macOS, where Node otherwise prefers an IPv6-only
// localhost listener in some environments.
server.listen(PORT, "127.0.0.1", () => {
  const address = server.address();
  const listeningPort = typeof address === "object" && address !== null
    ? address.port
    : PORT;
  console.log(`[terminus-control] listening on http://localhost:${listeningPort}`);
  console.log(`[terminus-control] kernel transport: grpc+uds (${KERNEL_GRPC_SOCKET || "not configured"})`);
  console.log(`[terminus-control] CORS origin: ${CONTROL_CORS_ORIGIN}`);
  console.log(`[terminus-control] auth: bearer token (TERMINUS_CONTROL_TOKEN)`);
  if (CONTROL_READY_FD !== null) {
    try {
      writeSync(CONTROL_READY_FD, `${JSON.stringify({
        schema: "terminus.control-ready.v1",
        port: listeningPort,
        instance_id: CONTROL_INSTANCE_NONCE,
      })}\n`);
      closeSync(CONTROL_READY_FD);
    } catch (error: unknown) {
      console.error("[terminus-control] failed to report bound listener", error);
      void shutdownControl().finally(() => process.exit(1));
    }
  }
});

let shuttingDown = false;
const desktopParentWatchdog = DESKTOP_PARENT_PID === null
  ? null
  : setInterval(() => {
      if (process.ppid === DESKTOP_PARENT_PID) return;
      console.error("[terminus-control] desktop supervisor disappeared; shutting down");
      void shutdownControl().finally(() => process.exit(1));
    }, 1_000);
async function shutdownControl(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  if (desktopParentWatchdog) clearInterval(desktopParentWatchdog);
  if (writerLeaseHeartbeat) clearInterval(writerLeaseHeartbeat);
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
  await releaseControlWriterLease().catch((error: unknown) => {
    console.error("[terminus-control] failed to release writer lease", error);
  });
  await db.$disconnect();
}

process.on("SIGINT", () => { void shutdownControl().finally(() => process.exit(0)); });
process.on("SIGTERM", () => { void shutdownControl().finally(() => process.exit(0)); });

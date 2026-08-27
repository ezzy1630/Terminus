/**
 * Durable ContextStore implementation for the control plane.
 *
 * Context bytes never enter Prisma. They cross the kernel ArtifactIngest RPC;
 * Prisma stores only immutable references and the manifest decision record.
 */
import { randomUUID } from "node:crypto";
import type { PrismaClient, Prisma } from "@prisma/client";
import {
  ArtifactClient,
  type ArtifactKernelClient,
  type ArtifactMetadata,
} from "@terminus/artifact-client";
import type {
  ArtifactRef,
  ContentHash,
  Rfc3339Timestamp,
  Uuid7,
} from "@terminus/domain";
import { generateUuid7 } from "@terminus/domain";
import type {
  ContextFragment,
  ContextManifest,
} from "@terminus/context-ir";
import { canonicalJson } from "@terminus/context-ir";
import type {
  ContextStore,
} from "@terminus/context-compiler";
import type {
  ArtifactIngestServiceClientImpl,
  GetArtifactMetadataResponse,
  GetArtifactResponse,
  IngestArtifactResponse,
  RequestContext,
} from "../../../packages/terminus-kernel-client/src/generated-ts-proto/terminus/kernel/v1/kernel.js";
import type { RenderedProviderRequest } from "@terminus/provider-core";

const EMPTY_CONTENT_HASH = ("sha256:" + "0".repeat(64)) as ContentHash;

export interface ContextArtifactScope {
  readonly sessionId: string;
  readonly taskId: string;
  readonly turnId: string;
  readonly workspaceId: string;
}

export type ContextMutationGate = <T>(operation: () => Promise<T>) => Promise<T>;
export type ContextTransactionFence = (tx: Prisma.TransactionClient) => Promise<void>;

export function createKernelArtifactClient(
  rpc: ArtifactIngestServiceClientImpl,
  context: RequestContext,
): ArtifactClient {
  const kernel: ArtifactKernelClient = {
    async ingest(bytes, metadata): Promise<ContentHash> {
      const response: IngestArtifactResponse = await rpc.Ingest({
        context: nextRequestContext(context),
        content: bytes,
        mediaType: typeof metadata.mediaType === "string"
          ? metadata.mediaType
          : "application/octet-stream",
      });
      const artifact = requireArtifact(response.artifact, "ingest");
      return artifact.sha256 as ContentHash;
    },
    async get(hash): Promise<Uint8Array | null> {
      const response: GetArtifactResponse = await rpc.Get({ context: nextRequestContext(context), sha256: hash });
      return response.artifact === undefined ? null : response.content;
    },
    async getMetadata(hash): Promise<Readonly<Record<string, unknown>> | null> {
      const response: GetArtifactMetadataResponse = await rpc.GetMetadata({ context: nextRequestContext(context), sha256: hash });
      if (response.artifact === undefined) return null;
      return {
        hash: response.artifact.sha256,
        bytes: response.artifact.sizeBytes,
        mediaType: response.artifact.mediaType,
      };
    },
    async link(hash, ownerType, ownerId, purpose): Promise<void> {
      const response = await rpc.Link({
        context: nextRequestContext(context),
        sha256: hash,
        ownerType,
        ownerId,
        purpose,
        ownerTaskId: context.taskId,
      });
      if (!response.linked) throw new Error("kernel did not admit the artifact ownership link");
    },
    async gcDryRun() {
      throw new Error("artifact GC is not part of the control-plane artifact boundary");
    },
    async gcApply() {
      throw new Error("artifact GC is not part of the control-plane artifact boundary");
    },
  };
  return new ArtifactClient({
    kernel,
    clock: () => new Date().toISOString() as Rfc3339Timestamp,
    cacheMaxEntries: 256,
  });
}

function nextRequestContext(context: RequestContext): RequestContext {
  return {
    ...context,
    requestId: randomUUID(),
    idempotencyKey: `${context.idempotencyKey}:${randomUUID()}`,
  };
}

export class PrismaContextStore implements ContextStore {
  constructor(
    private readonly db: PrismaClient,
    private readonly artifacts: ArtifactClient,
    private readonly scope: ContextArtifactScope,
    private readonly mutate: ContextMutationGate = (operation) => operation(),
    private readonly fence: ContextTransactionFence = async () => undefined,
  ) {}

  async persistManifest(
    manifest: Omit<ContextManifest, "id">,
    fragments: readonly ContextFragment[] = [],
  ): Promise<ContextManifest> {
    const id = generateUuid7();
    const durableManifest: ContextManifest = { id, ...manifest };
    const manifestArtifact = await this.ingestJson(
      durableManifest,
      "context-manifest",
    );
    const selectedById = new Map(
      durableManifest.fragments.map((entry) => [entry.fragmentId, entry]),
    );
    const omissionsById = new Map(
      durableManifest.omitted.map((omission) => [omission.fragmentId, omission.reason]),
    );
    const candidateById = new Map(fragments.map((fragment) => [fragment.id, fragment]));
    const transformationById = new Map(
      readTransforms(durableManifest.decisionRecord).map((transform) => [transform.outputFragmentId, transform]),
    );

    const persistedFragments = [] as Array<{
      id: string;
      manifestId: string;
      fragmentKey: string;
      kind: string;
      sourceUri: string;
      sourceVersion: string | null;
      contentArtifact: string;
      authority: number;
      priority: number;
      trust: string;
      confidentiality: string;
      injectionRisk: string;
      exactness: string;
      selected: boolean;
      renderedPosition: number | null;
      estimatedTokens: number;
      selectionReason: string | null;
      omissionReason: string | null;
      transformationJson: string | null;
      invalidationJson: string;
    }>;

    for (const [fragmentId, entry] of selectedById) {
      const fragment = candidateById.get(fragmentId);
      if (fragment === undefined) {
        throw new Error(`manifest references missing fragment bytes: ${fragmentId}`);
      }
      const contentArtifact = await this.persistFragmentArtifact(fragment);
      persistedFragments.push({
        id: randomUUID(),
        manifestId: id,
        fragmentKey: fragment.id,
        kind: fragment.kind,
        sourceUri: fragment.source.uri,
        sourceVersion: fragment.sourceVersion,
        contentArtifact,
        authority: fragment.authority,
        priority: fragment.priority,
        trust: fragment.trust,
        confidentiality: fragment.confidentiality,
        injectionRisk: fragment.injectionRisk,
        exactness: fragment.exactness,
        selected: true,
        renderedPosition: entry.order,
        estimatedTokens: entry.estimatedTokens,
        selectionReason: reasonForCandidate(durableManifest.decisionRecord, fragment.id),
        omissionReason: null,
        transformationJson: transformationById.has(fragment.id)
          ? safeJson(transformationById.get(fragment.id))
          : null,
        invalidationJson: safeJson(fragment.invalidation),
      });
    }

    for (const [fragmentId, reason] of omissionsById) {
      const fragment = candidateById.get(fragmentId);
      if (fragment === undefined || selectedById.has(fragmentId)) continue;
      // Omitted candidates are represented in the manifest decision record.
      // Persist a row only when bytes are already available; no omitted state
      // may invent an artifact reference.
      if (fragment.textContent === undefined) continue;
      const contentArtifact = await this.persistFragmentArtifact(fragment);
      persistedFragments.push({
        id: randomUUID(),
        manifestId: id,
        fragmentKey: fragment.id,
        kind: fragment.kind,
        sourceUri: fragment.source.uri,
        sourceVersion: fragment.sourceVersion,
        contentArtifact,
        authority: fragment.authority,
        priority: fragment.priority,
        trust: fragment.trust,
        confidentiality: fragment.confidentiality,
        injectionRisk: fragment.injectionRisk,
        exactness: fragment.exactness,
        selected: false,
        renderedPosition: null,
        estimatedTokens: fragment.estimatedTokens[durableManifest.model] ?? 0,
        selectionReason: null,
        omissionReason: reason,
        transformationJson: null,
        invalidationJson: safeJson(fragment.invalidation),
      });
    }

    await this.mutate(async () => {
      const existingEpoch = await this.db.contextEpoch.findUnique({ where: { id: durableManifest.epochId } });
      await this.db.$transaction(async (tx) => {
        await this.fence(tx);
        await tx.contextManifest.create({
        data: {
          id,
          providerAttemptId: null,
          compilerVersion: durableManifest.compilerVersion,
          policyVersion: durableManifest.policyVersion,
          epochId: existingEpoch?.id ?? null,
          providerKey: String(durableManifest.model).split("/", 1)[0] ?? String(durableManifest.model),
          modelKey: String(durableManifest.model),
          manifestArtifact: manifestArtifact.uri,
          // This is replaced by recordRenderedRequest before transport.
          renderedRequestHash: durableManifest.cachePlan.stablePrefixHash,
          estimatedTokensJson: safeJson({
            predictedInput: Number(durableManifest.fragments.reduce((sum, entry) => sum + entry.estimatedTokens, 0)),
            output: Number(durableManifest.outputReserveTokens),
            reasoning: Number(durableManifest.reasoningReserveTokens),
            toolResult: Number(durableManifest.toolResultReserveTokens),
            recovery: Number(durableManifest.recoveryMarginTokens),
          }),
          cachePlanJson: safeJson(durableManifest.cachePlan),
          experimentJson: safeJson({
            assignments: durableManifest.experimentAssignments,
            providerCapabilityHash: durableManifest.providerCapabilityHash,
            confidentialityDecisions: durableManifest.confidentialityDecisions,
            taintDecisions: durableManifest.taintDecisions,
            decisionRecord: durableManifest.decisionRecord ?? {},
          }),
        },
      });
        if (persistedFragments.length > 0) {
          await tx.contextFragment.createMany({ data: persistedFragments });
        }
      });
    });
    return durableManifest;
  }

  async getManifest(id: Uuid7): Promise<ContextManifest | null> {
    const row = await this.db.contextManifest.findUnique({
      where: { id },
      include: { fragments: true },
    });
    if (row === null) return null;
    const experimentRecord = parseJson<Record<string, unknown>>(row.experimentJson, {});
    const experimentDecisionRecord = experimentRecord.decisionRecord;
    const observedCachedTokens = readObservedCachedTokens(experimentRecord);
    const estimatedTokens = parseJson<Record<string, unknown>>(row.estimatedTokensJson, {});
    const cachePlan = parseJson<Record<string, unknown>>(row.cachePlanJson, {});
    if (row.epochId === null) {
      throw new Error(`context manifest ${row.id} has no durable context epoch`);
    }
    return {
      id: row.id as Uuid7,
      providerAttemptId: row.providerAttemptId as Uuid7 | null,
      epochId: row.epochId as Uuid7,
      compilerVersion: row.compilerVersion,
      policyVersion: row.policyVersion,
      providerCapabilityHash: typeof experimentRecord.providerCapabilityHash === "string"
        ? experimentRecord.providerCapabilityHash as ContentHash
        : EMPTY_CONTENT_HASH,
      model: row.modelKey as ContextManifest["model"],
      fragments: row.fragments
        .filter((fragment) => fragment.selected)
        .sort((a, b) => (a.renderedPosition ?? Number.MAX_SAFE_INTEGER) - (b.renderedPosition ?? Number.MAX_SAFE_INTEGER))
        .map((fragment) => ({
          fragmentId: fragment.fragmentKey,
          role: fragment.kind,
          order: fragment.renderedPosition ?? 0,
          artifactHash: uriToHash(fragment.contentArtifact),
          estimatedTokens: fragment.estimatedTokens,
          required: fragment.authority >= 80,
          cacheBreakpoint: false,
        })),
      omitted: readOmissions(row.experimentJson),
      cachePlan: {
        stablePrefixHash: typeof cachePlan.stablePrefixHash === "string"
          ? cachePlan.stablePrefixHash as ContentHash
          : EMPTY_CONTENT_HASH,
        volatileSuffixBoundary: finiteNonNegativeInteger(cachePlan.volatileSuffixBoundary),
        breakpoints: Array.isArray(cachePlan.breakpoints)
          ? cachePlan.breakpoints.filter(isFiniteNonNegativeInteger)
          : [],
        predictedCachedTokens: bigintField(cachePlan, "predictedCachedTokens") as ContextManifest["predictedCachedTokens"],
      },
      outputReserveTokens: bigintField(estimatedTokens, "output") as ContextManifest["outputReserveTokens"],
      reasoningReserveTokens: bigintField(estimatedTokens, "reasoning") as ContextManifest["reasoningReserveTokens"],
      toolResultReserveTokens: bigintField(estimatedTokens, "toolResult") as ContextManifest["toolResultReserveTokens"],
      recoveryMarginTokens: bigintField(estimatedTokens, "recovery") as ContextManifest["recoveryMarginTokens"],
      predictedCachedTokens: bigintField(cachePlan, "predictedCachedTokens") as ContextManifest["predictedCachedTokens"],
      observedCachedTokens: observedCachedTokens as ContextManifest["observedCachedTokens"],
      confidentialityDecisions: stringRecord(experimentRecord.confidentialityDecisions) as ContextManifest["confidentialityDecisions"],
      taintDecisions: stringRecord(experimentRecord.taintDecisions) as ContextManifest["taintDecisions"],
      experimentAssignments: Array.isArray(experimentRecord.assignments)
        ? experimentRecord.assignments.filter((value): value is string => typeof value === "string")
        : [],
      decisionRecord: typeof experimentDecisionRecord === "object" && experimentDecisionRecord !== null
        ? experimentDecisionRecord as Readonly<Record<string, unknown>>
        : {},
      createdAt: row.createdAt.toISOString() as Rfc3339Timestamp,
    };
  }

  async recordRenderedRequest(
    manifestId: Uuid7,
    rendered: RenderedProviderRequest,
  ): Promise<ArtifactRef | null> {
    const requestPayload = {
      providerId: rendered.providerId,
      model: rendered.model,
      body: rendered.body,
      request: { ...rendered.request, signal: null },
    };
    const artifact = await this.ingestJson(requestPayload, "provider-request");
    await this.mutate(() => this.db.$transaction(async (tx) => {
      await this.fence(tx);
      await tx.contextManifest.update({
        where: { id: manifestId },
        data: { renderedRequestHash: artifact.hash },
      });
    }));
    return artifact;
  }

  async recordObservation(
    manifestId: Uuid7,
    observation: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await this.mutate(async () => {
      await this.db.$transaction(async (tx) => {
        await this.fence(tx);
        const row = await tx.contextManifest.findUnique({ where: { id: manifestId } });
        if (row === null) throw new Error(`context manifest not found: ${manifestId}`);
        const current = parseJson(row.experimentJson, {} as Record<string, unknown>);
        await tx.contextManifest.update({
          where: { id: manifestId },
          data: { experimentJson: safeJson({ ...current, observation }) },
        });
      });
    });
  }

  private async ingestJson(value: unknown, purpose: string): Promise<ArtifactMetadata> {
    return this.artifacts.ingest(
      new TextEncoder().encode(canonicalJson(value)),
      {
        mediaType: "application/json",
        custom: {
          purpose,
          sessionId: this.scope.sessionId,
          taskId: this.scope.taskId,
          turnId: this.scope.turnId,
        },
      },
    );
  }

  private async persistFragmentArtifact(fragment: ContextFragment): Promise<string> {
    if (fragment.textContent === undefined) return fragment.contentRef.uri;
    const metadata = await this.artifacts.ingest(
      new TextEncoder().encode(fragment.textContent),
      {
        mediaType: fragment.contentRef.mediaType,
        custom: {
          purpose: "context-fragment",
          fragmentId: fragment.id,
          sourceUri: fragment.source.uri,
          sessionId: this.scope.sessionId,
          taskId: this.scope.taskId,
          turnId: this.scope.turnId,
        },
      },
    );
    if (metadata.hash !== fragment.contentRef.hash) {
      throw new Error(
        `context fragment content hash mismatch for ${fragment.id}: expected ${fragment.contentRef.hash}, got ${metadata.hash}`,
      );
    }
    return metadata.uri;
  }
}

function requireArtifact(
  artifact: { readonly sha256: string; readonly sizeBytes: number; readonly mediaType: string } | undefined,
  operation: string,
): { readonly sha256: string; readonly sizeBytes: number; readonly mediaType: string } {
  if (artifact === undefined) throw new Error(`kernel artifact ${operation} returned no artifact`);
  return artifact;
}

function safeJson(value: unknown): string {
  return canonicalJson(value);
}

function parseJson<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function bigintField(record: Readonly<Record<string, unknown>>, key: string): bigint {
  const value = record[key];
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    try {
      return BigInt(value);
    } catch {
      return 0n;
    }
  }
  return 0n;
}

function readObservedCachedTokens(record: Readonly<Record<string, unknown>>): bigint | null {
  const observation = record.observation;
  if (typeof observation !== "object" || observation === null || Array.isArray(observation)) return null;
  const cache = (observation as Readonly<Record<string, unknown>>).cache;
  if (typeof cache !== "object" || cache === null || Array.isArray(cache)) return null;
  const value = (cache as Readonly<Record<string, unknown>>).observedCachedTokens;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    try {
      return BigInt(value);
    } catch {
      return null;
    }
  }
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? BigInt(value)
    : null;
}

function isFiniteNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function finiteNonNegativeInteger(value: unknown): number {
  return isFiniteNonNegativeInteger(value) ? value : 0;
}

function stringRecord(
  value: unknown,
): Readonly<Record<string, string>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => typeof entry === "string"),
  );
}

function uriToHash(uri: string): ContentHash {
  const value = uri.replace(/^artifact:\/\/sha256\//, "sha256:");
  return value as ContentHash;
}

function readOmissions(text: string): readonly { readonly fragmentId: string; readonly reason: string }[] {
  const decoded = parseJson<{ decisionRecord?: { allocationOmissions?: unknown; confidentialityOmissions?: unknown } }>(text, {});
  const record = decoded.decisionRecord;
  if (record === undefined) return [];
  const values = [record.allocationOmissions, record.confidentialityOmissions].flat();
  return values.filter((value): value is { fragmentId: string; reason: string } =>
    typeof value === "object" && value !== null
    && typeof (value as { fragmentId?: unknown }).fragmentId === "string"
    && typeof (value as { reason?: unknown }).reason === "string",
  );
}

function readTransforms(value: Readonly<Record<string, unknown>> | undefined): readonly {
  readonly outputFragmentId: string;
  readonly inputFragmentIds: readonly string[];
  readonly lossPolicy: string;
  readonly evidenceRefs: readonly string[];
  readonly reason: string;
}[] {
  const transforms = value?.transforms;
  if (!Array.isArray(transforms)) return [];
  return transforms.filter((item): item is {
    outputFragmentId: string;
    inputFragmentIds: readonly string[];
    lossPolicy: string;
    evidenceRefs: readonly string[];
    reason: string;
  } => typeof item === "object" && item !== null
    && typeof (item as { outputFragmentId?: unknown }).outputFragmentId === "string"
    && Array.isArray((item as { inputFragmentIds?: unknown }).inputFragmentIds));
}

function reasonForCandidate(
  value: Readonly<Record<string, unknown>> | undefined,
  fragmentId: string,
): string | null {
  const candidates = value?.candidates;
  if (!Array.isArray(candidates)) return null;
  const candidate = candidates.find((item) =>
    typeof item === "object" && item !== null
    && (item as { fragmentId?: unknown }).fragmentId === fragmentId,
  );
  if (typeof candidate !== "object" || candidate === null) return null;
  const reason = (candidate as { reason?: unknown }).reason;
  return typeof reason === "string" ? reason : null;
}

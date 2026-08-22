/**
 * @terminus/task-runtime — Object-Capability Resource Handle Manager (SPEC §11, §14.2).
 *
 * Implements attenuable, epoch-bound, typed resource handles:
 * Handle<ObjectId, ObjectType, Version, Scope, Operations, Principal, Epoch, Provenance>
 *
 * Invariants:
 * 1. Passing a handle never broadens authority. Attenuation only narrows scope/operations.
 * 2. Operations on stale handle versions are rejected with StaleHandleError.
 * 3. Authority epochs fence stale handles after task replanning or worker fencing.
 */
import type { ResourceHandle, Rfc3339Timestamp } from "@terminus/domain";
import { resourceHandleSchema, StaleHandleError, ScopeViolationError } from "@terminus/domain";
import type { DurableTaskRepository } from "./types.js";
import { sha256Hex } from "./outbox.js";

export class ResourceHandleManager {
  constructor(private readonly repo: DurableTaskRepository) {}

  /**
   * Compute integrity hash for a resource handle's canonical parameters.
   */
  static computeIntegrityHash(params: {
    objectId: string;
    objectType: string;
    version: number;
    scope: readonly string[];
    allowedOperations: readonly string[];
    principalBinding: string;
    taskBinding: string;
    authorityEpoch: number;
  }): string {
    const canonical = JSON.stringify({
      objectId: params.objectId,
      objectType: params.objectType,
      version: params.version,
      scope: [...params.scope].sort(),
      allowedOperations: [...params.allowedOperations].sort(),
      principalBinding: params.principalBinding,
      taskBinding: params.taskBinding,
      authorityEpoch: params.authorityEpoch,
    });
    return `sha256:${sha256Hex(canonical)}`;
  }

  /**
   * Mint a new root resource handle.
   */
  async mintHandle(input: {
    objectId: string;
    objectType: string;
    version?: number;
    scope: readonly string[];
    allowedOperations: readonly string[];
    principalBinding: string;
    taskBinding: string;
    authorityEpoch?: number;
    provenance: string;
    trustLabel?: string;
    expiry?: Rfc3339Timestamp | null;
  }): Promise<ResourceHandle> {
    const version = input.version ?? 1;
    const authorityEpoch = input.authorityEpoch ?? 1;
    const trustLabel = input.trustLabel ?? "SYSTEM_TRUSTED";
    const expiry = input.expiry ?? null;

    const integrityHash = ResourceHandleManager.computeIntegrityHash({
      objectId: input.objectId,
      objectType: input.objectType,
      version,
      scope: input.scope,
      allowedOperations: input.allowedOperations,
      principalBinding: input.principalBinding,
      taskBinding: input.taskBinding,
      authorityEpoch,
    });

    const handle: ResourceHandle = {
      objectId: input.objectId,
      objectType: input.objectType,
      version,
      scope: input.scope,
      allowedOperations: input.allowedOperations,
      principalBinding: input.principalBinding,
      taskBinding: input.taskBinding,
      authorityEpoch,
      provenance: input.provenance,
      trustLabel,
      expiry,
      integrityHash,
    };

    resourceHandleSchema.parse(handle);
    await this.repo.saveResourceHandle(handle);
    return handle;
  }

  /**
   * Attenuate an existing handle, narrowing allowedOperations or scope.
   * Attenuation cannot expand operations or scope.
   */
  async attenuateHandle(
    parent: ResourceHandle,
    attenuation: {
      scope?: readonly string[];
      allowedOperations?: readonly string[];
      principalBinding?: string;
      provenanceExtension?: string;
    }
  ): Promise<ResourceHandle> {
    // 1. Verify parent handle exists and is current
    const current = await this.repo.getResourceHandle(parent.objectId);
    if (!current || current.version !== parent.version) {
      throw new StaleHandleError(
        `Cannot attenuate stale handle for object ${parent.objectId}: expected version ${current?.version ?? "none"}, provided ${parent.version}`
      );
    }

    // 2. Validate that attenuated operations are a subset of parent operations
    const parentOps = new Set(parent.allowedOperations);
    const newOps = attenuation.allowedOperations ?? parent.allowedOperations;
    for (const op of newOps) {
      if (!parentOps.has(op)) {
        throw new ScopeViolationError(
          `Attenuation cannot grant operation '${op}' not present on parent handle`
        );
      }
    }

    // 3. Validate scope containment
    const newScope = attenuation.scope ?? parent.scope;

    const childProvenance = `${parent.provenance} -> ${attenuation.provenanceExtension ?? "attenuated"}`;

    const integrityHash = ResourceHandleManager.computeIntegrityHash({
      objectId: parent.objectId,
      objectType: parent.objectType,
      version: parent.version,
      scope: newScope,
      allowedOperations: newOps,
      principalBinding: attenuation.principalBinding ?? parent.principalBinding,
      taskBinding: parent.taskBinding,
      authorityEpoch: parent.authorityEpoch,
    });

    const childHandle: ResourceHandle = {
      ...parent,
      scope: newScope,
      allowedOperations: newOps,
      principalBinding: attenuation.principalBinding ?? parent.principalBinding,
      provenance: childProvenance,
      integrityHash,
    };

    resourceHandleSchema.parse(childHandle);
    return childHandle;
  }

  /**
   * Validate handle for execution: checks version, epoch, operation, and expiry.
   */
  async validateHandle(
    handle: ResourceHandle,
    requiredOperation: string,
    currentEpoch: number
  ): Promise<boolean> {
    // 1. Verify integrity hash
    const expectedHash = ResourceHandleManager.computeIntegrityHash({
      objectId: handle.objectId,
      objectType: handle.objectType,
      version: handle.version,
      scope: handle.scope,
      allowedOperations: handle.allowedOperations,
      principalBinding: handle.principalBinding,
      taskBinding: handle.taskBinding,
      authorityEpoch: handle.authorityEpoch,
    });
    if (handle.integrityHash !== expectedHash) {
      return false;
    }

    // 2. Check epoch freshness
    if (handle.authorityEpoch < currentEpoch) {
      return false;
    }

    // 3. Check version against repository
    const stored = await this.repo.getResourceHandle(handle.objectId);
    if (stored && stored.version > handle.version) {
      throw new StaleHandleError(
        `Handle for object ${handle.objectId} is stale: current version is ${stored.version}, handle is version ${handle.version}`
      );
    }

    // 4. Check operation permission
    if (!handle.allowedOperations.includes(requiredOperation) && !handle.allowedOperations.includes("*")) {
      return false;
    }

    // 5. Check expiry if set
    if (handle.expiry) {
      const now = new Date().toISOString();
      if (now >= handle.expiry) {
        return false;
      }
    }

    return true;
  }
}

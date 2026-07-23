/**
 * @terminus/capability-registry — capability descriptor, registry, lockfile,
 * activation lifecycle, skills, MCP admission.
 *
 * SPEC §12, §35. Exit gate: no ambient effects; descriptor changes caught;
 * external results independently verified (adapters elsewhere).
 */
import type {
  CapabilityDescriptor,
  CapabilityActivation,
  CapabilityKind,
  CapabilityTrustLevel,
  ContentHash,
  Uuid7,
  PrincipalId,
  Rfc3339Timestamp,
} from "@terminus/domain";
import { ValidationError, ConflictError, PermissionError } from "@terminus/domain";
import { admissionFingerprint, diffDescriptors } from "./descriptor_diff.js";
import {
  buildLockfile,
  lockfileKey,
  MemoryLockfileStore,
  type CapabilityLockfile,
  type LockfileEntry,
  type LockfileStore,
} from "./lockfile.js";

export interface CapabilityRepository {
  createDescriptor(d: CapabilityDescriptor): Promise<CapabilityDescriptor>;
  getDescriptor(id: string, version: string): Promise<CapabilityDescriptor | null>;
  listDescriptors(): Promise<readonly CapabilityDescriptor[]>;
  deleteDescriptor(id: string, version: string): Promise<void>;
  createActivation(a: CapabilityActivation): Promise<CapabilityActivation>;
  getActivation(id: Uuid7): Promise<CapabilityActivation | null>;
  listActivations(filter: {
    readonly sessionId?: Uuid7 | undefined;
    readonly state?: "active" | "deactivated" | "revoked" | undefined;
  }): Promise<readonly CapabilityActivation[]>;
  updateActivation(a: CapabilityActivation): Promise<CapabilityActivation>;
}

export interface CapabilityRegistryDeps {
  readonly repo: CapabilityRepository;
  readonly idSource: () => Uuid7;
  readonly clock: () => Rfc3339Timestamp;
  readonly lockfileStore?: LockfileStore;
  /** Optional sink for security events (descriptor_changed, etc.). */
  readonly onSecurityEvent?: (event: {
    readonly kind: string;
    readonly detail: string;
    readonly capabilityId: string;
  }) => void;
}

export class CapabilityRegistry {
  private readonly lockfileStore: LockfileStore;
  private cache: Map<string, LockfileEntry> | null = null;

  constructor(private readonly deps: CapabilityRegistryDeps) {
    this.lockfileStore = deps.lockfileStore ?? new MemoryLockfileStore();
  }

  private async ensureCache(): Promise<Map<string, LockfileEntry>> {
    if (this.cache) return this.cache;
    const snap = await this.lockfileStore.load();
    this.cache = new Map(snap.entries.map((e) => [lockfileKey(e.id, e.version), e]));
    return this.cache;
  }

  private async persist(): Promise<void> {
    const cache = await this.ensureCache();
    await this.lockfileStore.save(buildLockfile([...cache.values()]));
  }

  async discover(sources: readonly CapabilityDescriptor[]): Promise<readonly CapabilityDescriptor[]> {
    const admitted: CapabilityDescriptor[] = [];
    for (const d of sources) {
      const existing = await this.deps.repo.getDescriptor(d.id, d.version);
      if (existing) continue;
      const saved = await this.deps.repo.createDescriptor(d);
      admitted.push(saved);
    }
    return admitted;
  }

  classifyEffects(
    descriptor: CapabilityDescriptor,
  ): readonly ("read_only" | "fs_mutate" | "network_egress" | "process_exec" | "secret_access")[] {
    if (descriptor.effectClassification && descriptor.effectClassification.length > 0) {
      return descriptor.effectClassification;
    }
    const effects: ("read_only" | "fs_mutate" | "network_egress" | "process_exec" | "secret_access")[] =
      [];
    const fs = descriptor.filesystem as { read?: unknown[]; write?: unknown[] };
    if (fs && Array.isArray(fs.write) && fs.write.length > 0) {
      effects.push("fs_mutate");
    } else {
      effects.push("read_only");
    }
    const net = descriptor.network as { allow?: unknown[] };
    if (net && Array.isArray(net.allow) && net.allow.length > 0) {
      effects.push("network_egress");
    }
    const sub = descriptor.subprocesses as { allow?: boolean; spawn?: unknown[] };
    if (sub && (sub.allow === true || (Array.isArray(sub.spawn) && sub.spawn.length > 0))) {
      effects.push("process_exec");
    }
    if (Array.isArray(descriptor.secrets) && descriptor.secrets.length > 0) {
      effects.push("secret_access");
    }
    return effects;
  }

  validateDescriptorPolicy(descriptor: CapabilityDescriptor): void {
    const effects = this.classifyEffects(descriptor);

    if (descriptor.trustLevel === "untrusted" && descriptor.lifecycle?.disableScripts === false) {
      throw new ValidationError(
        "untrusted capabilities must disable package lifecycle scripts",
        { id: descriptor.id },
      );
    }

    if (
      descriptor.trustLevel === "untrusted" &&
      effects.includes("process_exec") &&
      effects.includes("network_egress")
    ) {
      throw new PermissionError(
        "prohibited capability combination: untrusted capability cannot request both process execution and network egress",
        { id: descriptor.id, effects },
      );
    }

    if (
      descriptor.trustLevel === "untrusted" &&
      effects.includes("secret_access") &&
      effects.includes("process_exec")
    ) {
      throw new PermissionError(
        "prohibited capability combination: untrusted capability cannot request both raw secrets and process execution",
        { id: descriptor.id, effects },
      );
    }
  }

  /**
   * Admit a descriptor: validate hash, signature, and policy. Pin the
   * descriptor hash in the durable lockfile.
   */
  async admit(
    descriptor: CapabilityDescriptor,
    admittedBy: PrincipalId,
    opts?: {
      readonly toolDescriptorHashes?: Readonly<Record<string, ContentHash>>;
      readonly forceReauthorize?: boolean;
    },
  ): Promise<LockfileEntry> {
    this.validateDescriptorPolicy(descriptor);
    const cache = await this.ensureCache();
    const key = lockfileKey(descriptor.id, descriptor.version);
    const existing = cache.get(key);
    const fingerprint = admissionFingerprint(descriptor);

    if (existing && !opts?.forceReauthorize) {
      if (
        existing.contentHash !== descriptor.contentHash ||
        existing.admissionFingerprint !== fingerprint
      ) {
        this.deps.onSecurityEvent?.({
          kind: "descriptor_changed",
          detail: `hash mismatch for ${key}`,
          capabilityId: descriptor.id,
        });
        throw new ConflictError(
          "DESCRIPTOR_RUG_PULL",
          `descriptor ${key} already admitted with different hash — re-authorization required`,
          {
            existing: existing.contentHash,
            incoming: descriptor.contentHash,
            existingFingerprint: existing.admissionFingerprint,
            incomingFingerprint: fingerprint,
          },
        );
      }
      return existing;
    }

    if (existing && opts?.forceReauthorize) {
      const prior = await this.deps.repo.getDescriptor(descriptor.id, descriptor.version);
      if (prior) {
        const diff = diffDescriptors(prior, descriptor);
        if (diff.requiresReauthorization) {
          this.deps.onSecurityEvent?.({
            kind: "reauthorization",
            detail: `re-admitting ${key}: ${diff.mutations.map((m) => m.field).join(",")}`,
            capabilityId: descriptor.id,
          });
        }
      }
    }

    if (descriptor.trustLevel === "verified_third_party" && descriptor.signature === null) {
      throw new ValidationError("verified_third_party capabilities require a signature", {
        id: descriptor.id,
      });
    }

    const entry: LockfileEntry = {
      id: descriptor.id,
      version: descriptor.version,
      contentHash: descriptor.contentHash,
      admissionFingerprint: fingerprint,
      signature: descriptor.signature,
      trustLevel: descriptor.trustLevel,
      admittedAt: this.deps.clock(),
      admittedBy,
      toolDescriptorHashes: opts?.toolDescriptorHashes ?? {},
    };
    cache.set(key, entry);
    await this.deps.repo.createDescriptor(descriptor);
    await this.persist();
    return entry;
  }

  async activate(
    id: string,
    version: string,
    sessionId: Uuid7,
    taskId: Uuid7 | null,
    activatedBy: PrincipalId,
  ): Promise<CapabilityActivation> {
    const descriptor = await this.deps.repo.getDescriptor(id, version);
    if (descriptor === null) {
      throw new ValidationError("descriptor not found", { id, version });
    }
    const cache = await this.ensureCache();
    const lockfileEntry = cache.get(lockfileKey(id, version));
    if (lockfileEntry === undefined) {
      throw new PermissionError("capability not admitted to lockfile", { id, version });
    }
    const fingerprint = admissionFingerprint(descriptor);
    if (
      lockfileEntry.contentHash !== descriptor.contentHash ||
      lockfileEntry.admissionFingerprint !== fingerprint
    ) {
      this.deps.onSecurityEvent?.({
        kind: "descriptor_changed",
        detail: `rug-pull on activate ${id}@${version}`,
        capabilityId: id,
      });
      throw new ConflictError(
        "DESCRIPTOR_RUG_PULL",
        `descriptor hash mismatch for ${id}@${version} — rug-pull detected, re-authorization required`,
        {
          lockfile: lockfileEntry.contentHash,
          descriptor: descriptor.contentHash,
        },
      );
    }
    const activation: CapabilityActivation = {
      id: this.deps.idSource(),
      capabilityId: id,
      capabilityVersion: version,
      capabilityHash: descriptor.contentHash,
      sessionId,
      taskId,
      activatedBy,
      activatedAt: this.deps.clock(),
      deactivatedAt: null,
      state: "active",
    };
    return this.deps.repo.createActivation(activation);
  }

  async deactivate(activationId: Uuid7): Promise<CapabilityActivation> {
    const a = await this.requireActivation(activationId);
    return this.deps.repo.updateActivation({
      ...a,
      state: "deactivated",
      deactivatedAt: this.deps.clock(),
    });
  }

  async revoke(activationId: Uuid7): Promise<CapabilityActivation> {
    const a = await this.requireActivation(activationId);
    const revoked = await this.deps.repo.updateActivation({
      ...a,
      state: "revoked",
      deactivatedAt: this.deps.clock(),
    });
    const cache = await this.ensureCache();
    cache.delete(lockfileKey(a.capabilityId, a.capabilityVersion));
    await this.persist();
    return revoked;
  }

  async snapshotLockfile(): Promise<CapabilityLockfile> {
    const cache = await this.ensureCache();
    return buildLockfile([...cache.values()]);
  }

  /** Synchronous snapshot for tests that already warmed the cache via admit. */
  snapshotLockfileSync(): CapabilityLockfile {
    if (!this.cache) return buildLockfile([]);
    return buildLockfile([...this.cache.values()]);
  }

  private async requireActivation(id: Uuid7): Promise<CapabilityActivation> {
    const a = await this.deps.repo.getActivation(id);
    if (a === null) throw new ValidationError("activation not found", { activationId: id });
    return a;
  }
}

export * from "./hash.js";
export * from "./lockfile.js";
export * from "./descriptor_diff.js";
export * from "./skill_discovery.js";
export * from "./mcp_admission.js";
export * from "./mcp_relay.js";
export * from "./kernel_port.js";

export type {
  CapabilityDescriptor,
  CapabilityActivation,
  CapabilityKind,
  CapabilityTrustLevel,
  ContentHash,
  Uuid7,
  PrincipalId,
};

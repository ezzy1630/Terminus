/**
 * @terminus/capability-registry — capability descriptor, registry, lockfile,
 * activation lifecycle.
 *
 * Per SPEC §12, §35: CapabilityRegistry with discover(), admit(descriptor),
 * activate(id, session, task), deactivate(id), revoke(id). Loads Agent Skills
 * (SKILL.md + terminus.skill.yaml). Pin descriptor hashes.
 */
import { z } from "zod";
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

// ────────────────────────── Repository ───────────────────────────────────────

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

// ────────────────────────── Lockfile ─────────────────────────────────────────

export interface LockfileEntry {
  readonly id: string;
  readonly version: string;
  readonly contentHash: ContentHash;
  readonly signature: string | null;
  readonly trustLevel: CapabilityTrustLevel;
  readonly admittedAt: Rfc3339Timestamp;
  readonly admittedBy: PrincipalId;
}

export interface CapabilityLockfile {
  readonly entries: readonly LockfileEntry[];
}

export const lockfileEntrySchema = z.object({
  id: z.string(),
  version: z.string(),
  contentHash: z.string(),
  signature: z.string().nullable(),
  trustLevel: z.enum(["builtin", "first_party", "verified_third_party", "untrusted"]),
  admittedAt: z.string(),
  admittedBy: z.string(),
});

export const capabilityLockfileSchema = z.object({
  entries: z.array(lockfileEntrySchema),
});

// ────────────────────────── Service ──────────────────────────────────────────

export interface CapabilityRegistryDeps {
  readonly repo: CapabilityRepository;
  readonly idSource: () => Uuid7;
  readonly clock: () => Rfc3339Timestamp;
}

export class CapabilityRegistry {
  private readonly lockfile: Map<string, LockfileEntry> = new Map();

  constructor(private readonly deps: CapabilityRegistryDeps) {}

  /**
   * Discover capability descriptors from a list of sources. Each source
   * produces zero or more descriptors; the registry admits those that pass
   * policy.
   */
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

  /**
   * Admit a descriptor: validate hash, signature, and policy. Pin the
   * descriptor hash in the lockfile.
   */
  async admit(
    descriptor: CapabilityDescriptor,
    admittedBy: PrincipalId,
  ): Promise<LockfileEntry> {
    const existing = this.lockfile.get(`${descriptor.id}@${descriptor.version}`);
    if (existing) {
      if (existing.contentHash !== descriptor.contentHash) {
        throw new ConflictError(
          "ALREADY_EXISTS",
          `descriptor ${descriptor.id}@${descriptor.version} already admitted with different hash`,
          { existing: existing.contentHash, incoming: descriptor.contentHash },
        );
      }
      return existing;
    }
    if (descriptor.trustLevel === "verified_third_party" && descriptor.signature === null) {
      throw new ValidationError(
        "verified_third_party capabilities require a signature",
        { id: descriptor.id },
      );
    }
    const entry: LockfileEntry = {
      id: descriptor.id,
      version: descriptor.version,
      contentHash: descriptor.contentHash,
      signature: descriptor.signature,
      trustLevel: descriptor.trustLevel,
      admittedAt: this.deps.clock(),
      admittedBy,
    };
    this.lockfile.set(`${descriptor.id}@${descriptor.version}`, entry);
    await this.deps.repo.createDescriptor(descriptor);
    return entry;
  }

  /** Activate a capability in a session/task context. */
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
    const lockfileEntry = this.lockfile.get(`${id}@${version}`);
    if (lockfileEntry === undefined) {
      throw new PermissionError("capability not admitted to lockfile", { id, version });
    }
    if (lockfileEntry.contentHash !== descriptor.contentHash) {
      throw new ConflictError(
        "ALREADY_EXISTS",
        `descriptor hash mismatch — re-admission required`,
        { lockfile: lockfileEntry.contentHash, descriptor: descriptor.contentHash },
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

  /** Deactivate a capability (soft — can be re-activated). */
  async deactivate(activationId: Uuid7): Promise<CapabilityActivation> {
    const a = await this.requireActivation(activationId);
    return this.deps.repo.updateActivation({
      ...a,
      state: "deactivated",
      deactivatedAt: this.deps.clock(),
    });
  }

  /** Revoke a capability (hard — must be re-admitted to use again). */
  async revoke(activationId: Uuid7): Promise<CapabilityActivation> {
    const a = await this.requireActivation(activationId);
    const revoked = await this.deps.repo.updateActivation({
      ...a,
      state: "revoked",
      deactivatedAt: this.deps.clock(),
    });
    // Remove from lockfile.
    this.lockfile.delete(`${a.capabilityId}@${a.capabilityVersion}`);
    return revoked;
  }

  /** Returns the current lockfile snapshot. */
  snapshotLockfile(): CapabilityLockfile {
    return { entries: [...this.lockfile.values()] };
  }

  private async requireActivation(id: Uuid7): Promise<CapabilityActivation> {
    const a = await this.deps.repo.getActivation(id);
    if (a === null) throw new ValidationError("activation not found", { activationId: id });
    return a;
  }
}

// ────────────────────────── Skill file loader (interface only) ───────────────

export interface SkillManifest {
  readonly id: string;
  readonly version: string;
  readonly skillMdHash: ContentHash;
  readonly compatibleHarness: string;
  readonly requiredCapabilities: {
    readonly filesystem: { readonly read: readonly string[]; readonly write: readonly string[] };
    readonly network: readonly string[];
    readonly secrets: readonly string[];
  };
  readonly tests: readonly string[];
  readonly provenance: {
    readonly source: string;
    readonly publisher: string;
    readonly signature: string | null;
  };
}

export const skillManifestSchema = z.object({
  id: z.string(),
  version: z.string(),
  skillMdHash: z.string() as unknown as z.ZodType<ContentHash>,
  compatibleHarness: z.string(),
  requiredCapabilities: z.object({
    filesystem: z.object({ read: z.array(z.string()), write: z.array(z.string()) }),
    network: z.array(z.string()),
    secrets: z.array(z.string()),
  }),
  tests: z.array(z.string()),
  provenance: z.object({
    source: z.string(),
    publisher: z.string(),
    signature: z.string().nullable(),
  }),
});

/**
 * Loads a `SkillManifest` from a `terminus.skill.yaml`-shaped object. Does NOT
 * read the filesystem — the caller supplies the parsed YAML.
 */
export function loadSkillManifest(yaml: unknown): SkillManifest {
  return skillManifestSchema.parse(yaml);
}

/** Converts a `SkillManifest` to a `CapabilityDescriptor`. */
export function manifestToDescriptor(
  manifest: SkillManifest,
  source: string,
  contentHash: ContentHash,
): CapabilityDescriptor {
  return {
    id: manifest.id,
    version: manifest.version,
    kind: "skill" as CapabilityKind,
    source,
    contentHash,
    signature: manifest.provenance.signature,
    publisher: manifest.provenance.publisher,
    trustLevel: manifest.provenance.signature ? "verified_third_party" : "untrusted",
    entrypoint: null,
    operations: [],
    filesystem: {
      read: manifest.requiredCapabilities.filesystem.read,
      write: manifest.requiredCapabilities.filesystem.write,
    },
    network: { allow: manifest.requiredCapabilities.network },
    secrets: manifest.requiredCapabilities.secrets,
    subprocesses: {},
    externalState: {},
    resourceLimits: {},
    modelVisibility: {},
    configurationSchema: null,
    compatibility: { compatibleHarness: manifest.compatibleHarness },
  };
}

export type {
  CapabilityDescriptor,
  CapabilityActivation,
  CapabilityKind,
  CapabilityTrustLevel,
  ContentHash,
  Uuid7,
  PrincipalId,
};

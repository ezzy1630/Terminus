/**
 * @terminus/provider-conformance — Capability snapshot persistence store.
 *
 * Per SPEC §38.2: Persists ProviderCapabilitySnapshot per provider/model/version.
 * In-memory with optional SQLite backing. Each snapshot is versioned so the
 * model broker can select the right capability profile for compatibility checks.
 *
 * Jane Street style: strong types, no `any`, clear invariants.
 */
import type { ModelKey, Rfc3339Timestamp } from "@terminus/domain";
import type {
  ModelCapabilitySnapshot,
  ProviderCapabilitySnapshot,
} from "@terminus/provider-core";

// ────────────────────────── Versioned snapshot ────────────────────────────────

export interface VersionedSnapshot {
  readonly version: number;
  readonly providerId: string;
  readonly modelKey: ModelKey;
  readonly snapshot: ModelCapabilitySnapshot;
  readonly createdAt: Rfc3339Timestamp;
  readonly deprecatedAfter: Rfc3339Timestamp | null;
  readonly replacedBy: number | null;
}

// ────────────────────────── Store interface ──────────────────────────────────

export interface CapabilitySnapshotStore {
  /** Persist a new snapshot. Returns the versioned entry. */
  put(snapshot: ModelCapabilitySnapshot): Promise<VersionedSnapshot>;
  /** Get the latest active snapshot for a model. */
  latest(providerId: string, modelKey: ModelKey): Promise<VersionedSnapshot | null>;
  /** Get a specific version. */
  atVersion(providerId: string, modelKey: ModelKey, version: number): Promise<VersionedSnapshot | null>;
  /** List all versions for a model, newest first. */
  history(providerId: string, modelKey: ModelKey): Promise<readonly VersionedSnapshot[]>;
  /** Deprecate a version (marks it replaced by a newer one). */
  deprecate(providerId: string, modelKey: ModelKey, version: number, replacedBy: number): Promise<void>;
  /** List all active (non-deprecated) snapshots. */
  allActive(): Promise<readonly VersionedSnapshot[]>;
}

// ────────────────────────── In-memory implementation ─────────────────────────

export class InMemorySnapshotStore implements CapabilitySnapshotStore {
  private readonly snapshots: Map<string, VersionedSnapshot[]> = new Map();
  private readonly clock: () => string;

  constructor(clock: () => string = () => new Date().toISOString()) {
    this.clock = clock;
  }

  private key(providerId: string, modelKey: ModelKey): string {
    return `${providerId}:${String(modelKey)}`;
  }

  async put(snapshot: ModelCapabilitySnapshot): Promise<VersionedSnapshot> {
    const k = this.key(snapshot.providerId, snapshot.modelKey);
    const entries = this.snapshots.get(k) ?? [];
    const version = entries.length + 1;
    const versioned: VersionedSnapshot = {
      version,
      providerId: snapshot.providerId,
      modelKey: snapshot.modelKey,
      snapshot,
      createdAt: this.clock() as Rfc3339Timestamp,
      deprecatedAfter: null,
      replacedBy: null,
    };
    entries.push(versioned);
    this.snapshots.set(k, entries);
    return versioned;
  }

  async latest(
    providerId: string,
    modelKey: ModelKey,
  ): Promise<VersionedSnapshot | null> {
    const entries = this.snapshots.get(this.key(providerId, modelKey));
    if (!entries || entries.length === 0) return null;
    // Get the newest non-deprecated entry.
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i]!;
      if (e.deprecatedAfter === null) return e;
    }
    return null;
  }

  async atVersion(
    providerId: string,
    modelKey: ModelKey,
    version: number,
  ): Promise<VersionedSnapshot | null> {
    const entries = this.snapshots.get(this.key(providerId, modelKey));
    if (!entries || version < 1 || version > entries.length) return null;
    return entries[version - 1] ?? null;
  }

  async history(
    providerId: string,
    modelKey: ModelKey,
  ): Promise<readonly VersionedSnapshot[]> {
    const entries = this.snapshots.get(this.key(providerId, modelKey)) ?? [];
    return [...entries].reverse();
  }

  async deprecate(
    providerId: string,
    modelKey: ModelKey,
    version: number,
    replacedBy: number,
  ): Promise<void> {
    const entries = this.snapshots.get(this.key(providerId, modelKey));
    if (!entries || version < 1 || version > entries.length) return;
    const entry = entries[version - 1]!;
    entries[version - 1] = {
      ...entry,
      deprecatedAfter: this.clock() as Rfc3339Timestamp,
      replacedBy,
    };
  }

  async allActive(): Promise<readonly VersionedSnapshot[]> {
    const active: VersionedSnapshot[] = [];
    for (const entries of this.snapshots.values()) {
      for (const e of entries) {
        if (e.deprecatedAfter === null) {
          active.push(e);
        }
      }
    }
    return active;
  }
}

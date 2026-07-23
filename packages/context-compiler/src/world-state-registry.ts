/**
 * @terminus/context-compiler — World State Producer Registry (SPEC §33.5).
 *
 * Typed registry of world-state producers. Each producer observes a named
 * section of the current environment at safe turn boundaries (never
 * mid-flight). Observations carry source versions so the compiler can
 * validate freshness.
 *
 * Producers register with:
 *  - section: which WorldStateSection they cover
 *  - key: a stable key within that section
 *  - scan(): produces the current observation (or unavailable/stale)
 *
 * The registry does NOT own process execution — it is pure state observation.
 */

import type { Rfc3339Timestamp, Uuid7, ContentHash } from "@terminus/domain";
import type {
  WorldStateSection,
  WorldStateObservation,
  WorldStateSnapshot,
} from "@terminus/context-ir";

export type {
  WorldStateSection,
  WorldStateObservation,
  WorldStateSnapshot,
};

// ──────────────────────── Producer contract ──────────────────────────────────

/**
 * A world-state producer owns one typed observation. It is invoked at
 * safe turn boundaries to recompute the current value.
 *
 * The `scan` function must be pure with respect to external state — it
 * observes, but does not mutate.
 */
export interface WorldStateProducer<T = unknown> {
  /** Stable section this producer belongs to. */
  readonly section: WorldStateSection;
  /** Stable key within the section. */
  readonly key: string;
  /** Human-readable label for manifests and explanation. */
  readonly label: string;
  /** Scan the current world state and return an observation. */
  scan(): WorldStateObservation<T>;
}

// ──────────────────────── Producer registry ──────────────────────────────────

export interface RegistrySnapshot {
  readonly producers: ReadonlyArray<WorldStateProducer>;
  readonly snapshot: WorldStateProducerRegistry;
  readonly sections: ReadonlySet<WorldStateSection>;
}

/**
 * The producer registry. Producers are registered once during bootstrap;
 * callers invoke `snapshot()` at safe turn boundaries to collect all
 * current observations.
 *
 * Uses a simple registry pattern — producers register themselves and
 * the registry collects their observations on demand.
 */
export class WorldStateProducerRegistry {
  private readonly producers = new Map<string, WorldStateProducer>();

  /** Register a producer. Replaces an existing producer for the same key. */
  register(producer: WorldStateProducer): void {
    const id = `${producer.section}:${producer.key}`;
    this.producers.set(id, producer);
  }

  /** Remove a producer by section and key. */
  unregister(section: WorldStateSection, key: string): void {
    this.producers.delete(`${section}:${key}`);
  }

  /** Number of registered producers. */
  get size(): number {
    return this.producers.size;
  }

  /** Produce a snapshot of all registered observations. */
  snapshot(): readonly WorldStateSnapshot[] {
    const bySection = new Map<WorldStateSection, WorldStateObservation[]>();
    for (const producer of this.producers.values()) {
      const observation = producer.scan();
      const list = bySection.get(producer.section);
      if (list !== undefined) {
        list.push(observation);
      } else {
        bySection.set(producer.section, [observation]);
      }
    }
    const snapshots: WorldStateSnapshot[] = [];
    for (const [section, observations] of bySection) {
      const observedAt = observations.length > 0
        ? observations[0]!.observedAt
        : (new Date().toISOString() as Rfc3339Timestamp);
      snapshots.push({
        section,
        observations,
        observedAt,
        producerVersion: "v1",
      });
    }
    return snapshots;
  }

  /** Get a single observation by section and key. */
  get(section: WorldStateSection, key: string): WorldStateObservation | null {
    const id = `${section}:${key}`;
    const producer = this.producers.get(id);
    if (producer === undefined) return null;
    return producer.scan();
  }

  /** List all registered sections. */
  get sections(): ReadonlySet<WorldStateSection> {
    const set = new Set<WorldStateSection>();
    for (const producer of this.producers.values()) {
      set.add(producer.section);
    }
    return set;
  }

  /** Convert to a flat Record for source-version tracking. */
  sourceVersionMap(): Readonly<Record<string, string>> {
    const map: Record<string, string> = {};
    for (const producer of this.producers.values()) {
      const obs = producer.scan();
      map[`${producer.section}:${producer.key}`] = obs.sourceVersion;
    }
    return map;
  }
}

// ──────────────────────── Concrete producers ─────────────────────────────────

/**
 * A producer backed by a static value. Useful for test/demo or for
 * values that do not change within a session (e.g., environment info).
 */
export class StaticProducer<T> implements WorldStateProducer<T> {
  readonly section: WorldStateSection;
  readonly key: string;
  readonly label: string;
  private readonly value: T;
  private readonly version: string;
  private readonly observedAt: Rfc3339Timestamp;

  constructor(
    section: WorldStateSection,
    key: string,
    label: string,
    value: T,
    version: string,
    observedAt?: Rfc3339Timestamp,
  ) {
    this.section = section;
    this.key = key;
    this.label = label;
    this.value = value;
    this.version = version;
    this.observedAt = observedAt ?? (new Date().toISOString() as Rfc3339Timestamp);
  }

  scan(): WorldStateObservation<T> {
    return {
      key: this.key,
      value: this.value,
      observedAt: this.observedAt,
      sourceVersion: this.version,
      availability: "available",
      staleReason: null,
    };
  }
}

/**
 * A producer backed by a lazily-evaluated function. The function is
 * called each time `scan()` is invoked, so it always returns the
 * current state.
 */
export class FunctionalProducer<T> implements WorldStateProducer<T> {
  readonly section: WorldStateSection;
  readonly key: string;
  readonly label: string;
  private readonly fn: () => { value: T; version: string; available: boolean };
  private readonly observedBy: string;

  constructor(
    section: WorldStateSection,
    key: string,
    label: string,
    fn: () => { value: T; version: string; available: boolean },
    observedBy?: string,
  ) {
    this.section = section;
    this.key = key;
    this.label = label;
    this.fn = fn;
    this.observedBy = observedBy ?? "kernel";
  }

  scan(): WorldStateObservation<T> {
    const now = new Date().toISOString() as Rfc3339Timestamp;
    const result = this.fn();
    return {
      key: this.key,
      value: result.value,
      observedAt: now,
      sourceVersion: result.version,
      availability: result.available ? "available" : "temporarily_unavailable",
      staleReason: result.available ? null : "producer reported unavailable",
    };
  }
}

// ──────────────────────── Aggregated observations ────────────────────────────

/**
 * An observation group bundles all observations for one section, keyed
 * by their stable producer key. This is the shape consumed by the
 * context compiler when it builds world-state fragments.
 */
export interface ObservationGroup {
  readonly section: WorldStateSection;
  readonly observations: Readonly<Record<string, WorldStateObservation>>;
  readonly observedAt: Rfc3339Timestamp;
}

/** Collect all observations from a snapshot into a typed group. */
export function groupObservations(
  snapshots: readonly WorldStateSnapshot[],
): readonly ObservationGroup[] {
  return snapshots.map((snapshot) => {
    const observations: Record<string, WorldStateObservation> = {};
    for (const obs of snapshot.observations) {
      observations[obs.key] = obs;
    }
    return {
      section: snapshot.section,
      observations,
      observedAt: snapshot.observedAt,
    };
  });
}

// ──────────────────────── Repository state producer ──────────────────────────

export interface RepositoryState {
  readonly branch: string | null;
  readonly commit: string | null;
  readonly dirty: boolean;
  readonly recentCommits: readonly string[];
  readonly trackedFiles: number;
}

/**
 * Creates a `FunctionalProducer` for repository state. The caller passes
 * a function that queries git (via the kernel RPC) and returns current
 * repository state.
 */
export function repositoryStateProducer(
  fetchState: () => { value: RepositoryState; version: string; available: boolean },
): FunctionalProducer<RepositoryState> {
  return new FunctionalProducer<RepositoryState>(
    "repository",
    "git_state",
    "Git repository state",
    fetchState,
    "kernel",
  );
}

// ──────────────────────── Diagnostics producer ───────────────────────────────

export interface DiagnosticsState {
  readonly count: number;
  readonly errors: number;
  readonly warnings: number;
  readonly paths: readonly string[];
}

export function diagnosticsProducer(
  fetchDiagnostics: () => { value: DiagnosticsState; version: string; available: boolean },
): FunctionalProducer<DiagnosticsState> {
  return new FunctionalProducer<DiagnosticsState>(
    "diagnostics",
    "lsp_diagnostics",
    "Language server diagnostics",
    fetchDiagnostics,
    "kernel",
  );
}

// ──────────────────────── Jobs producer ──────────────────────────────────────

export interface JobsState {
  readonly running: number;
  readonly completed: number;
  readonly failed: number;
  readonly jobIds: Readonly<Record<string, string>>; // jobId → status
}

export function jobsProducer(
  fetchJobs: () => { value: JobsState; version: string; available: boolean },
): FunctionalProducer<JobsState> {
  return new FunctionalProducer<JobsState>(
    "jobs",
    "active_jobs",
    "Running and recently completed jobs",
    fetchJobs,
    "kernel",
  );
}

// ──────────────────────── Tests producer ─────────────────────────────────────

export interface TestsState {
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly failingNames: readonly string[];
}

export function testsProducer(
  fetchTests: () => { value: TestsState; version: string; available: boolean },
): FunctionalProducer<TestsState> {
  return new FunctionalProducer<TestsState>(
    "tests",
    "test_results",
    "Test execution results",
    fetchTests,
    "kernel",
  );
}

// ──────────────────────── Budgets producer ───────────────────────────────────

export interface BudgetsState {
  readonly modelMicrosUsed: bigint;
  readonly modelMicrosLimit: bigint;
  readonly wallClockUsedS: number;
  readonly wallClockLimitS: number;
  readonly approvalsUsed: number;
  readonly approvalsLimit: number;
}

export function budgetsProducer(
  fetchBudgets: () => { value: BudgetsState; version: string; available: boolean },
): FunctionalProducer<BudgetsState> {
  return new FunctionalProducer<BudgetsState>(
    "budget",
    "task_budget",
    "Task budget consumption",
    fetchBudgets,
    "kernel",
  );
}

// ──────────────────────── Permissions producer ───────────────────────────────

export interface PermissionsState {
  readonly activeApprovals: number;
  readonly deniedActions: readonly string[];
  readonly allowedPaths: readonly string[];
}

export function permissionsProducer(
  fetchPermissions: () => { value: PermissionsState; version: string; available: boolean },
): FunctionalProducer<PermissionsState> {
  return new FunctionalProducer<PermissionsState>(
    "permissions",
    "active_permissions",
    "Active permissions and approvals",
    fetchPermissions,
    "kernel",
  );
}

// ──────────────────────── Capabilities producer ──────────────────────────────

export interface CapabilitiesState {
  readonly activeCapabilityIds: readonly string[];
  readonly count: number;
}

export function capabilitiesProducer(
  fetchCapabilities: () => { value: CapabilitiesState; version: string; available: boolean },
): FunctionalProducer<CapabilitiesState> {
  return new FunctionalProducer<CapabilitiesState>(
    "capabilities",
    "active_capabilities",
    "Active capability descriptors",
    fetchCapabilities,
    "kernel",
  );
}

// ──────────────────────── Scope ledger producer ──────────────────────────────

export interface ScopeLedgerState {
  readonly entries: number;
  readonly writePaths: readonly string[];
  readonly externalSystems: readonly string[];
}

export function scopeLedgerProducer(
  fetchScopeLedger: () => { value: ScopeLedgerState; version: string; available: boolean },
): FunctionalProducer<ScopeLedgerState> {
  return new FunctionalProducer<ScopeLedgerState>(
    "scope",
    "scope_ledger",
    "Scope ledger entries",
    fetchScopeLedger,
    "kernel",
  );
}

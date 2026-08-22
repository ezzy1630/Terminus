/**
 * @terminus/public-api — Idempotency and Optimistic Concurrency Controller.
 *
 * Per SPEC §9.2, §16:
 * Guarantees exactly-once command settlement and optimistic concurrency
 * validation using `expected_version` and `idempotency_key`.
 */

export interface IdempotencyRecord<TResult = unknown> {
  readonly key: string;
  readonly status: "IN_FLIGHT" | "COMMITTED" | "FAILED";
  readonly result: TResult | null;
  readonly error: string | null;
  readonly aggregateVersion: number;
  readonly createdAtMs: number;
}

export class OptimisticConcurrencyError extends Error {
  readonly currentVersion: number;
  readonly expectedVersion: number;

  constructor(aggregateId: string, currentVersion: number, expectedVersion: number) {
    super(
      `optimistic concurrency conflict on aggregate ${aggregateId}: current version ${currentVersion}, expected version ${expectedVersion}`,
    );
    this.name = "OptimisticConcurrencyError";
    this.currentVersion = currentVersion;
    this.expectedVersion = expectedVersion;
  }
}

export class IdempotentExecutionConflictError extends Error {
  constructor(key: string) {
    super(`concurrent execution already in-flight for idempotency key "${key}"`);
    this.name = "IdempotentExecutionConflictError";
  }
}

export class IdempotencyController {
  private readonly records = new Map<string, IdempotencyRecord<unknown>>();
  private readonly versions = new Map<string, number>();

  /** Get or initialize aggregate version. */
  getVersion(aggregateId: string): number {
    return this.versions.get(aggregateId) ?? 0;
  }

  /** Set aggregate version. */
  setVersion(aggregateId: string, version: number): void {
    this.versions.set(aggregateId, version);
  }

  /**
   * Execute an operation under idempotency and concurrency guards.
   */
  async execute<TResult>(
    key: string,
    aggregateId: string,
    expectedVersion: number | null,
    operation: () => Promise<TResult>,
  ): Promise<{ result: TResult; cached: boolean; version: number }> {
    const existing = this.records.get(key);
    if (existing) {
      if (existing.status === "IN_FLIGHT") {
        throw new IdempotentExecutionConflictError(key);
      }
      if (existing.status === "COMMITTED") {
        return {
          result: existing.result as TResult,
          cached: true,
          version: existing.aggregateVersion,
        };
      }
      if (existing.status === "FAILED") {
        throw new Error(existing.error ?? "previous operation failed");
      }
    }

    const currentVersion = this.getVersion(aggregateId);
    if (expectedVersion !== null && expectedVersion !== currentVersion) {
      throw new OptimisticConcurrencyError(aggregateId, currentVersion, expectedVersion);
    }

    // Mark in-flight
    this.records.set(key, {
      key,
      status: "IN_FLIGHT",
      result: null,
      error: null,
      aggregateVersion: currentVersion,
      createdAtMs: Date.now(),
    });

    try {
      const result = await operation();
      const newVersion = currentVersion + 1;
      this.setVersion(aggregateId, newVersion);

      this.records.set(key, {
        key,
        status: "COMMITTED",
        result,
        error: null,
        aggregateVersion: newVersion,
        createdAtMs: Date.now(),
      });

      return { result, cached: false, version: newVersion };
    } catch (err) {
      this.records.set(key, {
        key,
        status: "FAILED",
        result: null,
        error: (err as Error).message,
        aggregateVersion: currentVersion,
        createdAtMs: Date.now(),
      });
      throw err;
    }
  }

  /** Clear all records (useful in tests). */
  clear(): void {
    this.records.clear();
    this.versions.clear();
  }
}

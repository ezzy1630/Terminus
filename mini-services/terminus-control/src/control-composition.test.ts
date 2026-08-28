/// <reference types="bun-types" />

import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import {
  artifactUriSchema,
  contentHashSchema,
  SandboxUnavailableError,
  type DelegationContractV2,
  type Rfc3339Timestamp,
} from "@terminus/domain";
import {
  DurableScopedDelegationService,
  SqliteDatabaseAdapter,
  SqliteDurableTaskRepository,
  type ScopedDelegationKernelPort,
  type SqliteDatabaseDriver,
  type SqliteStatement,
  type SqliteValue,
} from "@terminus/task-runtime";
import {
  computeUiObservationHash,
  GovernedComputerUseCoordinator,
  type ObservationReceiptVerifier,
  type TrustedObservationReceipt,
} from "@terminus/orchestration";

const NOW = "2026-08-28T00:00:00.000Z" as Rfc3339Timestamp;
const HASH = (letter: string) => contentHashSchema.parse(`sha256:${letter.repeat(64)}`);
const ARTIFACT = (letter: string) => artifactUriSchema.parse(`artifact://sha256/${letter.repeat(64)}`);

const contract = (): DelegationContractV2 => ({
  id: "delegation:task-1:scout",
  parentTaskId: "task-1",
  role: "scout",
  objective: "inspect the bounded task",
  authorityCeiling: {
    allowedOperations: ["read"],
    allowedPaths: ["packages/example/**"],
    deniedEffects: ["write", "network"],
  },
  inputHandles: [],
  expectedValue: 0.4,
  outputSchemaVersion: "2.0",
  evidenceRequirements: ["source_revision"],
  budgetMicros: 10n,
  deadline: null,
  writeIsolation: "read_only",
  returnRoute: "task://task-1/delegation-return",
});

class BunSqliteDriver implements SqliteDatabaseDriver {
  readonly database = new Database(":memory:");

  exec(sql: string): void {
    this.database.exec(sql);
  }

  query(sql: string): SqliteStatement {
    const statement = this.database.query(sql);
    return {
      get: (...parameters: SqliteValue[]) => statement.get(...parameters),
      all: (...parameters: SqliteValue[]) => statement.all(...parameters),
      run: (...parameters: SqliteValue[]) => ({ changes: statement.run(...parameters).changes }),
    };
  }

  transaction<TResult>(operation: () => TResult): TResult {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error: unknown) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

const unavailableKernel: ScopedDelegationKernelPort = {
  start: async () => {
    throw new SandboxUnavailableError("trusted delegation dispatch is unavailable");
  },
  recover: async () => {
    throw new SandboxUnavailableError("trusted delegation recovery is unavailable");
  },
};

describe("control-plane composition", () => {
  it("persists scoped admission and fails closed through restart recovery without a dispatcher", async () => {
    const driver = new BunSqliteDriver();
    const repository = new SqliteDurableTaskRepository(new SqliteDatabaseAdapter(driver));
    let idSequence = 0;
    const service = new DurableScopedDelegationService({
      repo: repository,
      kernel: unavailableKernel,
      idSource: () => `event-${++idSequence}`,
      clock: () => NOW,
      maxRecoveryAttempts: 1,
    });

    const admitted = await service.admit({
      id: "execution-1",
      taskId: "task-1",
      parentTurnId: "turn-1",
      contract: contract(),
      idempotencyKey: "delegation-1",
    });
    expect(admitted.execution.state).toBe("ADMITTED");

    const interrupted = await service.start(admitted.execution.id);
    expect(interrupted.state).toBe("INTERRUPTED");

    const recovery = await service.recoverAfterRestart("task-1");
    expect(recovery).toHaveLength(1);
    expect(recovery[0]?.outcome).toBe("manual_review");
    expect(recovery[0]?.execution.state).toBe("MANUAL_REVIEW");
    expect((await repository.getScopedDelegation("execution-1"))?.state).toBe("MANUAL_REVIEW");
    driver.database.close();
  });

  it("only admits an observation when the configured coordinator has a trusted verifier", () => {
    const observation = {
      id: "observation-1",
      sessionId: "session-1",
      taskId: "task-1",
      timestamp: NOW,
      viewport: { width: 800, height: 600, devicePixelRatio: 1, scaleFactor: 1 },
      screenshotArtifactId: null,
      domTreeArtifactId: null,
      documentUri: "https://example.test",
      accessibilityTree: [],
      focusedElementId: null,
      targetElements: [],
      taintLabel: "SYSTEM_TRUSTED" as const,
      version: 1,
    };
    const observationHash = computeUiObservationHash(observation);
    const receipt: TrustedObservationReceipt = {
      receiptId: "observation-receipt-1",
      adapterId: "trusted-browser-adapter",
      taskId: "task-1",
      observationId: observation.id,
      observationVersion: observation.version,
      observationHash,
      receiptArtifactUri: ARTIFACT("a"),
      receiptArtifactHash: HASH("a"),
      observedAt: NOW,
    };
    let verified = false;
    const verifier: ObservationReceiptVerifier = {
      verify: () => {
        verified = true;
        return true;
      },
    };
    const coordinator = new GovernedComputerUseCoordinator({
      observationReceipts: verifier,
      kernelReceipts: null,
    });

    expect(coordinator.admitTrustedObservation(observation, receipt).observationHash).toBe(observationHash);
    expect(verified).toBe(true);
    expect(() => new GovernedComputerUseCoordinator({
      observationReceipts: null,
      kernelReceipts: null,
    }).admitTrustedObservation(observation, receipt)).toThrow("verification is unavailable");
  });
});

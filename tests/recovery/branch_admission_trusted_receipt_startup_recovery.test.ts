/**
 * Trusted receipt startup recovery for candidate branches.
 *
 * The startup reconciler resolves an ADMITTING branch from a verified
 * external receipt in one transaction: ADMITTED for EXECUTED (the merge is
 * never issued again), MANUAL_REVIEW with a retained receipt for negative
 * outcomes, and fail-closed on any binding mismatch. Replay must not call
 * the external receipt source twice.
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { PrismaClient } from "@prisma/client";
import {
  reconcileAdmittingBranchWithTrustedReceipt,
  TrustedBranchAlreadyResolvedError,
  type CandidateBranchMergeReceipt,
  type CandidateBranchMergeReceiptQuery,
  type TrustedBranchReceiptEvent,
} from "../../mini-services/terminus-control/src/verification-runtime.js";

const ROOT = join(import.meta.dir, "..", "..");
const WORKSPACE_ID = "workspace-trusted-receipt-recovery";
const SESSION_ID = "session-trusted-receipt-recovery";
const THREAD_ID = "thread-trusted-receipt-recovery";
const TASK_ID = "task-trusted-receipt-recovery";
const TURN_ID = "turn-trusted-receipt-recovery";
const BRANCH_ID = "branch-trusted-receipt-recovery";

async function migrate(dbPath: string): Promise<void> {
  const child = Bun.spawn(["bun", "run", "scripts/migrate.ts"], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
    stdout: "ignore",
    stderr: "ignore",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`migration failed with exit code ${exitCode}`);
}

function seedTask(dbPath: string): void {
  const db = new Database(dbPath);
  const now = Date.now();
  try {
    db.query(
      "INSERT INTO workspaces (id, kind, root_uri, canonical_root, trust, policy_profile_id, created_at, last_opened_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(WORKSPACE_ID, "local_directory", "file:///workspace", "/workspace-trusted-receipt-recovery", "trusted", "default", now, now);
    db.query(
      "INSERT INTO sessions (id, workspace_id, owner_principal, title, status, default_model_profile, default_permission_profile, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(SESSION_ID, WORKSPACE_ID, "tester", "trusted receipt startup recovery", "active", "default", "default", "{}", now, now);
    db.query(
      "INSERT INTO threads (id, session_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run(THREAD_ID, SESSION_ID, "active", now, now);
    db.query(
      "INSERT INTO tasks (id, session_id, thread_id, status, phase, budget_json, scope_digest, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(TASK_ID, SESSION_ID, THREAD_ID, "VERIFYING", "VERIFY", "{}", `sha256:${"1".repeat(64)}`, now, now);
    db.query(
      "INSERT INTO turns (id, thread_id, task_id, sequence, state, initiating_actor) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(TURN_ID, THREAD_ID, TASK_ID, 1, "VERIFYING", "agent");
  } finally {
    db.close();
  }
}

const PROOF_DIGEST = `sha256:${"2".repeat(64)}`;
const SCOPE_DIGEST = `sha256:${"1".repeat(64)}`;

async function seedAdmittingBranch(prisma: PrismaClient, overrides: {
  readonly headRevision?: string;
  readonly baseRevision?: string;
  readonly proofDigest?: string;
} = {}): Promise<void> {
  await prisma.candidateBranch.create({
    data: {
      id: BRANCH_ID,
      taskId: TASK_ID,
      attemptId: TURN_ID,
      actorPrincipal: "agent:verification-runtime",
      worktreePath: "/workspace-trusted-receipt-recovery",
      epoch: 2,
      baseRevision: overrides.baseRevision ?? "git:source-1",
      headRevision: overrides.headRevision ?? "git:source-1",
      scopeDigest: SCOPE_DIGEST,
      effectIdsJson: "[]",
      proofJson: JSON.stringify({
        verificationPlanId: "plan-trusted-receipt-recovery",
        completionRecordDigest: overrides.proofDigest ?? PROOF_DIGEST,
        sourceRevision: overrides.headRevision ?? "git:source-1",
        environmentImageDigest: "env:trusted-receipt-recovery",
        completionExpressionSatisfied: true,
        claims: [{
          claimId: "tests.unit_passed",
          status: "SATISFIED",
          evidence: [{
            evidenceId: "e-trusted-receipt-recovery",
            artifactUri: `artifact://sha256/${"3".repeat(64)}`,
            artifactHash: `sha256:${"3".repeat(64)}`,
            sourceRevision: overrides.headRevision ?? "git:source-1",
            environmentImageDigest: "env:trusted-receipt-recovery",
            verifierResult: "pass",
          }],
        }],
      }),
      mergeReceiptJson: null,
      status: "ADMITTING",
    },
  });
}

function fakeReceipt(branch: {
  readonly branchId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly actorPrincipal: string;
  readonly baseRevision: string;
  readonly headRevision: string;
  readonly scopeDigest: string;
}, options: {
  readonly status: "EXECUTED" | "NOT_EXECUTED" | "AMBIGUOUS";
  readonly proofDigest?: string;
  readonly taskIdOverride?: string;
}): CandidateBranchMergeReceipt {
  const artifactHash = "a".repeat(64);
  const executed = options.status === "EXECUTED";
  return {
    status: options.status,
    operationId: `completion-admission:${branch.branchId}`,
    receiptArtifactUri: `artifact://sha256/${artifactHash}`,
    receiptArtifactHash: `sha256:${artifactHash}`,
    branchId: branch.branchId,
    taskId: options.taskIdOverride ?? branch.taskId,
    attemptId: branch.attemptId,
    actorPrincipal: branch.actorPrincipal,
    baseRevision: branch.baseRevision,
    candidateHeadRevision: branch.headRevision,
    scopeDigest: branch.scopeDigest,
    completionRecordDigest: options.proofDigest ?? PROOF_DIGEST,
    mergeId: executed ? `merge:${branch.branchId}` : null,
    authoritativeRevision: executed ? "git:source-2" : null,
  };
}

interface Harness {
  readonly prisma: PrismaClient;
  readonly cleanup: () => Promise<void>;
  readonly events: TrustedBranchReceiptEvent[];
  makeQuery: (receipt: CandidateBranchMergeReceipt) => CandidateBranchMergeReceiptQuery & { calls: () => number };
}

async function openHarness(): Promise<Harness> {
  const testDir = join(tmpdir(), `terminus-trusted-receipt-${randomUUID()}`);
  mkdirSync(testDir, { recursive: true });
  const dbPath = join(testDir, "test.db");
  await migrate(dbPath);
  seedTask(dbPath);
  const prisma = new PrismaClient({ datasources: { db: { url: `file:${dbPath}` } } });
  const events: TrustedBranchReceiptEvent[] = [];
  return {
    prisma,
    events,
    cleanup: async () => {
      await prisma.$disconnect();
      rmSync(testDir, { recursive: true, force: true });
    },
    makeQuery(receipt) {
      let calls = 0;
      return {
        calls: () => calls,
        getMergeReceipt: async () => {
          calls += 1;
          return receipt;
        },
      };
    },
  };
}

function emitCapture(prisma: PrismaClient, events: TrustedBranchReceiptEvent[]) {
  return async <T>(
    event: TrustedBranchReceiptEvent,
    mutation: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<unknown> => {
    events.push(event);
    return prisma.$transaction(mutation);
  };
}

describe("Trusted receipt startup recovery", () => {
  test("commits an executed receipt into ADMITTED once and replays without a second query", async () => {
    const harness = await openHarness();
    const { prisma } = harness;
    try {
      await seedAdmittingBranch(prisma);
      const query = harness.makeQuery(
        fakeReceipt({
          branchId: BRANCH_ID,
          taskId: TASK_ID,
          attemptId: TURN_ID,
          actorPrincipal: "agent:verification-runtime",
          baseRevision: "git:source-1",
          headRevision: "git:source-1",
          scopeDigest: SCOPE_DIGEST,
        }, { status: "EXECUTED" }),
      );
      const events: TrustedBranchReceiptEvent[] = [];
      const disposition = await reconcileAdmittingBranchWithTrustedReceipt(
        prisma,
        BRANCH_ID,
        query,
        emitCapture(prisma, events),
      );
      expect(disposition).toEqual({
        outcome: "ADMITTED",
        branchId: BRANCH_ID,
        authoritativeRevision: "git:source-2",
      });
      expect(query.calls()).toBe(1);
      expect(events).toHaveLength(1);
      expect(events[0]?.eventType).toBe("recovery.reconciled");

      const persisted = await prisma.candidateBranch.findUnique({ where: { id: BRANCH_ID } });
      expect(persisted?.status).toBe("ADMITTED");
      expect(persisted?.epoch).toBe(3);
      expect(persisted?.headRevision).toBe("git:source-2");
      expect(JSON.parse(persisted?.mergeReceiptJson ?? "null")).toMatchObject({
        status: "EXECUTED",
        mergeId: `merge:${BRANCH_ID}`,
      });
      const task = await prisma.task.findUnique({ where: { id: TASK_ID } });
      expect(task?.status).toBe("VERIFYING");

      const replay = await reconcileAdmittingBranchWithTrustedReceipt(
        prisma,
        BRANCH_ID,
        query,
        emitCapture(prisma, events),
      );
      expect(replay).toEqual({ outcome: "ALREADY_RESOLVED", branchId: BRANCH_ID });
      expect(query.calls()).toBe(1);
      expect(events).toHaveLength(1);
    } finally {
      await harness.cleanup();
    }
  });

  test("retains a NOT_EXECUTED receipt in MANUAL_REVIEW, blocks the task, and emits one semantic event", async () => {
    const harness = await openHarness();
    const { prisma } = harness;
    try {
      await seedAdmittingBranch(prisma);
      const query = harness.makeQuery(
        fakeReceipt({
          branchId: BRANCH_ID,
          taskId: TASK_ID,
          attemptId: TURN_ID,
          actorPrincipal: "agent:verification-runtime",
          baseRevision: "git:source-1",
          headRevision: "git:source-1",
          scopeDigest: SCOPE_DIGEST,
        }, { status: "NOT_EXECUTED" }),
      );
      const events: TrustedBranchReceiptEvent[] = [];
      const disposition = await reconcileAdmittingBranchWithTrustedReceipt(
        prisma,
        BRANCH_ID,
        query,
        emitCapture(prisma, events),
      );
      expect(disposition).toEqual({ outcome: "MANUAL_REVIEW", branchId: BRANCH_ID });
      expect(query.calls()).toBe(1);
      expect(events).toHaveLength(1);
      expect(events[0]?.eventType).toBe("candidate_branch.recovery_manual_review");

      const persisted = await prisma.candidateBranch.findUnique({ where: { id: BRANCH_ID } });
      expect(persisted?.status).toBe("MANUAL_REVIEW");
      expect(persisted?.epoch).toBe(3);
      expect(JSON.parse(persisted?.mergeReceiptJson ?? "null")).toMatchObject({
        status: "NOT_EXECUTED",
        mergeId: null,
        authoritativeRevision: null,
      });
      const task = await prisma.task.findUnique({ where: { id: TASK_ID } });
      expect(task?.status).toBe("BLOCKED");
      expect(JSON.parse(task?.terminalReasonJson ?? "{}")).toMatchObject({
        reason: "candidate_branch_admission_recovery_required",
      });

      const replay = await reconcileAdmittingBranchWithTrustedReceipt(
        prisma,
        BRANCH_ID,
        query,
        emitCapture(prisma, events),
      );
      expect(replay).toEqual({ outcome: "ALREADY_RESOLVED", branchId: BRANCH_ID });
      expect(query.calls()).toBe(1);
      expect(events).toHaveLength(1);
    } finally {
      await harness.cleanup();
    }
  });

  test("fails closed on a mismatched receipt binding without any transition", async () => {
    const harness = await openHarness();
    const { prisma } = harness;
    try {
      await seedAdmittingBranch(prisma);
      const query = harness.makeQuery(
        fakeReceipt({
          branchId: BRANCH_ID,
          taskId: TASK_ID,
          attemptId: TURN_ID,
          actorPrincipal: "agent:verification-runtime",
          baseRevision: "git:source-1",
          headRevision: "git:source-1",
          scopeDigest: SCOPE_DIGEST,
        }, { status: "EXECUTED", taskIdOverride: "task-other" }),
      );
      const events: TrustedBranchReceiptEvent[] = [];
      let threw = false;
      try {
        await reconcileAdmittingBranchWithTrustedReceipt(
          prisma,
          BRANCH_ID,
          query,
          emitCapture(prisma, events),
        );
      } catch (error) {
        threw = true;
        expect(error).not.toBeInstanceOf(TrustedBranchAlreadyResolvedError);
      }
      expect(threw).toBe(true);
      expect(events).toHaveLength(0);
      const persisted = await prisma.candidateBranch.findUnique({ where: { id: BRANCH_ID } });
      expect(persisted?.status).toBe("ADMITTING");
      expect(persisted?.epoch).toBe(2);
      expect(persisted?.mergeReceiptJson).toBeNull();
      const task = await prisma.task.findUnique({ where: { id: TASK_ID } });
      expect(task?.status).toBe("VERIFYING");
    } finally {
      await harness.cleanup();
    }
  });

  test("fails closed on a mismatched completion-record digest", async () => {
    const harness = await openHarness();
    const { prisma } = harness;
    try {
      await seedAdmittingBranch(prisma);
      const query = harness.makeQuery(
        fakeReceipt({
          branchId: BRANCH_ID,
          taskId: TASK_ID,
          attemptId: TURN_ID,
          actorPrincipal: "agent:verification-runtime",
          baseRevision: "git:source-1",
          headRevision: "git:source-1",
          scopeDigest: SCOPE_DIGEST,
        }, { status: "EXECUTED", proofDigest: `sha256:${"9".repeat(64)}` }),
      );
      const events: TrustedBranchReceiptEvent[] = [];
      let threw = false;
      try {
        await reconcileAdmittingBranchWithTrustedReceipt(
          prisma,
          BRANCH_ID,
          query,
          emitCapture(prisma, events),
        );
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
      expect(events).toHaveLength(0);
      const persisted = await prisma.candidateBranch.findUnique({ where: { id: BRANCH_ID } });
      expect(persisted?.status).toBe("ADMITTING");
    } finally {
      await harness.cleanup();
    }
  });
});

// The emit capture wraps prisma.$transaction directly: the reconciler only
// relies on the transactional execution of its mutation; the durable event
// bus is simulated by the caller that records the event first.

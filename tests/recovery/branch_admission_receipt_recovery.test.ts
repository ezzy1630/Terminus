/**
 * Prisma-backed candidate-branch receipt recovery.
 *
 * A trusted external receipt can finish an ADMITTING branch after restart,
 * but the same receipt query must never issue the merge again or accept a
 * mismatched operation identity.
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { PrismaClient } from "@prisma/client";
import { createPrismaCompletionAdmission } from "../../mini-services/terminus-control/src/verification-runtime.js";

const ROOT = join(import.meta.dir, "..", "..");
const WORKSPACE_ID = "workspace-branch-receipt-recovery";
const SESSION_ID = "session-branch-receipt-recovery";
const THREAD_ID = "thread-branch-receipt-recovery";
const TASK_ID = "task-branch-receipt-recovery";
const TURN_ID = "turn-branch-receipt-recovery";
const BRANCH_ID = "branch-branch-receipt-recovery";

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
    ).run(WORKSPACE_ID, "local_directory", "file:///workspace", "/workspace-branch-receipt-recovery", "trusted", "default", now, now);
    db.query(
      "INSERT INTO sessions (id, workspace_id, owner_principal, title, status, default_model_profile, default_permission_profile, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(SESSION_ID, WORKSPACE_ID, "tester", "branch receipt recovery", "active", "default", "default", "{}", now, now);
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

describe("Prisma-backed candidate branch receipt recovery", () => {
  test("persists an executed receipt and recovers the branch once", async () => {
    const testDir = join(tmpdir(), `terminus-branch-receipt-${randomUUID()}`);
    mkdirSync(testDir, { recursive: true });
    const dbPath = join(testDir, "test.db");
    const proofDigest = `sha256:${"2".repeat(64)}`;
    const scopeDigest = `sha256:${"1".repeat(64)}`;
    const artifactHash = "a".repeat(64);
    let queryCalls = 0;

    await migrate(dbPath);
    seedTask(dbPath);
    const prisma = new PrismaClient({ datasources: { db: { url: `file:${dbPath}` } } });
    try {
      const admission = createPrismaCompletionAdmission(
        prisma,
        async () => "git:source-1",
        {
          getMergeReceipt: async (branch) => {
            queryCalls += 1;
            return {
              status: "EXECUTED",
              operationId: `completion-admission:${branch.branchId}`,
              receiptArtifactUri: `artifact://sha256/${artifactHash}`,
              receiptArtifactHash: `sha256:${artifactHash}`,
              branchId: branch.branchId,
              taskId: branch.taskId,
              attemptId: branch.attemptId,
              actorPrincipal: branch.actorPrincipal,
              baseRevision: branch.baseRevision,
              candidateHeadRevision: branch.headRevision,
              scopeDigest: branch.scopeDigest,
              completionRecordDigest: proofDigest,
              mergeId: `merge:${branch.branchId}`,
              authoritativeRevision: "git:source-2",
            };
          },
        },
      );
      await admission.registerCandidateBranch({
        branchId: BRANCH_ID,
        taskId: TASK_ID,
        attemptId: TURN_ID,
        actorPrincipal: "agent:verification-runtime",
        worktreePath: "/workspace-branch-receipt-recovery",
        epoch: 1,
        baseRevision: "git:source-1",
        headRevision: "git:source-1",
        scopeDigest,
        effectIds: [],
        proof: {
          verificationPlanId: "plan-branch-receipt-recovery",
          completionRecordDigest: proofDigest,
          sourceRevision: "git:source-1",
          environmentImageDigest: "env:branch-receipt-recovery",
          completionExpressionSatisfied: true,
          claims: [{
            claimId: "tests.unit_passed",
            status: "SATISFIED",
            evidence: [{
              evidenceId: "e-branch-receipt-recovery",
              artifactUri: `artifact://sha256/${"3".repeat(64)}`,
              artifactHash: `sha256:${"3".repeat(64)}`,
              sourceRevision: "git:source-1",
              environmentImageDigest: "env:branch-receipt-recovery",
              verifierResult: "pass",
            }],
          }],
        },
        status: "OPEN",
      });
      const claimed = await prisma.candidateBranch.updateMany({
        where: { id: BRANCH_ID, epoch: 1, status: "OPEN" },
        data: { epoch: { increment: 1 }, status: "ADMITTING" },
      });
      expect(claimed.count).toBe(1);

      const recovered = await admission.reconcileAdmittingBranch(BRANCH_ID);
      expect(recovered).toEqual({
        disposition: "ADMITTED",
        committedEffects: [],
        authoritativeRevision: "git:source-2",
      });
      expect(queryCalls).toBe(1);

      const persisted = await prisma.candidateBranch.findUnique({ where: { id: BRANCH_ID } });
      expect(persisted?.status).toBe("ADMITTED");
      expect(persisted?.epoch).toBe(3);
      expect(JSON.parse(persisted?.mergeReceiptJson ?? "null")).toMatchObject({
        status: "EXECUTED",
        operationId: `completion-admission:${BRANCH_ID}`,
        authoritativeRevision: "git:source-2",
      });
      expect(await admission.reconcileAdmittingBranch(BRANCH_ID)).toMatchObject({
        disposition: "ALREADY_RESOLVED",
      });
      expect(queryCalls).toBe(1);
    } finally {
      await prisma.$disconnect();
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});

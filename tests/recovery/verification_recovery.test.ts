import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { createVerifierBinding, VerificationEngine, type VerificationResult } from "@terminus/verification";
import { verificationPlanFromPrisma, verificationResultFromPrisma } from "../../mini-services/terminus-control/src/verification-runtime.js";

const ROOT = join(import.meta.dir, "..", "..");

async function migrate(dbPath: string): Promise<void> {
  const child = Bun.spawn(["bun", "run", "scripts/migrate.ts"], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
    stdout: "ignore",
    stderr: "ignore",
  });
  expect(await child.exited).toBe(0);
}

describe("verification recovery", () => {
  test("rebuilds durable result identity and runs only missing nodes", async () => {
    const testDir = join(tmpdir(), `terminus-verification-recovery-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    const dbPath = join(testDir, "test.db");
    const taskId = "task-verification-recovery";
    const planId = "plan-verification-recovery";
    const now = Date.now();

    try {
      await migrate(dbPath);
      const db = new Database(dbPath);
      db.exec("PRAGMA foreign_keys = ON");
      db.query(
        "INSERT INTO workspaces (id, kind, root_uri, canonical_root, trust, policy_profile_id, created_at, last_opened_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run("workspace-verification", "local_directory", "file:///workspace", "/workspace", "trusted", "default", now, now);
      db.query(
        "INSERT INTO sessions (id, workspace_id, owner_principal, title, status, default_model_profile, default_permission_profile, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run("session-verification", "workspace-verification", "tester", "verification", "active", "default", "default", "{}", now, now);
      db.query(
        "INSERT INTO threads (id, session_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ).run("thread-verification", "session-verification", "active", now, now);
      db.query(
        "INSERT INTO tasks (id, session_id, thread_id, status, phase, budget_json, scope_digest, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(taskId, "session-verification", "thread-verification", "VERIFYING", "VERIFY", "{}", "sha256:scope", now, now);
      db.query(
        "INSERT INTO verification_plans (id, task_id, contract_version, source_revision, environment_digest, completion_expression, plan_artifact, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(planId, taskId, 1, "git:recovery-revision", "env:recovery", "settled && missing", "artifact://sha256/" + "a".repeat(64), now);
      const nodeSpec = JSON.stringify({ predicateType: "unit_test", paths: ["."], observations: {} });
      db.query(
        "INSERT INTO verification_nodes (id, plan_id, kind, required, specification_json, timeout_ms, retry_policy_json, acceptance_criterion_id, depends_on_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run("settled", planId, "command", 1, nodeSpec, 30_000, JSON.stringify({ maxAttempts: 1, backoffMs: 0, flakeIdentity: null }), null, "[]");
      db.query(
        "INSERT INTO verification_nodes (id, plan_id, kind, required, specification_json, timeout_ms, retry_policy_json, acceptance_criterion_id, depends_on_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run("missing", planId, "command", 1, nodeSpec, 30_000, JSON.stringify({ maxAttempts: 1, backoffMs: 0, flakeIdentity: null }), null, "[\"settled\"]");
      db.query(
        "INSERT INTO verification_edges (plan_id, from_node_id, to_node_id, kind) VALUES (?, ?, ?, ?)",
      ).run(planId, "settled", "missing", "depends");

      const plan = verificationPlanFromPrisma({
        id: planId,
        taskId,
        contractVersion: 1,
        sourceRevision: "git:recovery-revision",
        environmentDigest: "env:recovery",
        completionExpression: "settled && missing",
        planArtifact: "artifact://sha256/" + "a".repeat(64),
        createdAt: new Date(now),
        nodes: [
          {
            id: "settled",
            kind: "command",
            required: true,
            specificationJson: nodeSpec,
            timeoutMs: 30_000,
            retryPolicyJson: JSON.stringify({ maxAttempts: 1, backoffMs: 0, flakeIdentity: null }),
            acceptanceCriterionId: null,
            dependsOnJson: "[]",
          },
          {
            id: "missing",
            kind: "command",
            required: true,
            specificationJson: nodeSpec,
            timeoutMs: 30_000,
            retryPolicyJson: JSON.stringify({ maxAttempts: 1, backoffMs: 0, flakeIdentity: null }),
            acceptanceCriterionId: null,
            dependsOnJson: "[\"settled\"]",
          },
        ],
        edges: [{ fromNodeId: "settled", toNodeId: "missing", kind: "depends" }],
      });
      expect(plan).not.toBeNull();
      const binding = createVerifierBinding(plan!);
      const settledResultJson = JSON.stringify({
        verificationBinding: binding,
      });
      db.query(
        `INSERT INTO verification_results (
          id, plan_id, node_id, attempt, status, source_revision,
          environment_digest, exit_code, command_or_query,
          structured_observations_json, artifacts_json, verifier_version,
          started_at, completed_at, reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "result-settled",
        planId,
        "settled",
        1,
        "pass",
        "git:recovery-revision",
        "env:recovery",
        0,
        nodeSpec,
        settledResultJson,
        "[]",
        binding.verifierVersion,
        now,
        now,
        null,
      );

      const columns = db.query("PRAGMA table_info(verification_results)").all() as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
        "exit_code",
        "command_or_query",
        "structured_observations_json",
        "artifacts_json",
        "verifier_version",
      ]));
      const row = db.query(
        "SELECT id, plan_id AS planId, node_id AS nodeId, attempt, status, source_revision AS sourceRevision, environment_digest AS environmentDigest, exit_code AS exitCode, command_or_query AS commandOrQuery, structured_observations_json AS structuredObservationsJson, artifacts_json AS artifactsJson, verifier_version AS verifierVersion, evidence_artifact AS evidenceArtifact, tool_call_id AS toolCallId, started_at AS startedAt, completed_at AS completedAt, reason FROM verification_results WHERE plan_id = ? AND node_id = ?",
      ).get(planId, "settled") as {
        id: string;
        planId: string;
        nodeId: string;
        attempt: number;
        status: string;
        sourceRevision: string;
        environmentDigest: string;
        exitCode: number | null;
        commandOrQuery: string | null;
        structuredObservationsJson: string | null;
        artifactsJson: string | null;
        verifierVersion: string | null;
        evidenceArtifact: string | null;
        toolCallId: string | null;
        startedAt: Date;
        completedAt: Date | null;
        reason: string | null;
      };
      const settled = verificationResultFromPrisma({
        ...row,
        startedAt: new Date(Number(row.startedAt)),
        completedAt: row.completedAt === null ? null : new Date(Number(row.completedAt)),
      });
      expect(settled).not.toBeNull();

      const executed: string[] = [];
      const engine = new VerificationEngine({
        executorFor: () => ({
          async execute(input): Promise<VerificationResult> {
            executed.push(input.node.id);
            return {
              id: "result-missing" as VerificationResult["id"],
              planId: planId as VerificationResult["planId"],
              nodeId: input.node.id,
              status: "pass",
              startedAt: new Date(now).toISOString() as VerificationResult["startedAt"],
              completedAt: new Date(now).toISOString() as VerificationResult["completedAt"],
              sourceRevision: "git:recovery-revision",
              environmentImageDigest: "env:recovery",
              commandOrQuery: nodeSpec,
              exitCode: 0,
              structuredObservations: { verificationBinding: binding },
              artifacts: [],
              toolCallId: null,
              verifierVersion: binding.verifierVersion,
              reasonIfSkipped: null,
              attempts: 1,
            };
          },
        }),
        idSource: () => "result-generated" as VerificationResult["id"],
        clock: () => new Date(now).toISOString() as VerificationResult["startedAt"],
      });
      const evaluation = await engine.evaluate(plan!, "git:recovery-revision", null, {
        environmentImageDigest: "env:recovery",
        resumeResults: [settled!],
      });
      expect(executed).toEqual(["missing"]);
      expect(evaluation.allRequiredPassed).toBe(true);
      expect(evaluation.results.map((result) => result.nodeId).sort()).toEqual(["missing", "settled"]);
      db.close();
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});

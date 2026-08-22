/**
 * @terminus/testkit — ARP v2 Conformance Test Kit and Leak Validator.
 *
 * Per SPEC §9.2, §42.5, §43:
 * Verifies protocol conformance, expected-version concurrency, command idempotency,
 * stream resumption, and architectural purity (no OpenCode type leaks in canonical API).
 */
import { describe, expect, test } from "bun:test";
import { ArpV2FixtureServer } from "./arp_v2_fixture_server.js";
import { CursorCodec, eventEnvelopeV2Schema, commandEnvelopeSchema } from "@terminus/runtime-protocol";
import { generateUuid7, nowTimestamp } from "@terminus/domain";

export function runArpV2ConformanceSuite(): void {
  describe("ARP v2 Conformance Suite", () => {
    test("End-to-end task execution and effect settlement via ARP v2", async () => {
      const server = new ArpV2FixtureServer();

      // 1. Create Task
      const { task, cursor } = await server.createTask({
        idempotencyKey: "cmd-task-1",
        contract: {
          version: 1,
          mission: "Test task via ARP v2",
          scope: { resources: [], allowedEffectClasses: ["LOCAL_FS_WRITE"], excludedPathsOrSystems: [] },
          acceptance: [{ claimId: "c-1", statement: "Passed", evidenceRequirement: "TEST" }],
          constraints: { security: [], costMicros: 1000000n, timeoutSeconds: 60 },
          authorityCeiling: ["FS_WRITE"],
          mode: "interactive",
        },
      });

      expect(task.status).toBe("DRAFT");
      expect(task.version).toBe(1);

      // 2. Start Task (DRAFT -> READY -> RUNNING)
      const readyTask = await server.transitionTask({
        taskId: task.id,
        targetStatus: "READY",
        idempotencyKey: "cmd-ready-1",
      });
      expect(readyTask.status).toBe("READY");

      const runningTask = await server.transitionTask({
        taskId: task.id,
        targetStatus: "RUNNING",
        idempotencyKey: "cmd-run-1",
      });
      expect(runningTask.status).toBe("RUNNING");

      // 3. Propose Effect
      const effect = await server.proposeEffect({
        taskId: task.id,
        attemptId: "att-1",
        connectorOrWorker: "worker-local",
        intentType: "patch_file",
        canonicalParameters: { file: "test.ts" },
        effectClass: "LOCAL_FS_WRITE",
        semanticIdempotencyKey: "eff-key-1",
      });
      expect(effect.state).toBe("PROPOSED");

      // 4. Policy Check & Authorize Effect
      const checkedEff = await server.transitionEffect({
        effectId: effect.id,
        targetState: "POLICY_CHECKED",
        idempotencyKey: "cmd-eff-check-1",
      });
      expect(checkedEff.state).toBe("POLICY_CHECKED");

      const authEff = await server.transitionEffect({
        effectId: effect.id,
        targetState: "AUTHORIZED",
        idempotencyKey: "cmd-eff-auth-1",
      });
      expect(authEff.state).toBe("AUTHORIZED");

      // 5. Prepare, Dispatch, Observe, Validate, Commit
      const prepEff = await server.transitionEffect({
        effectId: effect.id,
        targetState: "PREPARED",
        idempotencyKey: "cmd-eff-prep-1",
      });
      const dispEff = await server.transitionEffect({
        effectId: effect.id,
        targetState: "DISPATCHED",
        idempotencyKey: "cmd-eff-disp-1",
      });
      const obsEff = await server.transitionEffect({
        effectId: effect.id,
        targetState: "OBSERVED",
        idempotencyKey: "cmd-eff-obs-1",
      });
      const valEff = await server.transitionEffect({
        effectId: effect.id,
        targetState: "VALIDATED",
        idempotencyKey: "cmd-eff-val-1",
      });
      const commitEff = await server.transitionEffect({
        effectId: effect.id,
        targetState: "COMMITTED",
        idempotencyKey: "cmd-eff-commit-1",
      });

      expect(commitEff.state).toBe("COMMITTED");
      expect(commitEff.settledAt).not.toBeNull();

      // 6. Complete Task
      const completedTask = await server.transitionTask({
        taskId: task.id,
        targetStatus: "COMPLETED",
        idempotencyKey: "cmd-complete-1",
      });
      expect(completedTask.status).toBe("COMPLETED");

      // 7. Verify Resumable Stream
      const allEvents = server.getEventsSince(null);
      expect(allEvents.events.length).toBeGreaterThan(5);

      const eventsSinceCursor = server.getEventsSince(cursor);
      expect(eventsSinceCursor.events.length).toBe(allEvents.events.length - 1);
    });

    test("Idempotency: duplicate commands return cached results without side effects", async () => {
      const server = new ArpV2FixtureServer();
      const contract = {
        version: 1,
        mission: "Idempotent task",
        scope: { resources: [], allowedEffectClasses: [], excludedPathsOrSystems: [] },
        acceptance: [],
        constraints: { security: [], costMicros: 0n, timeoutSeconds: 10 },
        authorityCeiling: [],
        mode: "interactive",
      };

      const res1 = await server.createTask({ contract, idempotencyKey: "idem-dup-key" });
      const res2 = await server.createTask({ contract, idempotencyKey: "idem-dup-key" });

      expect(res1.task.id).toBe(res2.task.id);
      expect(server.events.filter((e) => e.eventType === "task.created").length).toBe(1);
    });

    test("Optimistic Concurrency: rejects stale expected_version", async () => {
      const server = new ArpV2FixtureServer();
      const { task } = await server.createTask({
        idempotencyKey: "idem-occ-1",
        contract: {
          version: 1,
          mission: "OCC task",
          scope: { resources: [], allowedEffectClasses: [], excludedPathsOrSystems: [] },
          acceptance: [],
          constraints: { security: [], costMicros: 0n, timeoutSeconds: 10 },
          authorityCeiling: [],
          mode: "interactive",
        },
      });

      // Valid transition with expectedVersion 1
      await server.transitionTask({
        taskId: task.id,
        targetStatus: "READY",
        idempotencyKey: "idem-occ-2",
        expectedVersion: 1,
      });

      // Attempting next transition with stale version 1 instead of 2 should fail
      await expect(
        server.transitionTask({
          taskId: task.id,
          targetStatus: "RUNNING",
          idempotencyKey: "idem-occ-3",
          expectedVersion: 1, // Stale!
        }),
      ).rejects.toThrow();
    });

    test("Architectural Purity: no OpenCode internal type leaks in canonical API packages", async () => {
      const Domain = await import("@terminus/domain");
      const Protocol = await import("@terminus/runtime-protocol");
      const PublicApi = await import("@terminus/public-api");

      const allExportNames = [
        ...Object.keys(Domain),
        ...Object.keys(Protocol),
        ...Object.keys(PublicApi),
      ];

      const forbiddenSubstrings = ["opencode", "open_code"];
      for (const name of allExportNames) {
        for (const sub of forbiddenSubstrings) {
          expect(name.toLowerCase().includes(sub)).toBe(false);
        }
      }
    });
  });
}


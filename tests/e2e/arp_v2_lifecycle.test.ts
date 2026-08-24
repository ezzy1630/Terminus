/**
 * Live ARP v2 client-parity E2E (Phase 1 exit gate).
 *
 * Exit gate under test: "CLI and one graphical client use ARP v2 for the
 * same task." This suite drives ONE canonical v2 task through BOTH clients
 * against a LIVE control-plane HTTP/SSE daemon:
 *
 *   1. CLI (`apps/cli`, `new-task-v2` + `transition-task-v2` + effect
 *      commands) creates and advances the task.
 *   2. The graphical client's real adapter module (`apps/desktop`
 *      `lib/api-v2.ts`) reads the same task over `/v2/tasks/:id`,
 *      subscribes to `/v2/events` SSE, and proposes an effect.
 *   3. Cross-checks: each client observes the other's proposals on the same
 *      aggregate id, and the server rejects state advancement without a
 *      trusted receipt (no per-client state or success-shaped fallback).
 *
 * The harness (`scripts/e2e/deterministic.sh`) owns process supervision:
 * it exports TERMINUS_E2E_CONTROL_URL / TERMINUS_E2E_CONTROL_TOKEN after
 * booting kernel + control plane. When those variables are absent the
 * suite skips, so plain `bun test tests/` never touches the network.
 */
import { describe, expect, test } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { ArpV2EventEnvelope } from "../../apps/desktop/src/types/v2";
import type { TerminusArpV2Client } from "../../apps/desktop/src/lib/api-v2";

const CONTROL_URL = process.env.TERMINUS_E2E_CONTROL_URL ?? "";
const CONTROL_TOKEN = process.env.TERMINUS_E2E_CONTROL_TOKEN ?? "";
const ENABLED = CONTROL_URL.length > 0 && CONTROL_TOKEN.length > 0;
const ROOT = `${import.meta.dir}/../..`;

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Spawn the real CLI against the live control plane. */
function cli(args: string[], timeoutMs = 30_000): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child: ChildProcessWithoutNullStreams = spawn(
      process.execPath,
      [`${ROOT}/apps/cli/src/index.ts`, ...args],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          // The CLI targets the gateway; pointing it straight at the control
          // plane works because handlers ignore the XTransformPort param.
          TERMINUS_GATEWAY: CONTROL_URL,
          TERMINUS_TOKEN: CONTROL_TOKEN,
        },
      },
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`cli ${args[0]} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

function cliJson<T>(result: CliResult): T {
  if (result.code !== 0) {
    throw new Error(`CLI failed (${result.code}): ${result.stderr.slice(0, 500)}`);
  }
  const start = result.stdout.indexOf("{");
  if (start < 0) throw new Error(`CLI produced no JSON object: ${result.stdout.slice(0, 200)}`);
  return JSON.parse(result.stdout.slice(start)) as T;
}

/** Wait until the desktop SSE stream observes an envelope matching `predicate`. */
function waitForEnvelope(
  stream: { addEventListener: (type: "message", handler: (envelope: ArpV2EventEnvelope) => void) => () => void },
  predicate: (envelope: ArpV2EventEnvelope) => boolean,
  deadlineMs = 10_000,
): Promise<ArpV2EventEnvelope> {
  return new Promise((resolve, reject) => {
    const unsubscribe = stream.addEventListener("message", (envelope) => {
      if (!predicate(envelope)) return;
      cleanup();
      resolve(envelope);
    });
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("timed out waiting for envelope"));
    }, deadlineMs);
    function cleanup(): void {
      clearTimeout(timer);
      unsubscribe();
    }
  });
}

const describeLive = ENABLED ? describe : describe.skip;

describeLive("ARP v2 live lifecycle — CLI ↔ graphical client parity", () => {
  const OBJECTIVE = "e2e arp-v2 parity: drive one task through both clients";

  // Shared across the ordered steps below (single lifecycle, two clients).
  let taskId = "";
  let cliEffectId = "";
  let desktopProposedEffectId = "";
  let desktopClient: TerminusArpV2Client | null = null;

  async function loadDesktopAdapter(): Promise<TerminusArpV2Client> {
    if (!desktopClient) {
      const { TerminusArpV2Client: Client } = await import("../../apps/desktop/src/lib/api-v2.ts");
      desktopClient = new Client({ baseUrl: CONTROL_URL, token: CONTROL_TOKEN });
    }
    return desktopClient;
  }

  test("v2 health reports protocol version 2", async () => {
    const desktop = await loadDesktopAdapter();
    const health = await desktop.health();
    expect(health.protocolVersion).toBe(2);
  });

  test("CLI creates a canonical task; graphical client sees the same aggregate id", async () => {
    const created = cliJson<{ id: string; status: string; contract: { mission: string } }>(
      await cli(["new-task-v2", "--objective", OBJECTIVE]),
    );
    taskId = created.id;
    expect(created.status).toBe("DRAFT");

    const seenByDesktop = await (await loadDesktopAdapter()).getTask(taskId);
    expect(seenByDesktop).not.toBeNull();
    expect(seenByDesktop?.contract.mission).toBe(OBJECTIVE);
    expect(seenByDesktop?.status).toBe("DRAFT");
    expect(seenByDesktop?.version).toBe(1);
  });

  test("graphical adapter subscribes /v2/events and observes the CLI-driven task transitions", async () => {
    expect(taskId).not.toBe("");
    const { subscribeEventsV2 } = await import("../../apps/desktop/src/lib/api-v2.ts");
    const stream = subscribeEventsV2({ taskId, baseUrl: CONTROL_URL, token: CONTROL_TOKEN });

    // Drive READY → RUNNING via the CLI while the graphical stream listens.
    const readyPromise = waitForEnvelope(stream, (ev) => ev.eventType === "task.ready" && ev.aggregateId === taskId);
    cliJson(await cli(["transition-task-v2", taskId, "--status", "READY"]));
    const readyEvent = await readyPromise;
    expect(readyEvent.schemaVersion).toBe(2);

    const runningPromise = waitForEnvelope(stream, (ev) => ev.eventType === "task.running" && ev.aggregateId === taskId);
    cliJson(await cli(["transition-task-v2", taskId, "--status", "RUNNING"]));
    await runningPromise;

    const snapshot = await (await loadDesktopAdapter()).getTask(taskId);
    expect(snapshot?.status).toBe("RUNNING");
    expect(snapshot?.version).toBe(3);
    stream.close();
  });

  test("CLI proposes an effect; graphical client sees the same PROPOSED ledger record", async () => {
    expect(taskId).not.toBe("");
    const proposed = cliJson<{ id: string; state: string; taskId: string }>(
      await cli(["propose-effect", "--task", taskId, "--class", "LOCAL_FS_WRITE", "--intent", "write_file"]),
    );
    cliEffectId = proposed.id;
    expect(proposed.state).toBe("PROPOSED");
    expect(proposed.taskId).toBe(taskId);

    const desktop = await loadDesktopAdapter();
    const visibleToDesktop = await desktop.listEffects(taskId);
    expect(visibleToDesktop.some((effect) => effect.id === cliEffectId)).toBe(true);
  });

  test("graphical client proposal remains PROPOSED without trusted receipts", async () => {
    expect(taskId).not.toBe("");
    const desktop = await loadDesktopAdapter();

    // Either client may submit a semantic proposal. Neither may manufacture
    // the receipts required to advance the authoritative state machine.
    const effect = await desktop.proposeEffect({
      taskId,
      intentType: "run_tests",
      effectClass: "LOCAL_PROCESS_SPAWN",
      canonicalParameters: { command: "bun test" },
    }, { idempotencyKey: `desktop-effect:${taskId}` });
    expect(effect.state).toBe("PROPOSED");
    desktopProposedEffectId = effect.id;

    const rejected = await cli([
      "advance-effect",
      effect.id,
      "--to",
      "POLICY_CHECKED",
      "--expected-version",
      String(effect.version),
    ]);
    expect(rejected.code).not.toBe(0);
    expect(rejected.stderr).toContain("EXTERNAL_DEPENDENCY_FAILED");

    const visibleToDesktop = await desktop.listEffects(taskId);
    const unchanged = visibleToDesktop.find((candidate) => candidate.id === effect.id);
    expect(unchanged?.state).toBe("PROPOSED");
    expect(unchanged?.version).toBe(effect.version);
  });

  test("server rejects unverified and illegal advancement while preserving ledger state", async () => {
    expect(cliEffectId).not.toBe("");
    expect(desktopProposedEffectId).not.toBe("");

    const cliRejected = await cli([
      "advance-effect",
      cliEffectId,
      "--to",
      "POLICY_CHECKED",
    ]);
    expect(cliRejected.code).not.toBe(0);
    expect(cliRejected.stderr).toContain("EXTERNAL_DEPENDENCY_FAILED");

    for (const [effectId, targetState] of [
      [cliEffectId, "DENIED"],
      [desktopProposedEffectId, "CANCELLED"],
    ] as const) {
      const terminalRejected = await cli([
        "advance-effect",
        effectId,
        "--to",
        targetState,
      ]);
      expect(terminalRejected.code).not.toBe(0);
      expect(terminalRejected.stderr).toContain("EXTERNAL_DEPENDENCY_FAILED");
    }

    const desktopRejected = await cli([
      "advance-effect",
      desktopProposedEffectId,
      "--to",
      "PREPARED",
    ]);
    expect(desktopRejected.code).not.toBe(0);
    expect(desktopRejected.stderr).toContain("ILLEGAL_TRANSITION");

    const effects = await (await loadDesktopAdapter()).listEffects(taskId);
    expect(effects.find((effect) => effect.id === cliEffectId)?.state).toBe("PROPOSED");
    expect(effects.find((effect) => effect.id === desktopProposedEffectId)?.state).toBe("PROPOSED");
  });

  test("schema registry exposes the canonical event catalog to both clients", async () => {
    const registryFromCli = cliJson<{ protocolVersion: number; supportedEventTypes: string[] }>(
      await cli(["schema-registry"]),
    );
    expect(registryFromCli.protocolVersion).toBe(2);
    expect(registryFromCli.supportedEventTypes).toContain("task.created");
    expect(registryFromCli.supportedEventTypes).toContain("effect.committed");

    const desktop = await loadDesktopAdapter();
    const registryFromDesktop = await desktop.schemaRegistry();
    expect(registryFromDesktop.protocolVersion).toBe(2);
    expect(Object.keys(registryFromDesktop.schemas)).toContain("task-v2");
  });
});

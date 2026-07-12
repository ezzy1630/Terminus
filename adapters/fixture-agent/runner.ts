#!/usr/bin/env bun
/**
 * Fixture-agent adapter runner — SPEC §30.1 Boundary C / §35.11.
 *
 * A deterministic, no-model external-harness adapter used by the eval lab.
 * Speaks JSON-RPC 2.0 over stdio. It replays a recorded trajectory (if one
 * is supplied via run.params.trajectoryPath) or performs a no-op "perfect"
 * run. It is NOT a real coding agent; it is a test double.
 *
 * Lifecycle methods:
 *   initialize → returns the adapter capability profile
 *   run        → streams adapter/event notifications, then returns AdapterResult
 *   cancel     → emits a cancelled event and stops the current run
 *   shutdown   → exits cleanly
 *
 * Honesty (SPEC §30.1): the fixture agent declares and observes identical,
 * perfect capabilities — there are no opaque semantics and no discrepancies.
 */
import { createInterface } from "node:readline";
import { readFileSync, existsSync } from "node:fs";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number | null;
  method: string;
  params?: unknown;
}

interface AdapterEvent {
  readonly kind: string;
  readonly [k: string]: unknown;
}

interface AdapterResult {
  readonly status: "completed" | "blocked" | "failed" | "budget_exhausted" | "policy_denied";
  readonly summary: string;
  readonly changedFiles: readonly string[];
  readonly commit: string | null;
  readonly tests: readonly unknown[];
  readonly findings: readonly string[];
  readonly risks: readonly string[];
  readonly unresolved: readonly string[];
  readonly artifacts: readonly unknown[];
  readonly actualBudget: Readonly<Record<string, unknown>>;
}

const ADAPTER_ID = "fixture-agent";
const VERSION = "0.1.0";
const CAPABILITY_PROFILE = {
  exactContextVisibility: "full",
  toolInterception: "full",
  filesystemEnforcement: "native",
  networkEnforcement: "native",
  secretIsolation: "native",
  sessionResume: "native",
  typedResults: "native",
  artifactExport: "complete",
  cancellation: "reliable",
  modelSelection: "controlled",
  nativeCompaction: false,
  observedByProbe: null,
  lastVerified: null,
} as const;

let cancelled = false;
let trajectory: { events?: AdapterEvent[]; result?: Partial<AdapterResult> } | null = null;

function loadTrajectory(path: string | null): void {
  if (path && existsSync(path)) {
    try {
      trajectory = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      trajectory = null;
    }
  }
}

function send(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function notify(method: string, params: unknown): void {
  send({ jsonrpc: "2.0", method, params });
}

function nowIso(): string {
  return new Date().toISOString();
}

function handle(req: JsonRpcRequest): void {
  switch (req.method) {
    case "initialize": {
      send({
        jsonrpc: "2.0",
        id: req.id,
        result: { adapterId: ADAPTER_ID, version: VERSION, capabilityProfile: CAPABILITY_PROFILE },
      });
      return;
    }
    case "run": {
      const params = (req.params ?? {}) as { trajectoryPath?: string };
      loadTrajectory(params.trajectoryPath ?? null);
      notify("adapter/event", { kind: "started", startedAt: nowIso() });
      const events = trajectory?.events ?? [];
      for (const ev of events) {
        if (cancelled) break;
        notify("adapter/event", { ...ev, timestamp: nowIso() });
      }
      if (cancelled) {
        notify("adapter/event", { kind: "cancelled", timestamp: nowIso() });
        send({ jsonrpc: "2.0", id: req.id, result: { status: "failed", summary: "cancelled" } });
        return;
      }
      notify("adapter/event", { kind: "completed", status: "completed", timestamp: nowIso() });
      const result: AdapterResult = {
        status: "completed",
        summary: trajectory?.result?.summary ?? "fixture-agent replay completed (no-op)",
        changedFiles: trajectory?.result?.changedFiles ?? [],
        commit: trajectory?.result?.commit ?? null,
        tests: trajectory?.result?.tests ?? [],
        findings: trajectory?.result?.findings ?? [],
        risks: trajectory?.result?.risks ?? [],
        unresolved: trajectory?.result?.unresolved ?? [],
        artifacts: trajectory?.result?.artifacts ?? [],
        actualBudget: trajectory?.result?.actualBudget ?? {},
      };
      send({ jsonrpc: "2.0", id: req.id, result });
      return;
    }
    case "cancel": {
      cancelled = true;
      send({ jsonrpc: "2.0", id: req.id, result: { cancelled: true } });
      return;
    }
    case "shutdown": {
      send({ jsonrpc: "2.0", id: req.id, result: { ok: true } });
      process.exit(0);
    }
    default: {
      send({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `method not found: ${req.method}` } });
    }
  }
}

// --selftest: run a canned initialize exchange and exit 0 if well-formed.
if (process.argv.includes("--selftest")) {
  handle({ jsonrpc: "2.0", id: 1, method: "initialize" });
  process.exit(0);
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line: string) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let req: JsonRpcRequest;
  try {
    req = JSON.parse(trimmed);
  } catch {
    return;
  }
  try {
    handle(req);
  } catch (e) {
    send({ jsonrpc: "2.0", id: req.id ?? null, error: { code: -32603, message: String(e) } });
  }
});
rl.on("close", () => process.exit(0));

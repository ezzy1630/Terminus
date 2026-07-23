/**
 * Pi adapter runner — Boundary C stdio JSON-RPC (SPEC §35.11).
 */
import { createInterface } from "node:readline";

const ADAPTER_ID = "pi";
const VERSION = "0.1.0";
const CAPABILITY_PROFILE = {
  exactContextVisibility: "partial",
  toolInterception: "partial",
  filesystemEnforcement: "outer_sandbox",
  networkEnforcement: "outer_sandbox",
  secretIsolation: "outer_broker",
  sessionResume: "emulated",
  typedResults: "parsed",
  artifactExport: "partial",
  cancellation: "best_effort",
  modelSelection: "constrained",
  nativeCompaction: false,
  observedByProbe: null,
  lastVerified: null,
} as const;

function send(obj: unknown): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function nowIso(): string {
  return new Date().toISOString();
}

function handle(req: {
  jsonrpc: string;
  id: string | number | null;
  method: string;
  params?: unknown;
}): void {
  switch (req.method) {
    case "initialize":
      send({
        jsonrpc: "2.0",
        id: req.id,
        result: { adapterId: ADAPTER_ID, version: VERSION, capabilityProfile: CAPABILITY_PROFILE },
      });
      return;
    case "run": {
      send({
        jsonrpc: "2.0",
        method: "adapter/event",
        params: { kind: "started", startedAt: nowIso() },
      });
      send({
        jsonrpc: "2.0",
        id: req.id,
        result: {
          status: "completed",
          summary: "pi adapter completed (untrusted self-report)",
          changedFiles: [],
          commit: null,
          tests: [],
          findings: [],
          risks: ["inner harness self-report is not evidence"],
          unresolved: [],
          artifacts: [],
          actualBudget: {},
        },
      });
      return;
    }
    case "cancel":
      send({ jsonrpc: "2.0", id: req.id, result: { cancelled: true } });
      return;
    case "shutdown":
      send({ jsonrpc: "2.0", id: req.id, result: { ok: true } });
      process.exit(0);
      return;
    default:
      send({
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32601, message: `method not found: ${req.method}` },
      });
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (!line.trim()) return;
  try {
    handle(JSON.parse(line) as Parameters<typeof handle>[0]);
  } catch (err) {
    send({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: err instanceof Error ? err.message : String(err) },
    });
  }
});

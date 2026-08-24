import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");

interface RpcMessage {
  readonly id?: unknown;
  readonly method?: unknown;
  readonly result?: unknown;
  readonly params?: unknown;
}

interface AdapterResult {
  readonly status: string;
  readonly summary: string;
  readonly changedFiles: readonly string[];
  readonly commit: string | null;
  readonly tests: readonly unknown[];
  readonly findings: readonly string[];
  readonly risks: readonly string[];
  readonly unresolved: readonly string[];
  readonly artifacts: readonly unknown[];
}

const RUNNERS = [
  { id: "codex", script: join(ROOT, "adapters", "codex", "runner.ts") },
  { id: "claude-code", script: join(ROOT, "adapters", "claude-code", "runner.ts") },
  { id: "pi", script: join(ROOT, "adapters", "pi", "runner.ts") },
] as const;

async function runStub(script: string): Promise<readonly RpcMessage[]> {
  const processHandle = Bun.spawn(["bun", "run", script], {
    cwd: ROOT,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  await processHandle.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: "initialize-1", method: "initialize", params: {} })}\n` +
      `${JSON.stringify({ jsonrpc: "2.0", id: "run-1", method: "run", params: {} })}\n`,
  );
  processHandle.stdin.end();
  const [exitCode, stdout, stderr] = await Promise.all([
    processHandle.exited,
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
  ]);
  expect(exitCode).toBe(0);
  expect(stderr).toBe("");
  return stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as unknown as RpcMessage);
}

describe("external harness contract stubs", () => {
  for (const runner of RUNNERS) {
    test(`${runner.id} reports unavailable instead of completion`, async () => {
      const messages = await runStub(runner.script);
      const initialize = messages.find((message) => message.id === "initialize-1");
      const event = messages.find((message) => message.method === "adapter/event");
      const run = messages.find((message) => message.id === "run-1");

      expect(initialize).toBeDefined();
      expect(event).toBeDefined();
      expect(run).toBeDefined();
      expect(event?.params).toEqual(expect.objectContaining({
        kind: "error",
        errorCode: "adapter_unavailable",
      }));

      const result = run?.result as AdapterResult;
      expect(result.status).toBe("blocked");
      expect(result.summary).toContain("unavailable");
      expect(result.summary).toContain("not implemented");
      expect(result.unresolved.some((value) => value.includes("not implemented"))).toBe(true);
      expect(result.changedFiles).toEqual([]);
      expect(result.commit).toBeNull();
      expect(result.tests).toEqual([]);
      expect(result.findings).toEqual([]);
      expect(result.artifacts).toEqual([]);
      expect(messages.some((message) => message.method === "adapter/event"
        && (message.params as { kind?: unknown } | undefined)?.kind === "completed")).toBe(false);
    });
  }
});

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "..");
const TUI_SCRIPT = join(ROOT, "apps", "tui", "src", "index.ts");
const AUTH_VALUE = "fixture-auth-value";

interface TuiResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
});

async function runTui(gatewayUrl: string, token: string | undefined): Promise<TuiResult> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    TERMINUS_GATEWAY: gatewayUrl,
    TERMINUS_TOKEN: token,
  };
  const processHandle = Bun.spawn(["bun", TUI_SCRIPT, "health"], {
    cwd: ROOT,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    processHandle.exited,
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

describe("Terminus TUI authentication", () => {
  test("uses TERMINUS_TOKEN on the canonical public-client request", async () => {
    let authorization: string | null = null;
    let xformPort: string | null = null;
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        authorization = request.headers.get("authorization");
        xformPort = url.searchParams.get("XTransformPort");
        if (authorization !== `Bearer ${AUTH_VALUE}`) {
          return new Response("Unauthorized", { status: 401 });
        }
        return Response.json({
          status: "ok",
          version: "0.1.0",
          build_commit: "fixture",
          instance_id: "fixture-control",
          uptime_seconds: 1,
          ready: true,
        });
      },
    });
    servers.push(server);

    const result = await runTui(`http://127.0.0.1:${server.port}`, AUTH_VALUE);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("System health");
    expect(authorization as unknown).toBe(`Bearer ${AUTH_VALUE}`);
    expect(xformPort as unknown).toBe("3050");
  });

  test("fails before network access when TERMINUS_TOKEN is missing", async () => {
    let requestCount = 0;
    const server = Bun.serve({
      port: 0,
      fetch() {
        requestCount += 1;
        return Response.json({});
      },
    });
    servers.push(server);

    const result = await runTui(`http://127.0.0.1:${server.port}`, undefined);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("TERMINUS_TOKEN must be set");
    expect(requestCount).toBe(0);
  });
});

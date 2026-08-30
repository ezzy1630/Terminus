#!/usr/bin/env bun
/**
 * Development runtime launcher — kernel + control plane, from source.
 *
 * `StandaloneRuntimeSupervisor` (apps/desktop/electron/runtime-supervisor.ts)
 * only runs for packaged builds: `startPackagedRuntime()` returns immediately
 * when `isDev`. So a source checkout had nothing listening on 3050, and the
 * only way to see the desktop populated was the `?mock=true` fixture.
 *
 * This brings the same two processes up from source with the same environment
 * contract the supervisor uses, so development runs against the real control
 * plane and the real Rust kernel.
 *
 *   bun run dev:stack          # start kernel + control, stream logs
 *   bun run dev:stack -- --print-env   # emit shell exports and exit
 *   bun run dev:stack -- --electron    # start the stack, then the desktop app
 *
 * State (SQLite database, kernel data, UDS socket, tokens) lives in
 * `.terminus-dev/`, which is git-ignored and created 0700 because the kernel
 * refuses to bind a socket inside a world-readable directory.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const STATE_DIR = join(REPO_ROOT, ".terminus-dev");
const KERNEL_CRATE_DIR = join(REPO_ROOT, "mini-services/terminus-kernel");
const DESKTOP_DIR = join(REPO_ROOT, "apps/desktop");
/**
 * The kernel binary to launch. `TERMINUS_KERNEL_BIN` overrides the default so a
 * build made with `CARGO_TARGET_DIR` on the internal disk can be used directly:
 * binaries freshly linked on /Volumes/Workspace sit in a launch-time scan for
 * minutes, and the default path is only rebuilt when it is missing, so a stale
 * binary there must never silently run old kernel code.
 */
const KERNEL_BIN = process.env.TERMINUS_KERNEL_BIN ?? join(KERNEL_CRATE_DIR, "target/release/terminus-kernel-mini");
const CONTROL_ENTRY = join(REPO_ROOT, "mini-services/terminus-control/src/index.ts");
const CONTROL_PORT = 3050;
const API_BASE = `http://127.0.0.1:${CONTROL_PORT}`;
const VITE_ORIGIN = "http://localhost:5173";
const READY_TIMEOUT_MS = 60_000;

/** Matches the supervisor's TOKEN_PATTERN: base64url, 32–128 characters. */
function randomToken(): string {
  return randomBytes(36).toString("base64url");
}

/** Tokens persist across restarts so an already-running Vite keeps working. */
function persistentToken(name: string): string {
  const path = join(STATE_DIR, `${name}.token`);
  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8").trim();
    if (existing.length > 0) return existing;
  }
  const token = randomToken();
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return token;
}

function prepareState(): void {
  mkdirSync(STATE_DIR, { recursive: true });
  mkdirSync(join(STATE_DIR, "kernel-data"), { recursive: true });
  // The kernel asserts its socket's parent is private before binding.
  chmodSync(STATE_DIR, 0o700);
  chmodSync(join(STATE_DIR, "kernel-data"), 0o700);
}

function ensureKernelBinary(): void {
  if (process.env.TERMINUS_KERNEL_BIN !== undefined) {
    if (!existsSync(KERNEL_BIN)) {
      throw new Error(`TERMINUS_KERNEL_BIN does not exist: ${KERNEL_BIN}`);
    }
    console.log(`[dev-stack] using kernel binary from TERMINUS_KERNEL_BIN: ${KERNEL_BIN}`);
    return;
  }

  // `cargo build` is incremental when the binary is current. Running it on
  // every live launch is the cheap, deterministic freshness check; an mtime
  // comparison misses build scripts, workspace dependencies, and feature
  // changes and can put the desktop on a stale effect boundary.
  console.log("[dev-stack] building the current kernel (incremental when unchanged)");
  const build = spawnSync("cargo", ["build", "--release"], {
    cwd: KERNEL_CRATE_DIR,
    stdio: "inherit",
  });
  if (build.status !== 0) throw new Error("kernel build failed");
}

function runMigrations(databaseUrl: string): void {
  const migrate = spawnSync("bun", ["run", join(REPO_ROOT, "scripts/migrate.ts")], {
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: "inherit",
  });
  if (migrate.status !== 0) throw new Error("database migration failed");
}

async function waitForHealth(token: string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${API_BASE}/v1/system/health`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (response.ok) {
        const health = await response.json() as { ready?: boolean; kernel?: { state?: string } };
        if (health.ready === true) {
          console.log(`[dev-stack] control plane ready (kernel: ${health.kernel?.state ?? "unknown"})`);
          return;
        }
      }
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`control plane did not become ready within ${READY_TIMEOUT_MS}ms`);
}

async function waitForSocket(path: string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("kernel did not create its gRPC socket in time");
}

const children: ChildProcess[] = [];

function spawnService(
  name: string,
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd = REPO_ROOT,
): ChildProcess {
  const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  const relay = (stream: NodeJS.ReadableStream | null, sink: NodeJS.WriteStream): void => {
    stream?.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n")) {
        if (line.trim().length > 0) sink.write(`[${name}] ${line}\n`);
      }
    });
  };
  relay(child.stdout, process.stdout);
  relay(child.stderr, process.stderr);
  child.on("exit", (code) => {
    if (!shuttingDown) {
      console.error(`[dev-stack] ${name} exited unexpectedly with code ${code}`);
      void shutdown(1);
    }
  });
  children.push(child);
  return child;
}

let shuttingDown = false;

async function shutdown(code: number): Promise<never> {
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode === null) child.kill("SIGTERM");
  }
  await new Promise((resolve) => setTimeout(resolve, 400));
  for (const child of children) {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  process.exit(code);
}

async function main(): Promise<void> {
  prepareState();

  const databaseUrl = `file:${join(STATE_DIR, "control.db")}`;
  const kernelSocket = join(STATE_DIR, "kernel.sock");
  const controlToken = persistentToken("control");
  const bootstrapToken = persistentToken("bootstrap");

  if (process.argv.includes("--print-env")) {
    process.stdout.write(`export TERMINUS_API_BASE=${API_BASE}\n`);
    process.stdout.write(`export TERMINUS_TOKEN=${controlToken}\n`);
    process.stdout.write(`export VITE_TERMINUS_API_BASE=${API_BASE}\n`);
    process.stdout.write(`export VITE_TERMINUS_TOKEN=${controlToken}\n`);
    return;
  }

  ensureKernelBinary();
  runMigrations(databaseUrl);
  rmSync(kernelSocket, { force: true });

  const common: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: process.env.HOME ?? STATE_DIR,
    LANG: "en_US.UTF-8",
  };

  spawnService("kernel", KERNEL_BIN, [], {
    ...common,
    TERMINUS_DATA: join(STATE_DIR, "kernel-data"),
    TERMINUS_KERNEL_GRPC_SOCKET: kernelSocket,
    TERMINUS_KERNEL_REQUIRE_UDS: "1",
    TERMINUS_KERNEL_CONTROL_BOOTSTRAP: "1",
    TERMINUS_KERNEL_CONTROL_BOOTSTRAP_TOKEN: bootstrapToken,
    TERMINUS_KERNEL_TOKEN: randomToken(),
    // Dev kernels are ad-hoc linker-signed, so every rebuild is a new code
    // identity to the macOS Keychain and each secret read would block on a
    // SecurityAgent prompt (observed: 30 s DEADLINE_EXCEEDED on dispatch).
    // The file backend keeps provider credentials under the kernel data dir
    // (0600) instead; it is only honoured together with TERMINUS_DEV=1.
    TERMINUS_DEV: "1",
    TERMINUS_SECRETS_BACKEND: process.env.TERMINUS_SECRETS_BACKEND ?? "file",
    RUST_LOG: process.env.RUST_LOG ?? "info",
  });
  await waitForSocket(kernelSocket);

  spawnService("control", "bun", [CONTROL_ENTRY], {
    ...common,
    DATABASE_URL: databaseUrl,
    TERMINUS_KERNEL_GRPC_SOCKET: kernelSocket,
    TERMINUS_KERNEL_CONTROL_BOOTSTRAP_TOKEN: bootstrapToken,
    TERMINUS_CONTROL_TOKEN: controlToken,
    TERMINUS_CONTROL_PORT: String(CONTROL_PORT),
    TERMINUS_CONTROL_CORS_ORIGIN: process.env.TERMINUS_CONTROL_CORS_ORIGIN ?? VITE_ORIGIN,
    TERMINUS_CONTROL_INSTANCE_NONCE: randomToken(),
    TERMINUS_DEV: "1",
  });
  await waitForHealth(controlToken);

  if (process.argv.includes("--electron")) {
    spawnService("electron", "bun", ["run", "dev:electron"], {
      ...process.env,
      TERMINUS_API_BASE: API_BASE,
      TERMINUS_TOKEN: controlToken,
      VITE_TERMINUS_API_BASE: API_BASE,
      VITE_TERMINUS_TOKEN: controlToken,
    }, DESKTOP_DIR);
  }

  console.log("");
  console.log(`[dev-stack] API      ${API_BASE}`);
  console.log(`[dev-stack] token    ${STATE_DIR}/control.token`);
  if (!process.argv.includes("--electron")) {
    console.log("[dev-stack] renderer  bun run dev:live   (in apps/desktop)");
    console.log("[dev-stack] electron  bun run dev:electron:live");
  }
  console.log(`[dev-stack] Ctrl-C to stop ${process.argv.includes("--electron") ? "all three processes" : "both services"}.`);

  process.on("SIGINT", () => void shutdown(0));
  process.on("SIGTERM", () => void shutdown(0));
  await new Promise(() => { /* run until interrupted */ });
}

main().catch((error: unknown) => {
  console.error("[dev-stack]", error instanceof Error ? error.message : error);
  void shutdown(1);
});

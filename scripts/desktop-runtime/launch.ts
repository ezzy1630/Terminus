import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  type FileHandle,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { extractFile } from "@electron/asar";
import {
  decodeDesktopRuntimeManifest,
  type DesktopRuntimeArchitecture,
  type DesktopRuntimeBuildKind,
} from "../../apps/desktop/electron/runtime-contract";
import {
  deterministicProviderCommand,
  findPackagedRendererTarget,
  readProviderFixture,
  runDeterministicDesktopTask,
  type DeterministicDesktopTaskEvidence,
} from "./task";

const STARTUP_TIMEOUT_MS = 45_000;
const HEALTH_STABILITY_MS = 4_500;
const SHUTDOWN_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 250;
const MAX_RETAINED_LOG_BYTES = 8 * 1_024;
const MAX_DARWIN_UDS_PATH_BYTES = 103;
const DEFAULT_STATE_BASE = "/private/tmp";
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

interface ProcessRow {
  readonly pid: number;
  readonly parentPid: number;
  readonly command: string;
}

interface ArtifactEvidence {
  readonly name: string;
  readonly sha256: string;
  readonly size: number;
}

interface BoundedLogEvidence {
  readonly sha256: string;
  readonly tail: string;
  readonly truncated: boolean;
}

export interface DesktopRuntimeLaunchOptions {
  readonly application?: string;
  readonly architecture: DesktopRuntimeArchitecture;
  readonly commit: string;
  readonly version: string;
  readonly buildKind: DesktopRuntimeBuildKind;
  readonly artifact?: string;
  readonly stateBase?: string;
  /** Exercise the packaged renderer with a local deterministic provider. */
  readonly deterministicTask?: boolean;
  /** Test-only override for the local deterministic provider command. */
  readonly providerCommandJson?: string;
}

export interface DesktopRuntimeLaunchEvidence {
  readonly schema: "terminus.desktop-runtime.launch.v1";
  readonly status: "pass";
  readonly architecture: DesktopRuntimeArchitecture;
  readonly build_kind: DesktopRuntimeBuildKind;
  readonly candidate_commit: string;
  readonly version: string;
  readonly application: {
    readonly executable_sha256: string;
    readonly asar_sha256: string;
    readonly runtime_manifest_sha256: string;
  };
  readonly artifact?: ArtifactEvidence;
  readonly readiness: {
    readonly kernel_uds: true;
    readonly control_loopback_port: number;
    readonly public_health_ready: true;
    readonly cors_origin: "terminus://app";
    readonly unauthenticated_request_rejected: true;
    readonly renderer_process_observed: true;
    readonly renderer_loaded_under_csp: true;
    readonly renderer_authenticated_request_completed: true;
    readonly renderer_sse_stream_opened: true;
    readonly private_state: true;
    readonly bearer_environment: "sanitized";
    readonly runtime_log: BoundedLogEvidence;
    readonly electron_log: BoundedLogEvidence;
  };
  readonly deterministic_task?: DeterministicDesktopTaskEvidence;
  readonly shutdown: {
    readonly normal_quit_requested: true;
    readonly application_exited: true;
    readonly runtime_children_exited: true;
    readonly kernel_uds_removed: true;
  };
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function object(
  value: unknown,
  label: string,
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

async function processTable(): Promise<readonly ProcessRow[]> {
  const child = Bun.spawn(["/bin/ps", "-axo", "pid=,ppid=,command="], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0)
    throw new Error(`ps failed with exit ${exitCode}: ${stderr.slice(-4_000)}`);
  return stdout.split("\n").flatMap((line): readonly ProcessRow[] => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (match === null) return [];
    return [
      {
        pid: Number.parseInt(match[1] ?? "", 10),
        parentPid: Number.parseInt(match[2] ?? "", 10),
        command: match[3] ?? "",
      },
    ];
  });
}

function descendantPids(
  rootPid: number,
  rows: readonly ProcessRow[],
): readonly number[] {
  const descendants = new Set<number>();
  let frontier = [rootPid];
  while (frontier.length > 0) {
    const parents = new Set(frontier);
    frontier = rows
      .filter((row) => parents.has(row.parentPid) && !descendants.has(row.pid))
      .map((row) => row.pid);
    for (const pid of frontier) descendants.add(pid);
  }
  return [...descendants];
}

function childRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

const waitForExit = async (
  child: ChildProcess,
  timeoutMs: number,
): Promise<boolean> => {
  if (!childRunning(child)) return true;
  return await new Promise<boolean>((resolveWait) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onExit = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      resolveWait(true);
    };
    timer = setTimeout(() => {
      child.removeListener("exit", onExit);
      resolveWait(false);
    }, timeoutMs);
    child.once("exit", onExit);
  });
};

function signalIfRunning(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function terminateOwnedProcessTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return;
  const descendants = descendantPids(pid, await processTable());
  if (childRunning(child)) child.kill("SIGTERM");
  if (!(await waitForExit(child, 5_000)) && childRunning(child)) {
    child.kill("SIGKILL");
    await waitForExit(child, 5_000);
  }
  for (const descendant of [...descendants].reverse())
    signalIfRunning(descendant, "SIGTERM");
  await sleep(1_000);
  for (const descendant of [...descendants].reverse())
    signalIfRunning(descendant, "SIGKILL");
}

async function privateMode(
  path: string,
  expectedMode: number,
  kind: "directory" | "file" | "socket",
): Promise<void> {
  const details = await lstat(path);
  const expectedKind =
    kind === "directory"
      ? details.isDirectory()
      : kind === "file"
        ? details.isFile()
        : details.isSocket();
  if (!expectedKind || details.isSymbolicLink())
    throw new Error(`${path} is not a private ${kind}`);
  if ((details.mode & 0o777) !== expectedMode) {
    throw new Error(
      `${path} mode is ${(details.mode & 0o777).toString(8)}, expected ${expectedMode.toString(8)}`,
    );
  }
}

function redactLog(value: string): string {
  return value
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/(authorization:\s*bearer\s+)[A-Za-z0-9_-]+/gi, "$1<redacted>")
    .replace(/((?:TOKEN|SECRET)=)[A-Za-z0-9_-]+/g, "$1<redacted>");
}

async function boundedLog(path: string): Promise<BoundedLogEvidence> {
  const details = await stat(path);
  if (!details.isFile())
    throw new Error(`desktop launch log is not a regular file: ${path}`);
  const retainedBytes = Math.min(details.size, MAX_RETAINED_LOG_BYTES);
  const handle = await open(path, "r");
  try {
    const bytes = Buffer.alloc(retainedBytes);
    if (retainedBytes > 0)
      await handle.read(bytes, 0, retainedBytes, details.size - retainedBytes);
    return {
      sha256: await sha256File(path),
      tail: redactLog(bytes.toString("utf8")),
      truncated: details.size > MAX_RETAINED_LOG_BYTES,
    };
  } finally {
    await handle.close();
  }
}

async function readTail(path: string): Promise<string> {
  try {
    return (await boundedLog(path)).tail;
  } catch {
    return "";
  }
}

async function run(command: readonly string[]): Promise<string> {
  const child = Bun.spawn([...command], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `${command.join(" ")} failed with exit ${exitCode}\n${stderr.slice(-8_000)}`,
    );
  }
  return stdout.trim();
}

async function requestNormalQuit(pid: number): Promise<void> {
  const source = [
    "ObjC.import('AppKit')",
    `const application = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${pid})`,
    "if (!application) throw new Error('packaged application process is unavailable')",
    "if (!ObjC.unwrap(application.terminate)) throw new Error('normal application termination was rejected')",
  ].join(";");
  await run(["/usr/bin/osascript", "-l", "JavaScript", "-e", source]);
}

async function verifyPublicRuntime(
  port: number,
  commit: string,
  version: string,
): Promise<void> {
  const headers = { Origin: "terminus://app" };
  const healthResponse = await fetch(
    `http://127.0.0.1:${port}/v1/system/health`,
    {
      headers,
      signal: AbortSignal.timeout(2_000),
    },
  );
  const health = object(
    (await healthResponse.json()) as unknown,
    "public desktop health",
  );
  const writer = object(health.writer, "public desktop health writer");
  if (
    healthResponse.status !== 200 ||
    healthResponse.headers.get("access-control-allow-origin") !==
      "terminus://app" ||
    health.status !== "ok" ||
    health.ready !== true ||
    health.version !== version ||
    health.build_commit !== commit ||
    typeof health.instance_id !== "string" ||
    health.instance_id.length < 16 ||
    writer.healthy !== true
  ) {
    throw new Error(
      "packaged desktop public health identity/readiness is invalid",
    );
  }
  const unauthenticated = await fetch(
    `http://127.0.0.1:${port}/v1/sessions?limit=1`,
    {
      headers,
      signal: AbortSignal.timeout(2_000),
    },
  );
  if (
    unauthenticated.status !== 401 ||
    unauthenticated.headers.get("access-control-allow-origin") !==
      "terminus://app"
  ) {
    throw new Error(
      "packaged desktop public API did not reject an unauthenticated request",
    );
  }
}

async function artifactEvidence(path: string): Promise<ArtifactEvidence> {
  const resolved = resolve(path);
  const details = await stat(resolved);
  if (!details.isFile())
    throw new Error(`desktop artifact is not a regular file: ${resolved}`);
  return {
    name: basename(resolved),
    sha256: await sha256File(resolved),
    size: details.size,
  };
}

export async function launchDesktopRuntime(
  options: DesktopRuntimeLaunchOptions,
): Promise<DesktopRuntimeLaunchEvidence> {
  if (process.platform !== "darwin")
    throw new Error("desktop runtime launch evidence requires macOS");
  if (process.arch === "x64" && options.architecture === "arm64") {
    throw new Error(
      "arm64 desktop launch evidence requires an Apple Silicon runner",
    );
  }
  const hasApplication = options.application !== undefined;
  const hasArtifact = options.artifact !== undefined;
  if (hasApplication === hasArtifact) {
    throw new Error(
      "desktop launch requires exactly one local application or exact ZIP artifact",
    );
  }

  // Electron canonicalizes /var/folders to /private/var/folders. On a normal
  // macOS account that turns an apparently valid 98-byte socket path into 106
  // bytes, beyond sockaddr_un.sun_path. A private random child under the real
  // short temp root keeps the profile isolated and the UDS representable.
  const stateBase = resolve(options.stateBase ?? DEFAULT_STATE_BASE);
  await mkdir(stateBase, { recursive: true, mode: 0o700 });
  const state = await mkdtemp(
    join(stateBase, `terminus-${options.architecture}-`),
  );
  const profile = join(state, "profile");
  const home = join(state, "home");
  const electronLog = join(state, "electron.log");
  const runtimeRoot = join(profile, "runtime");
  const runtimeLog = join(runtimeRoot, "runtime.log");
  const database = join(runtimeRoot, "control.db");
  const kernelSocket = join(runtimeRoot, "kernel.sock");
  if (Buffer.byteLength(kernelSocket) > MAX_DARWIN_UDS_PATH_BYTES) {
    throw new Error(
      `desktop launch kernel UDS path exceeds ${MAX_DARWIN_UDS_PATH_BYTES} bytes: ${kernelSocket}`,
    );
  }
  await mkdir(profile, { mode: 0o700 });
  await mkdir(home, { mode: 0o700 });
  let child: ChildProcess | null = null;
  let logHandle: FileHandle | null = null;
  let completed = false;
  let deterministicTaskEvidence: DeterministicDesktopTaskEvidence | undefined;
  try {
    // Local packages are the only surface permitted to run the deterministic
    // provider fixture. Release evidence remains provider-independent.
    const deterministicTaskEnabled = options.buildKind === "local" || options.deterministicTask === true;
    const boundArtifact =
      options.artifact === undefined
        ? undefined
        : await artifactEvidence(options.artifact);
    let application: string;
    if (options.artifact !== undefined) {
      if (!options.artifact.endsWith(".zip")) {
        throw new Error(
          "exact desktop launch artifacts must be ZIP distributions",
        );
      }
      const extracted = join(state, "exact-zip");
      await mkdir(extracted, { mode: 0o700 });
      await run([
        "/usr/bin/ditto",
        "-x",
        "-k",
        resolve(options.artifact),
        extracted,
      ]);
      application = join(extracted, "Terminus.app");
    } else {
      application = resolve(options.application ?? "");
    }
    const executable = join(application, "Contents", "MacOS", "Terminus");
    const resources = join(application, "Contents", "Resources");
    const asar = join(resources, "app.asar");
    const runtimeManifestPath = join(resources, "runtime", "manifest.json");
    const runtimeManifest = decodeDesktopRuntimeManifest(
      JSON.parse(await readFile(runtimeManifestPath, "utf8")) as unknown,
    );
    const metadata = object(
      JSON.parse(extractFile(asar, "package.json").toString("utf8")) as unknown,
      "packaged desktop metadata",
    );
    if (
      metadata.version !== options.version ||
      metadata.terminusCommit !== options.commit ||
      metadata.terminusBuildKind !== options.buildKind ||
      runtimeManifest.version !== options.version ||
      runtimeManifest.candidate_commit !== options.commit ||
      runtimeManifest.architecture !== options.architecture ||
      runtimeManifest.build_kind !== options.buildKind
    ) {
      throw new Error(
        "packaged desktop identity does not match the requested launch evidence",
      );
    }

    const deterministicWorkspace = join(state, "task-workspace");
    const deterministicProviderPath = join(
      deterministicWorkspace,
      "terminus-provider-fixture.ts",
    );
    const deterministicProviderSource =
      deterministicTaskEnabled
        ? await readProviderFixture(
            resolve(import.meta.dir, "../e2e/provider-stdio-fixture.ts"),
          )
        : undefined;
    const deterministicProviderCommandJson =
      deterministicTaskEnabled
        ? (options.providerCommandJson ??
          deterministicProviderCommand(
            process.execPath,
            deterministicProviderPath,
          ))
        : undefined;

    logHandle = await open(electronLog, "w", 0o600);
    const architectureFlag =
      options.architecture === "arm64" ? "-arm64" : "-x86_64";
    const launchArguments = [
      architectureFlag,
      executable,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      ...(deterministicTaskEnabled
        ? ["--remote-debugging-port=0"]
        : []),
    ];
    const launched = spawn("/usr/bin/arch", launchArguments, {
      cwd: state,
      env: {
        HOME: home,
        LANG: "en_US.UTF-8",
        LOGNAME: process.env.LOGNAME ?? process.env.USER ?? "terminus",
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        SHELL: "/bin/zsh",
        TMPDIR: state,
        USER: process.env.USER ?? "terminus",
        ...(deterministicProviderCommandJson === undefined
          ? {}
          : {
              TERMINUS_LOCAL_PROVIDER_COMMAND_JSON:
                deterministicProviderCommandJson,
            }),
      },
      shell: false,
      stdio: ["ignore", logHandle.fd, logHandle.fd],
    });
    child = launched;
    const startedAt = Date.now();
    let controlPort = 0;
    while (Date.now() - startedAt < STARTUP_TIMEOUT_MS) {
      if (!childRunning(launched)) {
        throw new Error(
          `packaged desktop exited before readiness\n${await readTail(electronLog)}\n${await readTail(runtimeLog)}`,
        );
      }
      const runtimeText = await readTail(runtimeLog);
      const portMatch =
        /\[terminus-control\] listening on http:\/\/localhost:(\d+)/.exec(
          runtimeText,
        );
      const rows = await processTable();
      const kernel = rows.some(
        (row) =>
          row.command ===
          join(resources, "runtime", "bin", "terminus-kernel-mini"),
      );
      const control = rows.some(
        (row) =>
          row.command ===
          `${join(resources, "runtime", "terminus-control", "bin", "terminus-control")} serve`,
      );
      const renderer = rows.some(
        (row) =>
          row.parentPid === launched.pid &&
          row.command.includes("--type=renderer"),
      );
      let stateReady = false;
      try {
        await Promise.all([
          privateMode(profile, 0o700, "directory"),
          privateMode(home, 0o700, "directory"),
          privateMode(runtimeRoot, 0o700, "directory"),
          privateMode(database, 0o600, "file"),
          privateMode(runtimeLog, 0o600, "file"),
          privateMode(kernelSocket, 0o600, "socket"),
        ]);
        stateReady = true;
      } catch {
        stateReady = false;
      }
      if (portMatch !== null && kernel && control && renderer && stateReady) {
        controlPort = Number.parseInt(portMatch[1] ?? "0", 10);
        if (controlPort > 0 && controlPort <= 65_535) break;
      }
      await sleep(POLL_INTERVAL_MS);
    }
    if (controlPort === 0) {
      throw new Error(
        `packaged desktop did not reach ready task surface\n${await readTail(electronLog)}\n${await readTail(runtimeLog)}`,
      );
    }

    await verifyPublicRuntime(controlPort, options.commit, options.version);
    await sleep(HEALTH_STABILITY_MS);
    if (!childRunning(launched))
      throw new Error(
        "packaged desktop exited during the health-stability window",
      );

    const electronText = await readTail(electronLog);
    const rendererCspLoaded = electronText.includes(
      "[terminus-desktop] packaged renderer loaded under CSP",
    );
    const rendererAuthInjected = electronText.includes(
      "[terminus-desktop] authenticated header injected for renderer request",
    );
    const rendererSseOpened = electronText.includes(
      "[terminus-desktop] renderer opened SSE connection",
    );
    if (!rendererCspLoaded) {
      throw new Error(
        `packaged desktop did not observe renderer loading under generated CSP\n${electronText}`,
      );
    }
    if (!rendererAuthInjected) {
      throw new Error(
        `packaged desktop did not observe renderer authenticated request header injection\n${electronText}`,
      );
    }
    if (!rendererSseOpened) {
      throw new Error(
        `packaged desktop did not observe renderer opening SSE connection\n${electronText}`,
      );
    }

    if (deterministicTaskEnabled) {
      const devToolsMatch =
        /DevTools listening on ws:\/\/(?:127\.0\.0\.1|localhost):(\d+)\//.exec(
          electronText,
        );
      if (devToolsMatch === null) {
        throw new Error(
          "packaged deterministic task could not find the loopback renderer DevTools endpoint",
        );
      }
      const devToolsPort = Number.parseInt(devToolsMatch[1] ?? "0", 10);
      if (
        !Number.isSafeInteger(devToolsPort) ||
        devToolsPort < 1 ||
        devToolsPort > 65_535
      ) {
        throw new Error(
          "packaged deterministic task found an invalid renderer DevTools port",
        );
      }
      const renderer = await findPackagedRendererTarget(
        devToolsPort,
        STARTUP_TIMEOUT_MS,
      );
      if (deterministicProviderSource === undefined) {
        throw new Error(
          "packaged deterministic task provider fixture was not prepared",
        );
      }
      deterministicTaskEvidence = await runDeterministicDesktopTask(
        renderer.webSocketDebuggerUrl,
        {
          workspaceRoot: deterministicWorkspace,
          providerScriptSource: deterministicProviderSource,
          providerRuntime: process.execPath,
        },
      );
    }

    const rowsBeforeShutdown = await processTable();
    const runtimePrefix = join(resources, "runtime");
    if (
      !rowsBeforeShutdown.some((row) => row.command.startsWith(runtimePrefix))
    ) {
      throw new Error(
        "packaged desktop runtime children exited during the health-stability window",
      );
    }

    const launchedPid = launched.pid;
    if (launchedPid === undefined)
      throw new Error("packaged desktop has no process identifier");
    await requestNormalQuit(launchedPid);
    if (!(await waitForExit(launched, SHUTDOWN_TIMEOUT_MS))) {
      throw new Error(
        "packaged desktop did not honor the normal quit request within the shutdown timeout",
      );
    }
    const cleanupStartedAt = Date.now();
    while (Date.now() - cleanupStartedAt < SHUTDOWN_TIMEOUT_MS) {
      const rows = await processTable();
      const childrenRemain = rows.some((row) =>
        row.command.startsWith(runtimePrefix),
      );
      let socketRemains = true;
      try {
        await lstat(kernelSocket);
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          socketRemains = false;
        else throw error;
      }
      if (!childrenRemain && !socketRemains) break;
      await sleep(POLL_INTERVAL_MS);
    }
    const finalRows = await processTable();
    if (finalRows.some((row) => row.command.startsWith(runtimePrefix))) {
      throw new Error(
        "packaged desktop left standalone runtime children running after shutdown",
      );
    }
    try {
      await lstat(kernelSocket);
      throw new Error("packaged desktop left its kernel UDS after shutdown");
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await logHandle.close();
    logHandle = null;
    const observedArtifact =
      options.artifact === undefined
        ? undefined
        : await artifactEvidence(options.artifact);
    if (
      boundArtifact !== undefined &&
      observedArtifact !== undefined &&
      (observedArtifact.name !== boundArtifact.name ||
        observedArtifact.sha256 !== boundArtifact.sha256 ||
        observedArtifact.size !== boundArtifact.size)
    ) {
      throw new Error(
        "desktop ZIP artifact changed while its exact application was launched",
      );
    }
    const evidence: DesktopRuntimeLaunchEvidence = {
      schema: "terminus.desktop-runtime.launch.v1",
      status: "pass",
      architecture: options.architecture,
      build_kind: options.buildKind,
      candidate_commit: options.commit,
      version: options.version,
      application: {
        executable_sha256: await sha256File(executable),
        asar_sha256: await sha256File(asar),
        runtime_manifest_sha256: await sha256File(runtimeManifestPath),
      },
      ...(boundArtifact === undefined ? {} : { artifact: boundArtifact }),
      ...(deterministicTaskEvidence === undefined
        ? {}
        : { deterministic_task: deterministicTaskEvidence }),
      readiness: {
        kernel_uds: true,
        control_loopback_port: controlPort,
        public_health_ready: true,
        cors_origin: "terminus://app",
        unauthenticated_request_rejected: true,
        renderer_process_observed: true,
        renderer_loaded_under_csp: true,
        renderer_authenticated_request_completed: true,
        renderer_sse_stream_opened: true,
        private_state: true,
        bearer_environment: "sanitized",
        runtime_log: await boundedLog(runtimeLog),
        electron_log: await boundedLog(electronLog),
      },
      shutdown: {
        normal_quit_requested: true,
        application_exited: true,
        runtime_children_exited: true,
        kernel_uds_removed: true,
      },
    };
    for (const digest of Object.values(evidence.application)) {
      if (!SHA256_PATTERN.test(digest))
        throw new Error("desktop launch evidence contains an invalid digest");
    }
    completed = true;
    await rm(state, { recursive: true, force: true });
    return evidence;
  } finally {
    if (!completed) {
      if (child !== null)
        await terminateOwnedProcessTree(child).catch(() => undefined);
      await logHandle?.close().catch(() => undefined);
    }
  }
}

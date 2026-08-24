/**
 * Fixed-path lifecycle supervisor for the packaged Terminus runtime.
 *
 * This is the narrow ADR-0039 bootstrap exception. It executes only the
 * manifest-bound kernel and control binaries shipped in Electron resources.
 */
import { createHash, randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { constants as fsConstants, createReadStream, type Stats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { createConnection } from "node:net";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  CONTROL_EXECUTABLE_PATH,
  CONTROL_MANIFEST_PATH,
  KERNEL_EXECUTABLE_PATH,
  MAX_RUNTIME_BYTES,
  MAX_RUNTIME_FILES,
  MAX_RUNTIME_MANIFEST_BYTES,
  QUERY_ENGINE_PATH,
  RESIGNED_CONTROL_PATHS,
  RUNTIME_TARGETS,
  decodeControlRuntimeManifest,
  decodeDesktopRuntimeManifest,
  requireRuntimeArchitecture,
  requireRuntimeBuildKind,
  requireRuntimeCommit,
  requireRuntimeVersion,
  requireSafeRelativePath,
  type ControlManifestFile,
  type DesktopRuntimeArchitecture,
  type DesktopRuntimeBuildKind,
  type DigestReference,
} from "./runtime-contract";

const STARTUP_TIMEOUT_MS = 30_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const SOCKET_PROBE_TIMEOUT_MS = 1_000;
const MAX_MIGRATION_OUTPUT_BYTES = 64 * 1_024;
const MAX_HEALTH_BYTES = 64 * 1_024;
const MAX_CONTROL_READY_BYTES = 4 * 1_024;
const HEALTH_MONITOR_INTERVAL_MS = 2_000;
const HEALTH_MONITOR_FAILURE_LIMIT = 2;
const MAX_DARWIN_UDS_PATH_BYTES = 103;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

type RuntimeChildName = "kernel" | "control";

export interface PackagedRuntimeLayout {
  readonly root: string;
  readonly manifest: string;
  readonly kernel: string;
  readonly controlRoot: string;
  readonly controlManifest: string;
  readonly control: string;
  readonly queryEngine: string;
}

export interface VerifiedRuntimeIdentity {
  readonly buildKind: DesktopRuntimeBuildKind;
  readonly version: string;
  readonly candidateCommit: string;
  readonly architecture: DesktopRuntimeArchitecture;
  readonly target: string;
}

export interface StandaloneRuntimeStartInput {
  readonly resourcesPath: string;
  readonly userDataPath: string;
  readonly platform: NodeJS.Platform;
  readonly architecture: string;
  readonly expectedVersion: string;
  readonly expectedCommit: string;
  readonly expectedBuildKind: DesktopRuntimeBuildKind;
  readonly providerCommandJson?: string | undefined;
  readonly onFatalError: (error: Error) => void;
}

export interface StandaloneRuntimeConnection {
  readonly apiBase: string;
  readonly controlToken: string;
  readonly identity: VerifiedRuntimeIdentity;
  readonly logPath: string;
}

interface ManagedChild {
  readonly name: RuntimeChildName;
  readonly process: ChildProcess;
  readonly readyStream: NodeJS.ReadableStream | null;
  failure: Error | null;
}

interface RuntimeStatePaths {
  readonly database: string;
  readonly kernelData: string;
  readonly kernelSocket: string;
  readonly log: string;
}

interface RuntimeEnvironmentInput extends RuntimeStatePaths {
  readonly userDataPath: string;
  readonly controlToken: string;
  readonly controlInstanceNonce: string;
  readonly bootstrapToken: string;
  readonly candidateCommit: string;
  readonly version: string;
  readonly parentPid: number;
  readonly providerCommandJson?: string | undefined;
}

export interface StandaloneHealthProbeInput {
  readonly apiBase: string;
  readonly token: string;
  readonly expectedIdentity: VerifiedRuntimeIdentity;
  readonly expectedNonce: string;
}

export interface RuntimeEnvironments {
  readonly migration: NodeJS.ProcessEnv;
  readonly kernel: NodeJS.ProcessEnv;
  readonly control: NodeJS.ProcessEnv;
}

export function packagedRuntimeLayout(
  resourcesPath: string,
  platform: NodeJS.Platform,
  architecture: string,
): PackagedRuntimeLayout {
  if (platform !== "darwin") throw new Error(`the packaged desktop runtime does not support ${platform}`);
  requireRuntimeArchitecture(architecture);
  if (!isAbsolute(resourcesPath)) throw new Error("Electron resourcesPath must be absolute");
  const root = resolve(resourcesPath, "runtime");
  if (!isWithin(resourcesPath, root)) throw new Error("packaged runtime escaped Electron resources");
  const controlRoot = join(root, "terminus-control");
  return {
    root,
    manifest: join(root, "manifest.json"),
    kernel: join(root, "bin", "terminus-kernel-mini"),
    controlRoot,
    controlManifest: join(controlRoot, "manifest.json"),
    control: join(controlRoot, "bin", "terminus-control"),
    queryEngine: join(controlRoot, "lib", "terminus", "query-engine.node"),
  };
}

export async function verifyPackagedRuntime(
  layout: PackagedRuntimeLayout,
  architecture: string,
  expectedVersion: string,
  expectedCommit: string,
  expectedBuildKind: DesktopRuntimeBuildKind,
): Promise<VerifiedRuntimeIdentity> {
  const supportedArchitecture = requireRuntimeArchitecture(architecture);
  const version = requireRuntimeVersion(expectedVersion);
  const commit = requireRuntimeCommit(expectedCommit);
  const buildKind = requireRuntimeBuildKind(expectedBuildKind);
  const expectedTarget = RUNTIME_TARGETS[supportedArchitecture];
  await requireRealDirectory(layout.root, "desktop runtime root");
  await requireRealDirectory(layout.controlRoot, "control runtime root");
  const desktop = decodeDesktopRuntimeManifest(await readBoundedJson(layout.manifest));
  if (
    desktop.architecture !== supportedArchitecture
    || desktop.target !== expectedTarget
    || desktop.version !== version
    || desktop.candidate_commit !== commit
    || desktop.build_kind !== buildKind
  ) {
    throw new Error("desktop runtime identity does not match the packaged application");
  }
  assertExactReference(desktop.control.manifest, CONTROL_MANIFEST_PATH, "control manifest");
  assertExactReference(desktop.control.executable, CONTROL_EXECUTABLE_PATH, "control executable");
  assertExactReference(desktop.control.query_engine, QUERY_ENGINE_PATH, "query engine");
  assertExactReference(desktop.kernel.executable, KERNEL_EXECUTABLE_PATH, "kernel executable");
  await Promise.all([
    verifyDigestReference(layout.root, desktop.control.manifest, "control manifest"),
    verifyDigestReference(layout.root, desktop.control.executable, "control executable"),
    verifyDigestReference(layout.root, desktop.control.query_engine, "query engine"),
    verifyDigestReference(layout.root, desktop.kernel.executable, "kernel executable"),
  ]);

  const control = decodeControlRuntimeManifest(await readBoundedJson(layout.controlManifest));
  if (
    control.version !== version
    || control.candidate_commit !== commit
    || control.target.rust !== expectedTarget
    || (buildKind === "release" && !control.source_tree_clean)
  ) {
    throw new Error("nested control runtime identity does not match the packaged application");
  }
  const declaredControl = new Set<string>();
  for (const file of control.files) {
    declaredControl.add(file.path);
    await verifyControlFile(layout.controlRoot, file);
  }
  for (const required of [
    "bin/terminus-control",
    "lib/terminus/query-engine.node",
    "share/terminus/schema.prisma",
  ]) {
    if (!declaredControl.has(required)) throw new Error(`control runtime is missing ${required}`);
  }
  if (![...declaredControl].some((path) => /^share\/terminus\/migrations\/sqlite\/\d+_.+\.sql$/.test(path))) {
    throw new Error("control runtime contains no SQLite migrations");
  }

  const expectedFiles = new Set<string>([
    "manifest.json",
    CONTROL_MANIFEST_PATH,
    KERNEL_EXECUTABLE_PATH,
    ...[...declaredControl].map((path) => `terminus-control/${path}`),
  ]);
  const actualFiles = new Set(await walkRuntimeFiles(layout.root));
  const undeclared = [...actualFiles].filter((path) => !expectedFiles.has(path));
  const missing = [...expectedFiles].filter((path) => !actualFiles.has(path));
  if (undeclared.length > 0 || missing.length > 0) {
    throw new Error(
      `desktop runtime inventory mismatch; undeclared=${undeclared.join(",")}; missing=${missing.join(",")}`,
    );
  }
  await requireMode(layout.manifest, 0o644, "desktop runtime manifest");
  await requireMode(layout.controlManifest, 0o644, "control runtime manifest");
  await requireMode(layout.kernel, 0o755, "kernel executable");
  await requireMode(layout.control, 0o755, "control executable");
  return {
    buildKind,
    version,
    candidateCommit: commit,
    architecture: supportedArchitecture,
    target: expectedTarget,
  };
}

async function verifyControlFile(root: string, file: ControlManifestFile): Promise<void> {
  const path = resolveManifestPath(root, file.path);
  const details = await requireRegularFile(path, `control runtime file ${file.path}`);
  const expectedMode = file.mode === "0755" ? 0o755 : 0o644;
  if ((details.mode & 0o777) !== expectedMode) {
    throw new Error(`control runtime file mode mismatch for ${file.path}`);
  }
  // Codesigning rewrites these two Mach-O files after archive extraction.
  // Their final bytes are bound by the outer desktop manifest.
  if (!RESIGNED_CONTROL_PATHS.has(file.path)) {
    if (details.size !== file.size) throw new Error(`control runtime file size mismatch for ${file.path}`);
    if (await sha256File(path) !== file.sha256) {
      throw new Error(`control runtime file digest mismatch for ${file.path}`);
    }
  }
}

export class StandaloneRuntimeSupervisor {
  private readonly children: ManagedChild[] = [];
  private stopPromise: Promise<void> | null = null;
  private ready = false;
  private fatalReported = false;
  private logHandle: FileHandle | null = null;
  private healthMonitor: NodeJS.Timeout | null = null;
  private healthProbeInFlight = false;
  private healthFailures = 0;

  private constructor(
    private readonly input: StandaloneRuntimeStartInput,
    private readonly layout: PackagedRuntimeLayout,
    private readonly stateRoot: string,
    private readonly paths: RuntimeStatePaths,
    private connection: StandaloneRuntimeConnection,
  ) {}

  static async start(input: StandaloneRuntimeStartInput): Promise<StandaloneRuntimeSupervisor> {
    process.umask(0o077);
    const layout = packagedRuntimeLayout(input.resourcesPath, input.platform, input.architecture);
    const identity = await verifyPackagedRuntime(
      layout,
      input.architecture,
      input.expectedVersion,
      input.expectedCommit,
      input.expectedBuildKind,
    );
    if (!isAbsolute(input.userDataPath)) throw new Error("Electron userData path must be absolute");
    const stateRoot = join(input.userDataPath, "runtime");
    const paths: RuntimeStatePaths = {
      database: join(stateRoot, "control.db"),
      kernelData: join(stateRoot, "kernel-data"),
      kernelSocket: join(stateRoot, "kernel.sock"),
      log: join(stateRoot, "runtime.log"),
    };
    if (Buffer.byteLength(paths.kernelSocket) > MAX_DARWIN_UDS_PATH_BYTES) {
      throw new Error("standalone runtime UDS path exceeds the Darwin sockaddr_un limit");
    }
    const connection: StandaloneRuntimeConnection = {
      apiBase: "http://127.0.0.1:0",
      controlToken: randomToken(),
      identity,
      logPath: paths.log,
    };
    const supervisor = new StandaloneRuntimeSupervisor(input, layout, stateRoot, paths, connection);
    try {
      await supervisor.startChildren();
      return supervisor;
    } catch (error: unknown) {
      await supervisor.stop().catch(() => undefined);
      throw asError(error);
    }
  }

  details(): StandaloneRuntimeConnection {
    return this.connection;
  }

  stop(): Promise<void> {
    this.stopPromise ??= this.stopOwnedRuntime();
    return this.stopPromise;
  }

  private async startChildren(): Promise<void> {
    await prepareState(this.input.userDataPath, this.stateRoot, this.paths);
    await removeStaleSocket(this.paths.kernelSocket);
    this.logHandle = await openPrivateLog(this.paths.log);
    const controlInstanceNonce = randomToken();
    const environments = runtimeEnvironments({
      ...this.paths,
      userDataPath: this.input.userDataPath,
      controlToken: this.connection.controlToken,
      controlInstanceNonce,
      bootstrapToken: randomToken(),
      candidateCommit: this.connection.identity.candidateCommit,
      version: this.connection.identity.version,
      parentPid: process.pid,
      providerCommandJson: this.input.providerCommandJson,
    });
    const migration = spawn(this.layout.control, ["migrate"], {
      cwd: this.stateRoot,
      env: environments.migration,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const migrationResult = await collectBoundedChild(
      migration,
      MAX_MIGRATION_OUTPUT_BYTES,
      STARTUP_TIMEOUT_MS,
    );
    if (migrationResult.exitCode !== 0) {
      throw new Error(`control migration failed with exit ${migrationResult.exitCode}: ${migrationResult.output}`);
    }
    await verifyPrivateStateFiles(this.paths, true);

    const kernel = this.spawnService("kernel", this.layout.kernel, [], environments.kernel);
    await waitForSocket(this.paths.kernelSocket, kernel, STARTUP_TIMEOUT_MS);
    const control = this.spawnService(
      "control",
      this.layout.control,
      ["serve"],
      environments.control,
      true,
    );
    const controlPort = await waitForControlReady(
      control,
      controlInstanceNonce,
      STARTUP_TIMEOUT_MS,
    );
    this.connection = {
      ...this.connection,
      apiBase: `http://127.0.0.1:${controlPort}`,
    };
    await waitForHealth({
      apiBase: this.connection.apiBase,
      token: this.connection.controlToken,
      expectedIdentity: this.connection.identity,
      expectedNonce: controlInstanceNonce,
      kernel,
      control,
      timeoutMs: STARTUP_TIMEOUT_MS,
    });
    await verifyPrivateStateFiles(this.paths, true);
    assertManagedChildRunning(kernel, "kernel exited during standalone startup");
    assertManagedChildRunning(control, "control exited during standalone startup");
    this.ready = true;
    this.startHealthMonitor({
      apiBase: this.connection.apiBase,
      token: this.connection.controlToken,
      expectedIdentity: this.connection.identity,
      expectedNonce: controlInstanceNonce,
      kernel,
      control,
    });
  }

  private spawnService(
    name: RuntimeChildName,
    executable: string,
    args: readonly string[],
    environment: NodeJS.ProcessEnv,
    readinessPipe = false,
  ): ManagedChild {
    if (this.logHandle === null) throw new Error("runtime log was not opened");
    const child = spawn(executable, [...args], {
      cwd: this.stateRoot,
      env: environment,
      shell: false,
      windowsHide: true,
      stdio: readinessPipe
        ? ["ignore", this.logHandle.fd, this.logHandle.fd, "pipe"]
        : ["ignore", this.logHandle.fd, this.logHandle.fd],
    });
    const readinessDescriptor = readinessPipe ? child.stdio[3] : null;
    const readyStream = readinessDescriptor !== null
      && readinessDescriptor !== undefined
      && "read" in readinessDescriptor
      ? readinessDescriptor as NodeJS.ReadableStream
      : null;
    if (readinessPipe && readyStream === null) {
      child.kill("SIGKILL");
      throw new Error(`${name} readiness pipe was not created`);
    }
    const managed: ManagedChild = { name, process: child, readyStream, failure: null };
    this.children.push(managed);
    child.once("error", (error) => {
      managed.failure = new Error(`${name} process error: ${error.message}`);
      if (this.ready) this.reportFatal(managed.failure);
    });
    child.once("exit", (code, signal) => {
      if (this.ready && this.stopPromise === null) {
        this.reportFatal(new Error(
          `${name} exited unexpectedly (code=${String(code)}, signal=${String(signal)})`,
        ));
      }
    });
    return managed;
  }

  private reportFatal(error: Error): void {
    if (this.fatalReported || this.stopPromise !== null) return;
    this.fatalReported = true;
    const cleanup = this.stop();
    this.input.onFatalError(error);
    void cleanup.catch((cleanupError: unknown) => {
      console.error("[terminus-desktop] failed to stop standalone runtime", cleanupError);
    });
  }

  private startHealthMonitor(input: HealthProbeInput): void {
    if (this.healthMonitor !== null) throw new Error("standalone health monitor already started");
    this.healthMonitor = setInterval(() => {
      if (this.healthProbeInFlight || this.stopPromise !== null) return;
      this.healthProbeInFlight = true;
      void this.checkRuntimeHealth(input).finally(() => {
        this.healthProbeInFlight = false;
      });
    }, HEALTH_MONITOR_INTERVAL_MS);
    this.healthMonitor.unref();
  }

  private async checkRuntimeHealth(input: HealthProbeInput): Promise<void> {
    try {
      assertManagedChildRunning(input.kernel, "kernel exited during health monitoring");
      assertManagedChildRunning(input.control, "control exited during health monitoring");
      await probeStandaloneControlHealth(input);
      this.healthFailures = 0;
    } catch (error: unknown) {
      this.healthFailures += 1;
      if (this.healthFailures >= HEALTH_MONITOR_FAILURE_LIMIT) {
        this.reportFatal(new Error(
          `standalone runtime failed ${this.healthFailures} consecutive health probes: ${asError(error).message}`,
        ));
      }
    }
  }

  private async stopOwnedRuntime(): Promise<void> {
    this.ready = false;
    if (this.healthMonitor !== null) clearInterval(this.healthMonitor);
    this.healthMonitor = null;
    const failures: Error[] = [];
    for (const child of [...this.children].reverse()) {
      try {
        await stopChild(child.process);
      } catch (error: unknown) {
        failures.push(asError(error));
      }
    }
    this.children.length = 0;
    try {
      await this.logHandle?.close();
    } catch (error: unknown) {
      failures.push(asError(error));
    }
    this.logHandle = null;
    try {
      await removeStaleSocket(this.paths.kernelSocket);
    } catch (error: unknown) {
      failures.push(asError(error));
    }
    if (failures.length > 0) {
      throw new Error(`standalone runtime cleanup failed: ${failures.map((error) => error.message).join("; ")}`);
    }
  }
}

export function runtimeEnvironments(input: RuntimeEnvironmentInput): RuntimeEnvironments {
  for (const [label, token] of [
    ["control token", input.controlToken],
    ["control instance nonce", input.controlInstanceNonce],
    ["bootstrap token", input.bootstrapToken],
  ] as const) {
    if (!TOKEN_PATTERN.test(token)) throw new Error(`${label} is not a base64url capability`);
  }
  requireRuntimeCommit(input.candidateCommit);
  requireRuntimeVersion(input.version);
  if (!Number.isSafeInteger(input.parentPid) || input.parentPid <= 1) throw new Error("desktop parent PID is invalid");
  const common = (): NodeJS.ProcessEnv => ({
    HOME: input.userDataPath,
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    LANG: "en_US.UTF-8",
    TERMINUS_DESKTOP_PARENT_PID: String(input.parentPid),
  });
  const migration: NodeJS.ProcessEnv = {
    ...common(),
    DATABASE_URL: `file:${input.database}`,
  };
  const kernel: NodeJS.ProcessEnv = {
    ...common(),
    TERMINUS_DATA: input.kernelData,
    TERMINUS_KERNEL_GRPC_SOCKET: input.kernelSocket,
    TERMINUS_KERNEL_REQUIRE_UDS: "1",
    TERMINUS_KERNEL_CONTROL_BOOTSTRAP: "1",
    TERMINUS_KERNEL_CONTROL_BOOTSTRAP_TOKEN: input.bootstrapToken,
    TERMINUS_KERNEL_TOKEN: randomToken(),
    TERMINUS_BUILD_COMMIT: input.candidateCommit,
    TERMINUS_RUNTIME_VERSION: input.version,
    RUST_LOG: "info",
  };
  const control: NodeJS.ProcessEnv = {
    ...common(),
    DATABASE_URL: `file:${input.database}`,
    TERMINUS_KERNEL_GRPC_SOCKET: input.kernelSocket,
    TERMINUS_KERNEL_CONTROL_BOOTSTRAP_TOKEN: input.bootstrapToken,
    TERMINUS_CONTROL_TOKEN: input.controlToken,
    TERMINUS_CONTROL_PORT: "0",
    TERMINUS_CONTROL_READY_FD: "3",
    TERMINUS_CONTROL_CORS_ORIGIN: "terminus://app",
    TERMINUS_CONTROL_INSTANCE_NONCE: input.controlInstanceNonce,
  };
  if (input.providerCommandJson !== undefined && input.providerCommandJson.trim().length > 0) {
    control.TERMINUS_LOCAL_PROVIDER_COMMAND_JSON = input.providerCommandJson;
  }
  return { migration, kernel, control };
}

async function prepareState(
  userDataPath: string,
  stateRoot: string,
  paths: RuntimeStatePaths,
): Promise<void> {
  await requireOwnedDirectory(userDataPath, "Electron userData directory");
  await ensureOwnedDirectory(stateRoot);
  await ensureOwnedDirectory(paths.kernelData);
  await verifyPrivateStateFiles(paths, false);
}

async function requireOwnedDirectory(path: string, label: string): Promise<void> {
  const details = await lstat(path);
  if (!details.isDirectory() || details.isSymbolicLink()) throw new Error(`${label} is not a real directory: ${path}`);
  requireOwned(details.uid, `${label} is not owned by this user: ${path}`);
}

async function ensureOwnedDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const details = await lstat(path);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error(`runtime state path is not a real directory: ${path}`);
  }
  requireOwned(details.uid, `runtime state directory is not owned by this user: ${path}`);
  if ((details.mode & 0o077) !== 0) {
    throw new Error(`runtime state directory must already be owner-only: ${path}`);
  }
}

async function openPrivateLog(path: string): Promise<FileHandle> {
  await verifyOwnedPrivateFile(path, false);
  const handle = await open(
    path,
    fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    const details = await handle.stat();
    if (!details.isFile()) throw new Error(`runtime log is not a regular file: ${path}`);
    requireOwned(details.uid, `runtime log is not owned by this user: ${path}`);
    await handle.chmod(0o600);
    return handle;
  } catch (error: unknown) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function verifyPrivateStateFiles(paths: RuntimeStatePaths, requireDatabase: boolean): Promise<void> {
  await verifyOwnedPrivateFile(paths.database, requireDatabase);
  await verifyOwnedPrivateFile(`${paths.database}-wal`, false);
  await verifyOwnedPrivateFile(`${paths.database}-shm`, false);
  await verifyOwnedPrivateFile(paths.log, false);
}

async function verifyOwnedPrivateFile(path: string, required: boolean): Promise<void> {
  try {
    const details = await lstat(path);
    if (!details.isFile() || details.isSymbolicLink()) {
      throw new Error(`runtime state file is not a regular file: ${path}`);
    }
    requireOwned(details.uid, `runtime state file is not owned by this user: ${path}`);
    if ((details.mode & 0o077) !== 0) {
      throw new Error(`runtime state file must already be owner-only: ${path}`);
    }
  } catch (error: unknown) {
    if (!required && isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
}

function requireOwned(uid: number, message: string): void {
  const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
  if (currentUid !== null && uid !== currentUid) throw new Error(message);
}

async function removeStaleSocket(path: string): Promise<void> {
  let details: Stats;
  try {
    details = await lstat(path);
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
  if (!details.isSocket() || details.isSymbolicLink()) {
    throw new Error(`refusing to replace non-socket runtime path: ${path}`);
  }
  requireOwned(details.uid, `runtime socket is not owned by this user: ${path}`);
  if ((details.mode & 0o077) !== 0) throw new Error(`runtime socket is not owner-only: ${path}`);
  if (await probeSocket(path) === "live") throw new Error(`refusing to detach a live runtime socket: ${path}`);
  await unlink(path);
}

async function probeSocket(path: string): Promise<"live" | "stale"> {
  return new Promise((resolveProbe, rejectProbe) => {
    const socket = createConnection({ path });
    let settled = false;
    const timer = setTimeout(() => finish(new Error(`timed out probing runtime socket: ${path}`)), SOCKET_PROBE_TIMEOUT_MS);
    const finish = (result: "live" | "stale" | Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (result instanceof Error) rejectProbe(result);
      else resolveProbe(result);
    };
    socket.once("connect", () => finish("live"));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT") finish("stale");
      else finish(new Error(`failed to probe runtime socket ${path}: ${error.message}`));
    });
  });
}

async function waitForSocket(path: string, child: ManagedChild, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    assertManagedChildRunning(child, "kernel exited before its private UDS became ready");
    try {
      const details = await lstat(path);
      if (!details.isSocket() || details.isSymbolicLink()) throw new Error(`kernel UDS path is not a socket: ${path}`);
      requireOwned(details.uid, `kernel UDS is not owned by this user: ${path}`);
      if ((details.mode & 0o077) !== 0) throw new Error(`kernel UDS is not owner-only: ${path}`);
      return;
    } catch (error: unknown) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    }
    await delay(50);
  }
  throw new Error(`kernel UDS did not become ready within ${timeoutMs}ms`);
}

async function waitForControlReady(
  child: ManagedChild,
  expectedNonce: string,
  timeoutMs: number,
): Promise<number> {
  const stream = child.readyStream;
  if (stream === null) throw new Error("control readiness pipe is unavailable");
  return new Promise<number>((resolveReady, rejectReady) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const timer = setTimeout(
      () => finish(new Error(`control did not report its bound port within ${timeoutMs}ms`)),
      timeoutMs,
    );
    const cleanup = (): void => {
      clearTimeout(timer);
      stream.removeListener("data", onData);
      stream.removeListener("error", onError);
      stream.removeListener("end", onEnd);
      child.process.removeListener("exit", onExit);
    };
    const finish = (result: number | Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (result instanceof Error) rejectReady(result);
      else resolveReady(result);
    };
    const decode = (): void => {
      const newline = Buffer.concat(chunks).indexOf(0x0a);
      if (newline < 0) return;
      try {
        const value = requireObject(
          JSON.parse(Buffer.concat(chunks).subarray(0, newline).toString("utf8")) as unknown,
          "control readiness message",
        );
        const fields = Object.keys(value).sort().join(",");
        if (fields !== "instance_id,port,schema") {
          throw new Error(`control readiness fields are invalid: ${fields}`);
        }
        if (value.schema !== "terminus.control-ready.v1" || value.instance_id !== expectedNonce) {
          throw new Error("control readiness identity mismatch");
        }
        if (typeof value.port !== "number" || !Number.isInteger(value.port) || value.port < 1 || value.port > 65_535) {
          throw new Error("control readiness port is invalid");
        }
        finish(value.port);
      } catch (error: unknown) {
        finish(asError(error));
      }
    };
    const onData = (chunk: Buffer | string): void => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += value.byteLength;
      if (bytes > MAX_CONTROL_READY_BYTES) {
        finish(new Error(`control readiness message exceeds ${MAX_CONTROL_READY_BYTES} bytes`));
        return;
      }
      chunks.push(value);
      decode();
    };
    const onError = (error: Error): void => finish(new Error(`control readiness pipe failed: ${error.message}`));
    const onEnd = (): void => finish(new Error("control readiness pipe ended before a valid message"));
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      finish(new Error(`control exited before readiness (code=${String(code)}, signal=${String(signal)})`));
    };
    stream.on("data", onData);
    stream.once("error", onError);
    stream.once("end", onEnd);
    child.process.once("exit", onExit);
  });
}

interface HealthWaitInput extends StandaloneHealthProbeInput {
  readonly kernel: ManagedChild;
  readonly control: ManagedChild;
  readonly timeoutMs: number;
}

type HealthProbeInput = Omit<HealthWaitInput, "timeoutMs">;

async function waitForHealth(input: HealthWaitInput): Promise<void> {
  const deadline = Date.now() + input.timeoutMs;
  let lastError = "health endpoint did not respond";
  while (Date.now() < deadline) {
    assertManagedChildRunning(input.kernel, "kernel exited before standalone health became ready");
    assertManagedChildRunning(input.control, "control exited before standalone health became ready");
    try {
      await probeStandaloneControlHealth(input);
      return;
    } catch (error: unknown) {
      lastError = asError(error).message;
    }
    await delay(100);
  }
  throw new Error(`standalone runtime did not become ready within ${input.timeoutMs}ms: ${lastError}`);
}

export async function probeStandaloneControlHealth(
  input: StandaloneHealthProbeInput,
): Promise<void> {
  const signal = typeof process !== "undefined" && process.env.VITEST ? undefined : AbortSignal.timeout(1_000);
  const healthResponse = await fetch(`${input.apiBase}/v1/system/health`, {
    cache: "no-store",
    redirect: "error",
    signal,
  });
  if (!healthResponse.ok) throw new Error(`health returned HTTP ${healthResponse.status}`);
  const health = requireObject(
    await readBoundedResponseJson(healthResponse, MAX_HEALTH_BYTES),
    "standalone health response",
  );
  const writer = requireObject(health.writer, "standalone health writer");
  const exactIdentity = health.version === input.expectedIdentity.version
    && health.build_commit === input.expectedIdentity.candidateCommit
    && health.instance_id === input.expectedNonce;
  if (health.status !== "ok" || health.ready !== true || writer.healthy !== true || !exactIdentity) {
    throw new Error(`health identity/readiness mismatch: ${JSON.stringify(health)}`);
  }
  // Do not send the bearer capability until the nonce proves this is the
  // child we launched rather than an ambient process occupying the port.
  const authenticated = await fetch(`${input.apiBase}/v1/sessions?limit=1`, {
    headers: { Authorization: `Bearer ${input.token}` },
    cache: "no-store",
    redirect: "error",
    signal,
  });
  const authenticatedStatus = authenticated.status;
  await authenticated.body?.cancel();
  if (!authenticated.ok) {
    throw new Error(`authenticated control probe returned HTTP ${authenticatedStatus}`);
  }
}

function assertManagedChildRunning(child: ManagedChild, message: string): void {
  if (child.failure !== null) throw child.failure;
  if (child.process.exitCode !== null || child.process.signalCode !== null) {
    throw new Error(`${message} (code=${String(child.process.exitCode)}, signal=${String(child.process.signalCode)})`);
  }
}

async function collectBoundedChild(
  child: ChildProcess,
  maximumBytes: number,
  timeoutMs: number,
): Promise<{ readonly exitCode: number; readonly output: string }> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let truncated = false;
  const collect = (chunk: Buffer | string): void => {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = Math.max(0, maximumBytes - bytes);
    if (remaining > 0) {
      const kept = value.subarray(0, remaining);
      chunks.push(kept);
      bytes += kept.byteLength;
    }
    if (value.byteLength > remaining) truncated = true;
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  const exit = new Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>(
    (resolveExit, rejectExit) => {
      child.once("error", rejectExit);
      child.once("exit", (code, signal) => resolveExit({ code, signal }));
    },
  );
  const result = await Promise.race([
    exit.then((value) => ({ kind: "exit" as const, value })),
    delay(timeoutMs).then(() => ({ kind: "timeout" as const })),
  ]);
  if (result.kind === "timeout") {
    await stopChild(child);
    throw new Error(`control migration timed out after ${timeoutMs}ms: ${boundedOutput(chunks, truncated, maximumBytes)}`);
  }
  return {
    exitCode: result.value.code ?? (result.value.signal === null ? 1 : 128),
    output: boundedOutput(chunks, truncated, maximumBytes),
  };
}

function boundedOutput(chunks: readonly Buffer[], truncated: boolean, maximumBytes: number): string {
  const suffix = truncated ? `\n[output truncated after ${maximumBytes} bytes]` : "";
  return `${Buffer.concat(chunks).toString("utf8")}${suffix}`.trim();
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
  child.kill("SIGTERM");
  const graceful = await Promise.race([exited.then(() => true), delay(SHUTDOWN_TIMEOUT_MS).then(() => false)]);
  if (graceful) return;
  child.kill("SIGKILL");
  const killed = await Promise.race([exited.then(() => true), delay(1_000).then(() => false)]);
  if (!killed && child.exitCode === null && child.signalCode === null) {
    throw new Error(`runtime process ${String(child.pid)} did not exit after SIGKILL`);
  }
}

async function walkRuntimeFiles(root: string): Promise<readonly string[]> {
  const files: string[] = [];
  let totalBytes = 0;
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`desktop runtime may not contain symlinks: ${path}`);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        const details = await lstat(path);
        totalBytes += details.size;
        files.push(relative(root, path).split(sep).join("/"));
        if (files.length > MAX_RUNTIME_FILES || totalBytes > MAX_RUNTIME_BYTES) {
          throw new Error("desktop runtime exceeds its bounded inventory");
        }
      } else throw new Error(`desktop runtime contains a special file: ${path}`);
    }
  }
  await visit(root);
  return files.sort((left, right) => left.localeCompare(right));
}

async function verifyDigestReference(root: string, reference: DigestReference, label: string): Promise<void> {
  const path = resolveManifestPath(root, reference.path);
  await requireRegularFile(path, label);
  if (await sha256File(path) !== reference.sha256) throw new Error(`${label} digest mismatch`);
}

async function requireRealDirectory(path: string, label: string): Promise<void> {
  const details = await lstat(path);
  if (!details.isDirectory() || details.isSymbolicLink()) throw new Error(`${label} is not a real directory: ${path}`);
}

async function requireRegularFile(path: string, label: string): Promise<Stats> {
  const details = await lstat(path);
  if (!details.isFile() || details.isSymbolicLink()) throw new Error(`${label} is not a regular file: ${path}`);
  return details;
}

async function requireMode(path: string, expected: number, label: string): Promise<void> {
  const details = await requireRegularFile(path, label);
  if ((details.mode & 0o777) !== expected) {
    throw new Error(`${label} mode must be ${expected.toString(8).padStart(4, "0")}`);
  }
}

function assertExactReference(reference: DigestReference, expectedPath: string, label: string): void {
  if (reference.path !== expectedPath) throw new Error(`${label} path must be ${expectedPath}`);
}

function resolveManifestPath(root: string, relativePath: string): string {
  const safe = requireSafeRelativePath(relativePath, "runtime manifest path");
  const path = resolve(root, ...safe.split("/"));
  if (!isWithin(root, path)) throw new Error(`runtime manifest path escaped its root: ${relativePath}`);
  return path;
}

function isWithin(parent: string, child: string): boolean {
  const root = resolve(parent);
  const candidate = resolve(child);
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

async function readBoundedJson(path: string): Promise<unknown> {
  try {
    const details = await requireRegularFile(path, "runtime manifest");
    if (details.size > MAX_RUNTIME_MANIFEST_BYTES) throw new Error("manifest exceeds the byte limit");
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error: unknown) {
    throw new Error(`runtime manifest ${path} is unreadable: ${asError(error).message}`);
  }
}

async function readBoundedResponseJson(response: Response, maximumBytes: number): Promise<unknown> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0) {
      await response.body?.cancel();
      throw new Error("health response has an invalid content-length");
    }
    if (length > maximumBytes) {
      await response.body?.cancel();
      throw new Error(`health response exceeds ${maximumBytes} bytes`);
    }
  }
  if (response.body === null) throw new Error("health response has no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel();
        throw new Error(`health response exceeds ${maximumBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

async function sha256File(path: string): Promise<string> {
  return new Promise((resolveDigest, rejectDigest) => {
    const hash = createHash("sha256");
    const input = createReadStream(path);
    input.on("data", (chunk) => hash.update(chunk));
    input.once("error", rejectDigest);
    input.once("end", () => resolveDigest(hash.digest("hex")));
  });
}

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

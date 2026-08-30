import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  packagedRuntimeLayout,
  probeStandaloneControlHealth,
  runtimeEnvironments,
  StandaloneRuntimeSupervisor,
  userToolchainPath,
  verifyPackagedRuntime,
} from "../electron/runtime-supervisor";

const VERSION = "0.1.0";
const COMMIT = "a".repeat(40);

interface RuntimeFixture {
  readonly temporaryRoot: string;
  readonly resources: string;
  readonly layout: ReturnType<typeof packagedRuntimeLayout>;
}

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function sha256(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function writeRuntimeFile(root: string, path: string, contents: string, mode: number): Promise<void> {
  const destination = join(root, ...path.split("/"));
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, contents, { mode });
  await chmod(destination, mode);
}

async function runtimeFixture(
  buildKind: "release" | "local" = "release",
  sourceTreeClean = true,
): Promise<RuntimeFixture> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "terminus-desktop-runtime-test-"));
  temporaryRoots.push(temporaryRoot);
  const resources = join(temporaryRoot, "resources");
  const runtime = join(resources, "runtime");
  const controlRoot = join(runtime, "terminus-control");
  await mkdir(controlRoot, { recursive: true });

  const controlFiles = [
    { path: "bin/terminus-control", contents: "control-binary", mode: "0755" as const },
    { path: "lib/terminus/query-engine.node", contents: "query-engine", mode: "0644" as const },
    { path: "share/terminus/schema.prisma", contents: "datasource db {}", mode: "0644" as const },
    { path: "share/terminus/migrations/sqlite/0001_base.sql", contents: "CREATE TABLE base(id TEXT);", mode: "0644" as const },
  ];
  for (const file of controlFiles) {
    await writeRuntimeFile(controlRoot, file.path, file.contents, file.mode === "0755" ? 0o755 : 0o644);
  }
  const controlManifest = {
    schema: "terminus.control-runtime.v1",
    version: VERSION,
    candidate_commit: COMMIT,
    source_tree_clean: sourceTreeClean,
    source_date_epoch: 1_700_000_000,
    target: {
      rust: "aarch64-apple-darwin",
      bun: "bun-darwin-arm64",
      prisma: "darwin-arm64",
    },
    toolchain: { bun: "1.3.14", prisma_client: "6.11.1" },
    entrypoint: "bin/terminus-control",
    files: controlFiles.map((file) => ({
      path: file.path,
      sha256: sha256(file.contents),
      size: Buffer.byteLength(file.contents),
      mode: file.mode,
    })),
  };
  const controlManifestBytes = `${JSON.stringify(controlManifest, null, 2)}\n`;
  await writeRuntimeFile(controlRoot, "manifest.json", controlManifestBytes, 0o644);
  await writeRuntimeFile(runtime, "bin/terminus-kernel-mini", "kernel-binary", 0o755);

  const reference = async (path: string): Promise<{ readonly path: string; readonly sha256: string }> => ({
    path,
    sha256: sha256(await readFile(join(runtime, ...path.split("/")))),
  });
  const desktopManifest = {
    schema: "terminus.desktop-runtime.v1",
    build_kind: buildKind,
    version: VERSION,
    candidate_commit: COMMIT,
    architecture: "arm64",
    target: "aarch64-apple-darwin",
    control: {
      manifest: await reference("terminus-control/manifest.json"),
      executable: await reference("terminus-control/bin/terminus-control"),
      query_engine: await reference("terminus-control/lib/terminus/query-engine.node"),
    },
    kernel: { executable: await reference("bin/terminus-kernel-mini") },
  };
  await writeRuntimeFile(runtime, "manifest.json", `${JSON.stringify(desktopManifest, null, 2)}\n`, 0o644);
  return {
    temporaryRoot,
    resources,
    layout: packagedRuntimeLayout(resources, "darwin", "arm64"),
  };
}

describe("packaged standalone runtime", () => {
  it("accepts only the exact app-bound runtime inventory", async () => {
    const fixture = await runtimeFixture();
    await expect(verifyPackagedRuntime(fixture.layout, "arm64", VERSION, COMMIT, "release")).resolves.toEqual({
      buildKind: "release",
      version: VERSION,
      candidateCommit: COMMIT,
      architecture: "arm64",
      target: "aarch64-apple-darwin",
    });
    await expect(verifyPackagedRuntime(fixture.layout, "x64", VERSION, COMMIT, "release")).rejects.toThrow(
      "desktop runtime identity does not match",
    );
    await expect(verifyPackagedRuntime(fixture.layout, "arm64", "0.1.1", COMMIT, "release")).rejects.toThrow(
      "desktop runtime identity does not match",
    );
  });

  it("rejects a tampered manifest-bound executable", async () => {
    const fixture = await runtimeFixture();
    await writeFile(fixture.layout.kernel, "tampered");
    await expect(verifyPackagedRuntime(fixture.layout, "arm64", VERSION, COMMIT, "release")).rejects.toThrow(
      "kernel executable digest mismatch",
    );
  });

  it("rejects undeclared migrations and symlink substitution", async () => {
    const fixture = await runtimeFixture();
    const injected = join(
      fixture.layout.controlRoot,
      "share",
      "terminus",
      "migrations",
      "sqlite",
      "9999_injected.sql",
    );
    await writeFile(injected, "DROP TABLE base;");
    await expect(verifyPackagedRuntime(fixture.layout, "arm64", VERSION, COMMIT, "release")).rejects.toThrow(
      "inventory mismatch",
    );
    await rm(injected);

    const schema = join(fixture.layout.controlRoot, "share", "terminus", "schema.prisma");
    const external = join(fixture.temporaryRoot, "external-schema.prisma");
    await writeFile(external, "datasource injected {}");
    await unlink(schema);
    await symlink(external, schema);
    await expect(verifyPackagedRuntime(fixture.layout, "arm64", VERSION, COMMIT, "release")).rejects.toThrow(
      "not a regular file",
    );
  });

  it("binds dirty source truth to an explicit local build", async () => {
    const fixture = await runtimeFixture("local", false);
    await expect(
      verifyPackagedRuntime(fixture.layout, "arm64", VERSION, COMMIT, "local"),
    ).resolves.toMatchObject({ buildKind: "local" });
    await expect(
      verifyPackagedRuntime(fixture.layout, "arm64", VERSION, COMMIT, "release"),
    ).rejects.toThrow("desktop runtime identity does not match");
  });

  it("rejects an oversized pre-auth health body without disclosing the bearer", async () => {
    const authorizationHeaders: Array<string | undefined> = [];
    const server = createServer((request, response) => {
      authorizationHeaders.push(request.headers.authorization);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(Buffer.alloc(64 * 1_024 + 1, "x"));
    });
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(0, "127.0.0.1", resolveListen);
    });
    try {
      const address = server.address();
      if (typeof address !== "object" || address === null) throw new Error("test server has no TCP address");
      await expect(probeStandaloneControlHealth({
        apiBase: `http://127.0.0.1:${address.port}`,
        token: "t".repeat(43),
        expectedIdentity: {
          buildKind: "local",
          version: VERSION,
          candidateCommit: COMMIT,
          architecture: "arm64",
          target: "aarch64-apple-darwin",
        },
        expectedNonce: "n".repeat(43),
      })).rejects.toThrow("health response exceeds");
      expect(authorizationHeaders).toEqual([undefined]);
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });

  it("rejects permissive pre-existing runtime state instead of repairing it", async () => {
    const fixture = await runtimeFixture("local", false);
    const userData = await mkdtemp(join("/tmp", "terminus-desktop-state-test-"));
    temporaryRoots.push(userData);
    const stateRoot = join(userData, "runtime");
    await mkdir(stateRoot, { recursive: true, mode: 0o700 });
    await chmod(stateRoot, 0o777);
    await expect(StandaloneRuntimeSupervisor.start({
      resourcesPath: fixture.resources,
      userDataPath: userData,
      userHomePath: fixture.temporaryRoot,
      platform: "darwin",
      architecture: "arm64",
      expectedVersion: VERSION,
      expectedCommit: COMMIT,
      expectedBuildKind: "local",
      onFatalError: () => undefined,
    })).rejects.toThrow("runtime state directory must already be owner-only");

    await chmod(stateRoot, 0o700);
    await mkdir(join(stateRoot, "kernel-data"), { mode: 0o700 });
    await writeFile(join(stateRoot, "control.db"), "insecure", { mode: 0o666 });
    await chmod(join(stateRoot, "control.db"), 0o666);
    await expect(StandaloneRuntimeSupervisor.start({
      resourcesPath: fixture.resources,
      userDataPath: userData,
      userHomePath: fixture.temporaryRoot,
      platform: "darwin",
      architecture: "arm64",
      expectedVersion: VERSION,
      expectedCommit: COMMIT,
      expectedBuildKind: "local",
      onFatalError: () => undefined,
    })).rejects.toThrow("runtime state file must already be owner-only");
  });

  it("isolates migration, kernel, and control environments", () => {
    const environments = runtimeEnvironments({
      userDataPath: "/tmp/terminus-user-data",
      userHomePath: "/Users/example",
      inheritedPath: "/custom/bin:/usr/bin:relative-bin",
      database: "/tmp/terminus-user-data/runtime/control.db",
      kernelData: "/tmp/terminus-user-data/runtime/kernel-data",
      kernelSocket: "/tmp/terminus-user-data/runtime/kernel.sock",
      log: "/tmp/terminus-user-data/runtime/runtime.log",
      controlToken: "c".repeat(43),
      controlInstanceNonce: "i".repeat(43),
      bootstrapToken: "b".repeat(43),
      candidateCommit: COMMIT,
      version: VERSION,
      parentPid: 42,
    });
    expect(environments.migration).not.toHaveProperty("TERMINUS_CONTROL_TOKEN");
    expect(environments.migration).not.toHaveProperty("TERMINUS_KERNEL_CONTROL_BOOTSTRAP_TOKEN");
    expect(environments.control).not.toHaveProperty("TERMINUS_KERNEL_TOKEN");
    expect(environments.control).not.toHaveProperty("TERMINUS_KERNEL_CAPABILITY_SECRET");
    expect(environments.control.TERMINUS_CONTROL_PORT).toBe("0");
    expect(environments.control.TERMINUS_CONTROL_READY_FD).toBe("3");
    expect(environments.kernel).not.toHaveProperty("TERMINUS_CONTROL_TOKEN");
    expect(environments.kernel).not.toHaveProperty("TERMINUS_KERNEL_CAPABILITY_SECRET");
    expect(environments.kernel.TERMINUS_USER_HOME).toBe("/Users/example");
    expect(environments.control.TERMINUS_USER_HOME).toBe("/Users/example");
    expect(environments.control.TERMINUS_USER_PATH).toBe(userToolchainPath(
      "/Users/example",
      "/custom/bin:/usr/bin:relative-bin",
    ));
    expect(environments.control.TERMINUS_USER_PATH).toContain("/Users/example/.cargo/bin");
    expect(environments.control.TERMINUS_USER_PATH).toContain("/opt/homebrew/bin");
    expect(environments.control.TERMINUS_USER_PATH).toContain("/custom/bin");
    expect(environments.control.TERMINUS_USER_PATH).not.toContain("relative-bin");
    expect(environments.kernel.TERMINUS_KERNEL_CONTROL_BOOTSTRAP_TOKEN).toBe("b".repeat(43));
    expect(environments.control.TERMINUS_KERNEL_CONTROL_BOOTSTRAP_TOKEN).toBe("b".repeat(43));
  });

  it("preserves explicit per-user auth roots without exposing them to migration or control", () => {
    const environments = runtimeEnvironments({
      userDataPath: "/tmp/terminus-user-data",
      userHomePath: "/Users/example",
      userXdgDataHome: "/Users/example/Library/Application Support",
      userCodexHome: "/Users/example/.config/codex",
      database: "/tmp/terminus-user-data/runtime/control.db",
      kernelData: "/tmp/terminus-user-data/runtime/kernel-data",
      kernelSocket: "/tmp/terminus-user-data/runtime/kernel.sock",
      log: "/tmp/terminus-user-data/runtime/runtime.log",
      controlToken: "c".repeat(43),
      controlInstanceNonce: "n".repeat(43),
      bootstrapToken: "b".repeat(43),
      candidateCommit: COMMIT,
      version: VERSION,
      parentPid: process.pid,
    });

    expect(environments.kernel.XDG_DATA_HOME).toBe("/Users/example/Library/Application Support");
    expect(environments.kernel.CODEX_HOME).toBe("/Users/example/.config/codex");
    expect(environments.control).not.toHaveProperty("XDG_DATA_HOME");
    expect(environments.control).not.toHaveProperty("CODEX_HOME");
    expect(environments.migration).not.toHaveProperty("XDG_DATA_HOME");
  });

  it("ignores relative custom auth roots", () => {
    const environments = runtimeEnvironments({
      userDataPath: "/tmp/terminus-user-data",
      userHomePath: "/Users/example",
      userXdgDataHome: "relative-xdg",
      userCodexHome: "relative-codex",
      database: "/tmp/terminus-user-data/runtime/control.db",
      kernelData: "/tmp/terminus-user-data/runtime/kernel-data",
      kernelSocket: "/tmp/terminus-user-data/runtime/kernel.sock",
      log: "/tmp/terminus-user-data/runtime/runtime.log",
      controlToken: "c".repeat(43),
      controlInstanceNonce: "n".repeat(43),
      bootstrapToken: "b".repeat(43),
      candidateCommit: COMMIT,
      version: VERSION,
      parentPid: process.pid,
    });

    expect(environments.control).not.toHaveProperty("XDG_DATA_HOME");
    expect(environments.control).not.toHaveProperty("CODEX_HOME");
  });

  it("includes common Finder-invisible user toolchain shims", () => {
    const path = userToolchainPath("/Users/example", "/usr/bin:/bin");
    expect(path.split(":")).toEqual(expect.arrayContaining([
      "/Users/example/.local/share/mise/shims",
      "/Users/example/.asdf/shims",
      "/Users/example/.nodenv/shims",
      "/Users/example/.nvm/current/bin",
      "/Users/example/.pyenv/shims",
      "/Users/example/go/bin",
    ]));
  });
});

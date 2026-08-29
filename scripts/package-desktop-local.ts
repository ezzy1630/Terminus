#!/usr/bin/env bun
import { extractFile } from "@electron/asar";
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { readArchiveFile } from "./control-runtime/archive";
import { controlRuntimeTarget } from "./control-runtime/targets";
import {
  createDesktopRuntimeManifest,
  inspectDesktopRuntime,
  type DesktopRuntimeArchitecture,
} from "./desktop-runtime/manifest";
import { launchDesktopRuntime } from "./desktop-runtime/launch";

const ROOT = resolve(import.meta.dir, "..");
const DESKTOP = join(ROOT, "apps", "desktop");
const CACHE_BASE = join(ROOT, "node_modules", ".cache", "terminus-desktop-local-package");
const PACKAGE_CACHE = join(CACHE_BASE, `run-${process.pid}`);

const RUST_TARGETS: Readonly<Record<DesktopRuntimeArchitecture, string>> = {
  arm64: "aarch64-apple-darwin",
  x64: "x86_64-apple-darwin",
};

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function architectures(): readonly DesktopRuntimeArchitecture[] {
  const configured = argument("architectures") ?? (process.arch === "x64" ? "x64" : "arm64");
  const values = [...new Set(configured.split(","))];
  if (values.length === 0 || values.some((value) => value !== "arm64" && value !== "x64")) {
    throw new Error(`--architectures must contain arm64, x64, or both: ${configured}`);
  }
  return values as readonly DesktopRuntimeArchitecture[];
}

async function run(
  command: readonly string[],
  cwd: string = ROOT,
): Promise<string> {
  const child = Bun.spawn([...command], {
    cwd,
    env: process.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "pipe",
  });
  const [stderr, exitCode] = await Promise.all([
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed with exit ${exitCode}\n${stderr.slice(-8_000)}`);
  }
  return stderr.trim();
}

async function output(command: readonly string[]): Promise<string> {
  const child = Bun.spawn([...command], { cwd: ROOT, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed with exit ${exitCode}\n${stderr.slice(-8_000)}`);
  }
  return stdout.trim();
}

async function stageRuntime(
  architecture: DesktopRuntimeArchitecture,
  commit: string,
  version: string,
): Promise<void> {
  const rustTarget = RUST_TARGETS[architecture];
  const target = controlRuntimeTarget(rustTarget);
  await run(["rustup", "target", "add", rustTarget]);
  await run([
    "cargo",
    "build",
    "--release",
    "--target",
    rustTarget,
    "--manifest-path",
    "mini-services/terminus-kernel/Cargo.toml",
  ]);

  const archive = join(PACKAGE_CACHE, "archives", target.artifactName);
  await mkdir(dirname(archive), { recursive: true });
  await run([
    "bun",
    "run",
    "control:package",
    `--target=${rustTarget}`,
    `--output=${archive}`,
    `--commit=${commit}`,
    `--version=${version}`,
    "--allow-dirty",
  ]);

  const runtimeRoot = join(PACKAGE_CACHE, "runtime", architecture);
  for (const entry of await readArchiveFile(archive)) {
    if (!entry.path.startsWith("terminus-control/")) {
      throw new Error(`control archive has an unexpected root: ${entry.path}`);
    }
    const destination = join(runtimeRoot, entry.path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, entry.bytes, { mode: entry.mode & 0o777 });
    await chmod(destination, entry.mode & 0o777);
  }
  const kernel = join(
    ROOT,
    "mini-services",
    "terminus-kernel",
    "target",
    rustTarget,
    "release",
    "terminus-kernel-mini",
  );
  const packagedKernel = join(runtimeRoot, "bin", "terminus-kernel-mini");
  await mkdir(dirname(packagedKernel), { recursive: true });
  await copyFile(kernel, packagedKernel);
  await chmod(packagedKernel, 0o755);
  await createDesktopRuntimeManifest({
    root: runtimeRoot,
    architecture,
    commit,
    version,
    allowUnsigned: true,
    buildKind: "local",
  });
}

async function verifyPackagedApplication(
  architecture: DesktopRuntimeArchitecture,
  commit: string,
  version: string,
  packageOutput: string,
): Promise<string> {
  const outputDirectory = architecture === "arm64" ? "mac-arm64" : "mac";
  const application = join(packageOutput, outputDirectory, "Terminus.app");
  const metadata = JSON.parse(
    extractFile(join(application, "Contents", "Resources", "app.asar"), "package.json").toString("utf8"),
  ) as Readonly<Record<string, unknown>>;
  if (
    metadata.version !== version
    || metadata.terminusCommit !== commit
    || metadata.terminusBuildKind !== "local"
  ) {
    throw new Error(`${architecture} packaged metadata does not match its embedded runtime`);
  }
  await inspectDesktopRuntime({
    root: join(application, "Contents", "Resources", "runtime"),
    architecture,
    commit,
    version,
    allowUnsigned: true,
    buildKind: "local",
  });
  return application;
}

if (process.platform !== "darwin") throw new Error("local desktop packaging requires macOS");
if (!PACKAGE_CACHE.startsWith(`${CACHE_BASE}${sep}`)) {
  throw new Error(`refusing to replace unexpected desktop package cache: ${PACKAGE_CACHE}`);
}
const selectedArchitectures = architectures();
const packageOutput = resolve(argument("output") ?? join(DESKTOP, "release"));
const commit = await output(["git", "rev-parse", "HEAD"]);
const desktopPackage = JSON.parse(await readFile(join(DESKTOP, "package.json"), "utf8")) as {
  readonly version?: unknown;
};
if (typeof desktopPackage.version !== "string") throw new Error("desktop package has no version");
const version = desktopPackage.version;
await rm(PACKAGE_CACHE, { recursive: true, force: true });
try {
  for (const architecture of selectedArchitectures) {
    await stageRuntime(architecture, commit, version);
  }
  await run(["bun", "run", "build:electron"], DESKTOP);

  const runtimeSource = join(PACKAGE_CACHE, "runtime", "${arch}");
  const builderArguments = [
    "bunx",
    "electron-builder",
    "--mac",
    ...selectedArchitectures.map((architecture) => `--${architecture}`),
    ...(process.argv.includes("--dir") ? ["--dir"] : []),
    `--config.extraMetadata.version=${version}`,
    `--config.extraMetadata.terminusCommit=${commit}`,
    "--config.extraMetadata.terminusBuildKind=local",
    `--config.directories.output=${packageOutput}`,
    `--config.extraResources.from=${runtimeSource}`,
    "--config.extraResources.to=runtime",
    "--config.mac.signIgnore=/Contents/Resources/runtime/(terminus-control/bin/terminus-control|terminus-control/lib/terminus/query-engine[.]node|bin/terminus-kernel-mini)$",
    "--config.mac.identity=null",
    "--config.mac.notarize=false",
  ];
  await run(builderArguments, DESKTOP);
  const launchedArchitectures: DesktopRuntimeArchitecture[] = [];
  for (const architecture of selectedArchitectures) {
    const application = await verifyPackagedApplication(architecture, commit, version, packageOutput);
    const launchable = process.arch === "arm64" || architecture === "x64";
    if (launchable) {
      // Keep the launch profile under launchDesktopRuntime's short OS-temp
      // root. PACKAGE_CACHE is long enough to overflow Darwin's 103-byte UDS
      // path limit before the packaged runtime can bind kernel.sock.
      await launchDesktopRuntime({
        application,
        architecture,
        commit,
        version,
        buildKind: "local",
      });
      launchedArchitectures.push(architecture);
    }
  }
  console.log(JSON.stringify({
    schema: "terminus.desktop-local-package.v1",
    status: "pass",
    commit,
    version,
    architectures: selectedArchitectures,
    launch_architectures: launchedArchitectures,
    signed: false,
  }));
} finally {
  await rm(PACKAGE_CACHE, { recursive: true, force: true });
}

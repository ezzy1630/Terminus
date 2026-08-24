import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  CONTROL_EXECUTABLE_PATH,
  CONTROL_MANIFEST_PATH,
  decodeControlRuntimeManifest,
  decodeDesktopRuntimeManifest,
  KERNEL_EXECUTABLE_PATH,
  QUERY_ENGINE_PATH,
  RESIGNED_CONTROL_PATHS,
  RUNTIME_TARGETS,
  type DesktopRuntimeArchitecture,
  type DesktopRuntimeBuildKind,
  type DesktopRuntimeManifest,
  type DigestReference,
} from "../../apps/desktop/electron/runtime-contract";

export type { DesktopRuntimeArchitecture } from "../../apps/desktop/electron/runtime-contract";

export interface DesktopRuntimeInspection {
  readonly schema: "terminus.desktop-runtime.inspection.v1";
  readonly build_kind: DesktopRuntimeBuildKind;
  readonly version: string;
  readonly candidate_commit: string;
  readonly architecture: DesktopRuntimeArchitecture;
  readonly target: string;
  readonly manifest_sha256: string;
  readonly control_manifest_sha256: string;
  readonly control_executable_sha256: string;
  readonly query_engine_sha256: string;
  readonly kernel_executable_sha256: string;
  readonly control_files: number;
  readonly migrations: number;
  readonly signatures_verified: boolean;
  readonly signing_team_identifier?: string;
}

export interface InspectDesktopRuntimeOptions {
  readonly root: string;
  readonly architecture: DesktopRuntimeArchitecture;
  readonly commit: string;
  readonly version: string;
  readonly allowUnsigned?: boolean;
  readonly buildKind?: DesktopRuntimeBuildKind;
}

const ARCHITECTURES: Readonly<Record<DesktopRuntimeArchitecture, {
  readonly rustTarget: string;
  readonly machoArchitecture: string;
}>> = {
  arm64: {
    rustTarget: RUNTIME_TARGETS.arm64,
    machoArchitecture: "arm64",
  },
  x64: {
    rustTarget: RUNTIME_TARGETS.x64,
    machoArchitecture: "x86_64",
  },
};

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function run(command: readonly string[]): Promise<{ readonly stdout: string; readonly stderr: string }> {
  const child = Bun.spawn([...command], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    const output = `${stdout}\n${stderr}`;
    throw new Error(`${command.join(" ")} failed with exit ${exitCode}\n${output.slice(-8_000)}`);
  }
  return { stdout: stdout.trim(), stderr: stderr.trim() };
}

async function requireRegularFile(path: string, label: string): Promise<void> {
  const details = await lstat(path);
  if (!details.isFile() || details.isSymbolicLink()) throw new Error(`${label} is not a regular file: ${path}`);
}

async function verifyDigestReference(root: string, reference: DigestReference, label: string): Promise<string> {
  const path = join(root, reference.path);
  await requireRegularFile(path, label);
  const actual = await sha256File(path);
  if (actual !== reference.sha256) {
    throw new Error(`${label} digest mismatch: ${actual} != ${reference.sha256}`);
  }
  return path;
}

async function walkFiles(directory: string): Promise<readonly string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`desktop runtime may not contain symlinks: ${path}`);
    if (entry.isDirectory()) files.push(...await walkFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files.sort((left, right) => left.localeCompare(right));
}

async function walkRelativeTree(root: string, directory: string = root): Promise<{
  readonly files: readonly string[];
  readonly directories: readonly string[];
}> {
  const files: string[] = [];
  const directories: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const details = await lstat(path);
    if (details.isSymbolicLink()) throw new Error(`desktop runtime may not contain symlinks: ${path}`);
    const relativePath = relativeFrom(root, path);
    if (details.isDirectory()) {
      directories.push(relativePath);
      const nested = await walkRelativeTree(root, path);
      files.push(...nested.files);
      directories.push(...nested.directories);
    } else if (details.isFile()) {
      files.push(relativePath);
    } else {
      throw new Error(`desktop runtime may contain only files and directories: ${path}`);
    }
  }
  return {
    files: files.sort((left, right) => left.localeCompare(right)),
    directories: directories.sort((left, right) => left.localeCompare(right)),
  };
}

function signingField(details: string, name: string): string {
  const prefix = `${name}=`;
  const line = details.split("\n").find((candidate) => candidate.startsWith(prefix));
  if (!line || line.length === prefix.length) throw new Error(`codesign output is missing ${name}`);
  return line.slice(prefix.length);
}

async function verifySignedMachO(
  path: string,
  expectedArchitecture: string,
  allowUnsigned: boolean,
): Promise<string | undefined> {
  const architectures = (await run(["lipo", "-archs", path])).stdout.split(/\s+/).filter(Boolean);
  if (architectures.length !== 1 || architectures[0] !== expectedArchitecture) {
    throw new Error(`${path} has unexpected Mach-O architectures: ${architectures.join(", ")}`);
  }
  if (allowUnsigned) return undefined;
  await run(["codesign", "--verify", "--strict", "--verbose=2", path]);
  const signing = await run(["codesign", "-dv", "--verbose=4", path]);
  return signingField(`${signing.stdout}\n${signing.stderr}`, "TeamIdentifier");
}

async function assertExecutable(path: string): Promise<void> {
  const details = await stat(path);
  if ((details.mode & 0o111) === 0) throw new Error(`runtime entrypoint is not executable: ${path}`);
}

async function assertMode(path: string, expected: number, label: string): Promise<void> {
  const details = await lstat(path);
  if ((details.mode & 0o777) !== expected) {
    throw new Error(`${label} mode is ${(details.mode & 0o777).toString(8)}, expected ${expected.toString(8)}`);
  }
}

function parentDirectories(paths: readonly string[]): readonly string[] {
  const directories = new Set<string>();
  for (const path of paths) {
    const segments = path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      directories.add(segments.slice(0, index).join("/"));
    }
  }
  return [...directories].sort((left, right) => left.localeCompare(right));
}

function assertExactReference(reference: DigestReference, expected: string, label: string): void {
  if (reference.path !== expected) throw new Error(`${label} path must be ${expected}: ${reference.path}`);
}

function relativeFrom(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

export async function createDesktopRuntimeManifest(options: InspectDesktopRuntimeOptions): Promise<string> {
  const root = resolve(options.root);
  const target = ARCHITECTURES[options.architecture];
  const buildKind = options.buildKind ?? "release";
  const controlManifestPath = join(root, CONTROL_MANIFEST_PATH);
  const controlManifestBytes = await readFile(controlManifestPath);
  const controlManifest = decodeControlRuntimeManifest(
    JSON.parse(controlManifestBytes.toString("utf8")) as unknown,
  );
  if (
    controlManifest.version !== options.version
    || controlManifest.candidate_commit !== options.commit
    || controlManifest.target.rust !== target.rustTarget
    || (buildKind === "release" && !controlManifest.source_tree_clean)
  ) {
    throw new Error("control runtime identity does not match the desktop runtime request");
  }
  if (controlManifest.entrypoint !== "bin/terminus-control") {
    throw new Error(`unexpected Darwin control entrypoint: ${controlManifest.entrypoint}`);
  }
  const reference = async (path: string): Promise<DigestReference> => {
    await requireRegularFile(join(root, path), path);
    return { path, sha256: await sha256File(join(root, path)) };
  };
  const manifest: DesktopRuntimeManifest = {
    schema: "terminus.desktop-runtime.v1",
    build_kind: buildKind,
    version: options.version,
    candidate_commit: options.commit,
    architecture: options.architecture,
    target: target.rustTarget,
    control: {
      manifest: {
        path: CONTROL_MANIFEST_PATH,
        sha256: createHash("sha256").update(controlManifestBytes).digest("hex"),
      },
      executable: await reference(CONTROL_EXECUTABLE_PATH),
      query_engine: await reference(QUERY_ENGINE_PATH),
    },
    kernel: {
      executable: await reference(KERNEL_EXECUTABLE_PATH),
    },
  };
  const manifestPath = join(root, "manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o644 });
  return manifestPath;
}

export async function inspectDesktopRuntime(
  options: InspectDesktopRuntimeOptions,
): Promise<DesktopRuntimeInspection> {
  const root = resolve(options.root);
  const expectedTarget = ARCHITECTURES[options.architecture];
  const expectedBuildKind = options.buildKind ?? "release";
  const manifestPath = join(root, "manifest.json");
  const rootDetails = await lstat(root);
  if (!rootDetails.isDirectory() || rootDetails.isSymbolicLink()) {
    throw new Error(`desktop runtime root is not a real directory: ${root}`);
  }
  await assertMode(root, 0o755, "desktop runtime root");
  await requireRegularFile(manifestPath, "desktop runtime manifest");
  const manifestBytes = await readFile(manifestPath);
  const manifest = decodeDesktopRuntimeManifest(JSON.parse(manifestBytes.toString("utf8")) as unknown);
  if (
    manifest.version !== options.version
    || manifest.candidate_commit !== options.commit
    || manifest.architecture !== options.architecture
    || manifest.target !== expectedTarget.rustTarget
    || manifest.build_kind !== expectedBuildKind
  ) {
    throw new Error("desktop runtime manifest identity does not match the requested package");
  }
  assertExactReference(manifest.control.manifest, CONTROL_MANIFEST_PATH, "control manifest");
  assertExactReference(manifest.control.executable, CONTROL_EXECUTABLE_PATH, "control executable");
  assertExactReference(manifest.control.query_engine, QUERY_ENGINE_PATH, "query engine");
  assertExactReference(manifest.kernel.executable, KERNEL_EXECUTABLE_PATH, "kernel executable");

  const controlManifestPath = await verifyDigestReference(root, manifest.control.manifest, "control manifest");
  const controlExecutablePath = await verifyDigestReference(root, manifest.control.executable, "control executable");
  const queryEnginePath = await verifyDigestReference(root, manifest.control.query_engine, "query engine");
  const kernelExecutablePath = await verifyDigestReference(root, manifest.kernel.executable, "kernel executable");
  await Promise.all([assertExecutable(controlExecutablePath), assertExecutable(kernelExecutablePath)]);
  await Promise.all([
    assertMode(manifestPath, 0o644, "desktop runtime manifest"),
    assertMode(controlManifestPath, 0o644, "control runtime manifest"),
    assertMode(kernelExecutablePath, 0o755, "kernel executable"),
  ]);

  const controlManifest = decodeControlRuntimeManifest(
    JSON.parse(await readFile(controlManifestPath, "utf8")) as unknown,
  );
  if (
    controlManifest.version !== options.version
    || controlManifest.candidate_commit !== options.commit
    || controlManifest.target.rust !== expectedTarget.rustTarget
    || controlManifest.entrypoint !== "bin/terminus-control"
    || (expectedBuildKind === "release" && !controlManifest.source_tree_clean)
  ) {
    throw new Error("nested control runtime identity is invalid");
  }

  const controlRoot = dirname(controlManifestPath);
  const declared = new Set<string>();
  for (const file of controlManifest.files) {
    if (declared.has(file.path)) throw new Error(`duplicate control runtime file: ${file.path}`);
    declared.add(file.path);
    const path = join(controlRoot, file.path);
    await requireRegularFile(path, `control runtime file ${file.path}`);
    const details = await stat(path);
    const expectedMode = file.mode === "0755" ? 0o755 : 0o644;
    if ((details.mode & 0o777) !== expectedMode) throw new Error(`mode mismatch for ${file.path}`);
    if (!RESIGNED_CONTROL_PATHS.has(file.path)) {
      if (details.size !== file.size) throw new Error(`size mismatch for ${file.path}`);
      if (await sha256File(path) !== file.sha256) throw new Error(`digest mismatch for ${file.path}`);
    }
  }
  const actualControlFiles = (await walkFiles(controlRoot))
    .map((path) => relativeFrom(controlRoot, path))
    .filter((path) => path !== "manifest.json");
  const undeclared = actualControlFiles.filter((path) => !declared.has(path));
  const missing = [...declared].filter((path) => !actualControlFiles.includes(path));
  if (undeclared.length > 0 || missing.length > 0) {
    throw new Error(`control runtime inventory mismatch; undeclared=${undeclared.join(",")}; missing=${missing.join(",")}`);
  }
  const expectedOuterFiles = [
    "manifest.json",
    KERNEL_EXECUTABLE_PATH,
    CONTROL_MANIFEST_PATH,
    ...controlManifest.files.map((file) => `terminus-control/${file.path}`),
  ].sort((left, right) => left.localeCompare(right));
  const expectedOuterDirectories = parentDirectories(expectedOuterFiles);
  const outerTree = await walkRelativeTree(root);
  if (
    JSON.stringify(outerTree.files) !== JSON.stringify(expectedOuterFiles)
    || JSON.stringify(outerTree.directories) !== JSON.stringify(expectedOuterDirectories)
  ) {
    throw new Error(
      `desktop runtime outer inventory mismatch; files=${outerTree.files.join(",")}; directories=${outerTree.directories.join(",")}`,
    );
  }
  await Promise.all(
    expectedOuterDirectories.map((directory) => assertMode(join(root, directory), 0o755, `runtime directory ${directory}`)),
  );
  for (const required of [
    "bin/terminus-control",
    "lib/terminus/query-engine.node",
    "share/terminus/schema.prisma",
  ]) {
    if (!declared.has(required)) throw new Error(`control runtime is missing ${required}`);
  }
  const migrations = [...declared].filter((path) => (
    /^share\/terminus\/migrations\/sqlite\/\d+_.+\.sql$/.test(path)
  ));
  if (migrations.length === 0) throw new Error("control runtime contains no SQLite migrations");

  const teams = await Promise.all([
    verifySignedMachO(
      controlExecutablePath,
      expectedTarget.machoArchitecture,
      options.allowUnsigned === true,
    ),
    verifySignedMachO(queryEnginePath, expectedTarget.machoArchitecture, options.allowUnsigned === true),
    verifySignedMachO(
      kernelExecutablePath,
      expectedTarget.machoArchitecture,
      options.allowUnsigned === true,
    ),
  ]);
  const observedTeams = [...new Set(teams.filter((team): team is string => team !== undefined))];
  if (!options.allowUnsigned && observedTeams.length !== 1) {
    throw new Error(`embedded runtime signing teams do not match: ${observedTeams.join(", ")}`);
  }

  return {
    schema: "terminus.desktop-runtime.inspection.v1",
    build_kind: manifest.build_kind,
    version: manifest.version,
    candidate_commit: manifest.candidate_commit,
    architecture: manifest.architecture,
    target: manifest.target,
    manifest_sha256: createHash("sha256").update(manifestBytes).digest("hex"),
    control_manifest_sha256: manifest.control.manifest.sha256,
    control_executable_sha256: manifest.control.executable.sha256,
    query_engine_sha256: manifest.control.query_engine.sha256,
    kernel_executable_sha256: manifest.kernel.executable.sha256,
    control_files: controlManifest.files.length + 1,
    migrations: migrations.length,
    signatures_verified: options.allowUnsigned !== true,
    ...(observedTeams[0] ? { signing_team_identifier: observedTeams[0] } : {}),
  };
}

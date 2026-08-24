import { posix } from "node:path";

export const CONTROL_MANIFEST_PATH = "terminus-control/manifest.json";
export const CONTROL_EXECUTABLE_PATH = "terminus-control/bin/terminus-control";
export const QUERY_ENGINE_PATH = "terminus-control/lib/terminus/query-engine.node";
export const KERNEL_EXECUTABLE_PATH = "bin/terminus-kernel-mini";
export const MAX_RUNTIME_MANIFEST_BYTES = 1_048_576;
export const MAX_RUNTIME_FILES = 2_048;
export const MAX_RUNTIME_BYTES = 2 * 1_024 * 1_024 * 1_024;

export type DesktopRuntimeArchitecture = "arm64" | "x64";
export type DesktopRuntimeBuildKind = "release" | "local";

export const RUNTIME_TARGETS: Readonly<Record<DesktopRuntimeArchitecture, string>> = {
  arm64: "aarch64-apple-darwin",
  x64: "x86_64-apple-darwin",
};

export const RESIGNED_CONTROL_PATHS = new Set([
  "bin/terminus-control",
  "lib/terminus/query-engine.node",
]);

export interface DigestReference {
  readonly path: string;
  readonly sha256: string;
}

export interface ControlManifestFile {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
  readonly mode: "0644" | "0755";
}

export interface DesktopRuntimeManifest {
  readonly schema: "terminus.desktop-runtime.v1";
  readonly build_kind: DesktopRuntimeBuildKind;
  readonly version: string;
  readonly candidate_commit: string;
  readonly architecture: DesktopRuntimeArchitecture;
  readonly target: string;
  readonly control: {
    readonly manifest: DigestReference;
    readonly executable: DigestReference;
    readonly query_engine: DigestReference;
  };
  readonly kernel: { readonly executable: DigestReference };
}

export interface ControlRuntimeManifest {
  readonly schema: "terminus.control-runtime.v1";
  readonly version: string;
  readonly candidate_commit: string;
  readonly source_tree_clean: boolean;
  readonly source_date_epoch: number;
  readonly target: {
    readonly rust: string;
    readonly bun: string;
    readonly prisma: string;
  };
  readonly toolchain: {
    readonly bun: string;
    readonly prisma_client: string;
  };
  readonly entrypoint: "bin/terminus-control";
  readonly files: readonly ControlManifestFile[];
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const GIT_COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function decodeDesktopRuntimeManifest(value: unknown): DesktopRuntimeManifest {
  const manifest = requireObject(value, "desktop runtime manifest");
  requireExactFields(
    manifest,
    ["schema", "build_kind", "version", "candidate_commit", "architecture", "target", "control", "kernel"],
    "desktop runtime manifest",
  );
  if (manifest.schema !== "terminus.desktop-runtime.v1") {
    throw new Error("desktop runtime manifest has an unsupported schema");
  }
  const control = requireObject(manifest.control, "desktop runtime control");
  const kernel = requireObject(manifest.kernel, "desktop runtime kernel");
  requireExactFields(control, ["manifest", "executable", "query_engine"], "desktop runtime control");
  requireExactFields(kernel, ["executable"], "desktop runtime kernel");
  return {
    schema: "terminus.desktop-runtime.v1",
    build_kind: requireRuntimeBuildKind(manifest.build_kind),
    version: requireRuntimeVersion(manifest.version),
    candidate_commit: requireRuntimeCommit(manifest.candidate_commit),
    architecture: requireRuntimeArchitecture(manifest.architecture),
    target: requireString(manifest.target, "desktop runtime target"),
    control: {
      manifest: decodeDigestReference(control.manifest, "desktop runtime control manifest"),
      executable: decodeDigestReference(control.executable, "desktop runtime control executable"),
      query_engine: decodeDigestReference(control.query_engine, "desktop runtime query engine"),
    },
    kernel: {
      executable: decodeDigestReference(kernel.executable, "desktop runtime kernel executable"),
    },
  };
}

export function requireRuntimeBuildKind(value: unknown): DesktopRuntimeBuildKind {
  const buildKind = requireString(value, "runtime build kind");
  if (buildKind !== "release" && buildKind !== "local") {
    throw new Error(`runtime build kind is unsupported: ${buildKind}`);
  }
  return buildKind;
}

export function decodeControlRuntimeManifest(value: unknown): ControlRuntimeManifest {
  const manifest = requireObject(value, "control runtime manifest");
  requireExactFields(
    manifest,
    [
      "schema",
      "version",
      "candidate_commit",
      "source_tree_clean",
      "source_date_epoch",
      "target",
      "toolchain",
      "entrypoint",
      "files",
    ],
    "control runtime manifest",
  );
  if (manifest.schema !== "terminus.control-runtime.v1") {
    throw new Error("control runtime manifest has an unsupported schema");
  }
  if (manifest.entrypoint !== "bin/terminus-control") {
    throw new Error("control runtime manifest has an unexpected entrypoint");
  }
  if (typeof manifest.source_tree_clean !== "boolean") {
    throw new Error("control runtime source_tree_clean must be a boolean");
  }
  const target = requireObject(manifest.target, "control runtime target");
  const toolchain = requireObject(manifest.toolchain, "control runtime toolchain");
  requireExactFields(target, ["rust", "bun", "prisma"], "control runtime target");
  requireExactFields(toolchain, ["bun", "prisma_client"], "control runtime toolchain");
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error("control runtime manifest files must be a non-empty array");
  }
  if (manifest.files.length > MAX_RUNTIME_FILES) {
    throw new Error(`control runtime manifest exceeds ${MAX_RUNTIME_FILES} files`);
  }
  const seen = new Set<string>();
  let totalBytes = 0;
  const files = manifest.files.map((entry, index): ControlManifestFile => {
    const file = requireObject(entry, `control runtime manifest files[${index}]`);
    requireExactFields(
      file,
      ["path", "sha256", "size", "mode"],
      `control runtime manifest files[${index}]`,
    );
    const path = requireSafeRelativePath(file.path, `control runtime manifest files[${index}].path`);
    if (seen.has(path)) throw new Error(`control runtime manifest repeats ${path}`);
    seen.add(path);
    const size = requireNonnegativeInteger(file.size, `control runtime manifest files[${index}].size`);
    totalBytes += size;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_RUNTIME_BYTES) {
      throw new Error(`control runtime manifest exceeds ${MAX_RUNTIME_BYTES} bytes`);
    }
    const sha256 = requireString(file.sha256, `control runtime manifest files[${index}].sha256`);
    if (!SHA256_PATTERN.test(sha256)) {
      throw new Error(`control runtime manifest files[${index}].sha256 is invalid`);
    }
    if (file.mode !== "0644" && file.mode !== "0755") {
      throw new Error(`control runtime manifest files[${index}].mode is invalid`);
    }
    return { path, sha256, size, mode: file.mode };
  });
  return {
    schema: "terminus.control-runtime.v1",
    version: requireRuntimeVersion(manifest.version),
    candidate_commit: requireRuntimeCommit(manifest.candidate_commit),
    source_tree_clean: manifest.source_tree_clean,
    source_date_epoch: requireNonnegativeInteger(
      manifest.source_date_epoch,
      "control runtime source_date_epoch",
    ),
    target: {
      rust: requireString(target.rust, "control runtime Rust target"),
      bun: requireString(target.bun, "control runtime Bun target"),
      prisma: requireString(target.prisma, "control runtime Prisma target"),
    },
    toolchain: {
      bun: requireString(toolchain.bun, "control runtime Bun toolchain"),
      prisma_client: requireString(toolchain.prisma_client, "control runtime Prisma toolchain"),
    },
    entrypoint: "bin/terminus-control",
    files,
  };
}

export function decodeDigestReference(value: unknown, label: string): DigestReference {
  const reference = requireObject(value, label);
  requireExactFields(reference, ["path", "sha256"], label);
  const sha256 = requireString(reference.sha256, `${label}.sha256`);
  if (!SHA256_PATTERN.test(sha256)) throw new Error(`${label}.sha256 is invalid`);
  return {
    path: requireSafeRelativePath(reference.path, `${label}.path`),
    sha256,
  };
}

export function requireSafeRelativePath(value: unknown, label: string): string {
  const path = requireString(value, label);
  if (
    path.startsWith("/")
    || path.includes("\\")
    || path.includes("\0")
    || posix.normalize(path) !== path
    || path.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new Error(`${label} must be a normalized relative path`);
  }
  return path;
}

export function requireRuntimeArchitecture(value: unknown): DesktopRuntimeArchitecture {
  const architecture = requireString(value, "runtime architecture");
  if (architecture !== "arm64" && architecture !== "x64") {
    throw new Error(`runtime architecture is unsupported: ${architecture}`);
  }
  return architecture;
}

export function requireRuntimeVersion(value: unknown): string {
  const version = requireString(value, "runtime version");
  if (!VERSION_PATTERN.test(version)) throw new Error(`runtime version is not stable SemVer: ${version}`);
  return version;
}

export function requireRuntimeCommit(value: unknown): string {
  const commit = requireString(value, "runtime candidate commit");
  if (!GIT_COMMIT_PATTERN.test(commit)) throw new Error("runtime candidate commit is invalid");
  return commit;
}

function requireNonnegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function requireExactFields(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((field, index) => field !== wanted[index])) {
    throw new Error(`${label} fields are invalid: ${actual.join(", ")}`);
  }
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

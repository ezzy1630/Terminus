#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { readDeterministicArchive, type ArchiveEntry } from "./control-runtime/archive";
import { controlRuntimeTarget } from "./control-runtime/targets";

interface ManifestFile {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
  readonly mode: "0644" | "0755";
}

interface RuntimeManifest {
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
  readonly entrypoint: string;
  readonly files: readonly ManifestFile[];
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function object(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} must be a non-negative integer`);
  return value as number;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function decodeManifest(value: unknown): RuntimeManifest {
  const manifest = object(value, "manifest");
  if (manifest.schema !== "terminus.control-runtime.v1") throw new Error("unsupported control runtime manifest schema");
  const target = object(manifest.target, "manifest.target");
  const toolchain = object(manifest.toolchain, "manifest.toolchain");
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error("manifest.files must be a non-empty array");
  }
  const files = manifest.files.map((rawFile, index): ManifestFile => {
    const file = object(rawFile, `manifest.files[${index}]`);
    const path = string(file.path, `manifest.files[${index}].path`);
    const digest = string(file.sha256, `manifest.files[${index}].sha256`);
    const mode = string(file.mode, `manifest.files[${index}].mode`);
    if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error(`invalid SHA-256 for ${path}`);
    if (mode !== "0644" && mode !== "0755") throw new Error(`invalid mode for ${path}: ${mode}`);
    return {
      path,
      sha256: digest,
      size: integer(file.size, `manifest.files[${index}].size`),
      mode,
    };
  });
  return {
    schema: "terminus.control-runtime.v1",
    version: string(manifest.version, "manifest.version"),
    candidate_commit: string(manifest.candidate_commit, "manifest.candidate_commit"),
    source_tree_clean: boolean(manifest.source_tree_clean, "manifest.source_tree_clean"),
    source_date_epoch: integer(manifest.source_date_epoch, "manifest.source_date_epoch"),
    target: {
      rust: string(target.rust, "manifest.target.rust"),
      bun: string(target.bun, "manifest.target.bun"),
      prisma: string(target.prisma, "manifest.target.prisma"),
    },
    toolchain: {
      bun: string(toolchain.bun, "manifest.toolchain.bun"),
      prisma_client: string(toolchain.prisma_client, "manifest.toolchain.prisma_client"),
    },
    entrypoint: string(manifest.entrypoint, "manifest.entrypoint"),
    files,
  };
}

function option(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function archivePaths(): readonly string[] {
  return process.argv.slice(2).filter((value) => !value.startsWith("--"));
}

function entryMap(entries: readonly ArchiveEntry[]): ReadonlyMap<string, ArchiveEntry> {
  return new Map(entries.map((entry) => [entry.path, entry]));
}

function verifyRuntimeArchive(
  archivePath: string,
  archiveBytes: Uint8Array,
  expectedCommit: string | undefined,
  expectedVersion: string | undefined,
): Readonly<Record<string, unknown>> {
  const entries = readDeterministicArchive(archiveBytes);
  const entriesByPath = entryMap(entries);
  const manifestEntry = entriesByPath.get("terminus-control/manifest.json");
  if (!manifestEntry) throw new Error(`${archivePath}: missing terminus-control/manifest.json`);
  const manifest = decodeManifest(JSON.parse(Buffer.from(manifestEntry.bytes).toString("utf8")) as unknown);
  const target = controlRuntimeTarget(manifest.target.rust);
  if (basename(archivePath) !== target.artifactName) {
    throw new Error(`${archivePath}: expected artifact name ${target.artifactName}`);
  }
  if (manifest.target.bun !== target.bunTarget || manifest.target.prisma !== target.prismaTarget) {
    throw new Error(`${archivePath}: target toolchain does not match ${target.rustTarget}`);
  }
  if (manifest.entrypoint !== `bin/${target.executableName}`) {
    throw new Error(`${archivePath}: invalid entrypoint ${manifest.entrypoint}`);
  }
  if (!/^[0-9a-f]{40}$/.test(manifest.candidate_commit)) {
    throw new Error(`${archivePath}: candidate_commit is not a full lowercase Git SHA`);
  }
  if (expectedCommit && manifest.candidate_commit !== expectedCommit) {
    throw new Error(`${archivePath}: commit mismatch: ${manifest.candidate_commit} != ${expectedCommit}`);
  }
  if (expectedVersion && manifest.version !== expectedVersion) {
    throw new Error(`${archivePath}: version mismatch: ${manifest.version} != ${expectedVersion}`);
  }
  if (!manifest.source_tree_clean && !process.argv.includes("--allow-dirty")) {
    throw new Error(`${archivePath}: runtime was built from a dirty source tree`);
  }

  const declared = new Set<string>();
  for (const file of manifest.files) {
    if (file.path.startsWith("/") || file.path.split("/").includes("..")) {
      throw new Error(`${archivePath}: unsafe manifest file path ${file.path}`);
    }
    if (declared.has(file.path)) throw new Error(`${archivePath}: duplicate manifest file ${file.path}`);
    declared.add(file.path);
    const entry = entriesByPath.get(`terminus-control/${file.path}`);
    if (!entry) throw new Error(`${archivePath}: missing declared file ${file.path}`);
    if (entry.bytes.byteLength !== file.size) throw new Error(`${archivePath}: size mismatch for ${file.path}`);
    if (sha256(entry.bytes) !== file.sha256) throw new Error(`${archivePath}: digest mismatch for ${file.path}`);
    const expectedMode = file.mode === "0755" ? 0o755 : 0o644;
    if ((entry.mode & 0o777) !== expectedMode) throw new Error(`${archivePath}: mode mismatch for ${file.path}`);
  }
  const undeclared = entries
    .map((entry) => entry.path)
    .filter((path) => path !== "terminus-control/manifest.json")
    .filter((path) => !declared.has(path.slice("terminus-control/".length)));
  if (undeclared.length > 0) throw new Error(`${archivePath}: undeclared archive files: ${undeclared.join(", ")}`);

  for (const required of [
    manifest.entrypoint,
    "lib/terminus/query-engine.node",
    "share/terminus/schema.prisma",
    "share/terminus/README.md",
    "share/terminus/licenses/terminus.txt",
    "share/terminus/licenses/prisma-client.txt",
  ]) {
    if (!declared.has(required)) throw new Error(`${archivePath}: missing required runtime file ${required}`);
  }
  const migrations = [...declared].filter((path) => /^share\/terminus\/migrations\/sqlite\/\d+_.+\.sql$/.test(path));
  if (migrations.length === 0) throw new Error(`${archivePath}: package contains no SQL migrations`);
  const entrypoint = entriesByPath.get(`terminus-control/${manifest.entrypoint}`);
  const engine = entriesByPath.get("terminus-control/lib/terminus/query-engine.node");
  if (!entrypoint || entrypoint.bytes.byteLength < 1_000_000) throw new Error(`${archivePath}: entrypoint is not a compiled runtime`);
  if (!engine || engine.bytes.byteLength < 1_000_000) throw new Error(`${archivePath}: Prisma query engine is incomplete`);

  return {
    artifact: archivePath,
    sha256: sha256(archiveBytes),
    version: manifest.version,
    candidate_commit: manifest.candidate_commit,
    source_tree_clean: manifest.source_tree_clean,
    target: manifest.target.rust,
    files: manifest.files.length + 1,
    migrations: migrations.length,
  };
}

const paths = archivePaths();
if (paths.length === 0) {
  throw new Error("usage: bun scripts/verify-control-runtime-package.ts [--commit=<sha>] [--version=<semver>] <archive> [...]");
}
const results: Readonly<Record<string, unknown>>[] = [];
for (const path of paths) {
  const bytes = await readFile(path);
  results.push(verifyRuntimeArchive(path, bytes, option("commit"), option("version")));
}
console.log(JSON.stringify({ schema: "terminus.control-runtime.verification.v1", status: "pass", artifacts: results }));

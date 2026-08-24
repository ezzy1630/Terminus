#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function object(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
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

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

const evidencePath = resolve(string(argument("evidence"), "--evidence"));
const artifactsDirectory = resolve(string(argument("artifacts-dir"), "--artifacts-dir"));
const expectedCommit = string(argument("commit"), "--commit");
const expectedVersion = string(argument("version"), "--version");
const allowUnsigned = process.argv.includes("--allow-unsigned");
const evidence = object(JSON.parse(await readFile(evidencePath, "utf8")) as unknown, "evidence");
if (evidence.schema !== "terminus.desktop-release-evidence.v1" || evidence.status !== "pass") {
  throw new Error("desktop release evidence is not a passing v1 record");
}
if (evidence.candidate_commit !== expectedCommit || evidence.version !== expectedVersion) {
  throw new Error("desktop release evidence is not bound to the requested commit and version");
}
if (!Array.isArray(evidence.artifacts) || evidence.artifacts.length !== 4) {
  throw new Error("desktop release evidence must contain exactly four artifacts");
}

const expectedNames = new Set([
  `Terminus-${expectedVersion}-arm64.dmg`,
  `Terminus-${expectedVersion}-arm64.zip`,
  `Terminus-${expectedVersion}-x64.dmg`,
  `Terminus-${expectedVersion}-x64.zip`,
]);
const observedNames = new Set<string>();
const runtimeDigests = new Map<string, string>();
for (const [index, rawArtifact] of evidence.artifacts.entries()) {
  const artifact = object(rawArtifact, `artifacts[${index}]`);
  const kind = string(artifact.kind, `artifacts[${index}].kind`);
  const architecture = string(artifact.architecture, `artifacts[${index}].architecture`);
  const name = string(artifact.name, `artifacts[${index}].name`);
  const digest = string(artifact.sha256, `artifacts[${index}].sha256`);
  const size = integer(artifact.size, `artifacts[${index}].size`);
  if ((kind !== "zip" && kind !== "dmg") || (architecture !== "arm64" && architecture !== "x64")) {
    throw new Error(`invalid desktop artifact coordinates: ${kind}/${architecture}`);
  }
  if (name !== basename(name) || !expectedNames.has(name)) throw new Error(`unexpected desktop artifact name: ${name}`);
  if (observedNames.has(name)) throw new Error(`duplicate desktop artifact evidence: ${name}`);
  observedNames.add(name);
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error(`invalid desktop artifact digest: ${name}`);
  const path = join(artifactsDirectory, name);
  const actualStat = await stat(path);
  if (!actualStat.isFile() || actualStat.size !== size) throw new Error(`desktop artifact size mismatch: ${name}`);
  if (await sha256File(path) !== digest) throw new Error(`desktop artifact digest mismatch: ${name}`);

  const application = object(artifact.application, `${name}.application`);
  if (
    application.bundle_identifier !== "dev.terminus.desktop"
    || application.bundle_version !== expectedVersion
    || application.build_version !== expectedVersion
    || application.packaged_commit !== expectedCommit
    || application.packaged_build_kind !== "release"
    || application.hardened_renderer !== true
  ) {
    throw new Error(`desktop application identity or hardening evidence is invalid: ${name}`);
  }
  const expectedExecutableArchitecture = architecture === "x64" ? "x86_64" : "arm64";
  if (
    !Array.isArray(application.executable_architectures)
    || application.executable_architectures.length !== 1
    || application.executable_architectures[0] !== expectedExecutableArchitecture
  ) {
    throw new Error(`desktop executable architecture evidence is invalid: ${name}`);
  }
  if (
    !Array.isArray(application.asar_roots)
    || JSON.stringify(application.asar_roots) !== JSON.stringify(["dist", "dist-electron", "package.json"])
    || !Array.isArray(application.forbidden_content_matches)
    || application.forbidden_content_matches.length !== 0
    || integer(application.asar_entries, `${name}.asar_entries`) === 0
  ) {
    throw new Error(`desktop standalone-content evidence is invalid: ${name}`);
  }
  for (const field of ["executable_sha256", "asar_sha256", "asar_header_sha256"] as const) {
    if (!/^[0-9a-f]{64}$/.test(string(application[field], `${name}.${field}`))) {
      throw new Error(`invalid ${field} in ${name}`);
    }
  }
  const signature = object(application.signature, `${name}.signature`);
  const runtime = object(application.standalone_runtime, `${name}.standalone_runtime`);
  const expectedTarget = architecture === "x64" ? "x86_64-apple-darwin" : "aarch64-apple-darwin";
  if (
    runtime.schema !== "terminus.desktop-runtime.inspection.v1"
    || runtime.build_kind !== "release"
    || runtime.version !== expectedVersion
    || runtime.candidate_commit !== expectedCommit
    || runtime.architecture !== architecture
    || runtime.target !== expectedTarget
    || integer(runtime.control_files, `${name}.standalone_runtime.control_files`) === 0
    || integer(runtime.migrations, `${name}.standalone_runtime.migrations`) === 0
  ) {
    throw new Error(`desktop standalone runtime identity is invalid: ${name}`);
  }
  const runtimeDigestFields = [
    "manifest_sha256",
    "control_manifest_sha256",
    "control_executable_sha256",
    "query_engine_sha256",
    "kernel_executable_sha256",
  ] as const;
  for (const field of runtimeDigestFields) {
    if (!/^[0-9a-f]{64}$/.test(string(runtime[field], `${name}.standalone_runtime.${field}`))) {
      throw new Error(`invalid standalone runtime ${field}: ${name}`);
    }
  }
  const digestSet = JSON.stringify(runtimeDigestFields.map((field) => runtime[field]));
  const priorDigestSet = runtimeDigests.get(architecture);
  if (priorDigestSet !== undefined && priorDigestSet !== digestSet) {
    throw new Error(`desktop ZIP and DMG embed different ${architecture} runtimes`);
  }
  runtimeDigests.set(architecture, digestSet);
  if (kind === "zip") {
    const launch = object(application.launch, `${name}.application.launch`);
    const launchedArtifact = object(launch.artifact, `${name}.application.launch.artifact`);
    const launchedApplication = object(launch.application, `${name}.application.launch.application`);
    const readiness = object(launch.readiness, `${name}.application.launch.readiness`);
    const shutdown = object(launch.shutdown, `${name}.application.launch.shutdown`);
    if (
      launch.schema !== "terminus.desktop-runtime.launch.v1"
      || launch.status !== "pass"
      || launch.architecture !== architecture
      || launch.build_kind !== "release"
      || launch.candidate_commit !== expectedCommit
      || launch.version !== expectedVersion
      || launchedArtifact.name !== name
      || launchedArtifact.sha256 !== digest
      || integer(launchedArtifact.size, `${name}.application.launch.artifact.size`) !== size
      || launchedApplication.executable_sha256 !== application.executable_sha256
      || launchedApplication.asar_sha256 !== application.asar_sha256
      || launchedApplication.runtime_manifest_sha256 !== runtime.manifest_sha256
    ) {
      throw new Error(`desktop exact-app launch evidence is not artifact-bound: ${name}`);
    }
    const controlPort = integer(
      readiness.control_loopback_port,
      `${name}.application.launch.readiness.control_loopback_port`,
    );
    if (
      controlPort === 0
      || controlPort > 65_535
      || readiness.kernel_uds !== true
      || readiness.public_health_ready !== true
      || readiness.cors_origin !== "terminus://app"
      || readiness.unauthenticated_request_rejected !== true
      || readiness.renderer_process_observed !== true
      || readiness.renderer_loaded_under_csp !== true
      || readiness.renderer_authenticated_request_completed !== true
      || readiness.renderer_sse_stream_opened !== true
      || readiness.private_state !== true
      || readiness.bearer_environment !== "sanitized"
      || shutdown.normal_quit_requested !== true
      || shutdown.application_exited !== true
      || shutdown.runtime_children_exited !== true
      || shutdown.kernel_uds_removed !== true
    ) {
      throw new Error(`desktop exact-app lifecycle evidence is invalid: ${name}`);
    }
    for (const field of ["runtime_log", "electron_log"] as const) {
      const log = object(readiness[field], `${name}.application.launch.readiness.${field}`);
      if (
        !/^[0-9a-f]{64}$/.test(string(log.sha256, `${name}.application.launch.readiness.${field}.sha256`))
        || typeof log.tail !== "string"
        || log.tail.length > 8 * 1_024
        || typeof log.truncated !== "boolean"
      ) {
        throw new Error(`desktop exact-app bounded log evidence is invalid: ${name}/${field}`);
      }
    }
  } else if (application.launch !== undefined) {
    throw new Error(`desktop DMG inspection must not duplicate launch evidence: ${name}`);
  }
  if (!allowUnsigned) {
    if (signature.verified !== true) throw new Error(`desktop signature was not verified: ${name}`);
    if (!/^[0-9A-Fa-f]+$/.test(string(signature.cdhash, `${name}.signature.cdhash`))) {
      throw new Error(`desktop CDHash is invalid: ${name}`);
    }
    const signingTeam = string(signature.team_identifier, `${name}.signature.team_identifier`);
    if (
      runtime.signatures_verified !== true
      || runtime.signing_team_identifier !== signingTeam
    ) {
      throw new Error(`desktop app and standalone runtime signatures do not match: ${name}`);
    }
  }
}
if (observedNames.size !== expectedNames.size) throw new Error("desktop evidence does not cover every expected artifact");

const checksumPath = join(artifactsDirectory, "terminus-desktop.sha256");
const checksumText = await readFile(checksumPath, "utf8");
for (const name of expectedNames) {
  const artifact = object(
    evidence.artifacts.find((candidate) => object(candidate, "artifact").name === name),
    `evidence for ${name}`,
  );
  const digest = string(artifact.sha256, `${name}.sha256`);
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!new RegExp(`^${digest}\\s+\\*?\\.?\\/?${escaped}$`, "m").test(checksumText)) {
    throw new Error(`desktop checksum file is not bound to ${name}`);
  }
}

console.log(JSON.stringify({
  schema: "terminus.desktop-release-evidence.verification.v1",
  status: "pass",
  evidence: evidencePath,
  candidate_commit: expectedCommit,
  version: expectedVersion,
  artifacts: observedNames.size,
}));

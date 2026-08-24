#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { extractFile, getRawHeader, listPackage, statFile } from "@electron/asar";
import { inspectDesktopRuntime } from "./desktop-runtime/manifest";
import { launchDesktopRuntime } from "./desktop-runtime/launch";

const FORBIDDEN_MARKERS = [
  "node-pty",
  "pty.node",
  "@xterm",
  "desktopCapturer",
  "mediaDevices",
  "getUserMedia",
  "getDisplayMedia",
  "URL.createObjectURL",
  "capture:getSources",
  "capture:get-sources",
  "pty:create",
  "pty:write",
  "pty:resize",
  "pty:kill",
] as const;
const FORBIDDEN_RUNTIME = /(?:^|[/@._-])open[-_.]?code(?:$|[/@._-])|(?:^|[/@._-])opencode(?:$|[/@._-])/i;
const MAX_ASAR_ENTRY_BYTES = 16 * 1024 * 1024;

interface ArtifactInput {
  readonly kind: "zip" | "dmg";
  readonly architecture: "arm64" | "x64";
  readonly artifact: string;
  readonly application: string;
}

interface AsarFileStat {
  readonly size?: number;
  readonly files?: Readonly<Record<string, unknown>>;
  readonly integrity?: {
    readonly algorithm?: string;
    readonly hash?: string;
  };
}

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function boundedTail(value: string): string {
  return value.length <= 8_000 ? value : value.slice(value.length - 8_000);
}

async function run(command: readonly string[]): Promise<{ readonly stdout: string; readonly stderr: string }> {
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
    throw new Error(`${command.join(" ")} failed with exit ${exitCode}\n${boundedTail(stdout)}\n${boundedTail(stderr)}`);
  }
  return { stdout: stdout.trim(), stderr: stderr.trim() };
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function infoRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Info.plist did not decode to an object");
  }
  return value as Readonly<Record<string, unknown>>;
}

function parseSigningField(details: string, name: string): string {
  const line = details.split("\n").find((candidate) => candidate.startsWith(`${name}=`));
  if (!line) throw new Error(`codesign output is missing ${name}`);
  return nonEmptyString(line.slice(name.length + 1), `codesign ${name}`);
}

async function inspectApplication(
  input: ArtifactInput,
  expectedCommit: string,
  expectedVersion: string,
  allowUnsigned: boolean,
): Promise<Readonly<Record<string, unknown>>> {
  const app = resolve(input.application);
  const infoPath = join(app, "Contents", "Info.plist");
  const executablePath = join(app, "Contents", "MacOS", "Terminus");
  const asarPath = join(app, "Contents", "Resources", "app.asar");
  const runtimePath = join(app, "Contents", "Resources", "runtime");
  for (const required of [infoPath, executablePath, asarPath]) {
    if (!existsSync(required)) throw new Error(`${input.kind}/${input.architecture}: missing ${required}`);
  }
  if (existsSync(`${asarPath}.unpacked`)) {
    throw new Error(`${input.kind}/${input.architecture}: app.asar.unpacked is forbidden`);
  }

  const plistJson = (await run(["plutil", "-convert", "json", "-o", "-", infoPath])).stdout;
  const info = infoRecord(JSON.parse(plistJson) as unknown);
  const bundleVersion = nonEmptyString(info.CFBundleShortVersionString, "CFBundleShortVersionString");
  const buildVersion = nonEmptyString(info.CFBundleVersion, "CFBundleVersion");
  const bundleIdentifier = nonEmptyString(info.CFBundleIdentifier, "CFBundleIdentifier");
  if (bundleVersion !== expectedVersion || buildVersion !== expectedVersion) {
    throw new Error(`${input.kind}/${input.architecture}: bundle version does not match ${expectedVersion}`);
  }
  if (bundleIdentifier !== "dev.terminus.desktop") {
    throw new Error(`${input.kind}/${input.architecture}: unexpected bundle identifier ${bundleIdentifier}`);
  }

  const rawHeader = getRawHeader(asarPath);
  const headerSha256 = createHash("sha256").update(rawHeader.headerString, "utf8").digest("hex");
  const asarIntegrity = infoRecord(info.ElectronAsarIntegrity);
  const appAsarIntegrity = infoRecord(asarIntegrity["Resources/app.asar"]);
  if (appAsarIntegrity.algorithm !== "SHA256" || appAsarIntegrity.hash !== headerSha256) {
    throw new Error(`${input.kind}/${input.architecture}: ElectronAsarIntegrity does not match the ASAR header`);
  }

  const listed = listPackage(asarPath, { isPack: true }).map((path) => path.replace(/^\//, ""));
  const roots = [...new Set(listed.map((path) => path.split("/")[0]))].sort();
  const expectedRoots = ["dist", "dist-electron", "package.json"];
  if (JSON.stringify(roots) !== JSON.stringify(expectedRoots)) {
    throw new Error(`${input.kind}/${input.architecture}: unexpected ASAR roots: ${roots.join(", ")}`);
  }
  for (const required of [
    "dist/index.html",
    "dist-electron/main.js",
    "dist-electron/preload.js",
    "dist-electron/runtime-contract.js",
    "dist-electron/runtime-supervisor.js",
    "dist-electron/shell-guards.js",
    "package.json",
  ]) {
    if (!listed.includes(required)) throw new Error(`${input.kind}/${input.architecture}: missing ASAR entry ${required}`);
  }

  const files = listed.filter((path) => {
    const file = statFile(asarPath, path) as unknown as AsarFileStat;
    return file.files === undefined;
  });
  const forbiddenMatches: string[] = [];
  for (const path of files) {
    const file = statFile(asarPath, path) as unknown as AsarFileStat;
    const size = file.size ?? -1;
    if (size < 0 || size > MAX_ASAR_ENTRY_BYTES) {
      throw new Error(`${input.kind}/${input.architecture}: unsupported ASAR entry size for ${path}: ${size}`);
    }
    const bytes = extractFile(asarPath, path);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (file.integrity?.algorithm !== "SHA256" || file.integrity.hash !== digest) {
      throw new Error(`${input.kind}/${input.architecture}: ASAR entry integrity mismatch for ${path}`);
    }
    const text = bytes.toString("latin1");
    for (const marker of FORBIDDEN_MARKERS) {
      if (path.includes(marker) || text.includes(marker)) forbiddenMatches.push(`${path}:${marker}`);
    }
    if (FORBIDDEN_RUNTIME.test(path) || FORBIDDEN_RUNTIME.test(text)) {
      forbiddenMatches.push(`${path}:retired-runtime`);
    }
  }
  if (forbiddenMatches.length > 0) {
    throw new Error(`${input.kind}/${input.architecture}: forbidden desktop content: ${forbiddenMatches.join(", ")}`);
  }

  const main = extractFile(asarPath, "dist-electron/main.js").toString("utf8");
  for (const invariant of ["contextIsolation: true", "nodeIntegration: false", "sandbox: true"]) {
    if (!main.includes(invariant)) throw new Error(`${input.kind}/${input.architecture}: main bundle is missing ${invariant}`);
  }
  const renderer = extractFile(asarPath, "dist/index.html").toString("utf8");
  for (const forbidden of ["__TERMINUS_CONNECT_SOURCES__", "ws://localhost:5173", "http://localhost:5173"]) {
    if (renderer.includes(forbidden)) throw new Error(`${input.kind}/${input.architecture}: renderer contains ${forbidden}`);
  }
  const packageJson = infoRecord(JSON.parse(extractFile(asarPath, "package.json").toString("utf8")) as unknown);
  if (
    packageJson.name !== "@terminus/desktop"
    || packageJson.version !== expectedVersion
    || packageJson.terminusCommit !== expectedCommit
    || packageJson.terminusBuildKind !== "release"
  ) {
    throw new Error(`${input.kind}/${input.architecture}: packaged application metadata is invalid`);
  }

  const architectureOutput = (await run(["lipo", "-archs", executablePath])).stdout.split(/\s+/).filter(Boolean);
  const expectedArchitecture = input.architecture === "x64" ? "x86_64" : "arm64";
  if (architectureOutput.length !== 1 || architectureOutput[0] !== expectedArchitecture) {
    throw new Error(`${input.kind}/${input.architecture}: executable architectures are ${architectureOutput.join(", ")}`);
  }

  const standaloneRuntime = await inspectDesktopRuntime({
    root: runtimePath,
    architecture: input.architecture,
    commit: expectedCommit,
    version: expectedVersion,
    allowUnsigned,
    buildKind: "release",
  });

  let signature: Readonly<Record<string, unknown>> = { verified: false };
  let signatureTeam: string | undefined;
  if (!allowUnsigned) {
    await run(["codesign", "--verify", "--deep", "--strict", "--verbose=2", app]);
    const signingDetails = await run(["codesign", "-dv", "--verbose=4", app]);
    const combinedDetails = `${signingDetails.stdout}\n${signingDetails.stderr}`;
    await run(["spctl", "--assess", "--type", "execute", "--verbose=2", app]);
    await run(["xcrun", "stapler", "validate", app]);
    signatureTeam = parseSigningField(combinedDetails, "TeamIdentifier");
    signature = {
      verified: true,
      team_identifier: signatureTeam,
      cdhash: parseSigningField(combinedDetails, "CDHash"),
    };
  }
  if (input.kind === "dmg" && !allowUnsigned) {
    await run(["xcrun", "stapler", "validate", resolve(input.artifact)]);
  }
  if (!allowUnsigned && standaloneRuntime.signing_team_identifier !== signatureTeam) {
    throw new Error(`${input.kind}/${input.architecture}: app and embedded runtime signing teams do not match`);
  }
  const launch = input.kind === "zip"
    ? await launchDesktopRuntime({
      architecture: input.architecture,
      commit: expectedCommit,
      version: expectedVersion,
      buildKind: "release",
      artifact: input.artifact,
    })
    : undefined;

  return {
    bundle_identifier: bundleIdentifier,
    bundle_version: bundleVersion,
    build_version: buildVersion,
    packaged_commit: packageJson.terminusCommit,
    packaged_build_kind: packageJson.terminusBuildKind,
    executable_architectures: architectureOutput,
    executable_sha256: await sha256File(executablePath),
    asar_sha256: await sha256File(asarPath),
    asar_header_sha256: headerSha256,
    asar_entries: files.length,
    asar_roots: roots,
    forbidden_content_matches: forbiddenMatches,
    hardened_renderer: true,
    standalone_runtime: standaloneRuntime,
    signature,
    ...(launch === undefined ? {} : { launch }),
  };
}

function inputs(): readonly ArtifactInput[] {
  const values: ArtifactInput[] = [];
  for (const architecture of ["arm64", "x64"] as const) {
    for (const kind of ["zip", "dmg"] as const) {
      const artifact = argument(`${kind}-${architecture}`);
      const application = argument(`${kind}-${architecture}-app`);
      if ((artifact === undefined) !== (application === undefined)) {
        throw new Error(`${kind}/${architecture} requires both artifact and application paths`);
      }
      if (artifact && application) values.push({ kind, architecture, artifact, application });
    }
  }
  if (values.length === 0) throw new Error("no desktop artifact inputs were provided");
  return values;
}

if (process.platform !== "darwin") throw new Error("desktop content inspection requires macOS");
const version = nonEmptyString(argument("version"), "--version");
const commit = nonEmptyString(argument("commit"), "--commit");
const output = resolve(nonEmptyString(argument("output"), "--output"));
if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("--commit must be a full lowercase Git SHA");
const allowUnsigned = process.argv.includes("--allow-unsigned");
const artifacts: Readonly<Record<string, unknown>>[] = [];
for (const input of inputs()) {
  const artifactPath = resolve(input.artifact);
  const artifactStat = await stat(artifactPath);
  if (!artifactStat.isFile()) throw new Error(`${artifactPath} is not a regular file`);
  artifacts.push({
    kind: input.kind,
    architecture: input.architecture,
    name: basename(artifactPath),
    sha256: await sha256File(artifactPath),
    size: artifactStat.size,
    application: await inspectApplication(input, commit, version, allowUnsigned),
  });
}
const evidence = {
  schema: "terminus.desktop-release-evidence.v1",
  status: "pass",
  candidate_commit: commit,
  version,
  generated_at: new Date().toISOString(),
  artifacts,
};
await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ schema: evidence.schema, status: evidence.status, output, artifacts: artifacts.length }));

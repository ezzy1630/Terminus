#!/usr/bin/env bun
import { join, resolve } from "node:path";
import { extractFile } from "@electron/asar";
import { requireRuntimeBuildKind } from "../apps/desktop/electron/runtime-contract";
import {
  inspectDesktopRuntime,
  type DesktopRuntimeArchitecture,
} from "./desktop-runtime/manifest";

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function required(name: string): string {
  const value = argument(name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

const commit = required("commit");
const version = required("version");
const allowUnsigned = process.argv.includes("--allow-unsigned");
const buildKind = requireRuntimeBuildKind(argument("build-kind") ?? "release");
const results = [];
for (const architecture of ["arm64", "x64"] as const satisfies readonly DesktopRuntimeArchitecture[]) {
  const application = resolve(required(`app-${architecture}`));
  const packagedMetadata = JSON.parse(
    extractFile(join(application, "Contents", "Resources", "app.asar"), "package.json").toString("utf8"),
  ) as unknown;
  if (typeof packagedMetadata !== "object" || packagedMetadata === null || Array.isArray(packagedMetadata)) {
    throw new Error(`${architecture} packaged package.json is not an object`);
  }
  const metadata = packagedMetadata as Readonly<Record<string, unknown>>;
  if (
    metadata.name !== "@terminus/desktop"
    || metadata.version !== version
    || metadata.terminusCommit !== commit
    || metadata.terminusBuildKind !== buildKind
  ) {
    throw new Error(`${architecture} packaged package.json is not bound to the runtime identity`);
  }
  const runtime = await inspectDesktopRuntime({
    root: join(application, "Contents", "Resources", "runtime"),
    architecture,
    commit,
    version,
    allowUnsigned,
    buildKind,
  });
  if (
    runtime.version !== metadata.version
    || runtime.candidate_commit !== metadata.terminusCommit
    || runtime.build_kind !== metadata.terminusBuildKind
  ) {
    throw new Error(`${architecture} packaged application and runtime identities do not match`);
  }
  results.push(runtime);
}
console.log(JSON.stringify({
  schema: "terminus.desktop-runtime.packaging-verification.v1",
  status: "pass",
  runtimes: results,
}));

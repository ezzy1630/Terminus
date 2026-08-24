#!/usr/bin/env bun
import { resolve } from "node:path";
import {
  createDesktopRuntimeManifest,
  inspectDesktopRuntime,
  type DesktopRuntimeArchitecture,
} from "./desktop-runtime/manifest";
import { requireRuntimeBuildKind } from "../apps/desktop/electron/runtime-contract";

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function required(name: string): string {
  const value = argument(name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function architecture(): DesktopRuntimeArchitecture {
  const value = required("architecture");
  if (value !== "arm64" && value !== "x64") throw new Error(`unsupported architecture: ${value}`);
  return value;
}

const options = {
  root: resolve(required("runtime-root")),
  architecture: architecture(),
  commit: required("commit"),
  version: required("version"),
  buildKind: requireRuntimeBuildKind(argument("build-kind") ?? "release"),
  allowUnsigned: process.argv.includes("--allow-unsigned"),
} as const;
await createDesktopRuntimeManifest(options);
const result = await inspectDesktopRuntime(options);
console.log(JSON.stringify({
  schema: "terminus.desktop-runtime.creation.v1",
  status: "pass",
  runtime: result,
}));

#!/usr/bin/env bun

import { readSync } from "node:fs";

const expectedProtocol = "terminus.local-provider.v1";
const expectedModel = "local/e2e-model";
const maximumRequestBytes = 1_024 * 1_024;

function readRequestLine(): string {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const buffer = new Uint8Array(64 * 1_024);
  let input = "";
  while (!input.includes("\n")) {
    const bytesRead = readSync(0, buffer, 0, buffer.byteLength, null);
    if (bytesRead === 0) break;
    input += decoder.decode(buffer.subarray(0, bytesRead), { stream: true });
    if (input.length > maximumRequestBytes) {
      throw new Error("provider request exceeded the fixture input limit");
    }
  }
  input += decoder.decode();
  return input.split("\n", 1)[0] ?? "";
}

if (process.env.TERMINUS_PROVIDER_PROTOCOL !== expectedProtocol) {
  throw new Error("provider protocol environment was not brokered");
}

const rawRequest = readRequestLine();
const request: unknown = JSON.parse(rawRequest);
if (
  typeof request !== "object"
  || request === null
  || !("protocol" in request)
  || request.protocol !== expectedProtocol
  || !("provider" in request)
  || request.provider !== "local"
  || !("model" in request)
  || request.model !== expectedModel
  || !("body" in request)
  || typeof request.body !== "object"
  || request.body === null
) {
  throw new Error("provider request did not satisfy the NDJSON input contract");
}

const renderedBody = JSON.stringify(request.body);
const isRestartRecoveryTask = renderedBody.includes(
  "exercise deterministic process restart during provider execution",
);
const isIntegrationSpineTask = renderedBody.includes("PR 7 Turn Integration Spine Task");
const isPackagedDesktopTask = renderedBody.includes(
  "exercise packaged desktop deterministic task",
);
const isBuildFailureTask = renderedBody.includes("build-001")
  && renderedBody.includes("missing import");
function declaresTool(value: unknown, toolName: string): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const tools = (value as Record<string, unknown>).tools;
  if (!Array.isArray(tools)) return false;
  return tools.some((tool) => {
    if (typeof tool !== "object" || tool === null || Array.isArray(tool)) return false;
    const fn = (tool as Record<string, unknown>).function;
    return typeof fn === "object"
      && fn !== null
      && !Array.isArray(fn)
      && (fn as Record<string, unknown>).name === toolName;
  });
}
const workspaceReadAvailable = declaresTool(request.body, "read");
const workspaceInspectAvailable = declaresTool(request.body, "inspect");
const exerciseInspect = process.env.TERMINUS_E2E_EXPECT_INSPECT === "1";
// Keep the contiguous marker out of this provider source. The model request
// can contain repository metadata for this file; only the deep read result
// may satisfy this check.
const deepReadMarker = ["TERMINUS", "DEEP", "RANGE", "SENTINEL"].join("_");
function hasToolResultContaining(value: unknown, markers: readonly string[]): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => hasToolResultContaining(entry, markers));
  }
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.role === "tool") {
    const serialized = JSON.stringify(record);
    return markers.every((marker) => serialized.includes(marker));
  }
  return Object.values(record).some((entry) => hasToolResultContaining(entry, markers));
}
const deepReadSettled = hasToolResultContaining(request.body, [
  deepReadMarker,
  "e2e-large-fixture.txt",
  "40001",
  "40002",
]);
const buildReadSettled = hasToolResultContaining(request.body, [
  "src/main.py",
  "file_sha256",
]);
const buildInspectSettled = hasToolResultContaining(request.body, [
  "Repository map returned",
  "src/main.py",
]);
const buildPatchSettled = hasToolResultContaining(request.body, [
  "src/main.py",
  "new_sha256",
]);
const buildExecSettled = hasToolResultContaining(request.body, [
  "exit_code",
  "stdout",
]);
const emitDone = (): void => {
  console.log(JSON.stringify({
    kind: "done",
    usage: {
      input_tokens: 17,
      cached_input_tokens: 0,
      cache_write_tokens: 0,
      output_tokens: 9,
      reasoning_tokens: 0,
      tool_schema_tokens: 0,
      latency_ms: 250,
      time_to_first_token_ms: 250,
    },
  }));
};

const restartCrashBoundary = "TERMINUS_E2E_CRASH_BOUNDARY";
const sleep = (milliseconds: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
};
if (rawRequest.includes(restartCrashBoundary)) {
  // The supervisor kills control while this bounded provider attempt is
  // running. The restart reconciler, rather than a user-interrupt handler,
  // must own the resulting BLOCKED/INTERRUPTED transition.
  sleep(9_000);
} else {
  sleep(250);
}

// Exercise both profile arms. Minimal must activate workspace capabilities;
// adaptive already declares read and starts useful work on its first request.
// State comes only from the replayed transcript, so each fixture process is
// stateless.
if (
  !renderedBody.includes('"role":"tool"')
  && !(isBuildFailureTask && workspaceReadAvailable)
) {
  console.log(JSON.stringify({
    kind: "tool_call",
    tool_call: {
      tool_call_id: "fixture-capability",
      tool_name: "capability",
      arguments: { action: "activate_workspace" },
    },
  }));
  emitDone();
  process.exit(0);
}

if (isBuildFailureTask && exerciseInspect && workspaceInspectAvailable && !buildInspectSettled) {
  console.log(JSON.stringify({
    kind: "tool_call",
    tool_call: {
      tool_call_id: "fixture-build-inspect",
      tool_name: "inspect",
      arguments: { action: "repository_map", limit: 10 },
    },
  }));
  emitDone();
  process.exit(0);
}

if (isBuildFailureTask && !buildReadSettled) {
  console.log(JSON.stringify({
    kind: "tool_call",
    tool_call: {
      tool_call_id: "fixture-build-read",
      tool_name: "read",
      arguments: { path: "src/main.py", render: "raw" },
    },
  }));
  emitDone();
  process.exit(0);
}

if (isBuildFailureTask && !buildPatchSettled) {
  const expectedUtf8 = `"""Small command entry point with an import-time build failure."""

from .runner import run


def main(argv: list[str] | None = None) -> int:
    """Run the command and return its process status."""
    if argv is None:
        argv = []
    return run(argv)


if __name__ == "__main__":
    sys.exit(main())
`;
  const replacementUtf8 = expectedUtf8.replace(
    "from .runner import run",
    "import sys\n\nfrom .runner import run",
  );
  console.log(JSON.stringify({
    kind: "tool_call",
    tool_call: {
      tool_call_id: "fixture-build-patch",
      tool_name: "patch",
      arguments: {
        path: "src/main.py",
        expected_utf8: expectedUtf8,
        replacement_utf8: replacementUtf8,
      },
    },
  }));
  emitDone();
  process.exit(0);
}

if (isBuildFailureTask && !buildExecSettled) {
  console.log(JSON.stringify({
    kind: "tool_call",
    tool_call: {
      tool_call_id: "fixture-build-exec",
      tool_name: "exec",
      arguments: {
        cmd: 'git status --short -- "src/main.py"',
        workdir: ".",
      },
    },
  }));
  emitDone();
  process.exit(0);
}

if (isBuildFailureTask) {
  console.log(JSON.stringify({
    kind: "text",
    text: "Added the missing sys import after reading and patching src/main.py.",
  }));
  emitDone();
  process.exit(0);
}

if (!renderedBody.includes("file_sha256")) {
  console.log(JSON.stringify({
    kind: "tool_call",
    tool_call: {
      tool_call_id: "fixture-read",
      tool_name: "read",
      arguments: { path: "e2e-fixture.txt", render: "raw" },
    },
  }));
  emitDone();
  process.exit(0);
}

if (isRestartRecoveryTask) {
  console.log(JSON.stringify({
    kind: "text",
    text: "Terminus resumed the interrupted provider turn and re-read the scoped workspace fixture.",
  }));
  emitDone();
  process.exit(0);
}

if (isIntegrationSpineTask && !deepReadSettled) {
  console.log(JSON.stringify({
    kind: "tool_call",
    tool_call: {
      tool_call_id: "fixture-deep-read",
      tool_name: "read",
      arguments: {
        path: "e2e-large-fixture.txt",
        offset_line: 40_001,
        max_lines: 2,
        render: "raw",
      },
    },
  }));
  emitDone();
  process.exit(0);
}

if (!renderedBody.includes("new_sha256")) {
  const expectedUtf8 = isPackagedDesktopTask
    ? "Terminus deterministic read fixture.\n"
    : isIntegrationSpineTask
      ? "Terminus agent-loop verified fixture.\n"
      : "Terminus deterministic patched fixture.\n";
  const replacementUtf8 = isPackagedDesktopTask
    ? "Terminus deterministic patched fixture.\n"
    : isIntegrationSpineTask
      ? "Terminus integration-spine verified fixture.\n"
      : "Terminus agent-loop verified fixture.\n";
  console.log(JSON.stringify({
    kind: "tool_call",
    tool_call: {
      tool_call_id: "fixture-patch",
      tool_name: "patch",
      arguments: {
        path: "e2e-fixture.txt",
        expected_utf8: expectedUtf8,
        replacement_utf8: replacementUtf8,
      },
    },
  }));
  emitDone();
  process.exit(0);
}

console.log(JSON.stringify({
  kind: "text",
  text: "Terminus provider fixture received local/e2e-model through kernel job input.",
}));
emitDone();

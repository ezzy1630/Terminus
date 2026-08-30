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
if (rawRequest.includes(restartCrashBoundary)) {
  // The supervisor kills control while this bounded provider attempt is
  // running. The restart reconciler, rather than a user-interrupt handler,
  // must own the resulting BLOCKED/INTERRUPTED transition.
  await Bun.sleep(9_000);
} else {
  await Bun.sleep(250);
}

// Exercise the real model-facing tool loop. The first minimal-profile request
// can only activate workspace capabilities; later requests read and patch the
// fixture before proposing completion. State is derived solely from the
// replayed provider transcript so every fixture process remains stateless.
if (!renderedBody.includes('"role":"tool"')) {
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

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

const restartCrashBoundary = "TERMINUS_E2E_CRASH_BOUNDARY";
if (rawRequest.includes(restartCrashBoundary)) {
  // The supervisor kills control while this bounded provider attempt is
  // running. The restart reconciler, rather than a user-interrupt handler,
  // must own the resulting BLOCKED/INTERRUPTED transition.
  await Bun.sleep(9_000);
} else {
  await Bun.sleep(250);
}

console.log(JSON.stringify({
  kind: "text",
  text: "Terminus provider fixture received local/e2e-model through kernel job input.",
}));
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

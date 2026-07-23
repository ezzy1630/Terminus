import { test, expect } from "bun:test";
import {
  RequestContext,
  EffectIntent,
} from "./generated-ts-proto/terminus/kernel/v1/kernel.js";

test("RequestContext ts-proto compatibility and default encoding", () => {
  const ctx = RequestContext.fromPartial({
    requestId: "ts-req-1",
    idempotencyKey: "ts-idemp-1",
    sessionId: "sess-1",
    taskId: "task-1",
    turnId: "turn-1",
    actorId: "actor-1",
    capabilityToken: "token-123",
    workspaceId: "ws-1",
  });

  const bytes = RequestContext.encode(ctx).finish();
  expect(bytes.length).toBeGreaterThan(0);

  const decoded = RequestContext.decode(bytes);
  expect(decoded.requestId).toBe("ts-req-1");
  expect(decoded.idempotencyKey).toBe("ts-idemp-1");
  expect(decoded.capabilityToken).toBe("token-123");
});

test("KernelInfo instanceId round-trip for remote identity binding", async () => {
  const { KernelInfo } = await import("./generated-ts-proto/terminus/kernel/v1/kernel.js");
  const info = KernelInfo.fromPartial({
    version: "0.1.0",
    protocolVersion: "terminus.kernel.v1",
    buildRevision: "dev",
    instanceId: "kernel:abc",
  });
  const decoded = KernelInfo.decode(KernelInfo.encode(info).finish());
  expect(decoded.instanceId).toBe("kernel:abc");
});

test("EffectIntent ts-proto trust label compatibility", () => {
  const intent = EffectIntent.fromPartial({
    userIntentRef: "ref-1",
    taskContractHash: "sha256:abc",
    trustLabel: "trusted",
    confidentialityLabel: "workspace",
    taintSources: [],
    policyProfileId: "secure-local-default",
  });

  const bytes = EffectIntent.encode(intent).finish();
  const decoded = EffectIntent.decode(bytes);
  expect(decoded.trustLabel).toBe("trusted");
  expect(decoded.policyProfileId).toBe("secure-local-default");
});

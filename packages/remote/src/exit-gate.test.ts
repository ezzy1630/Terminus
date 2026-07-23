import { describe, expect, test } from "bun:test";
import {
  assertKernelPeer,
  durableRecordsEquivalent,
  disconnectPreservesSafety,
  onDisconnect,
  parseDeploymentIdentities,
  parsePinnedImage,
  EffectState,
  ExecutionMode,
  type DurableEffectRecord,
} from "./index.js";
import { asKernelId } from "@terminus/domain";

describe("remote exit gate", () => {
  test("local and remote durable records equivalent", () => {
    const local: DurableEffectRecord = {
      effectId: "eff-1",
      taskId: "task-1",
      workspaceId: "ws-1",
      kernelIdentity: asKernelId("kernel:k1"),
      state: EffectState.SETTLED,
      executionMode: ExecutionMode.LOCAL,
      evidenceRefs: ["artifact://sha256/aa"],
    };
    const remote: DurableEffectRecord = {
      ...local,
      executionMode: ExecutionMode.REMOTE,
    };
    expect(durableRecordsEquivalent(local, remote)).toBe(true);
  });

  test("identity isolation rejects foreign kernel", () => {
    const ids = parseDeploymentIdentities({
      server: "server:s1",
      kernel: "kernel:k1",
      control: "control:c1",
    });
    expect(() => assertKernelPeer(ids.kernel, "kernel:other")).toThrow();
    expect(() => assertKernelPeer(ids.kernel, "kernel:k1")).not.toThrow();
  });

  test("disconnect cannot corrupt started into settled", () => {
    const after = onDisconnect(EffectState.STARTED);
    expect(after).toBe(EffectState.UNKNOWN);
    expect(disconnectPreservesSafety(EffectState.STARTED, after)).toBe(true);
    expect(disconnectPreservesSafety(EffectState.STARTED, EffectState.SETTLED)).toBe(false);
  });

  test("pinned image rejects latest", () => {
    expect(() => parsePinnedImage("alpine:latest")).toThrow();
    const pinned = parsePinnedImage(
      "alpine@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    expect(pinned.repository).toBe("alpine");
  });
});

import { describe, test, expect } from "bun:test";
import {
  HookRunner,
  validateInstallation,
  ProcessExtensionHost,
  type ExtensionHost,
  type KernelExtensionPort,
  type BoundExtension,
} from "./index.js";
import { ValidationError, type Rfc3339Timestamp, type Uuid7, type ContentHash } from "@terminus/domain";

describe("Extension Host Unit Tests", () => {
  const clock = () => Date.now();
  const timestamp = "2026-07-22T14:50:00Z" as Rfc3339Timestamp;
  const uuid = "018f7d98-1234-7000-8000-000000000001" as Uuid7;

  test("HookRunner sorts hooks deterministically by priority then extensionId", async () => {
    const executed: string[] = [];

    const mockHost = (extId: string): ExtensionHost => ({
      kind: "wasi",
      limits: { wallClockMs: 5000, memoryBytes: 64 * 1024 * 1024, cpuMs: 3000, outputBytes: 1024 },
      async invoke() {
        executed.push(extId);
        return { kind: "observe_only" };
      },
    });

    const runner = new HookRunner({ hostFor: mockHost, clock });

    await runner.run(
      [
        { kind: "observe_only", extensionId: "ext-z", priority: 10 },
        { kind: "observe_only", extensionId: "ext-a", priority: 5 },
        { kind: "observe_only", extensionId: "ext-b", priority: 5 },
      ],
      { eventId: uuid, aggregateType: "task", aggregateId: "t1", payload: {}, occurredAt: timestamp },
    );

    expect(executed).toEqual(["ext-a", "ext-b", "ext-z"]);
  });

  test("validateInstallation enforces signature for verified_third_party and blocks lifecycle scripts for untrusted", () => {
    expect(() =>
      validateInstallation({
        packageUri: "pkg://a",
        pinnedDigest: "sha256:1" as ContentHash,
        signature: null,
        publisher: "pub",
        trustLevel: "verified_third_party",
      }),
    ).toThrow(ValidationError);

    expect(() =>
      validateInstallation({
        packageUri: "pkg://b",
        pinnedDigest: "sha256:2" as ContentHash,
        signature: null,
        publisher: "pub",
        trustLevel: "untrusted",
        lifecycleScripts: { postinstall: "malicious.js" },
      }),
    ).toThrow(ValidationError);

    const valid = validateInstallation({
      packageUri: "pkg://c",
      pinnedDigest: "sha256:3" as ContentHash,
      signature: "sig",
      publisher: "pub",
      trustLevel: "verified_third_party",
    });
    expect(valid.contentHash).toBe("sha256:3" as ContentHash);
  });

  test("ProcessExtensionHost delegates to kernel with timeout", async () => {
    const calls: string[] = [];
    const kernel: KernelExtensionPort = {
      async invoke(req) {
        calls.push(req.extensionId);
        return { kind: "propose_annotation", annotation: { note: "x" } };
      },
    };
    const binding: BoundExtension = {
      extensionId: "ext-p",
      entrypoint: "hook.js",
      contentHash:
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as ContentHash,
      capabilityGrantId: "g1",
      grantedCapabilities: ["annotate"],
      trustLevel: "verified_third_party",
    };
    const host = new ProcessExtensionHost(binding, kernel);
    const outcome = await host.invoke({
      capability: { kind: "propose_annotation", extensionId: "ext-p", priority: 1 },
      event: {
        eventId: uuid,
        aggregateType: "task",
        aggregateId: "t1",
        payload: {},
        occurredAt: timestamp,
      },
      timeoutMs: 1000,
    });
    expect(calls).toEqual(["ext-p"]);
    expect(outcome.kind).toBe("propose_annotation");
  });
});

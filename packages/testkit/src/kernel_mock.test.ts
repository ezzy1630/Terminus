import { describe, it, expect, beforeEach } from "bun:test";
import {
  MockKernelClient,
  EffectTranscriptReplayer,
  MockKernelError,
  mockCapabilityBrokerReceipt,
  mockSecretBrokerReceipt,
} from "./kernel_mock.js";
import { computeContentHash } from "@terminus/context-ir";
import { artifactUriFromHex } from "@terminus/domain";

describe("MockKernelClient", () => {
  let client: MockKernelClient;

  beforeEach(() => {
    client = new MockKernelClient();
  });

  it("handles process execution and records calls with intent", async () => {
    client.scriptResponse("executeProcess", {
      exitCode: 0,
      stdout: "hello world\n",
      stderr: "",
      timedOut: false,
    });

    const res = await client.executeProcess({
      command: ["echo", "hello world"],
      intent: {
        taskId: "task-100",
        justification: "test execution",
      },
    });

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("hello world\n");
    expect(client.recordedCalls.length).toBe(1);
    expect(client.recordedCalls[0]?.method).toBe("executeProcess");

    client.assertCallCount("executeProcess", 1);
    client.assertCalledWithIntent("executeProcess");
  });

  it("supports explicitly scripted virtual filesystem reads and writes", async () => {
    client
      .scriptResponse("readFile", {
        content: new TextEncoder().encode("initial content"),
        truncated: false,
      })
      .scriptResponse("writeFile", { bytesWritten: 15 })
      .scriptResponse("readFile", {
        content: new TextEncoder().encode("updated content"),
        truncated: false,
      });

    const read1 = await client.readFile({ path: "/virtual/test.txt" });
    expect(new TextDecoder().decode(read1.content)).toBe("initial content");

    await client.writeFile({
      path: "/virtual/test.txt",
      content: new TextEncoder().encode("updated content"),
    });

    const read2 = await client.readFile({ path: "/virtual/test.txt" });
    expect(new TextDecoder().decode(read2.content)).toBe("updated content");
  });

  it("injects policy rejections and errors deterministically", async () => {
    client.injectPolicyDenial("executeProcess", "command 'rm -rf /' denied by root policy");

    expect(
      client.executeProcess({
        command: ["rm", "-rf", "/"],
      }),
    ).rejects.toThrow(/POLICY_DENIED/);

    expect(client.recordedCalls.length).toBe(1);
    expect(client.recordedCalls[0]?.error).toBeInstanceOf(MockKernelError);
  });

  it("returns only opaque handles and broker receipts for secret access", async () => {
    const secretRequest = {
      capabilityUri: "secret://fixture/repository-read",
      requestedBy: "task-100",
    } as const;
    client.scriptResponse(
      "fetchSecret",
      mockSecretBrokerReceipt({ ...secretRequest, handleId: "repository-read" }),
    );

    const secret = await client.fetchSecret(secretRequest);
    expect(secret.brokerReceipt.capabilityUri).toBe(secretRequest.capabilityUri);
    expect(secret.brokerReceipt.handle).toBe("secret-handle://repository-read");
    expect(secret.brokerReceipt.requestedBy).toBe("task-100");
    expect(secret.brokerReceipt).not.toHaveProperty("value");

    const capabilityRequest = {
      capabilityId: "cap-fs-read",
      principal: "operator",
      scope: "read:/src",
    } as const;
    client.scriptResponse(
      "acquireCapabilityToken",
      mockCapabilityBrokerReceipt(capabilityRequest, "fs-read"),
    );

    const capability = await client.acquireCapabilityToken(capabilityRequest);
    expect(capability.handle).toBe("capability-handle://fs-read");
    expect(capability.brokerReceipt.capabilityId).toBe("cap-fs-read");
    expect(capability.brokerReceipt).not.toHaveProperty("value");
  });

  it("ingests artifacts through an explicit fixture script", async () => {
    const data = new TextEncoder().encode("artifact binary contents");
    const hash = computeContentHash(data);
    client.scriptResponse("ingestArtifact", {
      hash,
      uri: artifactUriFromHex(hash.slice("sha256:".length)),
    });
    const result = await client.ingestArtifact({ bytes: data });

    expect(result.hash).toBe(hash);
    expect(result.uri).toMatch(/^artifact:\/\/sha256\/[0-9a-f]{64}$/);
  });

  it("fails closed for every unscripted privileged call", async () => {
    await expect(client.executeProcess({ command: ["true"] })).rejects.toMatchObject({
      code: "UNSCRIPTED_CALL",
    });
    await expect(client.readFile({ path: "/virtual/read.txt" })).rejects.toMatchObject({
      code: "UNSCRIPTED_CALL",
    });
    await expect(client.writeFile({
      path: "/virtual/write.txt",
      content: new Uint8Array(),
    })).rejects.toMatchObject({ code: "UNSCRIPTED_CALL" });
    await expect(client.fetchSecret({
      capabilityUri: "secret://fixture/repository-read",
      requestedBy: "task-100",
    })).rejects.toMatchObject({ code: "UNSCRIPTED_CALL" });
    await expect(client.acquireCapabilityToken({
      capabilityId: "cap-fs-read",
      principal: "operator",
      scope: "read:/src",
    })).rejects.toMatchObject({ code: "UNSCRIPTED_CALL" });
    await expect(client.ingestArtifact({ bytes: new Uint8Array() })).rejects.toMatchObject({
      code: "UNSCRIPTED_CALL",
    });

    expect(client.recordedCalls).toHaveLength(6);
    expect(client.recordedCalls.every((call) => (
      call.error instanceof MockKernelError && call.error.code === "UNSCRIPTED_CALL"
    ))).toBe(true);
  });
});

describe("EffectTranscriptReplayer", () => {
  it("replays recorded transcript steps and detects divergence", () => {
    const transcript = [
      {
        method: "executeProcess",
        request: { command: ["git", "status"] },
        response: { exitCode: 0, stdout: "clean" },
      },
      {
        method: "readFile",
        request: { path: "package.json" },
        response: { content: new Uint8Array([1, 2, 3]) },
      },
    ];

    const replayer = new EffectTranscriptReplayer(transcript);
    expect(replayer.remainingSteps).toBe(2);

    const step1 = replayer.next<{ exitCode: number; stdout: string }>("executeProcess", {
      command: ["git", "status"],
    });
    expect(step1.stdout).toBe("clean");
    expect(replayer.remainingSteps).toBe(1);

    // Mismatched step should fail
    expect(() => replayer.next("executeProcess", {})).toThrow(/Transcript step mismatch/);
  });

  it("rejects request drift even when the method is unchanged", () => {
    const replayer = new EffectTranscriptReplayer([{
      method: "readFile",
      request: { path: "expected.txt" },
      response: { content: new Uint8Array() },
    }]);

    expect(() => replayer.next("readFile", { path: "other.txt" })).toThrow(
      /Transcript request mismatch/,
    );
  });
});

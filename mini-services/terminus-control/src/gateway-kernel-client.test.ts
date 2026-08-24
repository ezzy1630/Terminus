import { describe, expect, test } from "bun:test";
import { KernelGatewayClient } from "./gateway-kernel-client.js";
import type { RequestContext } from "../../../packages/terminus-kernel-client/src/generated-ts-proto/terminus/kernel/v1/kernel.js";

const context: RequestContext = {
  requestId: "request",
  idempotencyKey: "attempt",
  sessionId: "session",
  taskId: "task",
  turnId: "turn",
  actorId: "control",
  traceparent: "",
  capabilityToken: "opaque",
  workspaceId: "workspace",
  deadline: undefined,
  resourceBudgets: undefined,
  policyVersion: "v1",
};

describe("KernelGatewayClient", () => {
  test("mints an exact grant and returns the scrubbed kernel body", async () => {
    const calls: unknown[] = [];
    const client = new KernelGatewayClient({
        MintGrant: async (request) => {
          calls.push(request);
          return { encodedGrant: "opaque-grant", grantId: "grant", expiresAtUnix: 1 };
        },
        Execute: async (request) => {
          calls.push(request);
          return {
            receipt: {
              grantId: "grant", taskId: "task", effectId: "effect", connectorId: "opencode-gateway",
              method: "POST", path: "/zen/v1/chat/completions", destination: "https://opencode.ai:443",
              requestSha256: "a".repeat(64), statusCode: 200, responseSha256: "b".repeat(64),
              responseRedactions: 0, outcome: "accepted",
            },
            body: new TextEncoder().encode("data: [DONE]\n\n"),
            contentType: "text/event-stream",
          };
        },
    }, context);
    const chunks: Uint8Array[] = [];
    for await (const chunk of client.stream({
      url: "https://opencode.ai/zen/v1/chat/completions",
      method: "POST",
      headers: { accept: "text/event-stream", "content-type": "application/json" },
      body: "{}",
      credentialBindingId: "secret://opencode/zen",
      authStyle: "bearer",
      signal: null,
    })) chunks.push(chunk);
    expect(new TextDecoder().decode(chunks[0])).toBe("data: [DONE]\n\n");
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(calls)).not.toContain("api-key");
  });

  test("rejects destination substitution before minting", async () => {
    let called = false;
    const client = new KernelGatewayClient({
      MintGrant: async () => { called = true; throw new Error("unexpected"); },
      Execute: async () => { called = true; throw new Error("unexpected"); },
    }, context);
    const consume = async (): Promise<void> => {
      for await (const _chunk of client.stream({
        url: "https://example.com/zen/v1/chat/completions",
        method: "POST", headers: {}, body: "{}", credentialBindingId: "secret://opencode/zen",
        authStyle: "bearer", signal: null,
      })) { /* unreachable */ }
    };
    await expect(consume()).rejects.toThrow("outside the admitted");
    expect(called).toBe(false);
  });
});

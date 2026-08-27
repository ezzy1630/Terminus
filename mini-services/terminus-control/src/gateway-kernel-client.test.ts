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

  test("selects the anonymous kernel connector for a public gateway binding", async () => {
    let connectorId: string | null = null;
    const client = new KernelGatewayClient({
      MintGrant: async (request) => {
        connectorId = request.binding?.connectorId ?? null;
        return { encodedGrant: "opaque-grant", grantId: "grant", expiresAtUnix: 1 };
      },
      Execute: async () => ({
        receipt: {
          grantId: "grant", taskId: "task", effectId: "effect", connectorId: "opencode-gateway-anonymous",
          method: "GET", path: "/zen/v1/models", destination: "https://opencode.ai:443",
          requestSha256: "a".repeat(64), statusCode: 200, responseSha256: "b".repeat(64),
          responseRedactions: 0, outcome: "accepted",
        },
        body: new TextEncoder().encode("{}"),
        contentType: "application/json",
      }),
    }, context);

    const chunks: Uint8Array[] = [];
    for await (const chunk of client.stream({
      url: "https://opencode.ai/zen/v1/models",
      method: "GET",
      headers: { accept: "application/json" },
      credentialBindingId: "",
      authStyle: "none",
      signal: null,
    })) chunks.push(chunk);

    expect(connectorId).toBe("opencode-gateway-anonymous");
    expect(new TextDecoder().decode(chunks[0])).toBe("{}");
  });

  test("streams multiple SSE frames incrementally", async () => {
    const sseBody = "data: {\"choices\":[{\"delta\":{\"content\":\"Hello\"}}]}\n\ndata: {\"choices\":[{\"delta\":{\"content\":\" world\"}}]}\n\ndata: [DONE]\n\n";
    const client = new KernelGatewayClient({
      MintGrant: async () => ({ encodedGrant: "opaque-grant", grantId: "grant", expiresAtUnix: 1 }),
      Execute: async () => ({
        receipt: {
          grantId: "grant", taskId: "task", effectId: "effect", connectorId: "opencode-gateway",
          method: "POST", path: "/zen/v1/chat/completions", destination: "https://opencode.ai:443",
          requestSha256: "a".repeat(64), statusCode: 200, responseSha256: "b".repeat(64),
          responseRedactions: 0, outcome: "accepted",
        },
        body: new TextEncoder().encode(sseBody),
        contentType: "text/event-stream",
      }),
    }, context);

    const chunks: string[] = [];
    for await (const chunk of client.stream({
      url: "https://opencode.ai/zen/v1/chat/completions",
      method: "POST",
      headers: { accept: "text/event-stream", "content-type": "application/json" },
      body: "{}",
      credentialBindingId: "secret://opencode/zen",
      authStyle: "bearer",
      signal: null,
    })) {
      chunks.push(new TextDecoder().decode(chunk));
    }

    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toBe("data: {\"choices\":[{\"delta\":{\"content\":\"Hello\"}}]}\n\n");
    expect(chunks[1]).toBe("data: {\"choices\":[{\"delta\":{\"content\":\" world\"}}]}\n\n");
    expect(chunks[2]).toBe("data: [DONE]\n\n");
  });

  test("aborts immediately when signal is aborted prior to dispatch", async () => {
    const controller = new AbortController();
    controller.abort();

    const client = new KernelGatewayClient({
      MintGrant: async () => { throw new Error("should not be called"); },
      Execute: async () => { throw new Error("should not be called"); },
    }, context);

    const consume = async (): Promise<void> => {
      for await (const _chunk of client.stream({
        url: "https://opencode.ai/zen/v1/chat/completions",
        method: "POST",
        headers: {},
        body: "{}",
        credentialBindingId: "secret://opencode/zen",
        authStyle: "bearer",
        signal: controller.signal,
      })) { /* unreachable */ }
    };

    await expect(consume()).rejects.toThrow("gateway request was aborted");
  });

  test("aborts immediately when signal triggers during Execute", async () => {
    const controller = new AbortController();
    const client = new KernelGatewayClient({
      MintGrant: async () => ({ encodedGrant: "opaque-grant", grantId: "grant", expiresAtUnix: 1 }),
      Execute: async () => {
        // Trigger abort while Execute is in-flight
        controller.abort();
        await new Promise((resolve) => setTimeout(resolve, 50));
        return {
          receipt: {
            grantId: "grant", taskId: "task", effectId: "effect", connectorId: "opencode-gateway",
            method: "POST", path: "/zen/v1/chat/completions", destination: "https://opencode.ai:443",
            requestSha256: "a".repeat(64), statusCode: 200, responseSha256: "b".repeat(64),
            responseRedactions: 0, outcome: "accepted",
          },
          body: new TextEncoder().encode("data: [DONE]\n\n"),
        };
      },
    }, context);

    const consume = async (): Promise<void> => {
      for await (const _chunk of client.stream({
        url: "https://opencode.ai/zen/v1/chat/completions",
        method: "POST",
        headers: {},
        body: "{}",
        credentialBindingId: "secret://opencode/zen",
        authStyle: "bearer",
        signal: controller.signal,
      })) { /* unreachable */ }
    };

    await expect(consume()).rejects.toThrow("gateway request was aborted");
  });

  test("aborts mid-stream between yielded chunks", async () => {
    const controller = new AbortController();
    const sseBody = "data: chunk1\n\ndata: chunk2\n\ndata: chunk3\n\n";
    const client = new KernelGatewayClient({
      MintGrant: async () => ({ encodedGrant: "opaque-grant", grantId: "grant", expiresAtUnix: 1 }),
      Execute: async () => ({
        receipt: {
          grantId: "grant", taskId: "task", effectId: "effect", connectorId: "opencode-gateway",
          method: "POST", path: "/zen/v1/chat/completions", destination: "https://opencode.ai:443",
          requestSha256: "a".repeat(64), statusCode: 200, responseSha256: "b".repeat(64),
          responseRedactions: 0, outcome: "accepted",
        },
        body: new TextEncoder().encode(sseBody),
      }),
    }, context);

    const yielded: string[] = [];
    const consume = async (): Promise<void> => {
      for await (const chunk of client.stream({
        url: "https://opencode.ai/zen/v1/chat/completions",
        method: "POST",
        headers: {},
        body: "{}",
        credentialBindingId: "secret://opencode/zen",
        authStyle: "bearer",
        signal: controller.signal,
      })) {
        yielded.push(new TextDecoder().decode(chunk));
        // Abort after consuming the first chunk
        controller.abort();
      }
    };

    await expect(consume()).rejects.toThrow("gateway request was aborted");
    expect(yielded).toHaveLength(1);
    expect(yielded[0]).toBe("data: chunk1\n\n");
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

/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import { Observable } from "rxjs";
import {
  KernelConnectorClient,
  ZEN_GATEWAY_ENDPOINT,
  type KernelConnectorEndpoint,
} from "./gateway-kernel-client.js";
import { CODEX_MODELS_URL, discoverAccountModels } from "./provider-account-models.js";
import { CODEX_PATH_PREFIX, type ProviderAccountRecord } from "./provider-accounts.js";
import type {
  ConnectorChunk,
  ConnectorService,
  ExecuteConnectorRequest,
  MintConnectorGrantRequest,
  RequestContext,
} from "../../../packages/terminus-kernel-client/src/generated-ts-proto/terminus/kernel/v1/kernel.js";

const CONTEXT: RequestContext = {
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

const CODEX_ENDPOINT: KernelConnectorEndpoint = {
  connectorId: "chatgpt-codex",
  host: "chatgpt.com",
  port: 443,
  allowedPathPrefixes: [CODEX_PATH_PREFIX],
  label: "ChatGPT Codex",
};

interface Recorded {
  readonly mints: MintConnectorGrantRequest[];
  readonly executions: ExecuteConnectorRequest[];
}

/** A kernel that streams one body and a terminal receipt with headers. */
function fakeKernel(input: {
  readonly body: string;
  readonly statusCode?: number;
  readonly responseHeaders?: readonly { readonly name: string; readonly value: string }[];
}): { readonly connectors: ConnectorService; readonly recorded: Recorded } {
  const recorded: Recorded = { mints: [], executions: [] };
  return {
    recorded,
    connectors: {
      MintGrant: async (request) => {
        recorded.mints.push(request);
        return { encodedGrant: "opaque-grant", grantId: "grant", expiresAtUnix: 1 };
      },
      Execute: async () => { throw new Error("buffered Execute must not be used"); },
      ExecuteStream: (request) =>
        new Observable<ConnectorChunk>((subscriber) => {
          recorded.executions.push(request);
          subscriber.next({ bytes: new TextEncoder().encode(input.body), receipt: undefined });
          subscriber.next({
            bytes: undefined,
            receipt: {
              grantId: "grant",
              taskId: "task",
              effectId: "effect",
              connectorId: "chatgpt-codex",
              method: request.operation?.method ?? "GET",
              path: request.operation?.path ?? "",
              destination: "https://chatgpt.com:443",
              requestSha256: "a".repeat(64),
              statusCode: input.statusCode ?? 200,
              responseSha256: "b".repeat(64),
              responseRedactions: 0,
              outcome: "accepted",
              responseHeaders: [...(input.responseHeaders ?? [])],
            },
          });
          subscriber.complete();
          return () => {};
        }),
    },
  };
}

function codexAccount(): ProviderAccountRecord {
  return {
    id: "account-codex",
    source: "codex-chatgpt",
    displayName: "ChatGPT Codex",
    vendorId: "openai",
    authKind: "chatgpt",
    credentialUri: "secret://provider-account/account-codex",
    fingerprint: "0123456789ab",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    host: "chatgpt.com",
    protocol: "responses",
    connectorId: "chatgpt-codex",
    renderProfile: "chatgpt_codex",
    status: "connected",
    statusDetail: "",
    billing: "subscription",
    metadataJson: JSON.stringify({ account_id: "acct-1", plan_type: "plus" }),
    isDefault: true,
    discoveredAt: new Date("2026-08-28T12:00:00.000Z"),
    lastVerifiedAt: null,
    expiresAt: null,
    revision: 1,
  };
}

async function drain(stream: AsyncIterable<Uint8Array>): Promise<string> {
  let text = "";
  for await (const chunk of stream) text += new TextDecoder().decode(chunk);
  return text;
}

describe("KernelConnectorClient", () => {
  test("mints a grant bound to the account's own host and connector", async () => {
    const { connectors, recorded } = fakeKernel({ body: "{}" });
    const client = new KernelConnectorClient(connectors, CONTEXT, CODEX_ENDPOINT);
    await drain(client.stream({
      url: CODEX_MODELS_URL,
      method: "GET",
      headers: { accept: "application/json", originator: "terminus" },
      credentialBindingId: "secret://provider-account/account-codex",
      authStyle: "bearer",
      signal: null,
    }));

    expect(recorded.mints).toHaveLength(1);
    expect(recorded.mints[0]?.capabilityUri).toBe("secret://provider-account/account-codex");
    expect(recorded.mints[0]?.binding).toMatchObject({
      connectorId: "chatgpt-codex",
      destinationHost: "chatgpt.com",
      destinationPort: 443,
      scheme: "https",
      method: "GET",
      pathClass: "/backend-api/codex/models",
      allowedHosts: ["chatgpt.com"],
    });
    expect(recorded.executions[0]?.operation).toMatchObject({
      host: "chatgpt.com",
      path: "/backend-api/codex/models",
      query: "client_version=0.150.1",
    });
  });

  test("forwards the connector's non-credential headers untouched", async () => {
    const { connectors, recorded } = fakeKernel({ body: "{}" });
    const client = new KernelConnectorClient(connectors, CONTEXT, CODEX_ENDPOINT);
    await drain(client.stream({
      url: `${CODEX_MODELS_URL}`,
      method: "GET",
      headers: {
        accept: "application/json",
        originator: "terminus",
        "chatgpt-account-id": "acct-1",
        "session-id": "thread-1",
      },
      credentialBindingId: "secret://provider-account/account-codex",
      authStyle: "bearer",
      signal: null,
    }));
    const headers = Object.fromEntries(
      (recorded.executions[0]?.operation?.headers ?? []).map((header) => [header.name, header.value]),
    );
    expect(headers).toMatchObject({
      originator: "terminus",
      "chatgpt-account-id": "acct-1",
      "session-id": "thread-1",
    });
    // The bearer is injected inside the kernel; it is never constructed here.
    expect(headers).not.toHaveProperty("authorization");
  });

  test("refuses a URL outside the account's admitted path prefix", async () => {
    const { connectors, recorded } = fakeKernel({ body: "{}" });
    const client = new KernelConnectorClient(connectors, CONTEXT, CODEX_ENDPOINT);
    await expect(drain(client.stream({
      url: "https://chatgpt.com/backend-api/accounts/me",
      method: "GET",
      headers: {},
      credentialBindingId: "secret://provider-account/account-codex",
      authStyle: "bearer",
      signal: null,
    }))).rejects.toThrow("outside the admitted");
    expect(recorded.mints).toHaveLength(0);
  });

  test("refuses another host even when the path would be admitted", async () => {
    const { connectors } = fakeKernel({ body: "{}" });
    const client = new KernelConnectorClient(connectors, CONTEXT, CODEX_ENDPOINT);
    await expect(drain(client.stream({
      url: "https://evil.example/backend-api/codex/responses",
      method: "GET",
      headers: {},
      credentialBindingId: "secret://provider-account/account-codex",
      authStyle: "bearer",
      signal: null,
    }))).rejects.toThrow("outside the admitted");
  });

  test("an endpoint with no anonymous connector rejects an empty binding", async () => {
    const { connectors } = fakeKernel({ body: "{}" });
    const client = new KernelConnectorClient(connectors, CONTEXT, CODEX_ENDPOINT);
    await expect(drain(client.stream({
      url: CODEX_MODELS_URL,
      method: "GET",
      headers: {},
      credentialBindingId: "",
      authStyle: "none",
      signal: null,
    }))).rejects.toThrow("no anonymous connector");
  });

  test("keeps the Zen endpoint on exact paths", async () => {
    const { connectors, recorded } = fakeKernel({ body: "data: [DONE]\n\n" });
    const client = new KernelConnectorClient(connectors, CONTEXT, ZEN_GATEWAY_ENDPOINT);
    await drain(client.stream({
      url: "https://opencode.ai/zen/v1/models",
      method: "GET",
      headers: {},
      credentialBindingId: "",
      authStyle: "none",
      signal: null,
    }));
    expect(recorded.mints[0]?.binding?.connectorId).toBe("opencode-gateway-anonymous");
    await expect(drain(client.stream({
      url: "https://opencode.ai/zen/v1/models/extra",
      method: "GET",
      headers: {},
      credentialBindingId: "",
      authStyle: "none",
      signal: null,
    }))).rejects.toThrow("outside the admitted");
  });

  test("surfaces the connector's admitted response headers", async () => {
    const { connectors } = fakeKernel({
      body: "{}",
      responseHeaders: [
        { name: "X-Codex-Primary-Used-Percent", value: "42" },
        { name: "x-codex-primary-reset-after-seconds", value: "3600" },
      ],
    });
    const client = new KernelConnectorClient(connectors, CONTEXT, CODEX_ENDPOINT);
    await drain(client.stream({
      url: CODEX_MODELS_URL,
      method: "GET",
      headers: {},
      credentialBindingId: "secret://provider-account/account-codex",
      authStyle: "bearer",
      signal: null,
    }));
    expect(client.responseHeaders()).toEqual({
      "x-codex-primary-used-percent": "42",
      "x-codex-primary-reset-after-seconds": "3600",
    });
  });

  test("a non-2xx receipt becomes a transport error naming the status", async () => {
    const { connectors } = fakeKernel({
      body: JSON.stringify({ error: { message: "Store must be set to false" } }),
      statusCode: 400,
    });
    const client = new KernelConnectorClient(connectors, CONTEXT, CODEX_ENDPOINT);
    await expect(drain(client.stream({
      url: CODEX_MODELS_URL,
      method: "GET",
      headers: {},
      credentialBindingId: "secret://provider-account/account-codex",
      authStyle: "bearer",
      signal: null,
    }))).rejects.toThrow("ChatGPT Codex returned HTTP 400: Store must be set to false");
  });
});

describe("discoverAccountModels through a fake kernel", () => {
  test("reads the Codex catalogue over the account's connector", async () => {
    const { connectors, recorded } = fakeKernel({
      body: JSON.stringify({
        models: [
          {
            slug: "gpt-5.6-sol",
            display_name: "GPT-5.6 Sol",
            visibility: "list",
            context_window: 272_000,
            default_reasoning_level: "medium",
            supported_reasoning_levels: ["low", "medium", "high", "ultra"],
            supports_parallel_tool_calls: true,
            supports_reasoning_summaries: true,
          },
          { slug: "gpt-reserve", visibility: "hidden" },
        ],
      }),
    });
    const account = codexAccount();
    const result = await discoverAccountModels({
      account,
      client: new KernelConnectorClient(connectors, CONTEXT, CODEX_ENDPOINT),
      observedAt: "2026-08-28T12:00:00.000Z",
      headers: { originator: "terminus", "chatgpt-account-id": "acct-1" },
    });

    expect(recorded.executions[0]?.operation?.path).toBe("/backend-api/codex/models");
    expect(result.models.map((model) => model.id)).toEqual(["gpt-5.6-sol"]);
    expect(result.rejected[0]?.modelId).toBe("gpt-reserve");
    expect(result.reachable).toBe(true);
    // Nothing about the credential reaches the persisted record.
    expect(JSON.stringify(result)).not.toContain("secret://");
  });

  test("a catalogue failure propagates rather than producing an empty list", async () => {
    const { connectors } = fakeKernel({ body: "{}", statusCode: 401 });
    await expect(discoverAccountModels({
      account: codexAccount(),
      client: new KernelConnectorClient(connectors, CONTEXT, CODEX_ENDPOINT),
      observedAt: "2026-08-28T12:00:00.000Z",
    })).rejects.toThrow("HTTP 401");
  });

  test("an endpoint with no /models route records a terse, URL-free note", async () => {
    // Cloudflare's base URL embeds the user's own account id and answers 405.
    const { connectors } = fakeKernel({ body: "", statusCode: 405 });
    const account: ProviderAccountRecord = {
      ...codexAccount(),
      id: "account-cloudflare",
      source: "opencode:cloudflare-workers-ai",
      displayName: "Cloudflare Workers AI",
      vendorId: "cloudflare-workers-ai",
      baseUrl: "https://api.cloudflare.com/client/v4/accounts/f6facc5c/ai/v1",
      host: "api.cloudflare.com",
      protocol: "chat_completions",
      connectorId: "openai-compatible",
      renderProfile: "openai_compatible",
      billing: "paid",
    };
    const result = await discoverAccountModels({
      account,
      client: new KernelConnectorClient(connectors, CONTEXT, {
        connectorId: "openai-compatible",
        host: "api.cloudflare.com",
        allowedPathPrefixes: ["/client/v4/accounts/f6facc5c/ai/v1/"],
        label: "Cloudflare Workers AI",
      }),
      observedAt: "2026-08-28T12:00:00.000Z",
      catalog: {},
    });
    expect(result.reachable).toBe(false);
    expect(result.reachabilityDetail)
      .toBe("model probe unsupported (HTTP 405); using the models.dev catalogue");
    expect(result.reachabilityDetail).not.toContain("f6facc5c");
    expect(result.reachabilityDetail).not.toContain("https://");
  });

  test("a chat-completions account records an unreachable probe without demoting itself", async () => {
    const failing: ConnectorService = {
      MintGrant: async () => { throw new Error("connector refused"); },
      Execute: async () => { throw new Error("connector refused"); },
      ExecuteStream: () => new Observable<ConnectorChunk>((subscriber) => {
        subscriber.error(new Error("connector refused"));
      }),
    };
    const account: ProviderAccountRecord = {
      ...codexAccount(),
      id: "account-cerebras",
      source: "opencode:cerebras",
      displayName: "Cerebras",
      vendorId: "cerebras",
      baseUrl: "https://api.cerebras.ai/v1",
      host: "api.cerebras.ai",
      protocol: "chat_completions",
      connectorId: "openai-compatible",
      renderProfile: "openai_compatible",
      billing: "unknown",
    };
    const result = await discoverAccountModels({
      account,
      client: new KernelConnectorClient(failing, CONTEXT, {
        connectorId: "openai-compatible",
        host: "api.cerebras.ai",
        allowedPathPrefixes: ["/v1/"],
        label: "Cerebras",
      }),
      observedAt: "2026-08-28T12:00:00.000Z",
      catalog: {
        cerebras: {
          id: "cerebras",
          name: "Cerebras",
          npm: "@ai-sdk/openai-compatible",
          models: { "llama-4": { id: "llama-4", name: "Llama 4", tool_call: true } },
        },
      },
    });
    expect(result.models.map((model) => model.id)).toEqual(["llama-4"]);
    expect(result.reachable).toBe(false);
    expect(result.reachabilityDetail).toBe("model probe did not complete; using the models.dev catalogue");
    // The base URL can embed the user's own account id; it must not leak into
    // a field shown in Settings.
    expect(result.reachabilityDetail).not.toContain("api.cerebras.ai");
  });
});

/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import {
  ZEN_SOURCE,
  chooseDefaultAccount,
  connectLocalProviderAccount,
  discoverAndConnectLocalAccounts,
  mapGatewayConfiguration,
  mapLocalCredential,
  providerAccountCapabilityScope,
  providerAccountProviderId,
  providerAccountWorkspaceAccess,
  providerAccountSecretUri,
  providerAccountWire,
  recoverLegacyProviderAccountCredential,
  legacyProviderAccountSecretUri,
  settleProviderAccountSecretCleanup,
  resolveTurnProvider,
  uuidV7,
  zenAccountCredentialUri,
  type LocalProviderCredential,
  type ProviderAccountRecord,
  type ProviderAccountUpsert,
} from "./provider-accounts.js";

/**
 * A models.dev document with exactly the providers these cases exercise.
 * Values mirror the real catalogue; credentials never appear anywhere here.
 */
const CATALOG = {
  cerebras: {
    id: "cerebras",
    name: "Cerebras",
    npm: "@ai-sdk/openai-compatible",
    models: { "llama-4": { id: "llama-4", name: "Llama 4" } },
  },
  nvidia: {
    id: "nvidia",
    name: "NVIDIA",
    npm: "@ai-sdk/openai-compatible",
    api: "https://integrate.api.nvidia.com/v1/",
    models: {},
  },
  "cloudflare-workers-ai": {
    id: "cloudflare-workers-ai",
    name: "Cloudflare Workers AI",
    npm: "@ai-sdk/openai-compatible",
    // skipcq: JS-0038
    api: "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/v1",
    models: {},
  },
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    npm: "@ai-sdk/anthropic",
    api: "https://api.anthropic.com/v1",
    models: {},
  },
  "amazon-bedrock": {
    id: "amazon-bedrock",
    name: "Amazon Bedrock",
    npm: "@ai-sdk/amazon-bedrock",
    api: "https://bedrock-runtime.us-east-1.amazonaws.com",
    models: {},
  },
} as const;

const NOW_MS = Date.parse("2026-08-28T12:00:00.000Z");
const FINGERPRINT_0 = "0123456789abcdef".repeat(4);
const FINGERPRINT_A = "a".repeat(64);
const FINGERPRINT_B = "b".repeat(64);
const FINGERPRINT_C = "c".repeat(64);
const FINGERPRINT_D = "d".repeat(64);
const FINGERPRINT_F = "f".repeat(64);
const CATALOG_DIGEST = `sha256:${"1".repeat(64)}`;

function credential(overrides: Partial<LocalProviderCredential> = {}): LocalProviderCredential {
  return {
    source: "opencode:cerebras",
    authKind: "api",
    fingerprint: FINGERPRINT_0,
    metadataJson: "{}",
    expiresAtUnix: 0,
    store: "local-auth-store",
    ...overrides,
  };
}

function account(overrides: Partial<ProviderAccountRecord> = {}): ProviderAccountRecord {
  const fingerprint = overrides.fingerprint ?? FINGERPRINT_0;
  const baseUrl = overrides.baseUrl ?? "https://api.cerebras.ai/v1";
  const catalogDigest = overrides.catalogDigest ?? CATALOG_DIGEST;
  const credentialUri = overrides.credentialUri ?? providerAccountSecretUri("account-1");
  const secretState = overrides.secretState ?? (credentialUri === "" ? "none" : "bound");
  return {
    id: "account-1",
    source: "opencode:cerebras",
    displayName: "Cerebras",
    vendorId: "cerebras",
    authKind: "api",
    credentialUri,
    fingerprint,
    baseUrl,
    catalogDigest,
    credentialFingerprint: overrides.credentialFingerprint ?? (secretState === "bound" ? fingerprint : ""),
    approvedBaseUrl: overrides.approvedBaseUrl ?? (secretState === "bound" ? baseUrl : ""),
    approvedCatalogDigest: overrides.approvedCatalogDigest ?? (secretState === "bound" ? catalogDigest : ""),
    secretState,
    secretOperationId: "",
    host: "api.cerebras.ai",
    protocol: "chat_completions",
    connectorId: "openai-compatible",
    renderProfile: "openai_compatible",
    status: "connected",
    statusDetail: "",
    billing: "unknown",
    metadataJson: "{}",
    isDefault: false,
    discoveredAt: new Date(NOW_MS),
    lastVerifiedAt: null,
    expiresAt: null,
    revision: 1,
    ...overrides,
  };
}

function accountUpsert(
  row: ProviderAccountRecord,
  overrides: Partial<ProviderAccountUpsert> = {},
): ProviderAccountUpsert {
  return {
    id: row.id,
    source: row.source,
    displayName: row.displayName,
    vendorId: row.vendorId,
    authKind: row.authKind,
    credentialUri: row.credentialUri,
    fingerprint: row.fingerprint,
    baseUrl: row.baseUrl,
    catalogDigest: row.catalogDigest,
    credentialFingerprint: row.credentialFingerprint,
    approvedBaseUrl: row.approvedBaseUrl,
    approvedCatalogDigest: row.approvedCatalogDigest,
    secretState: row.secretState === "import_pending" || row.secretState === "revoke_pending" || row.secretState === "bound"
      ? row.secretState
      : "none",
    secretOperationId: row.secretOperationId,
    host: row.host,
    protocol: row.protocol,
    connectorId: row.connectorId,
    renderProfile: row.renderProfile,
    status: row.status,
    statusDetail: row.statusDetail,
    billing: row.billing,
    metadataJson: row.metadataJson,
    discoveredAt: row.discoveredAt,
    expiresAt: row.expiresAt,
    ...overrides,
  };
}

describe("mapLocalCredential", () => {
  test("falls back to the SDK default base URL when models.dev publishes none", () => {
    const mapping = mapLocalCredential({ credential: credential(), catalog: CATALOG, nowMs: NOW_MS });
    expect(mapping).toMatchObject({
      source: "opencode:cerebras",
      displayName: "Cerebras",
      vendorId: "cerebras",
      baseUrl: "https://api.cerebras.ai/v1",
      host: "api.cerebras.ai",
      protocol: "chat_completions",
      connectorId: "openai-compatible",
      renderProfile: "openai_compatible",
      status: "connected",
      statusDetail: "",
    });
  });

  test("trims the trailing slash off a published base URL", () => {
    const mapping = mapLocalCredential({
      credential: credential({ source: "opencode:nvidia" }),
      catalog: CATALOG,
      nowMs: NOW_MS,
    });
    expect(mapping.baseUrl).toBe("https://integrate.api.nvidia.com/v1");
  });

  test("substitutes only the allowlisted Cloudflare account id", () => {
    const accountId = "0123456789abcdef0123456789abcdef";
    const mapping = mapLocalCredential({
      credential: credential({
        source: "opencode:cloudflare-workers-ai",
        metadataJson: JSON.stringify({ account_id: accountId }),
      }),
      catalog: CATALOG,
      nowMs: NOW_MS,
    });
    expect(mapping.status).toBe("connected");
    expect(mapping.baseUrl).toBe(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`);
    expect(mapping.host).toBe("api.cloudflare.com");
  });

  test("rejects token-shaped and dot-segment Cloudflare metadata", () => {
    const malformedAccountIds = [
      "..",
      ["sk", "live", "secret"].join("-"),
      `${"0123456789abcdef".repeat(2)}g`,
    ];
    for (const accountId of malformedAccountIds) {
      const mapping = mapLocalCredential({
        credential: credential({
          source: "opencode:cloudflare-workers-ai",
          metadataJson: JSON.stringify({ account_id: accountId }),
        }),
        catalog: CATALOG,
        nowMs: NOW_MS,
      });
      expect(mapping.status).toBe("error");
      expect(mapping.baseUrl).toBe("");
      expect(mapping.metadataJson).toBe("{}");
    }
  });

  test("never makes account metadata routing-active for another provider", () => {
    const mapping = mapLocalCredential({
      credential: credential({ metadataJson: JSON.stringify({ account_id: "0".repeat(32) }) }),
      catalog: CATALOG,
      nowMs: NOW_MS,
    });
    expect(mapping.baseUrl).toBe("https://api.cerebras.ai/v1");
    expect(mapping.metadataJson).toBe("{}");
  });

  test("reports an unresolvable placeholder instead of inventing a destination", () => {
    const mapping = mapLocalCredential({
      credential: credential({ source: "opencode:cloudflare-workers-ai" }),
      catalog: CATALOG,
      nowMs: NOW_MS,
    });
    expect(mapping.status).toBe("error");
    expect(mapping.baseUrl).toBe("");
    expect(mapping.statusDetail).toContain("CLOUDFLARE_ACCOUNT_ID");
  });

  test("an SDK with no Terminus transport is unsupported, with the reason", () => {
    const mapping = mapLocalCredential({
      credential: credential({ source: "opencode:amazon-bedrock" }),
      catalog: CATALOG,
      nowMs: NOW_MS,
    });
    expect(mapping.status).toBe("unsupported");
    expect(mapping.statusDetail).toContain("@ai-sdk/amazon-bedrock");
    expect(mapping.displayName).toBe("Amazon Bedrock");
  });

  test("an API key bills per token, not `unknown`", () => {
    expect(mapLocalCredential({ credential: credential(), catalog: CATALOG, nowMs: NOW_MS }).billing)
      .toBe("paid");
    expect(mapLocalCredential({
      credential: credential({ source: "opencode:nvidia", authKind: "wellknown" }),
      catalog: CATALOG,
      nowMs: NOW_MS,
    }).billing).toBe("paid");
    // An entry Terminus cannot route is still a key the user pays for.
    expect(mapLocalCredential({
      credential: credential({ source: "opencode:amazon-bedrock" }),
      catalog: CATALOG,
      nowMs: NOW_MS,
    }).billing).toBe("paid");
  });

  test("an anthropic key maps to the messages protocol and connector", () => {
    const mapping = mapLocalCredential({
      credential: credential({ source: "opencode:anthropic" }),
      catalog: CATALOG,
      nowMs: NOW_MS,
    });
    expect(mapping).toMatchObject({
      protocol: "messages",
      connectorId: "anthropic-messages",
      renderProfile: "anthropic_messages",
    });
  });

  test("a non-ChatGPT OAuth login is unsupported in this release", () => {
    const mapping = mapLocalCredential({
      credential: credential({ source: "opencode:cerebras", authKind: "oauth" }),
      catalog: CATALOG,
      nowMs: NOW_MS,
    });
    expect(mapping.status).toBe("unsupported");
    expect(mapping.statusDetail).toContain("OAuth");
  });

  test("an unknown vendor blames the unreachable catalogue when it was offline", () => {
    const offline = mapLocalCredential({
      credential: credential({ source: "opencode:zenmux" }),
      catalog: CATALOG,
      catalogOffline: true,
      nowMs: NOW_MS,
    });
    expect(offline.status).toBe("error");
    expect(offline.statusDetail).toContain("could not be reached");

    const online = mapLocalCredential({
      credential: credential({ source: "opencode:zenmux" }),
      catalog: CATALOG,
      nowMs: NOW_MS,
    });
    expect(online.statusDetail).toContain("models.dev has no provider");
  });

  test("a ChatGPT login maps to the Terminus-owned Codex transport", () => {
    const mapping = mapLocalCredential({
      credential: credential({
        source: "codex-chatgpt",
        authKind: "chatgpt",
        expiresAtUnix: Math.floor(NOW_MS / 1_000) + 86_400,
        metadataJson: JSON.stringify({ account_id: "acct-1", plan_type: "plus", email: "user@example.test" }),
      }),
      catalog: CATALOG,
      nowMs: NOW_MS,
    });
    expect(mapping).toMatchObject({
      vendorId: "openai",
      billing: "subscription",
      status: "connected",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      host: "chatgpt.com",
      protocol: "responses",
      connectorId: "chatgpt-codex",
      renderProfile: "chatgpt_codex",
    });
    expect(JSON.parse(mapping.metadataJson)).toEqual({
      account_id: "acct-1",
      plan_type: "plus",
      email: "user@example.test",
    });
  });

  test("an expired ChatGPT token is visible but not routable", () => {
    const mapping = mapLocalCredential({
      credential: credential({
        source: "codex-chatgpt",
        authKind: "chatgpt",
        expiresAtUnix: Math.floor(NOW_MS / 1_000) - 60,
      }),
      catalog: CATALOG,
      nowMs: NOW_MS,
    });
    expect(mapping.status).toBe("expired");
    expect(mapping.statusDetail).toContain("expired");
    expect(mapping.expiresAt?.getTime()).toBe((Math.floor(NOW_MS / 1_000) - 60) * 1_000);
  });
});

describe("gateway row migration", () => {
  test("the anonymous free tier becomes an anonymous zen account with no secret", () => {
    const row = {
      deployment: "zen",
      protocol: "chat_completions",
      credentialConfigured: false,
      freeModel: true,
      secretUri: "secret://opencode/zen",
    };
    expect(mapGatewayConfiguration(row)).toMatchObject({
      source: ZEN_SOURCE,
      displayName: "OpenCode Zen",
      vendorId: "opencode",
      authKind: "anonymous",
      connectorId: "opencode-gateway-anonymous",
      renderProfile: "zen_gateway",
      billing: "free",
      status: "connected",
      host: "opencode.ai",
      baseUrl: "https://opencode.ai/zen/v1",
    });
    expect(zenAccountCredentialUri(row)).toBe("");
  });

  test("a credentialed deployment keeps its existing secret binding", () => {
    const row = {
      deployment: "go",
      protocol: "chat_completions",
      credentialConfigured: true,
      freeModel: false,
      secretUri: "secret://opencode/go",
    };
    expect(mapGatewayConfiguration(row)).toMatchObject({
      displayName: "OpenCode Go",
      authKind: "api",
      connectorId: "opencode-gateway",
      billing: "paid",
      baseUrl: "https://opencode.ai/zen/go/v1",
    });
    expect(zenAccountCredentialUri(row)).toBe("secret://opencode/go");
  });
});

describe("pre-saga provider-account secret recovery", () => {
  const legacyId = "0192f3a1-4b2c-7def-8a1b-2c3d4e5f6a7b";
  const legacyUri = providerAccountSecretUri(legacyId);

  test("derives only the old deterministic account URI", () => {
    expect(legacyProviderAccountSecretUri(legacyId)).toBe(legacyUri);
    expect(legacyProviderAccountSecretUri("account-1")).toBeNull();
  });

  test("probes and deletes present legacy material", async () => {
    const inspected: string[] = [];
    const revoked: string[] = [];
    await expect(recoverLegacyProviderAccountCredential({
      accountId: legacyId,
      inspect: async (uri) => {
        inspected.push(uri);
        return "present";
      },
      revoke: async (uri) => {
        revoked.push(uri);
        return true;
      },
    })).resolves.toBe(true);
    expect(inspected).toEqual([legacyUri]);
    expect(revoked).toEqual([legacyUri]);
  });

  test("treats an absent legacy item as settled without deleting", async () => {
    const revoked: string[] = [];
    await expect(recoverLegacyProviderAccountCredential({
      accountId: legacyId,
      inspect: async () => "missing",
      revoke: async (uri) => {
        revoked.push(uri);
        return true;
      },
    })).resolves.toBe(true);
    expect(revoked).toEqual([]);
  });

  test("keeps cleanup pending when the backend is unavailable", async () => {
    const revoked: string[] = [];
    await expect(recoverLegacyProviderAccountCredential({
      accountId: legacyId,
      inspect: async () => "unavailable",
      revoke: async (uri) => {
        revoked.push(uri);
        return true;
      },
    })).resolves.toBe(false);
    expect(revoked).toEqual([]);
  });

  test("import_pending before Store is recoverable through idempotent cleanup", async () => {
    const events: string[] = [];
    const pending = account({
      id: legacyId,
      credentialUri: providerAccountSecretUri("0192f3a1-4b2c-7def-8a1b-2c3d4e5f6a7c"),
      secretState: "import_pending",
      secretOperationId: "import-operation",
    });
    const settled = await settleProviderAccountSecretCleanup({
      account: pending,
      markRevokePending: async (row) => {
        events.push(`mark:${row.secretState}`);
        return { ...row, secretState: "revoke_pending" };
      },
      revokeCredential: async (uri, row) => {
        events.push(`delete:${row.secretState}:${uri}`);
        return true;
      },
      finalize: async (row) => {
        events.push(`finalize:${row.secretState}`);
        return { ...row, credentialUri: "", secretState: "none" };
      },
    });

    expect(events).toEqual([
      "mark:import_pending",
      `delete:revoke_pending:${pending.credentialUri}`,
      "finalize:revoke_pending",
    ]);
    expect(settled).toMatchObject({ credentialUri: "", secretState: "none" });
  });

  test("revoke_pending after Delete settles at the DB finalize boundary", async () => {
    const events: string[] = [];
    const pending = account({
      credentialUri: providerAccountSecretUri("0192f3a1-4b2c-7def-8a1b-2c3d4e5f6a7c"),
      secretState: "revoke_pending",
      secretOperationId: "revoke-operation",
    });
    const settled = await settleProviderAccountSecretCleanup({
      account: pending,
      markRevokePending: async () => {
        events.push("unexpected-mark");
        return null;
      },
      revokeCredential: async (_uri, row) => {
        events.push(`delete:${row.secretState}`);
        // The prior process may have deleted the item; absence is success.
        return true;
      },
      finalize: async (row) => {
        events.push(`finalize:${row.secretState}`);
        return { ...row, credentialUri: "", secretState: "none" };
      },
    });

    expect(events).toEqual(["delete:revoke_pending", "finalize:revoke_pending"]);
    expect(settled).toMatchObject({ credentialUri: "", secretState: "none" });
  });
});

// ── Auto-connect ────────────────────────────────────────────────────────────

interface FakeStore {
  readonly rows: Map<string, ProviderAccountRecord>;
  readonly imports: { source: string; capabilityUri: string; fingerprint: string }[];
  readonly revocations?: string[];
}

function fakeDependencies(input: {
  readonly credentials: readonly LocalProviderCredential[];
  readonly store?: FakeStore;
  readonly gateway?: Parameters<typeof mapGatewayConfiguration>[0] | null;
  readonly opencodeInstalled?: boolean;
  readonly opencodeStoreStatus?: "available" | "missing" | "rejected" | "unavailable";
  /** Omitted entirely when absent, so the default (no probe) is exercised. */
  readonly credentialStatus?: (credentialUri: string) => Promise<"present" | "missing" | "unavailable">;
  readonly revokeCredential?: (credentialUri: string) => Promise<boolean>;
}): { readonly dependencies: Parameters<typeof discoverAndConnectLocalAccounts>[0]; readonly store: FakeStore } {
  const store: FakeStore = input.store ?? { rows: new Map(), imports: [] };
  let counter = 0;
  return {
    store,
    dependencies: {
      ...(input.credentialStatus === undefined
        ? {}
        : { credentialStatus: input.credentialStatus }),
      discoverLocal: async () => ({
        credentials: input.credentials,
        warnings: ["local-auth-store: one entry did not decode"],
        codexInstalled: true,
        opencodeInstalled: input.opencodeInstalled ?? false,
        opencodeStoreStatus: input.opencodeStoreStatus ?? "available",
      }),
      importLocal: async ({ source, capabilityUri, fingerprint }) => {
        store.imports.push({ source, capabilityUri, fingerprint });
        return { capabilityUri, stored: true };
      },
      listAccounts: async () => [...store.rows.values()],
      revokeCredential: async (credentialUri) => {
        store.revocations?.push(credentialUri);
        return input.revokeCredential?.(credentialUri) ?? true;
      },
      upsertAccount: async (upsert: ProviderAccountUpsert) => {
        const current = store.rows.get(upsert.source) ?? null;
        const row: ProviderAccountRecord = {
          ...account(),
          ...upsert,
          id: current?.id ?? upsert.id,
          isDefault: current?.isDefault ?? false,
          lastVerifiedAt: current?.lastVerifiedAt ?? null,
          revision: current === null ? 1 : current.revision + 1,
        };
        store.rows.set(upsert.source, row);
        return row;
      },
      reconcileAccount: async (upsert, expected) => {
        const current = store.rows.get(upsert.source);
        if (
          current === undefined
          || current.id !== expected.id
          || current.revision !== expected.revision
          || current.fingerprint !== expected.fingerprint
          || current.credentialUri !== expected.credentialUri
          || current.secretState !== expected.secretState
          || current.secretOperationId !== expected.secretOperationId
        ) return null;
        const row: ProviderAccountRecord = {
          ...current,
          ...upsert,
          revision: current.revision + 1,
        };
        store.rows.set(upsert.source, row);
        return row;
      },
      readGatewayConfiguration: async () => input.gateway ?? null,
      fetchCatalog: async () => ({ catalog: CATALOG, offline: false, digest: CATALOG_DIGEST }),
      newAccountId: () => `account-${(counter += 1)}`,
      newOperationId: () => `operation-${(counter += 1)}`,
      now: () => new Date(NOW_MS),
      warn: () => {},
    },
  };
}

function connectDependencies(input: {
  readonly discovery: Parameters<typeof discoverAndConnectLocalAccounts>[0];
  readonly store: FakeStore;
  readonly account: ProviderAccountRecord;
  readonly userConsent: boolean;
  readonly expectedFingerprint?: string;
}): Parameters<typeof connectLocalProviderAccount>[0] {
  const expectedFingerprint = input.expectedFingerprint ?? input.account.fingerprint;
  return {
    account: input.account,
    expectedRevision: input.account.revision,
    expectedFingerprint,
    expectedDestination: input.account.baseUrl,
    expectedCatalogDigest: input.account.catalogDigest,
    capabilityUri: providerAccountSecretUri(uuidV7()),
    userConsent: input.userConsent,
    discoverLocal: input.discovery.discoverLocal,
    fetchCatalog: input.discovery.fetchCatalog,
    importLocal: async ({ source, capabilityUri, expectedFingerprint: approvedFingerprint }) => {
      input.store.imports.push({ source, capabilityUri, fingerprint: approvedFingerprint });
      return { capabilityUri, stored: true, fingerprint: approvedFingerprint };
    },
    claimImport: async (current, claim) => input.discovery.reconcileAccount(accountUpsert(current, {
      credentialUri: claim.capabilityUri,
      credentialFingerprint: claim.credentialFingerprint,
      approvedBaseUrl: claim.approvedBaseUrl,
      approvedCatalogDigest: claim.approvedCatalogDigest,
      secretState: "import_pending",
      secretOperationId: claim.operationId,
      status: "error",
    }), {
      id: current.id,
      revision: current.revision,
      fingerprint: current.fingerprint,
      credentialUri: current.credentialUri,
      secretState: current.secretState === "bound" ? "bound" : "none",
      secretOperationId: current.secretOperationId,
    }),
    finalizeImport: async (claimed) => input.discovery.reconcileAccount(accountUpsert(claimed, {
      secretState: "bound",
      secretOperationId: "",
      status: "connected",
      statusDetail: "",
    }), {
      id: claimed.id,
      revision: claimed.revision,
      fingerprint: claimed.fingerprint,
      credentialUri: claimed.credentialUri,
      secretState: "import_pending",
      secretOperationId: claimed.secretOperationId,
    }),
    markImportForCleanup: async (claimed) => input.discovery.reconcileAccount(accountUpsert(claimed, {
      secretState: "revoke_pending",
      status: "error",
    }), {
      id: claimed.id,
      revision: claimed.revision,
      fingerprint: claimed.fingerprint,
      credentialUri: claimed.credentialUri,
      secretState: "import_pending",
      secretOperationId: claimed.secretOperationId,
    }),
    now: () => new Date(NOW_MS),
  };
}

describe("discoverAndConnectLocalAccounts", () => {
  test("an installed OpenCode creates a ready anonymous free-model account", async () => {
    const { dependencies, store } = fakeDependencies({
      credentials: [],
      opencodeInstalled: true,
    });

    const result = await discoverAndConnectLocalAccounts(dependencies);

    expect(result.opencodeInstalled).toBe(true);
    expect(result.accounts).toHaveLength(1);
    expect(store.rows.get(ZEN_SOURCE)).toMatchObject({
      source: ZEN_SOURCE,
      authKind: "anonymous",
      status: "connected",
      billing: "free",
      credentialUri: "",
      isDefault: false,
    });
    expect(store.rows.get(ZEN_SOURCE)?.metadataJson).toBe(
      JSON.stringify({ connection_origin: "installed_opencode" }),
    );
  });

  test("discovery never imports local credentials or chooses an API account", async () => {
    const { dependencies, store } = fakeDependencies({
      credentials: [
        credential({ source: "opencode:cerebras", fingerprint: FINGERPRINT_A }),
        credential({ source: "opencode:amazon-bedrock", fingerprint: FINGERPRINT_B }),
        credential({
          source: "codex-chatgpt",
          authKind: "chatgpt",
          fingerprint: FINGERPRINT_C,
          expiresAtUnix: Math.floor(NOW_MS / 1_000) + 86_400,
        }),
      ],
    });
    const result = await discoverAndConnectLocalAccounts(dependencies);

    expect(result.accounts).toHaveLength(3);
    expect(result.warnings).toEqual(["local-auth-store: one entry did not decode"]);
    expect(result.imported).toHaveLength(0);
    expect(store.imports).toHaveLength(0);
    expect(result.accounts.find((row) => row.source === "opencode:cerebras")?.status).toBe("disconnected");
    expect(result.accounts.find((row) => row.source === "codex-chatgpt")?.status).toBe("disconnected");
    expect(store.rows.get("opencode:amazon-bedrock")?.credentialUri).toBe("");
    expect(store.rows.get("opencode:amazon-bedrock")?.status).toBe("unsupported");
  });

  test("a second run with unchanged fingerprints imports nothing again", async () => {
    const store: FakeStore = { rows: new Map(), imports: [] };
    const credentials = [credential({ source: "opencode:cerebras", fingerprint: FINGERPRINT_A })];
    await discoverAndConnectLocalAccounts(fakeDependencies({ credentials, store }).dependencies);
    const before = store.rows.get("opencode:cerebras")!;
    store.imports.length = 0;

    const second = await discoverAndConnectLocalAccounts(fakeDependencies({ credentials, store }).dependencies);
    expect(store.imports).toHaveLength(0);
    expect(second.imported).toHaveLength(0);
    expect(store.rows.get("opencode:cerebras")?.id).toBe(before.id);
  });

  test("a rotated key stays disconnected until an explicit connect", async () => {
    const store: FakeStore = { rows: new Map(), imports: [] };
    await discoverAndConnectLocalAccounts(fakeDependencies({
      credentials: [credential({ source: "opencode:cerebras", fingerprint: FINGERPRINT_A })],
      store,
    }).dependencies);
    const before = store.rows.get("opencode:cerebras")!;
    store.imports.length = 0;

    const rotated = await discoverAndConnectLocalAccounts(fakeDependencies({
      credentials: [credential({ source: "opencode:cerebras", fingerprint: FINGERPRINT_D })],
      store,
    }).dependencies);

    expect(store.imports).toHaveLength(0);
    expect(rotated.imported).toEqual([]);
    const after = store.rows.get("opencode:cerebras")!;
    expect(after.id).toBe(before.id);
    expect(after.fingerprint).toBe(FINGERPRINT_D);
    expect(after.revision).toBeGreaterThan(before.revision);
  });

  test("authoritative logout revokes the copied key and disables the account", async () => {
    const oldUri = providerAccountSecretUri("0192f3a1-4b2c-7def-8a1b-2c3d4e5f6a7b");
    const revocations: string[] = [];
    const store: FakeStore = {
      rows: new Map([["opencode:cerebras", account({ credentialUri: oldUri, status: "connected" })]]),
      imports: [],
      revocations,
    };
    const result = await discoverAndConnectLocalAccounts(fakeDependencies({
      credentials: [],
      store,
      opencodeStoreStatus: "available",
    }).dependencies);

    expect(revocations).toEqual([oldUri]);
    expect(result.accounts[0]).toMatchObject({ status: "disconnected", credentialUri: "", fingerprint: "" });
  });

  test("a rejected store disables routing without treating it as logout", async () => {
    const oldUri = providerAccountSecretUri("0192f3a1-4b2c-7def-8a1b-2c3d4e5f6a7b");
    const revocations: string[] = [];
    const store: FakeStore = {
      rows: new Map([["opencode:cerebras", account({ credentialUri: oldUri, status: "connected" })]]),
      imports: [],
      revocations,
    };
    const result = await discoverAndConnectLocalAccounts(fakeDependencies({
      credentials: [],
      store,
      opencodeStoreStatus: "rejected",
    }).dependencies);

    expect(revocations).toEqual([]);
    expect(result.accounts[0]).toMatchObject({ status: "error", credentialUri: oldUri });
  });

  test("an unavailable or legacy-unspecified store never drives logout", async () => {
    const oldUri = providerAccountSecretUri("0192f3a1-4b2c-7def-8a1b-2c3d4e5f6a7b");
    const store: FakeStore = {
      rows: new Map([["opencode:cerebras", account({ credentialUri: oldUri })]]),
      imports: [],
      revocations: [],
    };
    const result = await discoverAndConnectLocalAccounts(fakeDependencies({
      credentials: [],
      store,
      opencodeStoreStatus: "unavailable",
    }).dependencies);

    expect(store.revocations).toEqual([]);
    expect(result.accounts[0]).toMatchObject({
      status: "error",
      credentialUri: oldUri,
      secretState: "bound",
    });
  });

  test("rotation revokes old copied material before offering reconnect", async () => {
    const oldUri = providerAccountSecretUri("0192f3a1-4b2c-7def-8a1b-2c3d4e5f6a7b");
    const revocations: string[] = [];
    const store: FakeStore = {
      rows: new Map([[
        "opencode:cerebras",
        account({ credentialUri: oldUri, fingerprint: FINGERPRINT_A, status: "connected" }),
      ]]),
      imports: [],
      revocations,
    };
    const result = await discoverAndConnectLocalAccounts(fakeDependencies({
      credentials: [credential({ fingerprint: FINGERPRINT_B })],
      store,
    }).dependencies);

    expect(revocations).toEqual([oldUri]);
    expect(result.accounts[0]).toMatchObject({
      status: "disconnected",
      credentialUri: "",
      fingerprint: FINGERPRINT_B,
    });
  });

  test("a failed rotation delete cannot reactivate old bytes on the next sweep", async () => {
    const oldUri = providerAccountSecretUri("0192f3a1-4b2c-7def-8a1b-2c3d4e5f6a7b");
    const revocations: string[] = [];
    const store: FakeStore = {
      rows: new Map([["opencode:cerebras", account({
        credentialUri: oldUri,
        fingerprint: FINGERPRINT_A,
        credentialFingerprint: FINGERPRINT_A,
      })]]),
      imports: [],
      revocations,
    };
    await discoverAndConnectLocalAccounts(fakeDependencies({
      credentials: [credential({ fingerprint: FINGERPRINT_B })],
      store,
      revokeCredential: async () => false,
    }).dependencies);

    expect(store.rows.get("opencode:cerebras")).toMatchObject({
      credentialUri: oldUri,
      fingerprint: FINGERPRINT_A,
      credentialFingerprint: FINGERPRINT_A,
      secretState: "revoke_pending",
      status: "error",
    });

    await discoverAndConnectLocalAccounts(fakeDependencies({
      credentials: [credential({ fingerprint: FINGERPRINT_B })],
      store,
      revokeCredential: async () => true,
    }).dependencies);
    expect(revocations).toEqual([oldUri, oldUri]);
    expect(store.rows.get("opencode:cerebras")).toMatchObject({
      credentialUri: "",
      fingerprint: FINGERPRINT_B,
      credentialFingerprint: "",
      secretState: "none",
      status: "disconnected",
    });
  });

  test("catalog drift revokes the old binding and requires fresh destination consent", async () => {
    const oldUri = providerAccountSecretUri("0192f3a1-4b2c-7def-8a1b-2c3d4e5f6a7b");
    const store: FakeStore = {
      rows: new Map([["opencode:cerebras", account({ credentialUri: oldUri })]]),
      imports: [],
      revocations: [],
    };
    const { dependencies } = fakeDependencies({ credentials: [credential()], store });
    const nextDigest = `sha256:${"2".repeat(64)}`;
    await discoverAndConnectLocalAccounts({
      ...dependencies,
      fetchCatalog: async () => ({ catalog: CATALOG, offline: false, digest: nextDigest }),
    });

    expect(store.revocations).toEqual([oldUri]);
    expect(store.rows.get("opencode:cerebras")).toMatchObject({
      credentialUri: "",
      catalogDigest: nextDigest,
      approvedCatalogDigest: "",
      secretState: "none",
      status: "disconnected",
    });
  });

  test("a stale discovery CAS never deletes or overwrites a concurrently connected credential", async () => {
    const oldUri = providerAccountSecretUri("0192f3a1-4b2c-7def-8a1b-2c3d4e5f6a7b");
    const freshUri = providerAccountSecretUri("0192f3a1-4b2c-7def-8a1b-2c3d4e5f6a7c");
    const store: FakeStore = {
      rows: new Map([["opencode:cerebras", account({ credentialUri: oldUri, fingerprint: FINGERPRINT_A })]]),
      imports: [],
      revocations: [],
    };
    const { dependencies } = fakeDependencies({
      credentials: [credential({ fingerprint: FINGERPRINT_B })],
      store,
    });
    let raced = false;
    await discoverAndConnectLocalAccounts({
      ...dependencies,
      reconcileAccount: async (upsert, expected) => {
        if (!raced && upsert.secretState === "revoke_pending") {
          raced = true;
          const current = store.rows.get(upsert.source)!;
          store.rows.set(upsert.source, account({
            ...current,
            credentialUri: freshUri,
            fingerprint: FINGERPRINT_B,
            credentialFingerprint: FINGERPRINT_B,
            revision: current.revision + 1,
          }));
          return null;
        }
        return dependencies.reconcileAccount(upsert, expected);
      },
    });

    expect(store.revocations).toEqual([]);
    expect(store.rows.get("opencode:cerebras")).toMatchObject({
      credentialUri: freshUri,
      fingerprint: FINGERPRINT_B,
      credentialFingerprint: FINGERPRINT_B,
      secretState: "bound",
    });
  });

  test("the singleton gateway row is the default until an API account is connected", async () => {
    const { dependencies, store } = fakeDependencies({
      credentials: [credential({ source: "opencode:cerebras", fingerprint: FINGERPRINT_A })],
      gateway: {
        deployment: "zen",
        protocol: "chat_completions",
        credentialConfigured: false,
        freeModel: true,
        secretUri: "secret://opencode/zen",
      },
    });
    const result = await discoverAndConnectLocalAccounts(dependencies);

    const zen = store.rows.get(ZEN_SOURCE);
    expect(zen).toBeDefined();
    expect(zen?.renderProfile).toBe("zen_gateway");
    expect(zen?.credentialUri).toBe("");
    const defaults = result.accounts.filter((row) => row.isDefault);
    expect(defaults).toHaveLength(0);
  });

  test("the shared gateway is the default only when it is the only usable account", async () => {
    const { dependencies, store } = fakeDependencies({
      credentials: [],
      gateway: {
        deployment: "zen",
        protocol: "chat_completions",
        credentialConfigured: false,
        freeModel: true,
        secretUri: "secret://opencode/zen",
      },
    });
    await discoverAndConnectLocalAccounts(dependencies);
    expect(store.rows.get(ZEN_SOURCE)?.isDefault).toBe(false);
  });

  test("a kernel that cannot answer leaves existing accounts alone", async () => {
    const store: FakeStore = { rows: new Map(), imports: [] };
    const { dependencies } = fakeDependencies({ credentials: [], store });
    const failing = {
      ...dependencies,
      discoverLocal: async (): Promise<never> => { throw new Error("kernel unavailable"); },
    };
    const result = await discoverAndConnectLocalAccounts(failing);
    expect(result.accounts).toHaveLength(0);
    expect(result.warnings[0]).toContain("kernel unavailable");
  });

  test("a credential the kernel can no longer resolve becomes disconnected", async () => {
    const store: FakeStore = { rows: new Map(), imports: [] };
    const credentials = [credential({ source: "opencode:cerebras", fingerprint: FINGERPRINT_A })];
    await discoverAndConnectLocalAccounts(
      fakeDependencies({ credentials, store, credentialStatus: async () => "present" }).dependencies,
    );
    const before = store.rows.get("opencode:cerebras")!;
    expect(before.credentialUri).toBe("");
    store.imports.length = 0;

    // The kernel's secret backend changed under us: the row still names a URI
    // and the fingerprint has not rotated, but the bytes are gone.
    const probed: string[] = [];
    const recovered = await discoverAndConnectLocalAccounts(
      fakeDependencies({
        credentials,
        store,
        credentialStatus: async (uri) => {
          probed.push(uri);
          return "missing";
        },
      }).dependencies,
    );

    expect(probed).toEqual([]);
    expect(store.imports).toHaveLength(0);
    expect(recovered.imported).toEqual([]);
    expect(store.rows.get("opencode:cerebras")?.credentialUri).toBe("");
    expect(store.rows.get("opencode:cerebras")).toMatchObject({
      status: "disconnected",
      secretState: "none",
    });
  });

  test("a disconnected credential remains disconnected during discovery", async () => {
    const store: FakeStore = { rows: new Map(), imports: [] };
    const credentials = [credential({ source: "opencode:cerebras", fingerprint: FINGERPRINT_A })];
    await discoverAndConnectLocalAccounts(
      fakeDependencies({ credentials, store, credentialStatus: async () => "present" }).dependencies,
    );
    store.imports.length = 0;

    const second = await discoverAndConnectLocalAccounts(
      fakeDependencies({ credentials, store, credentialStatus: async () => "present" }).dependencies,
    );
    expect(store.imports).toHaveLength(0);
    expect(second.imported).toHaveLength(0);
  });

  test("a failing resolution probe disables routing without importing or deleting", async () => {
    const credentialUri = providerAccountSecretUri("0192f3a1-4b2c-7def-8a1b-2c3d4e5f6a7b");
    const revocations: string[] = [];
    const store: FakeStore = {
      rows: new Map([["opencode:cerebras", account({
        credentialUri,
        fingerprint: FINGERPRINT_A,
        status: "connected",
      })]]),
      imports: [],
      revocations,
    };
    const credentials = [credential({ source: "opencode:cerebras", fingerprint: FINGERPRINT_A })];

    const warnings: string[] = [];
    const { dependencies } = fakeDependencies({
      credentials,
      store,
      credentialStatus: async (): Promise<never> => { throw new Error("kernel restarting"); },
    });
    const result = await discoverAndConnectLocalAccounts({
      ...dependencies,
      warn: (message) => warnings.push(message),
    });

    expect(store.imports).toHaveLength(0);
    expect(result.imported).toHaveLength(0);
    expect(revocations).toHaveLength(0);
    expect(warnings.join("\n")).toContain("kernel restarting");
    expect(store.rows.get("opencode:cerebras")).toMatchObject({
      credentialUri,
      status: "error",
    });
  });

  test("explicit consent is required before an OpenCode API key import", async () => {
    const store: FakeStore = { rows: new Map(), imports: [] };
    const { dependencies } = fakeDependencies({
      credentials: [credential({ fingerprint: FINGERPRINT_A })],
      store,
    });
    const detected = await discoverAndConnectLocalAccounts(dependencies);
    const detectedAccount = detected.accounts.find((row) => row.source === "opencode:cerebras");
    expect(detectedAccount?.status).toBe("disconnected");
    expect(detectedAccount).toBeDefined();
    await expect(connectLocalProviderAccount(connectDependencies({
      discovery: dependencies,
      store,
      account: detectedAccount!,
      userConsent: false,
    }))).rejects.toThrow("explicit user consent");
    expect(store.imports).toHaveLength(0);

    const connected = await connectLocalProviderAccount(connectDependencies({
      discovery: dependencies,
      store,
      account: detectedAccount!,
      userConsent: true,
    }));
    expect(store.imports).toHaveLength(1);
    expect(store.imports[0]?.source).toBe("opencode:cerebras");
    expect(connected.credentialUri).toMatch(/^secret:\/\/provider-account\//);
    expect(connected.status).toBe("connected");
  });

  test("an expired credential cannot be imported", async () => {
    const store: FakeStore = { rows: new Map(), imports: [] };
    const { dependencies } = fakeDependencies({
      credentials: [credential({ expiresAtUnix: Math.floor(NOW_MS / 1_000) - 1 })],
      store,
    });
    const detected = await discoverAndConnectLocalAccounts(dependencies);
    const expired = detected.accounts.find((row) => row.source === "opencode:cerebras")!;
    expect(expired.status).toBe("expired");
    await expect(connectLocalProviderAccount(connectDependencies({
      discovery: dependencies,
      store,
      account: expired,
      userConsent: true,
    }))).rejects.toThrow("expired");
    expect(store.imports).toEqual([]);
  });

  test("a ChatGPT credential imports only after explicit consent", async () => {
    const store: FakeStore = { rows: new Map(), imports: [] };
    const { dependencies } = fakeDependencies({
      credentials: [credential({ source: "codex-chatgpt", authKind: "chatgpt" })],
      store,
    });
    const detected = await discoverAndConnectLocalAccounts(dependencies);
    const codex = detected.accounts.find((row) => row.source === "codex-chatgpt");
    expect(codex?.status).toBe("disconnected");
    const connected = await connectLocalProviderAccount(connectDependencies({
      discovery: dependencies,
      store,
      account: codex!,
      userConsent: true,
    }));
    expect(store.imports).toEqual([expect.objectContaining({ source: "codex-chatgpt" })]);
    expect(connected).toMatchObject({ status: "connected", secretState: "bound" });
  });

  test("an existing secret binding must be reconciled before connect", async () => {
    const store: FakeStore = { rows: new Map(), imports: [] };
    const existing = account({
      credentialUri: providerAccountSecretUri("0192f3a1-4b2c-7def-8a1b-2c3d4e5f6a7b"),
      fingerprint: FINGERPRINT_A,
      status: "connected",
    });
    store.rows.set(existing.source, existing);
    const { dependencies } = fakeDependencies({
      credentials: [credential({ fingerprint: FINGERPRINT_A })],
      store,
    });

    await expect(connectLocalProviderAccount(connectDependencies({
      discovery: dependencies,
      store,
      account: existing,
      userConsent: true,
    }))).rejects.toThrow("already has a credential binding");
    expect(store.imports).toHaveLength(0);
  });

  test("a rotated fingerprint cannot inherit an earlier approval", async () => {
    const store: FakeStore = { rows: new Map(), imports: [] };
    const { dependencies } = fakeDependencies({
      credentials: [credential({ fingerprint: FINGERPRINT_B })],
      store,
    });
    const detected = await discoverAndConnectLocalAccounts(dependencies);
    const detectedAccount = detected.accounts.find((row) => row.source === "opencode:cerebras")!;

    await expect(connectLocalProviderAccount(connectDependencies({
      discovery: dependencies,
      store,
      account: detectedAccount,
      userConsent: true,
      expectedFingerprint: FINGERPRINT_A,
    }))).rejects.toThrow("credential changed");
    expect(store.imports).toHaveLength(0);
  });

  test("a kernel response for different bytes is never committed", async () => {
    const store: FakeStore = { rows: new Map(), imports: [] };
    const { dependencies } = fakeDependencies({ credentials: [credential()], store });
    const detected = await discoverAndConnectLocalAccounts(dependencies);
    const detectedAccount = detected.accounts.find((row) => row.source === "opencode:cerebras")!;
    const connect = connectDependencies({
      discovery: dependencies,
      store,
      account: detectedAccount,
      userConsent: true,
    });

    await expect(connectLocalProviderAccount({
      ...connect,
      importLocal: async ({ capabilityUri }) => ({
        capabilityUri,
        stored: true,
        fingerprint: FINGERPRINT_F,
      }),
    })).rejects.toThrow("kernel did not confirm");
    expect(store.rows.get("opencode:cerebras")).toMatchObject({
      status: "error",
      secretState: "revoke_pending",
    });
  });

  test("a concurrent row change makes the final account commit fail closed", async () => {
    const store: FakeStore = { rows: new Map(), imports: [] };
    const { dependencies } = fakeDependencies({ credentials: [credential()], store });
    const detected = await discoverAndConnectLocalAccounts(dependencies);
    const detectedAccount = detected.accounts.find((row) => row.source === "opencode:cerebras")!;
    const connect = connectDependencies({
      discovery: dependencies,
      store,
      account: detectedAccount,
      userConsent: true,
    });

    await expect(connectLocalProviderAccount({
      ...connect,
      finalizeImport: async () => null,
    })).rejects.toThrow("changed while connecting");
    expect(store.rows.get("opencode:cerebras")).toMatchObject({
      status: "error",
      secretState: "revoke_pending",
    });
    expect(store.imports).toHaveLength(1);
  });
});

describe("chooseDefaultAccount", () => {
  test("prefers a connected non-gateway account, deterministically by source", () => {
    const chosen = chooseDefaultAccount([
      account({ id: "z", source: ZEN_SOURCE }),
      account({ id: "b", source: "opencode:nvidia" }),
      account({ id: "a", source: "opencode:cerebras" }),
      account({ id: "x", source: "opencode:zenmux", status: "unsupported" }),
    ]);
    expect(chosen?.id).toBe("a");
  });

  test("returns null when nothing is connected", () => {
    expect(chooseDefaultAccount([account({ status: "expired" })])).toBeNull();
  });
});

describe("resolveTurnProvider", () => {
  const turnAccount = account({ id: "turn", source: "opencode:cerebras" });
  const sessionAccount = account({ id: "session", source: "opencode:nvidia" });
  const defaultAccount = account({ id: "installation", source: "opencode:baseten", isDefault: true });
  const accounts = [turnAccount, sessionAccount, defaultAccount];

  test("the turn's own account wins", () => {
    const resolved = resolveTurnProvider({
      requestedAccountId: "turn",
      sessionDefaultAccountId: "session",
      accounts,
      hasModel: true,
    });
    expect(resolved).toMatchObject({ kind: "account", explicit: true });
    expect(resolved.kind === "account" && resolved.account.id).toBe("turn");
  });

  test("the session default is used when the turn names none", () => {
    const resolved = resolveTurnProvider({
      sessionDefaultAccountId: "session",
      accounts,
      hasModel: true,
    });
    expect(resolved.kind === "account" && resolved.account.id).toBe("session");
  });

  test("the installation default applies only to a turn that also names a model", () => {
    expect(resolveTurnProvider({ accounts, hasModel: true })).toMatchObject({
      kind: "account",
      explicit: false,
    });
    expect(resolveTurnProvider({ accounts, hasModel: false })).toEqual({ kind: "legacy" });
  });

  test("an unknown named account is an error, never a fallback", () => {
    expect(resolveTurnProvider({ requestedAccountId: "gone", accounts, hasModel: true })).toEqual({
      kind: "error",
      code: "PROVIDER_ACCOUNT_NOT_FOUND",
      accountId: "gone",
    });
  });

  test("a named account that is not connected is an error carrying its detail", () => {
    const expired = account({
      id: "expired",
      source: "codex-chatgpt",
      status: "expired",
      statusDetail: "The ChatGPT login expired.",
    });
    expect(resolveTurnProvider({
      requestedAccountId: "expired",
      accounts: [expired],
      hasModel: true,
    })).toEqual({
      kind: "error",
      code: "PROVIDER_ACCOUNT_UNAVAILABLE",
      accountId: "expired",
      status: "expired",
      statusDetail: "The ChatGPT login expired.",
    });
  });

  test("an unusable installation default falls back to the legacy chain", () => {
    expect(resolveTurnProvider({
      accounts: [account({ isDefault: true, status: "expired" })],
      hasModel: true,
    })).toEqual({ kind: "legacy" });
  });

  test("no accounts at all is the legacy chain", () => {
    expect(resolveTurnProvider({ accounts: [], hasModel: true })).toEqual({ kind: "legacy" });
  });

});

describe("account projections", () => {
  test("the wire form exposes identity and never provider metadata", () => {
    const accountId = "0123456789abcdef0123456789abcdef";
    const wire = providerAccountWire(
      account({
        source: "opencode:cloudflare-workers-ai",
        metadataJson: JSON.stringify({
          account_id: accountId,
          plan_type: "plus",
          email: "user@example.test",
          provider_metadata: { accountId: "cf-account" },
        }),
        lastVerifiedAt: new Date(NOW_MS),
        expiresAt: new Date(NOW_MS + 1_000),
      }),
      12,
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    expect(wire.metadata).toEqual({
      account_id: accountId,
    });
    expect(wire.model_count).toBe(12);
    expect(wire.credential_fingerprint).toBe(FINGERPRINT_0);
    expect(wire.connection_destination).toBe("https://api.cerebras.ai/v1");
    expect(wire.catalog_digest).toBe(CATALOG_DIGEST);
    expect(wire.discovered_at).toBe(new Date(NOW_MS).toISOString());
    expect(wire.last_verified_at).toBe(new Date(NOW_MS).toISOString());
    expect(wire.expires_at).toBe(new Date(NOW_MS + 1_000).toISOString());
    expect(JSON.stringify(wire)).not.toContain("cf-account");
  });

  test("the provider id keeps the colon source form", () => {
    expect(providerAccountProviderId({ source: "opencode:baseten" })).toBe("account:opencode:baseten");
    expect(providerAccountProviderId({ source: "opencode:baseten" })).not.toContain("/opencode/");
  });

  test("the capability scope is one host and at most one secret", () => {
    expect(providerAccountCapabilityScope(account({ credentialUri: "secret://provider-account/a" })))
      .toEqual({
        networkDestinations: ["api.cerebras.ai:443"],
        secretCapabilities: ["secret://provider-account/a"],
      });
    expect(providerAccountCapabilityScope(account({ source: ZEN_SOURCE, host: "opencode.ai", credentialUri: "" })))
      .toEqual({ networkDestinations: ["opencode.ai:443"], secretCapabilities: [] });
  });

  test("only a kernel-discovered OpenCode delegation bypasses manual gateway terms", () => {
    expect(providerAccountWorkspaceAccess(account({ source: "opencode:cerebras" }), false)).toBe(true);
    expect(providerAccountWorkspaceAccess(account({ source: ZEN_SOURCE, metadataJson: "{}" }), false)).toBe(false);
    expect(providerAccountWorkspaceAccess(account({
      source: ZEN_SOURCE,
      metadataJson: JSON.stringify({ connection_origin: "installed_opencode" }),
    }), false)).toBe(true);
    expect(providerAccountWorkspaceAccess(account({ source: ZEN_SOURCE, metadataJson: "{}" }), true)).toBe(true);
  });
});

describe("uuidV7", () => {
  test("carries the version, the variant, and the supplied timestamp", () => {
    const id = uuidV7(NOW_MS, (length) => new Uint8Array(length).fill(0xff));
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const timestamp = Number.parseInt(id.replace(/-/g, "").slice(0, 12), 16);
    expect(timestamp).toBe(NOW_MS);
  });

  test("later ids sort after earlier ones", () => {
    const earlier = uuidV7(NOW_MS);
    const later = uuidV7(NOW_MS + 1_000);
    expect(later > earlier).toBe(true);
  });
});

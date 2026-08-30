/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import {
  ZEN_SOURCE,
  chooseDefaultAccount,
  discoverAndConnectLocalAccounts,
  mapGatewayConfiguration,
  mapLocalCredential,
  providerAccountCapabilityScope,
  providerAccountProviderId,
  providerAccountWorkspaceAccess,
  providerAccountSecretUri,
  providerAccountWire,
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

function credential(overrides: Partial<LocalProviderCredential> = {}): LocalProviderCredential {
  return {
    source: "opencode:cerebras",
    authKind: "api",
    fingerprint: "0123456789ab",
    metadataJson: "{}",
    expiresAtUnix: 0,
    store: "local-auth-store",
    ...overrides,
  };
}

function account(overrides: Partial<ProviderAccountRecord> = {}): ProviderAccountRecord {
  return {
    id: "account-1",
    source: "opencode:cerebras",
    displayName: "Cerebras",
    vendorId: "cerebras",
    authKind: "api",
    credentialUri: providerAccountSecretUri("account-1"),
    fingerprint: "0123456789ab",
    baseUrl: "https://api.cerebras.ai/v1",
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

  test("substitutes the Cloudflare account id from the store's own metadata", () => {
    const mapping = mapLocalCredential({
      credential: credential({
        source: "opencode:cloudflare-workers-ai",
        metadataJson: JSON.stringify({ provider_metadata: { accountId: "acc0unt1d" } }),
      }),
      catalog: CATALOG,
      nowMs: NOW_MS,
    });
    expect(mapping.status).toBe("connected");
    expect(mapping.baseUrl).toBe("https://api.cloudflare.com/client/v4/accounts/acc0unt1d/ai/v1");
    expect(mapping.host).toBe("api.cloudflare.com");
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

  test("the Codex login maps to the ChatGPT endpoint and subscription billing", () => {
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
      host: "chatgpt.com",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      protocol: "responses",
      connectorId: "chatgpt-codex",
      renderProfile: "chatgpt_codex",
      billing: "subscription",
      status: "connected",
    });
    expect(JSON.parse(mapping.metadataJson)).toEqual({
      account_id: "acct-1",
      email: "user@example.test",
      plan_type: "plus",
    });
  });

  test("an expired ChatGPT token is expired, with the sign-in instruction", () => {
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
    expect(mapping.statusDetail).toContain("codex");
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

// ── Auto-connect ────────────────────────────────────────────────────────────

interface FakeStore {
  readonly rows: Map<string, ProviderAccountRecord>;
  readonly imports: { source: string; capabilityUri: string; fingerprint: string }[];
}

function fakeDependencies(input: {
  readonly credentials: readonly LocalProviderCredential[];
  readonly store?: FakeStore;
  readonly gateway?: Parameters<typeof mapGatewayConfiguration>[0] | null;
  readonly opencodeInstalled?: boolean;
  /** Omitted entirely when absent, so the default (no probe) is exercised. */
  readonly credentialResolves?: (credentialUri: string) => Promise<boolean>;
}): { readonly dependencies: Parameters<typeof discoverAndConnectLocalAccounts>[0]; readonly store: FakeStore } {
  const store: FakeStore = input.store ?? { rows: new Map(), imports: [] };
  let counter = 0;
  return {
    store,
    dependencies: {
      ...(input.credentialResolves === undefined
        ? {}
        : { credentialResolves: input.credentialResolves }),
      discoverLocal: async () => ({
        credentials: input.credentials,
        warnings: ["local-auth-store: one entry did not decode"],
        codexInstalled: true,
        opencodeInstalled: input.opencodeInstalled ?? false,
      }),
      importLocal: async ({ source, capabilityUri, fingerprint }) => {
        store.imports.push({ source, capabilityUri, fingerprint });
        return { capabilityUri, stored: true };
      },
      listAccounts: async () => [...store.rows.values()],
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
      setDefaultAccount: async (id: string) => {
        for (const [source, row] of store.rows) {
          store.rows.set(source, { ...row, isDefault: row.id === id });
        }
      },
      readGatewayConfiguration: async () => input.gateway ?? null,
      fetchCatalog: async () => ({ catalog: CATALOG, offline: false }),
      newAccountId: () => `account-${(counter += 1)}`,
      now: () => new Date(NOW_MS),
      warn: () => {},
    },
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
      isDefault: true,
    });
    expect(store.rows.get(ZEN_SOURCE)?.metadataJson).toBe(
      JSON.stringify({ connection_origin: "installed_opencode" }),
    );
  });

  test("imports every routable credential into its own provider-account URI", async () => {
    const { dependencies, store } = fakeDependencies({
      credentials: [
        credential({ source: "opencode:cerebras", fingerprint: "aaaaaaaaaaaa" }),
        credential({ source: "opencode:amazon-bedrock", fingerprint: "bbbbbbbbbbbb" }),
        credential({
          source: "codex-chatgpt",
          authKind: "chatgpt",
          fingerprint: "cccccccccccc",
          expiresAtUnix: Math.floor(NOW_MS / 1_000) + 86_400,
        }),
      ],
    });
    const result = await discoverAndConnectLocalAccounts(dependencies);

    expect(result.accounts).toHaveLength(3);
    expect(result.warnings).toEqual(["local-auth-store: one entry did not decode"]);
    expect(result.imported).toHaveLength(2);
    // The unsupported entry is visible but its secret is never copied: nothing
    // would ever read it.
    expect(store.imports.map((entry) => entry.source).sort()).toEqual([
      "codex-chatgpt",
      "opencode:cerebras",
    ]);
    for (const entry of store.imports) {
      expect(entry.capabilityUri).toMatch(/^secret:\/\/provider-account\/account-\d+$/);
    }
    expect(store.rows.get("opencode:amazon-bedrock")?.credentialUri).toBe("");
    expect(store.rows.get("opencode:amazon-bedrock")?.status).toBe("unsupported");
  });

  test("a second run with unchanged fingerprints imports nothing again", async () => {
    const store: FakeStore = { rows: new Map(), imports: [] };
    const credentials = [credential({ source: "opencode:cerebras", fingerprint: "aaaaaaaaaaaa" })];
    await discoverAndConnectLocalAccounts(fakeDependencies({ credentials, store }).dependencies);
    const before = store.rows.get("opencode:cerebras")!;
    store.imports.length = 0;

    const second = await discoverAndConnectLocalAccounts(fakeDependencies({ credentials, store }).dependencies);
    expect(store.imports).toHaveLength(0);
    expect(second.imported).toHaveLength(0);
    expect(store.rows.get("opencode:cerebras")?.id).toBe(before.id);
  });

  test("a rotated key is re-imported under the same account and reported", async () => {
    const store: FakeStore = { rows: new Map(), imports: [] };
    await discoverAndConnectLocalAccounts(fakeDependencies({
      credentials: [credential({ source: "opencode:cerebras", fingerprint: "aaaaaaaaaaaa" })],
      store,
    }).dependencies);
    const before = store.rows.get("opencode:cerebras")!;
    store.imports.length = 0;

    const rotated = await discoverAndConnectLocalAccounts(fakeDependencies({
      credentials: [credential({ source: "opencode:cerebras", fingerprint: "dddddddddddd" })],
      store,
    }).dependencies);

    expect(store.imports).toHaveLength(1);
    expect(store.imports[0]).toMatchObject({
      capabilityUri: before.credentialUri,
      fingerprint: "dddddddddddd",
    });
    expect(rotated.imported).toEqual([before.id]);
    const after = store.rows.get("opencode:cerebras")!;
    expect(after.id).toBe(before.id);
    expect(after.fingerprint).toBe("dddddddddddd");
    expect(after.revision).toBeGreaterThan(before.revision);
  });

  test("the singleton gateway row becomes one zen account and never the first default", async () => {
    const { dependencies, store } = fakeDependencies({
      credentials: [credential({ source: "opencode:cerebras", fingerprint: "aaaaaaaaaaaa" })],
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
    expect(defaults).toHaveLength(1);
    expect(defaults[0]?.source).toBe("opencode:cerebras");
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
    expect(store.rows.get(ZEN_SOURCE)?.isDefault).toBe(true);
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

  test("a credential the kernel can no longer resolve is re-imported", async () => {
    const store: FakeStore = { rows: new Map(), imports: [] };
    const credentials = [credential({ source: "opencode:cerebras", fingerprint: "aaaaaaaaaaaa" })];
    await discoverAndConnectLocalAccounts(
      fakeDependencies({ credentials, store, credentialResolves: async () => true }).dependencies,
    );
    const before = store.rows.get("opencode:cerebras")!;
    expect(before.credentialUri).not.toBe("");
    store.imports.length = 0;

    // The kernel's secret backend changed under us: the row still names a URI
    // and the fingerprint has not rotated, but the bytes are gone.
    const probed: string[] = [];
    const recovered = await discoverAndConnectLocalAccounts(
      fakeDependencies({
        credentials,
        store,
        credentialResolves: async (uri) => {
          probed.push(uri);
          return false;
        },
      }).dependencies,
    );

    expect(probed).toEqual([before.credentialUri]);
    expect(store.imports).toHaveLength(1);
    expect(store.imports[0]).toMatchObject({
      capabilityUri: before.credentialUri,
      fingerprint: "aaaaaaaaaaaa",
    });
    expect(recovered.imported).toEqual([before.id]);
    expect(store.rows.get("opencode:cerebras")?.credentialUri).toBe(before.credentialUri);
    expect(store.rows.get("opencode:cerebras")?.status).toBe("connected");
  });

  test("a resolvable credential is not re-imported", async () => {
    const store: FakeStore = { rows: new Map(), imports: [] };
    const credentials = [credential({ source: "opencode:cerebras", fingerprint: "aaaaaaaaaaaa" })];
    await discoverAndConnectLocalAccounts(
      fakeDependencies({ credentials, store, credentialResolves: async () => true }).dependencies,
    );
    store.imports.length = 0;

    const second = await discoverAndConnectLocalAccounts(
      fakeDependencies({ credentials, store, credentialResolves: async () => true }).dependencies,
    );
    expect(store.imports).toHaveLength(0);
    expect(second.imported).toHaveLength(0);
  });

  test("a failing resolution probe fails open rather than re-importing", async () => {
    const store: FakeStore = { rows: new Map(), imports: [] };
    const credentials = [credential({ source: "opencode:cerebras", fingerprint: "aaaaaaaaaaaa" })];
    await discoverAndConnectLocalAccounts(
      fakeDependencies({ credentials, store, credentialResolves: async () => true }).dependencies,
    );
    store.imports.length = 0;

    const warnings: string[] = [];
    const { dependencies } = fakeDependencies({
      credentials,
      store,
      credentialResolves: async (): Promise<never> => { throw new Error("kernel restarting"); },
    });
    const result = await discoverAndConnectLocalAccounts({
      ...dependencies,
      warn: (message) => warnings.push(message),
    });

    expect(store.imports).toHaveLength(0);
    expect(result.imported).toHaveLength(0);
    expect(warnings.join("\n")).toContain("kernel restarting");
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
    const wire = providerAccountWire(
      account({
        metadataJson: JSON.stringify({
          account_id: "acct-1",
          plan_type: "plus",
          email: "user@example.test",
          provider_metadata: { accountId: "cf-account" },
        }),
        lastVerifiedAt: new Date(NOW_MS),
        expiresAt: new Date(NOW_MS + 1_000),
      }),
      12,
    );
    expect(wire.metadata).toEqual({
      account_id: "acct-1",
      plan_type: "plus",
      email: "user@example.test",
    });
    expect(wire.model_count).toBe(12);
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
    expect(providerAccountCapabilityScope({ host: "api.cerebras.ai", credentialUri: "secret://provider-account/a" }))
      .toEqual({
        networkDestinations: ["api.cerebras.ai:443"],
        secretCapabilities: ["secret://provider-account/a"],
      });
    expect(providerAccountCapabilityScope({ host: "opencode.ai", credentialUri: "" }))
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

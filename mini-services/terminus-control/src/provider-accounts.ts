/**
 * Terminus Control — connected provider accounts.
 *
 * A developer machine usually already holds several usable model credentials:
 * a ChatGPT login the Codex CLI signed in with, and an OpenCode auth store
 * with one entry per provider. Terminus could reach exactly one of them,
 * because routing was a fixed chain — vendor-direct environment configuration,
 * else the singleton gateway row, else a local command — and picking a
 * different model meant rewriting global configuration.
 *
 * Each usable credential becomes one `provider_accounts` row instead. This
 * module owns three things:
 *
 *   1. What a discovered credential *is* — vendor, base URL, wire protocol,
 *      kernel connector, render profile — resolved from the models.dev
 *      catalogue rather than guessed. An SDK Terminus has no transport for is
 *      stored as `unsupported` with the reason, so it is visible but not
 *      selectable.
 *   2. Discovery: ask the kernel what supported local sources are present,
 *      migrate the legacy gateway row into a `zen` account, and never import
 *      a credential without an explicit user-consent operation.
 *   3. Which account a turn runs on, as a pure decision over already-loaded
 *      rows.
 *
 * Credential material never enters this module. Discovery returns identity, a
 * non-reversible fingerprint, and non-secret metadata; import returns the
 * capability URI it stored under. Nothing here is logged, returned, or
 * persisted beyond that.
 */
import { randomBytes } from "node:crypto";
import { protocolForPackage, type GatewayProtocol } from "@terminus/provider-zen";

// ────────────────────────── Domain ───────────────────────────────────────────

export const PROVIDER_ACCOUNT_AUTH_KINDS = ["api", "oauth", "wellknown", "chatgpt", "anonymous"] as const;
export type ProviderAccountAuthKind = (typeof PROVIDER_ACCOUNT_AUTH_KINDS)[number];

export const PROVIDER_ACCOUNT_STATUSES = ["connected", "expired", "error", "unsupported", "disconnected"] as const;
export type ProviderAccountStatus = (typeof PROVIDER_ACCOUNT_STATUSES)[number];

export const PROVIDER_ACCOUNT_BILLINGS = ["subscription", "free", "paid", "unknown"] as const;
export type ProviderAccountBilling = (typeof PROVIDER_ACCOUNT_BILLINGS)[number];

export const PROVIDER_RENDER_PROFILES = [
  "openai_compatible",
  "openai_responses",
  "anthropic_messages",
  "chatgpt_codex",
  "zen_gateway",
] as const;
export type ProviderRenderProfile = (typeof PROVIDER_RENDER_PROFILES)[number];

/** The `codex-chatgpt` source id, as the kernel reports it. */
export const CODEX_SOURCE = "codex-chatgpt";
/** The migrated OpenCode Zen/Go gateway account. */
export const ZEN_SOURCE = "zen";
/** models.dev provider id for the OpenCode gateway, and the local tool's name. */
export const ZEN_VENDOR_ID = "opencode";
/** Prefix for a local auth-store entry: `opencode:<providerID>`. */
export const OPENCODE_SOURCE_PREFIX = `${ZEN_VENDOR_ID}:`;

/**
 * The persisted account, in the shape Prisma returns. Declared structurally so
 * the pure decisions below can be exercised without a database.
 */
export interface ProviderAccountRecord {
  readonly id: string;
  readonly source: string;
  readonly displayName: string;
  readonly vendorId: string;
  readonly authKind: string;
  readonly credentialUri: string;
  readonly fingerprint: string;
  readonly baseUrl: string;
  readonly catalogDigest: string;
  readonly credentialFingerprint: string;
  readonly approvedBaseUrl: string;
  readonly approvedCatalogDigest: string;
  readonly secretState: string;
  readonly secretOperationId: string;
  readonly host: string;
  readonly protocol: string;
  readonly connectorId: string;
  readonly renderProfile: string;
  readonly status: string;
  readonly statusDetail: string;
  readonly billing: string;
  readonly metadataJson: string;
  readonly isDefault: boolean;
  readonly discoveredAt: Date;
  readonly lastVerifiedAt: Date | null;
  readonly expiresAt: Date | null;
  readonly revision: number;
}

export type ProviderAccountSecretState = "none" | "import_pending" | "bound" | "revoke_pending";

/** Non-secret identity the kernel reported alongside a credential. */
export interface ProviderAccountMetadata {
  readonly account_id?: string;
  /** Non-secret provenance for an account Terminus synthesized locally. */
  readonly connection_origin?: "installed_opencode";
}

export interface ProviderAccountWire {
  readonly id: string;
  readonly source: string;
  readonly display_name: string;
  readonly vendor_id: string;
  readonly auth_kind: ProviderAccountAuthKind;
  readonly status: ProviderAccountStatus;
  readonly status_detail: string;
  readonly billing: ProviderAccountBilling;
  readonly host: string;
  readonly protocol: GatewayProtocol;
  readonly is_default: boolean;
  readonly model_count: number;
  /** Non-reversible digest used to bind an explicit connect approval. */
  readonly credential_fingerprint: string;
  /** Exact reviewed destination the approved credential may reach. */
  readonly connection_destination: string;
  /** Immutable provider-catalog snapshot used to derive that destination. */
  readonly catalog_digest: string;
  readonly metadata: { account_id?: string };
  readonly discovered_at: string;
  readonly last_verified_at: string | null;
  readonly expires_at: string | null;
  readonly revision: number;
}

function admittedAuthKind(value: string): ProviderAccountAuthKind {
  return (PROVIDER_ACCOUNT_AUTH_KINDS as readonly string[]).includes(value)
    ? value as ProviderAccountAuthKind
    : "api";
}

function admittedStatus(value: string): ProviderAccountStatus {
  return (PROVIDER_ACCOUNT_STATUSES as readonly string[]).includes(value)
    ? value as ProviderAccountStatus
    : "error";
}

function admittedBilling(value: string): ProviderAccountBilling {
  return (PROVIDER_ACCOUNT_BILLINGS as readonly string[]).includes(value)
    ? value as ProviderAccountBilling
    : "unknown";
}

function admittedProtocol(value: string): GatewayProtocol {
  return value === "responses" || value === "messages" ? value : "chat_completions";
}

export function parseProviderAccountMetadata(json: string): ProviderAccountMetadata {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return {};
  }
  if (!isRecord(parsed)) return {};
  return {
    ...(typeof parsed.account_id === "string" && /^[0-9a-f]{32}$/i.test(parsed.account_id)
      ? { account_id: parsed.account_id.toLowerCase() }
      : {}),
    ...(parsed.connection_origin === "installed_opencode"
      ? { connection_origin: parsed.connection_origin }
      : {}),
  };
}

/**
 * The client-facing account.
 *
 * `provider_metadata` is deliberately not projected: it is the local tool's own
 * bag; only the provider-bound account id has a defined routing meaning here.
 */
export function providerAccountWire(
  account: ProviderAccountRecord,
  modelCount: number,
  catalogDigest: string,
): ProviderAccountWire {
  const metadata = parseProviderAccountMetadata(canonicalMetadataForAccount(account.source, account.metadataJson));
  return {
    id: account.id,
    source: account.source,
    display_name: account.displayName,
    vendor_id: account.vendorId,
    auth_kind: admittedAuthKind(account.authKind),
    status: admittedStatus(account.status),
    status_detail: account.statusDetail,
    billing: admittedBilling(account.billing),
    host: account.host,
    protocol: admittedProtocol(account.protocol),
    is_default: account.isDefault,
    model_count: Math.max(0, Math.floor(modelCount)),
    credential_fingerprint: account.fingerprint,
    connection_destination: account.baseUrl,
    catalog_digest: account.catalogDigest || catalogDigest,
    metadata: {
      ...(metadata.account_id === undefined ? {} : { account_id: metadata.account_id }),
    },
    discovered_at: account.discoveredAt.toISOString(),
    last_verified_at: account.lastVerifiedAt?.toISOString() ?? null,
    expires_at: account.expiresAt?.toISOString() ?? null,
    revision: account.revision,
  };
}

/**
 * Stable provider id for the attempt ledger and capability profile.
 *
 * The colon form is deliberate: `tools/standalone-check.ts` rejects a shipped
 * identifier that puts a path separator next to the harness name, and
 * `account:opencode:baseten` names the source exactly without one.
 */
export function providerAccountProviderId(account: Pick<ProviderAccountRecord, "source">): string {
  return `account:${account.source}`;
}

/** The exact kernel scope one account's turn needs: one host, one secret. */
export function providerAccountCapabilityScope(
  account: Pick<
    ProviderAccountRecord,
    | "source"
    | "host"
    | "credentialUri"
    | "fingerprint"
    | "baseUrl"
    | "catalogDigest"
    | "credentialFingerprint"
    | "approvedBaseUrl"
    | "approvedCatalogDigest"
    | "secretState"
  >,
): { readonly networkDestinations: readonly string[]; readonly secretCapabilities: readonly string[] } {
  if (account.source !== ZEN_SOURCE && !(
    account.secretState === "bound"
    && account.credentialUri !== ""
    && account.credentialFingerprint === account.fingerprint
    && account.approvedBaseUrl === account.baseUrl
    && account.approvedCatalogDigest === account.catalogDigest
  )) {
    throw new Error("provider account has no current approved binding");
  }
  const destination = account.source === ZEN_SOURCE ? account.host : new URL(account.approvedBaseUrl).hostname;
  return {
    networkDestinations: [`${destination}:443`],
    secretCapabilities: account.credentialUri === "" ? [] : [account.credentialUri],
  };
}

export function providerAccountHasApprovedBinding(account: ProviderAccountRecord): boolean {
  if (account.source === ZEN_SOURCE) return true;
  return account.secretState === "bound"
    && account.credentialUri !== ""
    && account.credentialFingerprint !== ""
    && account.credentialFingerprint === account.fingerprint
    && account.approvedBaseUrl !== ""
    && account.approvedBaseUrl === account.baseUrl
    && account.approvedCatalogDigest !== ""
    && account.approvedCatalogDigest === account.catalogDigest;
}

/** Whether this account may receive workspace-classified context. */
export function providerAccountWorkspaceAccess(
  account: Pick<ProviderAccountRecord, "source" | "metadataJson">,
  configuredGatewayTermsAdmitted: boolean,
): boolean {
  if (account.source !== ZEN_SOURCE) return true;
  const metadata = parseProviderAccountMetadata(account.metadataJson);
  return metadata.connection_origin === "installed_opencode" || configuredGatewayTermsAdmitted;
}

// ────────────────────────── uuid v7 ──────────────────────────────────────────

/**
 * A UUIDv7, because the kernel admits `secret://provider-account/<uuid-v7>`
 * only. Node ships v4 (`randomUUID`); v7 is a 48-bit big-endian millisecond
 * timestamp, the version and variant nibbles, and 74 random bits.
 */
export function uuidV7(
  nowMs: number = Date.now(),
  randomFill: (length: number) => Uint8Array = (length) => new Uint8Array(randomBytes(length)),
): string {
  const bytes = new Uint8Array(16);
  let timestamp = BigInt(Math.max(0, Math.floor(nowMs)));
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(timestamp & 0xffn);
    timestamp >>= 8n;
  }
  bytes.set(randomFill(10).subarray(0, 10), 6);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function providerAccountSecretUri(accountId: string): string {
  return `secret://provider-account/${accountId}`;
}

const LEGACY_PROVIDER_ACCOUNT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * URI used by the pre-saga importer, whose destination was the account id.
 * This is a one-release migration boundary: current imports use a fresh
 * UUIDv7 URI recorded before Store. Recovery may probe only this exact URI
 * when the row has no recorded credential; it never enumerates a keyring.
 */
export function legacyProviderAccountSecretUri(accountId: string): string | null {
  return LEGACY_PROVIDER_ACCOUNT_ID.test(accountId) ? providerAccountSecretUri(accountId) : null;
}

export async function recoverLegacyProviderAccountCredential(input: {
  readonly accountId: string;
  readonly inspect: (credentialUri: string) => Promise<"present" | "missing" | "unavailable">;
  readonly revoke: (credentialUri: string) => Promise<boolean>;
}): Promise<boolean> {
  const credentialUri = legacyProviderAccountSecretUri(input.accountId);
  if (credentialUri === null) return true;
  const presence = await input.inspect(credentialUri);
  if (presence === "missing") return true;
  if (presence === "unavailable") return false;
  return input.revoke(credentialUri);
}

/**
 * Finish a durable credential cleanup operation after a process restart.
 * `markRevokePending` and `finalize` are CAS operations owned by the caller;
 * keeping the effect between them makes both crash windows replayable.
 */
export async function settleProviderAccountSecretCleanup(input: {
  readonly account: ProviderAccountRecord;
  readonly markRevokePending: (
    account: ProviderAccountRecord,
  ) => Promise<ProviderAccountRecord | null>;
  readonly revokeCredential: (
    credentialUri: string,
    account: ProviderAccountRecord,
  ) => Promise<boolean>;
  readonly finalize: (account: ProviderAccountRecord) => Promise<ProviderAccountRecord | null>;
}): Promise<ProviderAccountRecord> {
  let pending = input.account;
  if (pending.secretState !== "revoke_pending") {
    const claimed = await input.markRevokePending(pending);
    if (claimed === null) return pending;
    pending = claimed;
  }
  if (
    pending.credentialUri !== ""
    && !await input.revokeCredential(pending.credentialUri, pending)
  ) {
    return pending;
  }
  return await input.finalize(pending) ?? pending;
}

// ────────────────────────── models.dev decoding ──────────────────────────────

export interface ModelsDevModelRecord {
  readonly id: string;
  readonly name: string;
  readonly npm: string | null;
  readonly toolCall: boolean;
  readonly reasoning: boolean;
  readonly structuredOutput: boolean;
  readonly imageInput: boolean;
  readonly contextTokens: number;
  readonly outputTokens: number;
  readonly inputCost: number;
  readonly cachedInputCost: number;
  readonly outputCost: number;
  readonly status: string | null;
}

export interface ModelsDevProviderRecord {
  readonly id: string;
  readonly name: string;
  readonly npm: string | null;
  readonly api: string | null;
  readonly models: readonly ModelsDevModelRecord[];
}

/**
 * Decode one provider out of the raw models.dev document.
 *
 * `@terminus/provider-zen`'s `parseModelsDevCatalog` decodes only the two
 * OpenCode gateway providers and asserts their base URLs, which is right for
 * that package and useless here: a connected account can be any of the 200+
 * providers the catalogue lists. This decoder is lenient about fields it does
 * not need and strict about the two it routes on (`npm`, `api`).
 */
export function decodeModelsDevProvider(
  catalog: unknown,
  providerId: string,
): ModelsDevProviderRecord | null {
  if (!isRecord(catalog)) return null;
  const raw = catalog[providerId];
  if (!isRecord(raw)) return null;
  const models: ModelsDevModelRecord[] = [];
  const rawModels = isRecord(raw.models) ? raw.models : {};
  for (const [key, value] of Object.entries(rawModels)) {
    if (!isRecord(value)) continue;
    const id = typeof value.id === "string" && value.id.trim() !== "" ? value.id : key;
    const limit = isRecord(value.limit) ? value.limit : {};
    const cost = isRecord(value.cost) ? value.cost : {};
    const modalities = isRecord(value.modalities) ? value.modalities : {};
    const override = isRecord(value.provider) ? value.provider : {};
    models.push({
      id,
      name: typeof value.name === "string" && value.name.trim() !== "" ? value.name : id,
      npm: typeof override.npm === "string" && override.npm.trim() !== "" ? override.npm : null,
      toolCall: value.tool_call === true,
      reasoning: value.reasoning === true,
      structuredOutput: value.structured_output === true,
      imageInput: Array.isArray(modalities.input) && modalities.input.includes("image"),
      contextTokens: positiveInteger(limit.context),
      outputTokens: positiveInteger(limit.output),
      inputCost: nonNegativeNumber(cost.input),
      cachedInputCost: nonNegativeNumber(cost.cache_read),
      outputCost: nonNegativeNumber(cost.output),
      status: typeof value.status === "string" ? value.status : null,
    });
  }
  return {
    id: typeof raw.id === "string" && raw.id.trim() !== "" ? raw.id : providerId,
    name: typeof raw.name === "string" && raw.name.trim() !== "" ? raw.name : providerId,
    npm: typeof raw.npm === "string" && raw.npm.trim() !== "" ? raw.npm : null,
    api: typeof raw.api === "string" && raw.api.trim() !== "" ? trimTrailingSlashes(raw.api) : null,
    models: models.sort((left, right) => left.id.localeCompare(right.id)),
  };
}

/**
 * Base URLs the provider SDK defaults to and models.dev does not publish.
 *
 * Deliberately tiny: a provider whose base URL is neither published nor listed
 * here is reported as an error, not sent somewhere invented.
 */
const SDK_DEFAULT_BASE_URLS: Readonly<Record<string, string>> = {
  cerebras: "https://api.cerebras.ai/v1",
};

/** `${VAR}` placeholders models.dev embeds in a base URL. */
const BASE_URL_PLACEHOLDER = /\$\{([A-Z0-9_]+)\}/g;

// ────────────────────────── Source → account mapping ─────────────────────────

/** A credential the kernel found, exactly as `LocalProviderCredentialMessage`. */
export interface LocalProviderCredential {
  readonly source: string;
  readonly authKind: string;
  readonly fingerprint: string;
  readonly metadataJson: string;
  readonly expiresAtUnix: number;
  readonly store: string;
}

export interface ProviderAccountMapping {
  readonly source: string;
  readonly displayName: string;
  readonly vendorId: string;
  readonly authKind: ProviderAccountAuthKind;
  readonly baseUrl: string;
  readonly host: string;
  readonly protocol: GatewayProtocol;
  readonly connectorId: string;
  readonly renderProfile: ProviderRenderProfile;
  readonly billing: ProviderAccountBilling;
  readonly status: ProviderAccountStatus;
  readonly statusDetail: string;
  readonly metadataJson: string;
  readonly expiresAt: Date | null;
}

const CONNECTOR_BY_PROTOCOL: Readonly<Record<GatewayProtocol, string>> = {
  chat_completions: "openai-compatible",
  responses: "openai-responses",
  messages: "anthropic-messages",
};

/**
 * How an account is paid for.
 *
 * A key in a local auth store is a key the user bought from that vendor, so it
 * bills per token: `paid`. `unknown` is reserved for an account Terminus cannot
 * describe at all, and would otherwise show a price badge nobody stated.
 */
function billingForAuthKind(authKind: ProviderAccountAuthKind): ProviderAccountBilling {
  switch (authKind) {
    case "api":
    case "wellknown":
      return "paid";
    case "chatgpt":
      return "subscription";
    case "anonymous":
      return "free";
    default:
      return "unknown";
  }
}

const RENDER_PROFILE_BY_PROTOCOL: Readonly<Record<GatewayProtocol, ProviderRenderProfile>> = {
  chat_completions: "openai_compatible",
  responses: "openai_responses",
  messages: "anthropic_messages",
};

export interface MapLocalCredentialInput {
  readonly credential: LocalProviderCredential;
  /** The raw models.dev document. */
  readonly catalog: unknown;
  /** True when the catalogue came from the committed offline snapshot. */
  readonly catalogOffline?: boolean;
  readonly nowMs?: number;
}

/**
 * Resolve one discovered credential into an account.
 *
 * Never throws: an entry Terminus cannot route is still an account, with the
 * reason on it. Hiding it would leave a user staring at a provider they know
 * they configured with no explanation.
 */
export function mapLocalCredential(input: MapLocalCredentialInput): ProviderAccountMapping {
  const { credential } = input;
  const nowMs = input.nowMs ?? Date.now();
  const expiresAt = credential.expiresAtUnix > 0 ? new Date(credential.expiresAtUnix * 1_000) : null;
  const authKind = admittedAuthKind(credential.authKind);

  if (credential.source === CODEX_SOURCE) {
    return unsupported({
      source: CODEX_SOURCE,
      displayName: "ChatGPT Codex",
      vendorId: "openai",
      authKind: "chatgpt",
      detail: "ChatGPT subscriptions are available through the separate Codex App Server lane; the raw CLI token is not importable",
      metadataJson: "{}",
      expiresAt,
    });
  }

  if (!credential.source.startsWith(OPENCODE_SOURCE_PREFIX)) {
    return unsupported({
      source: credential.source,
      displayName: credential.source,
      vendorId: credential.source,
      authKind,
      detail: `credential source '${credential.source}' has no Terminus mapping`,
      metadataJson: "{}",
      expiresAt,
    });
  }

  const vendorId = credential.source.slice(OPENCODE_SOURCE_PREFIX.length);
  const metadata = vendorId === "cloudflare-workers-ai"
    ? parseProviderAccountMetadata(credential.metadataJson)
    : {};
  const provider = decodeModelsDevProvider(input.catalog, vendorId);
  const displayName = provider?.name ?? vendorId;

  // v1 scope: OAuth logins other than the ChatGPT one have no refresh path
  // here, so they are stored and shown rather than half-supported.
  if (authKind === "oauth") {
    return unsupported({
      source: credential.source,
      displayName,
      vendorId,
      authKind,
      detail: "OAuth logins from the local auth store are not connectable in this release",
      metadataJson: canonicalMetadata(metadata),
      expiresAt,
    });
  }

  if (provider === null) {
    return {
      source: credential.source,
      displayName,
      vendorId,
      authKind,
      baseUrl: "",
      host: "",
      protocol: "chat_completions",
      connectorId: CONNECTOR_BY_PROTOCOL.chat_completions,
      renderProfile: "openai_compatible",
      billing: billingForAuthKind(authKind),
      status: "error",
      statusDetail: input.catalogOffline === true
        ? `the models.dev catalogue could not be reached, so ${vendorId}'s base URL and protocol are unknown`
        : `models.dev has no provider '${vendorId}'`,
      metadataJson: canonicalMetadata(metadata),
      expiresAt,
    };
  }

  const npm = provider.npm;
  const protocol = npm === null ? null : protocolForPackage(npm);
  if (protocol === null) {
    return unsupported({
      source: credential.source,
      displayName,
      vendorId,
      authKind,
      detail: npm === null
        ? `models.dev publishes no SDK for ${vendorId}, so its wire protocol is unknown`
        : `OpenCode SDK ${npm} has no Terminus transport yet`,
      metadataJson: canonicalMetadata(metadata),
      expiresAt,
    });
  }

  const resolved = resolveAccountBaseUrl(provider, metadata.account_id);
  if (resolved.baseUrl === null) {
    return {
      source: credential.source,
      displayName,
      vendorId,
      authKind,
      baseUrl: "",
      host: "",
      protocol,
      connectorId: CONNECTOR_BY_PROTOCOL[protocol],
      renderProfile: RENDER_PROFILE_BY_PROTOCOL[protocol],
      billing: billingForAuthKind(authKind),
      status: "error",
      statusDetail: resolved.reason,
      metadataJson: canonicalMetadata(metadata),
      expiresAt,
    };
  }

  const expired = expiresAt !== null && expiresAt.getTime() <= nowMs;
  return {
    source: credential.source,
    displayName,
    vendorId,
    authKind,
    baseUrl: resolved.baseUrl,
    host: new URL(resolved.baseUrl).hostname,
    protocol,
    connectorId: CONNECTOR_BY_PROTOCOL[protocol],
    renderProfile: RENDER_PROFILE_BY_PROTOCOL[protocol],
    billing: billingForAuthKind(authKind),
    status: expired ? "expired" : "connected",
    statusDetail: expired ? "The stored credential expired." : "",
    metadataJson: canonicalMetadata(metadata),
    expiresAt,
  };
}

/**
 * The account's base URL: the catalogue's own `api`, with `${VAR}`
 * placeholders filled from the store's non-secret metadata, else the SDK
 * default for providers models.dev does not publish one for.
 */
function resolveAccountBaseUrl(
  provider: ModelsDevProviderRecord,
  accountId: string | undefined,
): { readonly baseUrl: string | null; readonly reason: string } {
  const template = provider.api ?? SDK_DEFAULT_BASE_URLS[provider.id] ?? null;
  if (template === null) {
    return { baseUrl: null, reason: `models.dev publishes no base URL for '${provider.id}'` };
  }
  let missing: string | null = null;
  const substituted = template.replace(BASE_URL_PLACEHOLDER, (_match, name: string) => {
    const value = accountPlaceholderValue(name, accountId);
    if (value === null) {
      missing = name;
      return "";
    }
    return value;
  });
  if (missing !== null) {
    return {
      baseUrl: null,
      reason: `the stored ${provider.id} entry carries no ${String(missing)}, so its base URL cannot be resolved`,
    };
  }
  let url: URL;
  try {
    url = new URL(substituted);
  } catch {
    return { baseUrl: null, reason: `models.dev base URL '${template}' for '${provider.id}' is not a URL` };
  }
  if (url.protocol !== "https:") {
    return { baseUrl: null, reason: `base URL '${substituted}' for '${provider.id}' is not HTTPS` };
  }
  if (
    url.username !== ""
    || url.password !== ""
    || url.hash !== ""
    || url.search !== ""
    || (url.port !== "" && url.port !== "443")
  ) {
    return { baseUrl: null, reason: `base URL '${substituted}' for '${provider.id}' has forbidden URL components` };
  }
  if (!isPublicProviderHost(url.hostname)) {
    return { baseUrl: null, reason: `base URL '${substituted}' for '${provider.id}' is not a public DNS origin` };
  }
  return { baseUrl: trimTrailingSlashes(url.href), reason: "" };
}

/**
 * Placeholder values, taken only from the store's own non-secret metadata.
 * Process environment is deliberately not consulted: an account's destination
 * must not depend on whatever the control plane happened to be started with.
 */
function accountPlaceholderValue(
  name: string,
  accountId: string | undefined,
): string | null {
  if (name !== "CLOUDFLARE_ACCOUNT_ID") return null;
  return accountId !== undefined && /^[0-9a-f]{32}$/i.test(accountId)
    ? accountId
    : null;
}

/** Provider credentials may never be routed to local or IP-literal origins. */
function isPublicProviderHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.includes(":")) return false;
  if (/^\d+(?:\.\d+){3}$/.test(host)) return false;
  return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host);
}

function unsupported(input: {
  source: string;
  displayName: string;
  vendorId: string;
  authKind: ProviderAccountAuthKind;
  detail: string;
  metadataJson: string;
  expiresAt: Date | null;
}): ProviderAccountMapping {
  return {
    source: input.source,
    displayName: input.displayName,
    vendorId: input.vendorId,
    authKind: input.authKind,
    baseUrl: "",
    host: "",
    protocol: "chat_completions",
    connectorId: CONNECTOR_BY_PROTOCOL.chat_completions,
    renderProfile: "openai_compatible",
    billing: billingForAuthKind(input.authKind),
    status: "unsupported",
    statusDetail: input.detail,
    metadataJson: input.metadataJson,
    expiresAt: input.expiresAt,
  };
}

/** The legacy singleton gateway row, in the shape this module reads it. */
export interface GatewayConfigurationSnapshot {
  readonly deployment: string;
  readonly protocol: string;
  readonly credentialConfigured: boolean;
  readonly freeModel: boolean;
  readonly secretUri: string;
}

const ZEN_BASE_URLS: Readonly<Record<string, string>> = {
  zen: "https://opencode.ai/zen/v1",
  go: "https://opencode.ai/zen/go/v1",
};

/** Fresh-install projection for the anonymous models OpenCode ships enabled. */
const ANONYMOUS_ZEN_CONFIGURATION: GatewayConfigurationSnapshot = {
  deployment: "zen",
  protocol: "chat_completions",
  credentialConfigured: false,
  freeModel: true,
  secretUri: "",
};

/**
 * The legacy gateway row as an account.
 *
 * The row itself stays authoritative for the legacy turn path — this is a
 * projection so the gateway shows up in one list with everything else, not a
 * replacement.
 */
export function mapGatewayConfiguration(row: GatewayConfigurationSnapshot): ProviderAccountMapping {
  const deployment = row.deployment === "go" ? "go" : "zen";
  const anonymous = deployment === "zen" && row.freeModel && !row.credentialConfigured;
  return {
    source: ZEN_SOURCE,
    displayName: deployment === "go" ? "OpenCode Go" : "OpenCode Zen",
    vendorId: "opencode",
    authKind: anonymous ? "anonymous" : "api",
    baseUrl: ZEN_BASE_URLS[deployment] ?? ZEN_BASE_URLS.zen!,
    host: "opencode.ai",
    protocol: admittedProtocol(row.protocol),
    connectorId: anonymous ? "opencode-gateway-anonymous" : "opencode-gateway",
    renderProfile: "zen_gateway",
    billing: anonymous ? "free" : "paid",
    status: anonymous || row.credentialConfigured ? "connected" : "error",
    statusDetail: anonymous || row.credentialConfigured ? "" : "No gateway credential is configured.",
    metadataJson: "{}",
    expiresAt: null,
  };
}

/** The credential URI a zen account binds to; empty for the anonymous tier. */
export function zenAccountCredentialUri(row: GatewayConfigurationSnapshot): string {
  const deployment = row.deployment === "go" ? "go" : "zen";
  const anonymous = deployment === "zen" && row.freeModel && !row.credentialConfigured;
  return anonymous ? "" : row.secretUri;
}

// ────────────────────────── Local account discovery ─────────────────────────

export interface LocalCredentialDiscovery {
  readonly credentials: readonly LocalProviderCredential[];
  readonly warnings: readonly string[];
  readonly codexInstalled: boolean;
  readonly opencodeInstalled: boolean;
  readonly opencodeStoreStatus: "available" | "missing" | "rejected" | "unavailable";
}

export interface ProviderAccountUpsert {
  readonly id: string;
  readonly source: string;
  readonly displayName: string;
  readonly vendorId: string;
  readonly authKind: string;
  readonly credentialUri: string;
  readonly fingerprint: string;
  readonly baseUrl: string;
  readonly catalogDigest: string;
  readonly credentialFingerprint: string;
  readonly approvedBaseUrl: string;
  readonly approvedCatalogDigest: string;
  readonly secretState: ProviderAccountSecretState;
  readonly secretOperationId: string;
  readonly host: string;
  readonly protocol: string;
  readonly connectorId: string;
  readonly renderProfile: string;
  readonly status: string;
  readonly statusDetail: string;
  readonly billing: string;
  readonly metadataJson: string;
  readonly discoveredAt: Date;
  readonly expiresAt: Date | null;
}

export interface ProviderAccountDiscoveryDependencies {
  readonly discoverLocal: () => Promise<LocalCredentialDiscovery>;
  /**
   * Imports the live credential for `source` into `capabilityUri`. The
   * fingerprint travels with it so the caller can key the kernel's required
   * idempotency token on the *credential*, not just its destination: a
   * rotated key imported to the same URI must not be deduplicated away.
   */
  readonly importLocal?: (input: {
    readonly source: string;
    readonly capabilityUri: string;
    readonly fingerprint: string;
  }) => Promise<{ readonly capabilityUri: string; readonly stored: boolean }>;
  readonly listAccounts: () => Promise<readonly ProviderAccountRecord[]>;
  /**
   * Whether the credential a row already points at still resolves in the
   * kernel's *active* credential store.
   *
   * A `credentialUri` recorded in the database is not evidence the bytes are
   * still there: the operator can switch the kernel's secret backend
   * (`TERMINUS_SECRETS_BACKEND`), or the OS keychain entry can be removed out
   * from under us. Without this probe such a row is permanently broken —
   * discovery sees an unrotated fingerprint and a non-empty URI, decides no
   * import is needed, and every turn then fails at grant-mint time.
   *
   * Metadata only; no secret bytes cross this boundary. Optional so callers
   * that cannot probe keep the previous behaviour.
   */
  readonly credentialStatus?: (credentialUri: string) => Promise<"present" | "missing" | "unavailable">;
  /** Revoke a copied local credential after logout or rotation. */
  readonly revokeCredential?: (credentialUri: string) => Promise<boolean>;
  /** Creates a row for a source that is not yet present. */
  readonly upsertAccount: (input: ProviderAccountUpsert) => Promise<ProviderAccountRecord>;
  /** Replaces one observed row only if its security-relevant snapshot still matches. */
  readonly reconcileAccount: (
    input: ProviderAccountUpsert,
    expected: ProviderAccountSecuritySnapshot,
  ) => Promise<ProviderAccountRecord | null>;
  readonly readGatewayConfiguration: () => Promise<GatewayConfigurationSnapshot | null>;
  readonly fetchCatalog: () => Promise<{
    readonly catalog: unknown;
    readonly offline: boolean;
    readonly digest: string;
  }>;
  readonly newAccountId?: () => string;
  readonly newOperationId?: () => string;
  readonly now?: () => Date;
  readonly warn?: (message: string) => void;
}

export interface ProviderAccountSecuritySnapshot {
  readonly id: string;
  readonly revision: number;
  readonly fingerprint: string;
  readonly credentialUri: string;
  readonly secretState: ProviderAccountSecretState;
  readonly secretOperationId: string;
}

export interface ProviderAccountDiscoveryResult {
  readonly accounts: readonly ProviderAccountRecord[];
  /** Credentials actually imported by an explicit connect operation (always empty during discovery). */
  readonly imported: readonly string[];
  readonly warnings: readonly string[];
  readonly codexInstalled: boolean;
  readonly opencodeInstalled: boolean;
  readonly opencodeStoreStatus: "available" | "missing" | "rejected" | "unavailable";
  readonly lastRunAt: string;
}

export interface ProviderAccountConnectDependencies {
  readonly account: ProviderAccountRecord;
  readonly expectedRevision: number;
  /** Fingerprint shown with the consent surface; binds approval to exact bytes. */
  readonly expectedFingerprint: string;
  readonly expectedDestination: string;
  readonly expectedCatalogDigest: string;
  /** Fresh per-connect destination so a failed CAS cannot overwrite a live key. */
  readonly capabilityUri: string;
  /** The user-visible confirmation must be true; discovery cannot supply it. */
  readonly userConsent: boolean;
  readonly discoverLocal: () => Promise<LocalCredentialDiscovery>;
  readonly importLocal: (input: {
    readonly source: string;
    readonly capabilityUri: string;
    readonly expectedFingerprint: string;
  }) => Promise<{
    readonly capabilityUri: string;
    readonly stored: boolean;
    readonly fingerprint: string;
  }>;
  readonly fetchCatalog: () => Promise<{
    readonly catalog: unknown;
    readonly offline: boolean;
    readonly digest: string;
  }>;
  /** Persist the exact approval before the kernel may copy any bytes. */
  readonly claimImport: (
    account: ProviderAccountRecord,
    claim: ProviderAccountImportClaim,
  ) => Promise<ProviderAccountRecord | null>;
  readonly finalizeImport: (claimed: ProviderAccountRecord) => Promise<ProviderAccountRecord | null>;
  readonly markImportForCleanup: (claimed: ProviderAccountRecord) => Promise<ProviderAccountRecord | null>;
  readonly now?: () => Date;
}

export interface ProviderAccountImportClaim {
  readonly capabilityUri: string;
  readonly operationId: string;
  readonly credentialFingerprint: string;
  readonly approvedBaseUrl: string;
  readonly approvedCatalogDigest: string;
}

/**
 * Import one already-discovered OpenCode credential after explicit consent.
 * The source is re-read immediately before import so a stale discovery cannot
 * cause the wrong credential to be copied into the account's capability URI.
 */
export async function connectLocalProviderAccount(
  dependencies: ProviderAccountConnectDependencies,
): Promise<ProviderAccountRecord> {
  if (!dependencies.userConsent) {
    throw new Error("explicit user consent is required before importing a local credential");
  }
  if (dependencies.account.revision !== dependencies.expectedRevision) {
    throw new Error("provider account changed; reload it before connecting");
  }
  if (
    dependencies.expectedFingerprint === ""
    || dependencies.account.fingerprint !== dependencies.expectedFingerprint
  ) {
    throw new Error("provider credential changed; run discovery and approve the current credential");
  }
  if (dependencies.account.source === CODEX_SOURCE || dependencies.account.renderProfile === "chatgpt_codex") {
    throw new Error("ChatGPT subscriptions require the separate Codex App Server lane");
  }
  if (dependencies.account.credentialUri !== "") {
    throw new Error("provider account already has a credential binding; reconcile or disconnect it before connecting");
  }
  if (dependencies.account.secretState !== "none") {
    throw new Error("provider account credential recovery is still pending; reload it before connecting");
  }
  if (
    dependencies.account.baseUrl !== dependencies.expectedDestination
    || dependencies.account.catalogDigest !== dependencies.expectedCatalogDigest
  ) {
    throw new Error("provider destination changed; reload it before connecting");
  }

  const discovery = await dependencies.discoverLocal();
  const credential = discovery.credentials.find((candidate) => candidate.source === dependencies.account.source);
  if (credential === undefined) {
    throw new Error("the local credential is no longer available; run discovery again");
  }
  if (credential.fingerprint !== dependencies.expectedFingerprint) {
    throw new Error("provider credential changed after approval; run discovery and approve it again");
  }
  const { catalog, offline, digest } = await dependencies.fetchCatalog();
  if (digest !== dependencies.expectedCatalogDigest) {
    throw new Error("provider catalog changed after approval; reload it before connecting");
  }
  const mapping = mapLocalCredential({
    credential,
    catalog,
    catalogOffline: offline,
    nowMs: (dependencies.now ?? (() => new Date()))().getTime(),
  });
  if (mapping.status !== "connected") {
    throw new Error(mapping.statusDetail || "this local credential is not supported by Terminus");
  }
  if (mapping.baseUrl !== dependencies.expectedDestination) {
    throw new Error("provider destination changed after approval; reload it before connecting");
  }
  const capabilityUri = dependencies.capabilityUri;
  const importLocal = dependencies.importLocal;
  if (importLocal === undefined) {
    throw new Error("local credential import is unavailable");
  }
  const claimed = await dependencies.claimImport(dependencies.account, {
    capabilityUri,
    operationId: uuidV7(),
    credentialFingerprint: dependencies.expectedFingerprint,
    approvedBaseUrl: dependencies.expectedDestination,
    approvedCatalogDigest: dependencies.expectedCatalogDigest,
  });
  if (claimed === null) {
    throw new Error("provider account changed while claiming credential import; reload it before retrying");
  }
  try {
    const result = await importLocal({
      source: credential.source,
      capabilityUri,
      expectedFingerprint: dependencies.expectedFingerprint,
    });
    if (
      !result.stored
      || result.capabilityUri !== capabilityUri
      || result.fingerprint !== dependencies.expectedFingerprint
    ) {
      throw new Error("kernel did not confirm credential storage");
    }
    const committed = await dependencies.finalizeImport(claimed);
    if (committed === null) {
      throw new Error("provider account changed while connecting; reload it before retrying");
    }
    return committed;
  } catch (error: unknown) {
    await dependencies.markImportForCleanup(claimed);
    throw error;
  }
}

/**
 * Ask the kernel what credentials exist on this machine and make each one an
 * account.
 *
 * Runs at startup and on `POST /v1/provider-accounts/discover`. Discovery is
 * metadata-only. A separate explicit-connect operation is the only path that
 * invokes `importLocal`, so opening Settings cannot silently copy a secret.
 *
 * Order matters. A configured gateway is projected before credential discovery
 * so a temporarily unavailable kernel cannot hide it. After discovery, an
 * installed OpenCode with no legacy gateway row gets the anonymous Zen account
 * OpenCode itself exposes by default. The CLI is never launched or imported.
 */
export async function discoverAndConnectLocalAccounts(
  dependencies: ProviderAccountDiscoveryDependencies,
): Promise<ProviderAccountDiscoveryResult> {
  const now = dependencies.now ?? (() => new Date());
  const newAccountId = dependencies.newAccountId ?? (() => uuidV7());
  const newOperationId = dependencies.newOperationId ?? (() => uuidV7());
  const warn = dependencies.warn ?? (() => {});
  const imported: string[] = [];

  const existing = new Map(
    (await dependencies.listAccounts()).map((account) => [account.source, account] as const),
  );

  // 1. The legacy gateway row, as one account.
  const gatewayRow = await dependencies.readGatewayConfiguration();
  if (gatewayRow !== null) {
    const mapping = mapGatewayConfiguration(gatewayRow);
    const current = existing.get(ZEN_SOURCE) ?? null;
    const upserted = await dependencies.upsertAccount({
      id: current?.id ?? newAccountId(),
      ...mappingColumns(mapping, ""),
      credentialUri: zenAccountCredentialUri(gatewayRow),
      fingerprint: current?.fingerprint ?? "",
      credentialFingerprint: "",
      approvedBaseUrl: "",
      approvedCatalogDigest: "",
      secretState: "none",
      secretOperationId: "",
      discoveredAt: current?.discoveredAt ?? now(),
    });
    existing.set(ZEN_SOURCE, upserted);
  }

  const reconcile = async (
    current: ProviderAccountRecord,
    input: ProviderAccountUpsert,
  ): Promise<ProviderAccountRecord> => {
    const updated = await dependencies.reconcileAccount(
      input,
      providerAccountSecuritySnapshot(current),
    );
    if (updated !== null) return updated;
    warn(`provider account ${current.source} changed during discovery; stale reconciliation was discarded`);
    return current;
  };

  const disableUnverifiedAccounts = async (detail: string): Promise<void> => {
    for (const current of [...existing.values()]) {
      if (!current.source.startsWith(OPENCODE_SOURCE_PREFIX)) continue;
      if (current.secretState === "import_pending" || current.secretState === "revoke_pending") continue;
      const disabled = await reconcile(current, existingAccountUpsert(current, {
        status: "error",
        statusDetail: detail,
        metadataJson: canonicalMetadataForAccount(current.source, current.metadataJson),
      }));
      existing.set(current.source, disabled);
    }
  };

  // 2. Everything the kernel can see in the local credential stores.
  let discovery: LocalCredentialDiscovery;
  try {
    discovery = await dependencies.discoverLocal();
  } catch (error: unknown) {
    warn(`local credential discovery failed: ${errorMessage(error)}`);
    await disableUnverifiedAccounts(
      "The OpenCode credential store is unavailable; routing is disabled until it can be verified.",
    );
    return {
      accounts: [...existing.values()].sort(byDisplayName),
      imported,
      warnings: [`local credential discovery failed: ${errorMessage(error)}`],
      codexInstalled: false,
      opencodeInstalled: false,
      opencodeStoreStatus: "unavailable",
      lastRunAt: now().toISOString(),
    };
  }

  if (
    discovery.opencodeStoreStatus === "rejected"
    || discovery.opencodeStoreStatus === "unavailable"
  ) {
    await disableUnverifiedAccounts(discovery.opencodeStoreStatus === "rejected"
      ? "The OpenCode credential store was rejected; routing is disabled until it can be verified."
      : "The OpenCode credential store status is unavailable; routing is disabled until it can be verified.");
    return {
      accounts: [...existing.values()].sort(byDisplayName),
      imported,
      warnings: [...discovery.warnings],
      codexInstalled: discovery.codexInstalled,
      opencodeInstalled: discovery.opencodeInstalled,
      opencodeStoreStatus: discovery.opencodeStoreStatus,
      lastRunAt: now().toISOString(),
    };
  }

  const { catalog, offline, digest: catalogDigest } = await dependencies.fetchCatalog();
  const warnings = [...discovery.warnings];
  const observedSources = new Set(discovery.credentials.map((credential) => credential.source));

  const candidateInput = (
    mapping: ProviderAccountMapping,
    current: ProviderAccountRecord | null,
    fingerprint: string,
    detail?: string,
  ): ProviderAccountUpsert => ({
    id: current?.id ?? newAccountId(),
    ...mappingColumns(mapping, catalogDigest),
    credentialUri: "",
    fingerprint,
    credentialFingerprint: "",
    approvedBaseUrl: "",
    approvedCatalogDigest: "",
    secretState: "none",
    secretOperationId: "",
    status: mapping.status === "connected" ? "disconnected" : mapping.status,
    statusDetail: detail ?? (mapping.status === "connected"
      ? "Credential detected in the local OpenCode store; connect to approve copying it into the Terminus keyring."
      : mapping.statusDetail),
    discoveredAt: current?.discoveredAt ?? now(),
  });

  const revokeThenReplace = async (
    current: ProviderAccountRecord,
    replacement: ProviderAccountUpsert,
  ): Promise<ProviderAccountRecord> => {
    if (current.secretState === "import_pending") {
      return reconcile(current, existingAccountUpsert(current, {
        status: "error",
        statusDetail: "Credential import settlement is pending; routing is disabled until recovery completes.",
      }));
    }
    let claimed = current;
    if (current.credentialUri !== "" && current.secretState !== "revoke_pending") {
      claimed = await reconcile(current, existingAccountUpsert(current, {
        secretState: "revoke_pending",
        secretOperationId: newOperationId(),
        status: "error",
        statusDetail: "Credential cleanup is pending; routing is disabled.",
      }));
      if (claimed.revision === current.revision) return claimed;
    }
    if (claimed.credentialUri !== "") {
      const revoked = await revokeCopiedCredential(dependencies, claimed.credentialUri, warn);
      if (!revoked) return claimed;
    }
    return reconcile(claimed, {
      ...replacement,
      id: claimed.id,
      discoveredAt: claimed.discoveredAt,
    });
  };

  // A fresh Terminus install has no legacy gateway row. Installation discovery
  // is sufficient for the credential-free Zen surface: model discovery still
  // goes through Terminus's kernel connector and admits only catalogued free
  // models. Without this projection, detecting OpenCode changed no runnable
  // state and the desktop incorrectly asked the user to log in.
  if (gatewayRow === null && discovery.opencodeInstalled && !existing.has(ZEN_SOURCE)) {
    const mapping = mapGatewayConfiguration(ANONYMOUS_ZEN_CONFIGURATION);
    const upserted = await dependencies.upsertAccount({
      id: newAccountId(),
      ...mappingColumns(mapping, ""),
      credentialUri: "",
      fingerprint: "",
      credentialFingerprint: "",
      approvedBaseUrl: "",
      approvedCatalogDigest: "",
      secretState: "none",
      secretOperationId: "",
      metadataJson: JSON.stringify({ connection_origin: "installed_opencode" }),
      discoveredAt: now(),
    });
    existing.set(ZEN_SOURCE, upserted);
  }

  for (const credential of discovery.credentials) {
    if (credential.source === ZEN_SOURCE) continue;
    const mapping = mapLocalCredential({
      credential,
      catalog,
      catalogOffline: offline,
      nowMs: now().getTime(),
    });
    const current = existing.get(credential.source) ?? null;
    const candidate = candidateInput(mapping, current, credential.fingerprint, current === null
      ? undefined
      : "Credential or destination changed; connect again to approve the current binding.");
    if (current === null) {
      const created = await dependencies.upsertAccount(candidate);
      existing.set(credential.source, created);
      continue;
    }
    if (current.secretState === "import_pending") {
      existing.set(credential.source, current);
      continue;
    }
    if (current.secretState === "revoke_pending") {
      existing.set(credential.source, await revokeThenReplace(current, candidate));
      continue;
    }
    const bindingMatches = current.secretState === "bound"
      && current.credentialUri !== ""
      && current.credentialFingerprint === credential.fingerprint
      && current.approvedBaseUrl === mapping.baseUrl
      && current.approvedCatalogDigest === catalogDigest;
    if (!bindingMatches) {
      const updated = current.credentialUri === ""
        ? await reconcile(current, candidate)
        : await revokeThenReplace(current, candidate);
      existing.set(credential.source, updated);
      continue;
    }
    if (mapping.status !== "connected") {
      const updated = await revokeThenReplace(current, candidate);
      existing.set(credential.source, updated);
      continue;
    }
    const credentialStatus = await credentialBindingStatus(dependencies, current.credentialUri, warn);
    if (credentialStatus === "missing") {
      const updated = await reconcile(current, candidateInput(
        mapping,
        current,
        credential.fingerprint,
        "Credential is no longer present in the Terminus keyring; connect again to approve import.",
      ));
      existing.set(credential.source, updated);
      continue;
    }
    if (credentialStatus === "unavailable") {
      const updated = await reconcile(current, existingAccountUpsert(current, {
        status: "error",
        statusDetail: "The copied credential could not be verified; routing is disabled until the kernel recovers.",
      }));
      existing.set(credential.source, updated);
      continue;
    }
    const bound = await reconcile(current, {
      ...candidate,
      credentialUri: current.credentialUri,
      credentialFingerprint: current.credentialFingerprint,
      approvedBaseUrl: current.approvedBaseUrl,
      approvedCatalogDigest: current.approvedCatalogDigest,
      secretState: "bound",
      secretOperationId: "",
      status: "connected",
      statusDetail: "",
    });
    const upserted = bound;
    existing.set(credential.source, upserted);
  }

  // A valid empty/missing store is authoritative logout. Revoke Terminus's
  // copied key and keep a disconnected row explaining why it disappeared.
  // A rejected/unavailable store returned earlier and never reaches this path.
  for (const current of [...existing.values()]) {
    if (
      current.source === ZEN_SOURCE
      || !current.source.startsWith(OPENCODE_SOURCE_PREFIX)
      || observedSources.has(current.source)
    ) continue;
    const replacement = existingAccountUpsert(current, {
      credentialUri: "",
      fingerprint: "",
      catalogDigest: "",
      credentialFingerprint: "",
      approvedBaseUrl: "",
      approvedCatalogDigest: "",
      secretState: "none",
      secretOperationId: "",
      metadataJson: "{}",
      status: "disconnected",
      statusDetail: "Credential is no longer present in the OpenCode store; connect again after signing in.",
    });
    const updated = current.credentialUri === ""
      ? await reconcile(current, replacement)
      : await revokeThenReplace(current, replacement);
    existing.set(current.source, updated);
  }

  // 3. Discovery never chooses or changes a default. An explicit connect or
  //    Settings action owns that user decision; the anonymous Zen account is
  //    selected in-memory by `resolveTurnProvider` when no default exists.
  const accounts = await dependencies.listAccounts();
  return {
    accounts: [...accounts].sort(byDisplayName),
    imported: [...new Set(imported)],
    warnings,
    codexInstalled: discovery.codexInstalled,
    opencodeInstalled: discovery.opencodeInstalled,
    opencodeStoreStatus: discovery.opencodeStoreStatus,
    lastRunAt: now().toISOString(),
  };
}

/**
 * Ask the kernel whether `credentialUri` still resolves.
 *
 * `null` means the kernel could not answer. Callers disable routing but retain
 * the URI for a later probe; they neither import nor delete on uncertainty.
 */
async function credentialBindingStatus(
  dependencies: ProviderAccountDiscoveryDependencies,
  credentialUri: string,
  warn: (message: string) => void,
): Promise<"present" | "missing" | "unavailable"> {
  if (dependencies.credentialStatus === undefined) return "unavailable";
  try {
    return await dependencies.credentialStatus(credentialUri);
  } catch (error: unknown) {
    warn(`credential resolution probe failed for ${credentialUri}: ${errorMessage(error)}`);
    return "unavailable";
  }
}

async function revokeCopiedCredential(
  dependencies: ProviderAccountDiscoveryDependencies,
  credentialUri: string,
  warn: (message: string) => void,
): Promise<boolean> {
  if (dependencies.revokeCredential === undefined) return false;
  try {
    return await dependencies.revokeCredential(credentialUri);
  } catch (error: unknown) {
    warn(`credential revocation failed for ${credentialUri}: ${errorMessage(error)}`);
    return false;
  }
}

/**
 * The first connected account that is not the shared free gateway, else the
 * gateway. Sorted by source so the choice is reproducible.
 */
export function chooseDefaultAccount(
  accounts: readonly ProviderAccountRecord[],
): ProviderAccountRecord | null {
  const connected = accounts
    .filter((account) => account.status === "connected" && providerAccountHasApprovedBinding(account))
    .sort((left, right) => left.source.localeCompare(right.source));
  return connected.find((account) => account.source !== ZEN_SOURCE)
    ?? connected.find((account) => account.source === ZEN_SOURCE)
    ?? null;
}

function mappingColumns(
  mapping: ProviderAccountMapping,
  catalogDigest: string,
): Omit<
  ProviderAccountUpsert,
  | "id"
  | "credentialUri"
  | "fingerprint"
  | "credentialFingerprint"
  | "approvedBaseUrl"
  | "approvedCatalogDigest"
  | "secretState"
  | "secretOperationId"
  | "discoveredAt"
> {
  return {
    source: mapping.source,
    displayName: mapping.displayName,
    vendorId: mapping.vendorId,
    authKind: mapping.authKind,
    baseUrl: mapping.baseUrl,
    catalogDigest,
    host: mapping.host,
    protocol: mapping.protocol,
    connectorId: mapping.connectorId,
    renderProfile: mapping.renderProfile,
    status: mapping.status,
    statusDetail: mapping.statusDetail,
    billing: mapping.billing,
    metadataJson: mapping.metadataJson,
    expiresAt: mapping.expiresAt,
  };
}

function existingAccountUpsert(
  account: ProviderAccountRecord,
  changes: Partial<Pick<
    ProviderAccountUpsert,
    | "credentialUri"
    | "fingerprint"
    | "baseUrl"
    | "catalogDigest"
    | "credentialFingerprint"
    | "approvedBaseUrl"
    | "approvedCatalogDigest"
    | "secretState"
    | "secretOperationId"
    | "status"
    | "statusDetail"
    | "metadataJson"
  >>,
): ProviderAccountUpsert {
  return {
    id: account.id,
    source: account.source,
    displayName: account.displayName,
    vendorId: account.vendorId,
    authKind: account.authKind,
    credentialUri: changes.credentialUri ?? account.credentialUri,
    fingerprint: changes.fingerprint ?? account.fingerprint,
    baseUrl: changes.baseUrl ?? account.baseUrl,
    catalogDigest: changes.catalogDigest ?? account.catalogDigest,
    credentialFingerprint: changes.credentialFingerprint ?? account.credentialFingerprint,
    approvedBaseUrl: changes.approvedBaseUrl ?? account.approvedBaseUrl,
    approvedCatalogDigest: changes.approvedCatalogDigest ?? account.approvedCatalogDigest,
    secretState: changes.secretState ?? admittedSecretState(account.secretState),
    secretOperationId: changes.secretOperationId ?? account.secretOperationId,
    host: account.host,
    protocol: account.protocol,
    connectorId: account.connectorId,
    renderProfile: account.renderProfile,
    status: changes.status ?? account.status,
    statusDetail: changes.statusDetail ?? account.statusDetail,
    billing: account.billing,
    metadataJson: changes.metadataJson ?? account.metadataJson,
    discoveredAt: account.discoveredAt,
    expiresAt: account.expiresAt,
  };
}

export function providerAccountSecuritySnapshot(
  account: ProviderAccountRecord,
): ProviderAccountSecuritySnapshot {
  return {
    id: account.id,
    revision: account.revision,
    fingerprint: account.fingerprint,
    credentialUri: account.credentialUri,
    secretState: admittedSecretState(account.secretState),
    secretOperationId: account.secretOperationId,
  };
}

function admittedSecretState(value: string): ProviderAccountSecretState {
  return value === "import_pending" || value === "bound" || value === "revoke_pending"
    ? value
    : "none";
}

function byDisplayName(left: ProviderAccountRecord, right: ProviderAccountRecord): number {
  return left.displayName.localeCompare(right.displayName) || left.source.localeCompare(right.source);
}

// ────────────────────────── Turn selection ───────────────────────────────────

export type TurnProviderResolution =
  | { readonly kind: "account"; readonly account: ProviderAccountRecord; readonly explicit: boolean }
  | { readonly kind: "legacy" }
  | { readonly kind: "error"; readonly code: "PROVIDER_ACCOUNT_NOT_FOUND"; readonly accountId: string }
  | {
      readonly kind: "error";
      readonly code: "PROVIDER_ACCOUNT_UNAVAILABLE";
      readonly accountId: string;
      readonly status: string;
      readonly statusDetail: string;
    };

export interface ResolveTurnProviderInput {
  /** `provider_account_id` on `POST /v1/turns`. */
  readonly requestedAccountId?: string | null | undefined;
  /** `default_provider_account_id` on the session. */
  readonly sessionDefaultAccountId?: string | null | undefined;
  readonly accounts: readonly ProviderAccountRecord[];
  /** Whether the turn names a model at all. */
  readonly hasModel?: boolean | undefined;
}

/**
 * Which account this turn runs on.
 *
 * Order: the turn's own account, the session default, the installation
 * default, then the legacy direct/gateway/local chain. An account named
 * explicitly and then found missing or unusable is an error — silently
 * running the user's prompt against a *different* provider than the one they
 * picked is the one outcome that must never happen.
 *
 * The installation default is weaker on purpose: it applies only when the turn
 * also names a model. A turn that names neither is exactly the pre-accounts
 * turn and keeps its pre-accounts behaviour.
 */
export function resolveTurnProvider(input: ResolveTurnProviderInput): TurnProviderResolution {
  const byId = new Map(input.accounts.map((account) => [account.id, account] as const));
  for (const requested of [input.requestedAccountId, input.sessionDefaultAccountId]) {
    if (requested === undefined || requested === null || requested === "") continue;
    const account = byId.get(requested);
    if (account === undefined) {
      return { kind: "error", code: "PROVIDER_ACCOUNT_NOT_FOUND", accountId: requested };
    }
    if (
      account.status !== "connected"
      || !providerAccountHasApprovedBinding(account)
      || account.renderProfile === "chatgpt_codex"
      || account.source === CODEX_SOURCE
    ) {
      return {
        kind: "error",
        code: "PROVIDER_ACCOUNT_UNAVAILABLE",
        accountId: requested,
        status: account.status,
        statusDetail: account.statusDetail || "This Codex subscription requires the separate Codex App Server lane.",
      };
    }
    return { kind: "account", account, explicit: true };
  }
  const installationDefault = input.accounts.find((account) => account.isDefault)
    ?? input.accounts.find((account) => account.source === ZEN_SOURCE && account.authKind === "anonymous")
    ?? null;
  if (
    installationDefault !== null
    && installationDefault.status === "connected"
    && providerAccountHasApprovedBinding(installationDefault)
    && installationDefault.renderProfile !== "chatgpt_codex"
    && installationDefault.source !== CODEX_SOURCE
    && input.hasModel === true
  ) {
    return { kind: "account", account: installationDefault, explicit: false };
  }
  return { kind: "legacy" };
}

// ────────────────────────── Helpers ──────────────────────────────────────────

function canonicalMetadata(metadata: ProviderAccountMetadata): string {
  const ordered: Record<string, unknown> = {};
  if (metadata.account_id !== undefined) ordered.account_id = metadata.account_id;
  return JSON.stringify(ordered);
}

/** Drop every legacy/provider extension field that Terminus does not own. */
export function canonicalMetadataForAccount(source: string, metadataJson: string): string {
  const metadata = parseProviderAccountMetadata(metadataJson);
  if (source === "opencode:cloudflare-workers-ai" && metadata.account_id !== undefined) {
    return canonicalMetadata({ account_id: metadata.account_id });
  }
  if (source === ZEN_SOURCE && metadata.connection_origin === "installed_opencode") {
    return JSON.stringify({ connection_origin: "installed_opencode" });
  }
  return "{}";
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return value.slice(0, end);
}

function positiveInteger(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function nonNegativeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

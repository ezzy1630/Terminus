export type GatewayDeployment = "zen" | "go";

export type GatewayProtocol = "chat_completions" | "responses" | "messages";

export interface AvailableModel {
  readonly id: string;
  readonly ownedBy: string;
}
interface CatalogModel {
  readonly id: string;
  readonly name: string;
  readonly protocolPackage: string;
  readonly toolCalling: boolean;
  readonly structuredOutput: boolean;
  readonly imageInput: boolean;
  readonly reasoning: boolean;
  readonly contextTokens: number;
  readonly outputTokens: number;
  readonly inputCost: number;
  readonly cachedInputCost: number;
  readonly outputCost: number;
  readonly status: string | null;
}

interface CatalogProvider {
  readonly id: string;
  readonly api: string;
  readonly defaultProtocolPackage: string;
  readonly models: ReadonlyMap<string, CatalogModel>;
}

export interface ModelsDevCatalog {
  readonly providers: ReadonlyMap<string, CatalogProvider>;
}

/** The two gateway deployments Terminus ships a first-party binding for. */
export type ZenProviderId = "open_code_zen" | "open_code_go";

export interface GatewayModel {
  readonly id: string;
  readonly name: string;
  readonly deployment: GatewayDeployment;
  /**
   * Owning provider. Zen/Go discovery only ever produces `ZenProviderId`, but
   * the renderer and transport in this package are also reused by connected
   * provider accounts, whose owner is the account id. Callers that need the
   * gateway identity compare against `ZenProviderId` explicitly.
   */
  readonly providerId: string;
  readonly baseUrl: string;
  readonly protocol: GatewayProtocol;
  readonly free: boolean;
  readonly toolCalling: boolean;
  readonly structuredOutput: boolean;
  readonly imageInput: boolean;
  readonly reasoning: boolean;
  readonly contextTokens: number;
  readonly outputTokens: number;
  readonly inputMicrosPerMillion: number;
  readonly cachedInputMicrosPerMillion: number;
  readonly outputMicrosPerMillion: number;
  readonly observedAt: string;
}

export interface RejectedGatewayModel {
  readonly modelId: string;
  readonly reason: string;
}

export interface GatewayDiscoveryResult {
  readonly models: readonly GatewayModel[];
  readonly rejected: readonly RejectedGatewayModel[];
}

const PROVIDER_KEYS: Readonly<Record<GatewayDeployment, string>> = {
  zen: "opencode",
  go: "opencode-go",
};

const PROVIDER_IDS: Readonly<Record<GatewayDeployment, ZenProviderId>> = {
  zen: "open_code_zen",
  go: "open_code_go",
};

const EXPECTED_BASE_URLS: Readonly<Record<GatewayDeployment, string>> = {
  zen: "https://opencode.ai/zen/v1",
  go: "https://opencode.ai/zen/go/v1",
};

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return value.slice(0, end);
}

export function parseAvailableModels(input: unknown): readonly AvailableModel[] {
  const root = record(input, "gateway model list");
  if (root.object !== "list" || !Array.isArray(root.data)) {
    throw new Error("gateway model list must be an object=list response with a data array");
  }
  const seen = new Set<string>();
  return root.data.map((value, index) => {
    const item = record(value, `gateway model list data[${index}]`);
    const id = nonEmptyString(item.id, `gateway model list data[${index}].id`);
    if (seen.has(id)) throw new Error(`gateway model list contains duplicate model ${id}`);
    seen.add(id);
    return {
      id,
      ownedBy: typeof item.owned_by === "string" ? item.owned_by : "unknown",
    };
  });
}

export function parseModelsDevCatalog(input: unknown): ModelsDevCatalog {
  const root = record(input, "Models.dev catalog");
  const providers = new Map<string, CatalogProvider>();
  for (const providerKey of Object.values(PROVIDER_KEYS)) {
    const rawProvider = root[providerKey];
    if (rawProvider === undefined) continue;
    const provider = record(rawProvider, `Models.dev provider ${providerKey}`);
    const api = trimTrailingSlashes(
      nonEmptyString(provider.api, `Models.dev provider ${providerKey}.api`),
    );
    const deployment = providerKey === "opencode" ? "zen" : "go";
    if (api !== EXPECTED_BASE_URLS[deployment]) {
      throw new Error(`Models.dev provider ${providerKey} has untrusted API base URL ${api}`);
    }
    const defaultProtocolPackage = nonEmptyString(
      provider.npm,
      `Models.dev provider ${providerKey}.npm`,
    );
    const rawModels = record(provider.models, `Models.dev provider ${providerKey}.models`);
    const models = new Map<string, CatalogModel>();
    for (const [modelKey, rawModel] of Object.entries(rawModels)) {
      const model = record(rawModel, `Models.dev model ${providerKey}/${modelKey}`);
      const id = nonEmptyString(model.id, `Models.dev model ${providerKey}/${modelKey}.id`);
      if (id !== modelKey) {
        throw new Error(`Models.dev model key ${modelKey} does not match id ${id}`);
      }
      const providerOverride = optionalRecord(model.provider, `Models.dev model ${providerKey}/${modelKey}.provider`);
      const cost = optionalRecord(model.cost, `Models.dev model ${providerKey}/${modelKey}.cost`);
      const limit = optionalRecord(model.limit, `Models.dev model ${providerKey}/${modelKey}.limit`);
      const modalities = optionalRecord(model.modalities, `Models.dev model ${providerKey}/${modelKey}.modalities`);
      const inputModalities = Array.isArray(modalities.input) ? modalities.input : [];
      models.set(id, {
        id,
        name: typeof model.name === "string" && model.name.trim() !== "" ? model.name : id,
        protocolPackage:
          typeof providerOverride.npm === "string" && providerOverride.npm.trim() !== ""
            ? providerOverride.npm
            : defaultProtocolPackage,
        toolCalling: model.tool_call === true,
        structuredOutput: model.structured_output === true,
        imageInput: inputModalities.includes("image"),
        reasoning: model.reasoning === true,
        contextTokens: positiveIntegerOrZero(limit.context),
        outputTokens: positiveIntegerOrZero(limit.output),
        inputCost: nonNegativeNumberOrZero(cost.input),
        cachedInputCost: nonNegativeNumberOrZero(cost.cache_read),
        outputCost: nonNegativeNumberOrZero(cost.output),
        status: typeof model.status === "string" && model.status.trim() !== ""
          ? model.status.trim().toLowerCase()
          : null,
      });
    }
    providers.set(providerKey, {
      id: typeof provider.id === "string" ? provider.id : providerKey,
      api,
      defaultProtocolPackage,
      models,
    });
  }
  if (providers.size === 0) {
    throw new Error("Models.dev catalog contains neither opencode nor opencode-go");
  }
  return { providers };
}

export function discoverGatewayModels(input: {
  readonly deployment: GatewayDeployment;
  readonly available: readonly AvailableModel[];
  readonly catalog: ModelsDevCatalog;
  readonly observedAt: string;
}): GatewayDiscoveryResult {
  assertRfc3339(input.observedAt);
  const providerKey = PROVIDER_KEYS[input.deployment];
  const provider = input.catalog.providers.get(providerKey);
  if (provider === undefined) {
    throw new Error(`Models.dev catalog does not contain provider ${providerKey}`);
  }
  const models: GatewayModel[] = [];
  const rejected: RejectedGatewayModel[] = [];
  for (const available of input.available) {
    const catalogModel = provider.models.get(available.id);
    if (catalogModel === undefined) {
      rejected.push({
        modelId: available.id,
        reason: `model is absent from the decoded ${providerKey} catalog`,
      });
      continue;
    }
    if (catalogModel.status === "deprecated") {
      rejected.push({
        modelId: available.id,
        reason: `model is deprecated in the decoded ${providerKey} catalog`,
      });
      continue;
    }
    const protocol = protocolForPackage(catalogModel.protocolPackage);
    if (protocol === null) {
      rejected.push({
        modelId: available.id,
        reason: `unsupported protocol package ${catalogModel.protocolPackage}`,
      });
      continue;
    }
    models.push({
      id: catalogModel.id,
      name: catalogModel.name,
      deployment: input.deployment,
      providerId: PROVIDER_IDS[input.deployment],
      baseUrl: provider.api,
      protocol,
      free: catalogModel.inputCost === 0 && catalogModel.outputCost === 0,
      toolCalling: catalogModel.toolCalling,
      structuredOutput: catalogModel.structuredOutput,
      imageInput: catalogModel.imageInput,
      reasoning: catalogModel.reasoning,
      contextTokens: catalogModel.contextTokens,
      outputTokens: catalogModel.outputTokens,
      inputMicrosPerMillion: dollarsToMicros(catalogModel.inputCost),
      cachedInputMicrosPerMillion: dollarsToMicros(catalogModel.cachedInputCost),
      outputMicrosPerMillion: dollarsToMicros(catalogModel.outputCost),
      observedAt: input.observedAt,
    });
  }
  return {
    models: models.sort((left, right) => left.id.localeCompare(right.id)),
    rejected: rejected.sort((left, right) => left.modelId.localeCompare(right.modelId)),
  };
}

/**
 * The wire protocol an OpenCode/models.dev SDK package implies.
 *
 * Fails closed: an SDK Terminus has no transport for returns null rather than
 * being guessed into the nearest protocol. Exported because connected provider
 * accounts resolve their protocol from the same models.dev `npm` field.
 */
export function protocolForPackage(packageName: string): GatewayProtocol | null {
  switch (packageName) {
    case "@ai-sdk/openai-compatible":
      return "chat_completions";
    case "@ai-sdk/openai":
      return "responses";
    case "@ai-sdk/anthropic":
      return "messages";
    default:
      return null;
  }
}

function record(value: unknown, name: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function optionalRecord(value: unknown, name: string): Readonly<Record<string, unknown>> {
  return value === undefined ? {} : record(value, name);
}

function nonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} must be a non-empty string`);
  return value;
}

function positiveIntegerOrZero(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function nonNegativeNumberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function dollarsToMicros(value: number): number {
  return Math.round(value * 1_000_000);
}

function assertRfc3339(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)) {
    throw new Error("observedAt must be an RFC3339 UTC timestamp");
  }
}

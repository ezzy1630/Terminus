/**
 * @terminus/provider-core — Models.dev universal catalog parser & offline snapshot loader.
 *
 * Per SPEC §15 and §26: Provides fail-closed catalog decoding and access to the
 * committed offline catalog snapshot so discovery works 100% offline and in air-gapped CI.
 */
import { computeContentHash, canonicalJson } from "@terminus/context-ir";
import snapshotJson from "./models_dev_snapshot.json" with { type: "json" };

export interface UniversalCatalogModel {
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
}

export interface UniversalCatalogProvider {
  readonly id: string;
  readonly name: string;
  readonly api: string;
  readonly defaultProtocolPackage: string;
  readonly models: ReadonlyMap<string, UniversalCatalogModel>;
}

export interface UniversalModelsDevCatalog {
  readonly providers: ReadonlyMap<string, UniversalCatalogProvider>;
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return value.slice(0, end);
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
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function positiveIntegerOrZero(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function nonNegativeNumberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * Parses an arbitrary Models.dev catalog JSON root object in a fail-closed manner.
 */
export function parseModelsDevCatalogUniversal(input: unknown): UniversalModelsDevCatalog {
  const root = record(input, "Models.dev catalog");
  const providers = new Map<string, UniversalCatalogProvider>();

  for (const [providerKey, rawProvider] of Object.entries(root)) {
    if (typeof rawProvider !== "object" || rawProvider === null || Array.isArray(rawProvider)) {
      continue;
    }
    const providerObj = record(rawProvider, `Models.dev provider ${providerKey}`);
    const providerId = typeof providerObj.id === "string" && providerObj.id.trim() !== ""
      ? providerObj.id.trim()
      : providerKey;
    const providerName = typeof providerObj.name === "string" && providerObj.name.trim() !== ""
      ? providerObj.name.trim()
      : providerId;
    const api = trimTrailingSlashes(
      nonEmptyString(providerObj.api, `Models.dev provider ${providerKey}.api`),
    );
    const defaultProtocolPackage = nonEmptyString(
      providerObj.npm,
      `Models.dev provider ${providerKey}.npm`,
    );
    const rawModels = record(providerObj.models, `Models.dev provider ${providerKey}.models`);
    const models = new Map<string, UniversalCatalogModel>();

    for (const [modelKey, rawModel] of Object.entries(rawModels)) {
      const model = record(rawModel, `Models.dev model ${providerKey}/${modelKey}`);
      const id = nonEmptyString(model.id, `Models.dev model ${providerKey}/${modelKey}.id`);
      if (id !== modelKey) {
        throw new Error(`Models.dev model key '${modelKey}' does not match model id '${id}'`);
      }
      const providerOverride = optionalRecord(model.provider, `Models.dev model ${providerKey}/${modelKey}.provider`);
      const cost = optionalRecord(model.cost, `Models.dev model ${providerKey}/${modelKey}.cost`);
      const limit = optionalRecord(model.limit, `Models.dev model ${providerKey}/${modelKey}.limit`);
      const modalities = optionalRecord(model.modalities, `Models.dev model ${providerKey}/${modelKey}.modalities`);
      const inputModalities = Array.isArray(modalities.input) ? modalities.input : [];

      models.set(id, {
        id,
        name: typeof model.name === "string" && model.name.trim() !== "" ? model.name.trim() : id,
        protocolPackage:
          typeof providerOverride.npm === "string" && providerOverride.npm.trim() !== ""
            ? providerOverride.npm.trim()
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
      });
    }

    providers.set(providerKey, {
      id: providerId,
      name: providerName,
      api,
      defaultProtocolPackage,
      models,
    });
  }

  if (providers.size === 0) {
    throw new Error("Models.dev catalog contains no valid providers");
  }

  return { providers };
}

let parsedOfflineSnapshot: UniversalModelsDevCatalog | null = null;
let snapshotDigest: string | null = null;

/**
 * Returns the committed offline Models.dev catalog snapshot.
 */
export function loadOfflineCatalogSnapshot(): UniversalModelsDevCatalog {
  if (parsedOfflineSnapshot === null) {
    parsedOfflineSnapshot = parseModelsDevCatalogUniversal(snapshotJson);
  }
  return parsedOfflineSnapshot;
}

/**
 * Returns the raw committed snapshot JSON object.
 */
export function getOfflineCatalogSnapshotJson(): Readonly<Record<string, unknown>> {
  return snapshotJson as Readonly<Record<string, unknown>>;
}

/**
 * Returns the SHA-256 hex digest of the committed catalog snapshot.
 */
export function getOfflineCatalogSnapshotDigest(): string {
  if (snapshotDigest === null) {
    snapshotDigest = computeContentHash(canonicalJson(snapshotJson));
  }
  return snapshotDigest;
}


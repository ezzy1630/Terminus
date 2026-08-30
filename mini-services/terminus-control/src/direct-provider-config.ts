/**
 * Direct Anthropic/OpenAI provider configuration (ADR-0039 §10, audit P0-2).
 *
 * Precedence in the agent loop: direct (BYO-key via secret broker) >
 * OpenCode gateway > local NDJSON command. The configuration never carries
 * key material — only an opaque kernel secret capability URI. Model
 * capabilities and economics come from the offline Models.dev catalog
 * snapshot and unknown models fail closed.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Micros, ModelKey, Rfc3339Timestamp } from "@terminus/domain";
import {
  loadOfflineCatalogSnapshot,
  resolveModelFamily,
  resolveMaxOutputTokens,
  resolveTestedSafeContextTokens,
  type ProviderCapabilitySnapshot,
} from "@terminus/provider-core";

export const DIRECT_PROVIDER_CONFIGURATION_ENV = "TERMINUS_DIRECT_PROVIDER_JSON";

export const DIRECT_PROVIDER_VENDORS = ["anthropic", "openai"] as const;
export type DirectProviderVendor = (typeof DIRECT_PROVIDER_VENDORS)[number];

export const DIRECT_PROVIDER_PROTOCOLS = {
  anthropic: ["messages"],
  openai: ["responses", "chat_completions"],
} as const satisfies Record<DirectProviderVendor, readonly string[]>;

export type DirectProviderProtocol = "messages" | "responses" | "chat_completions";

export interface DirectModelRecord {
  readonly id: string;
  readonly vendor: DirectProviderVendor;
  readonly protocol: DirectProviderProtocol;
  readonly displayName: string;
  readonly contextTokens: number;
  readonly outputTokens: number;
  readonly inputMicrosPerMillion: number;
  readonly cachedInputMicrosPerMillion: number;
  readonly outputMicrosPerMillion: number;
  readonly toolCalling: boolean;
  readonly structuredOutput: boolean;
  readonly imageInput: boolean;
  readonly reasoning: boolean;
}

const envConfigurationSchema = z.object({
  vendor: z.enum(DIRECT_PROVIDER_VENDORS),
  protocol: z.enum(["messages", "responses", "chat_completions"]),
  model: z.string().trim().min(1).max(255).refine(
    (value) => !/[\0\r\n]/.test(value),
    "model contains a control delimiter",
  ),
  workspace_access: z.boolean().default(false),
}).strict();

export interface DirectProviderConfiguration {
  readonly vendor: DirectProviderVendor;
  readonly protocol: DirectProviderProtocol;
  readonly model: string;
  readonly workspaceAccess: boolean;
  readonly secretUri: `secret://direct/${DirectProviderVendor}`;
}

export function directSecretUri(vendor: DirectProviderVendor): `secret://direct/${DirectProviderVendor}` {
  return `secret://direct/${vendor}`;
}

/**
 * Parse and admit the direct-provider configuration from its environment
 * JSON. Fails closed on unknown vendors/protocols/models or a credential URI
 * that does not match the vendor's documented binding.
 */
export function parseDirectProviderConfiguration(raw: string | undefined | null): DirectProviderConfiguration | null {
  if (raw === undefined || raw === null || raw.trim() === "") return null;
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${DIRECT_PROVIDER_CONFIGURATION_ENV} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = envConfigurationSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new Error(`${DIRECT_PROVIDER_CONFIGURATION_ENV} is invalid: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
  }
  const { vendor, model, protocol, workspace_access: workspaceAccess } = parsed.data;
  if (!(DIRECT_PROVIDER_PROTOCOLS[vendor] as readonly string[]).includes(protocol)) {
    throw new Error(`${DIRECT_PROVIDER_CONFIGURATION_ENV}: vendor '${vendor}' does not support protocol '${protocol}'`);
  }
  const admitted = admitDirectModelRecord(vendor, protocol, model);
  if (admitted === null) {
    throw new Error(`${DIRECT_PROVIDER_CONFIGURATION_ENV}: model '${model}' has no record in the offline catalog for vendor '${vendor}'`);
  }
  return { vendor, protocol, model, workspaceAccess, secretUri: directSecretUri(vendor) };
}

/** Look up one vendor/model pair in the offline catalog snapshot; null when absent. */
export function admitDirectModelRecord(
  vendor: DirectProviderVendor,
  protocol: DirectProviderProtocol,
  modelId: string,
): DirectModelRecord | null {
  const catalog = loadOfflineCatalogSnapshot();
  const provider = catalog.providers.get(vendor);
  const model = provider?.models.get(modelId);
  if (provider === undefined || model === undefined) return null;
  return {
    id: model.id,
    vendor,
    protocol,
    displayName: model.name,
    contextTokens: model.contextTokens,
    outputTokens: model.outputTokens,
    inputMicrosPerMillion: dollarsToMicros(model.inputCost),
    cachedInputMicrosPerMillion: dollarsToMicros(model.cachedInputCost),
    outputMicrosPerMillion: dollarsToMicros(model.outputCost),
    toolCalling: model.toolCalling,
    structuredOutput: model.structuredOutput,
    imageInput: model.imageInput,
    reasoning: model.reasoning,
  };
}

function dollarsToMicros(dollars: number): number {
  return Math.round(dollars * 1_000_000);
}

/**
 * Capability snapshot for a configured direct model. Mirrors the gateway
 * snapshot shape so downstream budget/policy logic needs no special cases.
 * Workspace confidentiality requires the operator to explicitly enable it in
 * the configuration (direct APIs are treated as public-only by default).
 */
export function configuredDirectProviderSnapshot(
  configuration: DirectProviderConfiguration,
  observedAt: Rfc3339Timestamp,
): ProviderCapabilitySnapshot {
  const model = admitDirectModelRecord(configuration.vendor, configuration.protocol, configuration.model);
  if (model === null) throw new Error(`direct model ${configuration.model} has no offline catalog record`);
  const digest = createHash("sha256")
    .update(JSON.stringify({ vendor: model.vendor, protocol: model.protocol, model: model.id }), "utf8")
    .digest("hex");
  const explicitOpenAiCaching = model.vendor === "openai"
    && model.protocol === "responses"
    && resolveModelFamily(model.id) === "gpt-5.6";
  const caching = model.vendor === "anthropic"
    ? { mode: "explicit_breakpoints" as const, exactPrefixRequired: true, minimumTokens: 2_048, ttlOptions: [], toolOrderSensitive: true, usageReporting: true }
    : explicitOpenAiCaching
      ? { mode: "explicit_breakpoints" as const, exactPrefixRequired: true, minimumTokens: 1_024, ttlOptions: ["30m"], toolOrderSensitive: true, usageReporting: true }
      : { mode: "automatic_prefix" as const, exactPrefixRequired: false, minimumTokens: 0, ttlOptions: [], toolOrderSensitive: false, usageReporting: true };
  return {
    providerId: directProviderId(model.vendor),
    observedAt,
    source: `terminus-control/direct-provider-config-v1:${digest}`,
    context: {
      advertisedTokens: model.contextTokens,
      // Per-family, not a blanket 32,768: GPT-5.6 is capped at the 272K
      // billing cliff and Claude 5 gets its whole 1M window.
      testedSafeTokens: resolveTestedSafeContextTokens({
        modelId: model.id,
        contextTokens: model.contextTokens,
      }),
      maxOutputTokens: resolveMaxOutputTokens({
        modelId: model.id,
        outputTokens: model.outputTokens,
      }),
      roleSupport: model.vendor === "anthropic"
        ? ["system", "user", "assistant", "tool"]
        : ["system", "user", "assistant", "tool", "developer"],
      imageInput: model.imageInput,
      toolCalling: model.toolCalling,
      parallelToolCalls: model.vendor === "openai" || model.vendor === "anthropic",
      structuredOutput: model.structuredOutput,
    },
    continuation: {
      // Responses requests are rendered with `store: false`, so the endpoint
      // keeps nothing to continue from: the client replays the prefix and the
      // encrypted reasoning items instead of naming a previous response.
      nativeId: false,
      crossRequest: false,
      compaction: true,
      compatibilityKey: `direct-${model.vendor}-${model.protocol}-${model.id}`,
    },
    caching,
    reasoning: { supported: model.reasoning, budgetControl: model.vendor === "anthropic", summaryAvailable: false },
    economics: {
      inputMicrosPerMillion: BigInt(model.inputMicrosPerMillion) as Micros,
      cachedInputMicrosPerMillion: BigInt(model.cachedInputMicrosPerMillion) as Micros,
      ...(explicitOpenAiCaching
        ? { cacheWriteMicrosPerMillion: BigInt(Math.round(model.inputMicrosPerMillion * 1.25)) as Micros }
        : {}),
      outputMicrosPerMillion: BigInt(model.outputMicrosPerMillion) as Micros,
      reasoningAccounting: model.reasoning,
    },
    reliability: { toolCallSuccess: 0, structuredOutputSuccess: 0, editCohortSuccess: 0, latencyPercentiles: { p50: 0, p99: 0 } },
    policy: {
      allowedConfidentiality: configuration.workspaceAccess ? ["public", "workspace"] : ["public"],
      retentionMode: "provider_managed",
      region: null,
    },
  };
}

export function directProviderId(vendor: DirectProviderVendor): string {
  return vendor === "anthropic" ? "anthropic" : "openai";
}

export function directModelKey(configuration: DirectProviderConfiguration): ModelKey {
  return configuration.model as ModelKey;
}

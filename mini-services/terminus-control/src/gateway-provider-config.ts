import { createHash } from "node:crypto";
import { z } from "zod";
import type { Micros, ModelKey, Rfc3339Timestamp } from "@terminus/domain";
import type { ProviderCapabilitySnapshot } from "@terminus/provider-core";
import type { GatewayDeployment, GatewayModel, GatewayProtocol } from "@terminus/provider-zen";

export const GATEWAY_PROVIDER_CONFIGURATION_ID = "default";

const configurationSchema = z.object({
  deployment: z.enum(["zen", "go"]),
  protocol: z.enum(["chat_completions", "responses", "messages"]),
  model: z.string().trim().min(1).max(255).refine((value) => !/[\0\r\n]/.test(value), "model contains a control delimiter"),
  tools_enabled: z.boolean(),
  free_model: z.boolean(),
  workspace_access: z.boolean(),
}).strict();

export const gatewayProviderConfigurationUpdateSchema = configurationSchema.extend({
  credential: z.string().min(1).max(16 * 1_024).optional(),
  expected_revision: z.number().int().nonnegative(),
});

export type GatewayProviderConfigurationInput = z.infer<typeof configurationSchema>;
export type GatewayProviderConfigurationUpdate = z.infer<typeof gatewayProviderConfigurationUpdateSchema>;
export const gatewayProviderConfigurationDeleteSchema = z.object({
  expected_revision: z.number().int().positive(),
}).strict();

export interface GatewayProviderConfigurationWire extends GatewayProviderConfigurationInput {
  readonly configured: true;
  readonly credential_configured: boolean;
  readonly revision: number;
  readonly updated_by: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface GatewayProviderConfigurationResponse {
  readonly configured: boolean;
  readonly configuration: GatewayProviderConfigurationWire | null;
}

interface GatewayProviderRow {
  readonly deployment: string;
  readonly protocol: string;
  readonly model: string;
  readonly secretUri: string;
  readonly credentialConfigured: boolean;
  readonly toolsEnabled: boolean;
  readonly freeModel: boolean;
  readonly workspaceAccess: boolean;
  readonly revision: number;
  readonly updatedBy: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export function parseGatewayProviderConfigurationUpdate(raw: unknown): GatewayProviderConfigurationUpdate {
  const parsed = gatewayProviderConfigurationUpdateSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`gateway provider configuration is invalid: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
  }
  if (parsed.data.credential !== undefined && /\s/.test(parsed.data.credential)) {
    throw new Error("gateway credential must not contain whitespace");
  }
  return parsed.data;
}

export function gatewaySecretUri(deployment: GatewayDeployment): `secret://opencode/${GatewayDeployment}` {
  return `secret://opencode/${deployment}`;
}

export function gatewayProviderConfigurationWire(
  row: GatewayProviderRow | null,
): GatewayProviderConfigurationResponse {
  if (row === null) return { configured: false, configuration: null };
  const parsed = configurationSchema.parse({
    deployment: row.deployment,
    protocol: row.protocol,
    model: row.model,
    tools_enabled: row.toolsEnabled,
    free_model: row.freeModel,
    workspace_access: row.workspaceAccess,
  });
  if (row.secretUri !== gatewaySecretUri(parsed.deployment)) {
    throw new Error("persisted gateway credential URI does not match deployment");
  }
  return {
    configured: true,
    configuration: {
      configured: true,
      ...parsed,
      credential_configured: row.credentialConfigured,
      revision: row.revision,
      updated_by: row.updatedBy,
      created_at: row.createdAt.toISOString(),
      updated_at: row.updatedAt.toISOString(),
    },
  };
}

/**
 * Build the gateway model the turn will run against.
 *
 * `discovered` is the record from provider discovery for this exact model id,
 * when one has been seen. The stored configuration holds only deployment,
 * protocol, model id, and two operator switches, so without a discovered
 * record this function can do nothing but assert conservative placeholders —
 * no reasoning, a 32k window, zero cost. Those placeholders reach the context
 * compiler and the economics ledger, so a real record is always preferred.
 *
 * The configuration still wins on the fields it owns: protocol is how Terminus
 * was told to talk to the gateway, and tools/free are operator decisions that
 * must not be silently overridden by a catalogue.
 */
export function configuredGatewayModel(
  row: GatewayProviderRow,
  observedAt: Rfc3339Timestamp,
  discovered?: GatewayModel | null,
): GatewayModel {
  const wire = gatewayProviderConfigurationWire(row).configuration;
  if (wire === null || !wire.credential_configured) {
    throw new Error("gateway provider credential is not configured");
  }
  if (discovered != null && discovered.id === wire.model) {
    return {
      ...discovered,
      protocol: wire.protocol,
      toolCalling: wire.tools_enabled && discovered.toolCalling,
      free: wire.free_model,
      observedAt,
    };
  }
  return {
    id: wire.model,
    name: wire.model,
    deployment: wire.deployment,
    providerId: wire.deployment === "zen" ? "open_code_zen" : "open_code_go",
    baseUrl: wire.deployment === "zen" ? "https://opencode.ai/zen/v1" : "https://opencode.ai/zen/go/v1",
    protocol: wire.protocol,
    free: wire.free_model,
    toolCalling: wire.tools_enabled,
    structuredOutput: true,
    imageInput: false,
    reasoning: false,
    contextTokens: 32_768,
    outputTokens: 8_192,
    inputMicrosPerMillion: 0,
    cachedInputMicrosPerMillion: 0,
    outputMicrosPerMillion: 0,
    observedAt,
  };
}

export function configuredGatewayProviderSnapshot(
  model: GatewayModel,
  revision: number,
  workspaceAccess: boolean,
): ProviderCapabilitySnapshot {
  const digest = createHash("sha256")
    .update(JSON.stringify({ model, revision }), "utf8")
    .digest("hex");
  return {
    providerId: model.providerId,
    observedAt: model.observedAt as Rfc3339Timestamp,
    source: `terminus-control/opencode-gateway-config-v1:${digest}`,
    context: {
      advertisedTokens: model.contextTokens,
      testedSafeTokens: Math.min(model.contextTokens, 32_768),
      roleSupport: ["system", "user", "assistant", "tool"],
      imageInput: model.imageInput,
      toolCalling: model.toolCalling,
      parallelToolCalls: false,
      structuredOutput: model.structuredOutput,
    },
    continuation: {
      nativeId: model.protocol === "responses",
      crossRequest: model.protocol === "responses",
      compaction: true,
      compatibilityKey: `opencode-${model.deployment}-${model.protocol}-${model.id}`,
    },
    caching: { mode: "automatic_prefix", exactPrefixRequired: true, minimumTokens: 1_024, ttlOptions: [], toolOrderSensitive: true, usageReporting: true },
    reasoning: { supported: model.reasoning, budgetControl: false, summaryAvailable: false },
    economics: {
      inputMicrosPerMillion: BigInt(model.inputMicrosPerMillion) as Micros,
      cachedInputMicrosPerMillion: BigInt(model.cachedInputMicrosPerMillion) as Micros,
      outputMicrosPerMillion: BigInt(model.outputMicrosPerMillion) as Micros,
      reasoningAccounting: model.reasoning,
    },
    reliability: { toolCallSuccess: 0, structuredOutputSuccess: 0, editCohortSuccess: 0, latencyPercentiles: { p50: 0, p99: 0 } },
    policy: {
      allowedConfidentiality: workspaceAccess ? ["public", "workspace"] : ["public"],
      retentionMode: "provider_managed",
      region: null,
    },
  };
}

export function gatewayModelKey(model: GatewayModel): ModelKey {
  return model.id as ModelKey;
}

export function gatewayProtocol(value: string): GatewayProtocol {
  return z.enum(["chat_completions", "responses", "messages"]).parse(value);
}

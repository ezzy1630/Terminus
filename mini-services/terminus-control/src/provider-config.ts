import { createHash } from "node:crypto";
import { z } from "zod";
import type { ProviderCapabilitySnapshot } from "@terminus/provider-core";
import type { Micros, ModelKey, Rfc3339Timestamp } from "@terminus/domain";

export const PROVIDER_CONFIGURATION_ID = "default";

const MAX_PROGRAM_BYTES = 4_096;
const MAX_ARGUMENT_BYTES = 16_384;
const MAX_ARGUMENTS = 128;

export const providerConfigurationInputSchema = z.object({
  program: z.string().trim().min(1).max(MAX_PROGRAM_BYTES),
  args: z.array(z.string().min(1).max(MAX_ARGUMENT_BYTES)).max(MAX_ARGUMENTS),
  model: z.string().trim().min(1).max(255),
  timeout_seconds: z.number().int().min(1).max(3_600),
  tools_enabled: z.boolean(),
}).strict().superRefine((value, context) => {
  const values = [value.program, ...value.args, value.model];
  if (values.some((item) => /[\0\r\n]/.test(item))) {
    context.addIssue({ code: "custom", message: "program, arguments, and model may not contain control delimiters" });
  }
  if (value.program.includes("\\") || value.program.includes(";")) {
    context.addIssue({ code: "custom", message: "program must be an executable path or name, not a shell expression" });
  }
});

export type ProviderConfigurationInput = z.infer<typeof providerConfigurationInputSchema>;

export const providerConfigurationUpdateSchema = providerConfigurationInputSchema.extend({
  expected_revision: z.number().int().nonnegative(),
});

export type ProviderConfigurationUpdate = z.infer<typeof providerConfigurationUpdateSchema>;

export interface ProviderConfigurationRow extends ProviderConfigurationInput {
  readonly revision: number;
  readonly updated_by: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface ProviderConfigurationWire {
  readonly configured: boolean;
  readonly configuration: ProviderConfigurationRow | null;
}

export function parseProviderConfigurationInput(raw: unknown): ProviderConfigurationInput {
  const parsed = providerConfigurationInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`provider configuration is invalid: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
  }
  return parsed.data;
}

export function parseProviderConfigurationUpdate(raw: unknown): ProviderConfigurationUpdate {
  const parsed = providerConfigurationUpdateSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`provider configuration update is invalid: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
  }
  return parsed.data;
}

export function providerConfigurationWire(row: {
  readonly program: string;
  readonly argsJson: string;
  readonly model: string;
  readonly timeoutSeconds: number;
  readonly toolsEnabled: boolean;
  readonly revision: number;
  readonly updatedBy: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
} | null): ProviderConfigurationWire {
  if (row === null) return { configured: false, configuration: null };
  let args: unknown;
  try {
    args = JSON.parse(row.argsJson) as unknown;
  } catch {
    throw new Error("persisted provider configuration args are not valid JSON");
  }
  const input = parseProviderConfigurationInput({
    program: row.program,
    args,
    model: row.model,
    timeout_seconds: row.timeoutSeconds,
    tools_enabled: row.toolsEnabled,
  });
  return {
    configured: true,
    configuration: {
      ...input,
      revision: row.revision,
      updated_by: row.updatedBy,
      created_at: row.createdAt.toISOString(),
      updated_at: row.updatedAt.toISOString(),
    },
  };
}

export function providerConfigurationCommand(row: {
  readonly program: string;
  readonly argsJson: string;
  readonly model: string;
  readonly timeoutSeconds: number;
  readonly toolsEnabled: boolean;
}): {
  readonly program: string;
  readonly args: readonly string[];
  readonly model: ModelKey;
  readonly timeoutSeconds: number;
  readonly toolsEnabled: boolean;
} {
  const wire = providerConfigurationWire({
    ...row,
    revision: 1,
    updatedBy: "control",
    createdAt: new Date(0),
    updatedAt: new Date(0),
  });
  if (wire.configuration === null) throw new Error("provider configuration is missing");
  return {
    program: wire.configuration.program,
    args: wire.configuration.args,
    model: wire.configuration.model as ModelKey,
    timeoutSeconds: wire.configuration.timeout_seconds,
    toolsEnabled: wire.configuration.tools_enabled,
  };
}

/**
 * A configured command is not proof of remote model capabilities. The
 * snapshot therefore advertises only the local transport's known limits and
 * identifies the exact durable configuration revision in its source.
 */
export function configuredLocalProviderSnapshot(
  configuration: ProviderConfigurationInput,
  revision: number,
  observedAt: Rfc3339Timestamp,
): ProviderCapabilitySnapshot {
  const digest = createHash("sha256")
    .update(JSON.stringify({ ...configuration, revision }), "utf8")
    .digest("hex");
  return {
    providerId: "local",
    observedAt,
    source: `terminus-control/local-provider-config-v1:${digest}`,
    context: {
      advertisedTokens: 16_384,
      testedSafeTokens: 8_192,
      roleSupport: ["system", "user", "assistant", "tool"],
      imageInput: false,
      toolCalling: configuration.tools_enabled,
      parallelToolCalls: false,
      structuredOutput: true,
    },
    continuation: { nativeId: false, crossRequest: false, compaction: true, compatibilityKey: `local-config-v1:${digest}` },
    caching: { mode: "explicit_breakpoints", exactPrefixRequired: true, minimumTokens: 0, ttlOptions: [], toolOrderSensitive: false, usageReporting: false },
    reasoning: { supported: false, budgetControl: false, summaryAvailable: false },
    economics: { inputMicrosPerMillion: 0n as Micros, cachedInputMicrosPerMillion: 0n as Micros, outputMicrosPerMillion: 0n as Micros, reasoningAccounting: false },
    reliability: { toolCallSuccess: 0, structuredOutputSuccess: 0, editCohortSuccess: 0, latencyPercentiles: { p50: 0, p99: 0 } },
    policy: { allowedConfidentiality: ["public", "workspace"], retentionMode: "local_only", region: null },
  };
}

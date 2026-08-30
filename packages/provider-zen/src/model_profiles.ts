import { micros, type ModelProfile } from "@terminus/domain";
import {
  defineProviderProfileBundle,
  resolveTestedSafeContextTokens,
  type ProviderProfileBundle,
  type ProviderRenderingProfile,
} from "@terminus/provider-core";
import type { GatewayModel, GatewayProtocol } from "./catalog.js";

export interface GatewayRenderingProfile extends ProviderRenderingProfile {
  readonly adapterRef: GatewayModel["providerId"];
  readonly gatewayDeployment: GatewayModel["deployment"];
  readonly gatewayProtocol: GatewayProtocol;
  readonly baseUrl: string;
  readonly free: boolean;
  readonly toolDialect: "openai_chat_completions" | "openai_responses" | "anthropic_messages";
}

export function gatewayProfileBundles(
  models: readonly GatewayModel[],
): readonly ProviderProfileBundle<GatewayRenderingProfile>[] {
  return models.map((model) => {
    const version = `catalog-${model.observedAt.slice(0, 10)}`;
    const rendering: GatewayRenderingProfile = {
      id: `rendering:${model.providerId}:${model.id}:${version}`,
      adapterRef: model.providerId,
      modelKey: model.id,
      version,
      gatewayDeployment: model.deployment,
      gatewayProtocol: model.protocol,
      baseUrl: model.baseUrl,
      free: model.free,
      systemPromptPlacement: model.protocol === "messages" ? "top_level_system_blocks" : "message_input",
      toolDialect: toolDialect(model.protocol),
      editDialect: "hash_anchored_diff",
      reasoningEffort: model.reasoning ? "medium" : "none",
      continuationStrategy: model.protocol === "responses" ? "server_history" : "client_replay",
      compactionStrategy: "structured_claims_with_evidence",
      caching: {
        mode: model.protocol === "messages" ? "explicit_breakpoints" : "automatic_prefix",
        minimumTokens: 1_024,
        exactPrefixRequired: true,
      },
      structuredOutputRepair: {
        dialect: model.structuredOutput ? "provider_schema" : "prompt_guided_json",
        autoRepair: true,
        retryPromptTemplate: "Return valid JSON that matches the requested tool or output schema.",
      },
      knownFailureMitigations: [
        "fail_closed_on_gateway_protocol_drift",
        "require_terminal_stream_event_or_bounded_eof",
        "reject_incomplete_tool_arguments",
      ],
    };
    const testedSafeContextTokens = resolveTestedSafeContextTokens({
      modelId: model.id,
      contextTokens: model.contextTokens,
    });
    const profile: ModelProfile = {
      id: `profile-${model.providerId}-${model.id}-${version}`,
      adapterRef: model.providerId,
      renderingProfileRef: rendering.id,
      modelKey: model.id,
      version,
      modelFamilyRef: `gateway:${model.id}`,
      economics: {
        inputMicrosPerMillion: micros(model.inputMicrosPerMillion),
        cachedInputMicrosPerMillion: micros(model.cachedInputMicrosPerMillion),
        outputMicrosPerMillion: micros(model.outputMicrosPerMillion),
        reasoningAccounting: model.reasoning,
      },
      latencyModel: { p50Ms: 0, p90Ms: 0, p99Ms: 0, ttftMs: 0 },
      allowedConfidentiality: ["public"],
      capabilities: {
        codingQuality: "medium",
        toolReliability: "low",
        structuredOutput: model.structuredOutput,
        imageInput: model.imageInput,
        advertisedContextTokens: Math.max(1, model.contextTokens),
        testedSafeContextTokens,
        securityReasoning: "low",
        reasoningStrength: model.reasoning ? "medium" : "none",
        offlineExecution: false,
      },
    };
    return defineProviderProfileBundle(profile, rendering);
  });
}

function toolDialect(protocol: GatewayProtocol): GatewayRenderingProfile["toolDialect"] {
  switch (protocol) {
    case "chat_completions":
      return "openai_chat_completions";
    case "responses":
      return "openai_responses";
    case "messages":
      return "anthropic_messages";
  }
}

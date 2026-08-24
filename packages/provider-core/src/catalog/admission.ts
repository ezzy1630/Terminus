/**
 * @terminus/provider-core — Model admission records and capability probes.
 *
 * Per SPEC §15, §26, and ADR-0037: Evaluates model specifications against
 * required capabilities, producing immutable admission records with explicit
 * downgrade diagnostics or rejection reasons.
 */
import { getOfflineCatalogSnapshotDigest, type UniversalCatalogModel } from "./models_dev.js";

export type ModelAdmissionStatus = "admitted" | "rejected" | "downgraded";

export type ModelDowngradeReason =
  | "missing_native_tool_calling"
  | "missing_structured_output"
  | "missing_image_input"
  | "missing_prompt_caching"
  | "constrained_context_window"
  | "reasoning_unavailable";

export interface ModelAdmissionRequirements {
  readonly minContextTokens?: number | undefined;
  readonly requireToolCalling?: boolean | undefined;
  readonly requireStructuredOutput?: boolean | undefined;
  readonly requireImageInput?: boolean | undefined;
  readonly requireReasoning?: boolean | undefined;
  readonly strict?: boolean | undefined;
}

export interface ModelAdmissionRecord {
  readonly modelId: string;
  readonly vendor: string;
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
  readonly protocolPackage: string;
  readonly status: ModelAdmissionStatus;
  readonly downgrades: readonly ModelDowngradeReason[];
  readonly rejectionReasons: readonly string[];
  readonly snapshotDigest: string;
  readonly observedAt: string;
}

function dollarsToMicros(dollars: number): number {
  return Math.round(dollars * 1_000_000);
}

/**
 * Evaluates a model specification against admission requirements,
 * probing capabilities and emitting an immutable admission record.
 */
export function admitModelRecord(
  model: UniversalCatalogModel,
  vendor: string,
  requirements: ModelAdmissionRequirements = {},
  options?: {
    readonly snapshotDigest?: string | undefined;
    readonly observedAt?: string | undefined;
  },
): ModelAdmissionRecord {
  const minContext = requirements.minContextTokens ?? 8_192;
  const isStrict = requirements.strict === true;
  const rejectionReasons: string[] = [];
  const downgrades: ModelDowngradeReason[] = [];

  if (model.contextTokens <= 0) {
    rejectionReasons.push(`Model '${model.id}' advertises 0 context tokens`);
  } else if (model.contextTokens < minContext) {
    if (isStrict) {
      rejectionReasons.push(
        `Model '${model.id}' context window (${model.contextTokens}) is below minimum requirement (${minContext})`,
      );
    } else {
      downgrades.push("constrained_context_window");
    }
  }

  if (requirements.requireToolCalling && !model.toolCalling) {
    if (isStrict) {
      rejectionReasons.push(`Model '${model.id}' does not support required native tool calling`);
    } else {
      downgrades.push("missing_native_tool_calling");
    }
  } else if (!model.toolCalling) {
    downgrades.push("missing_native_tool_calling");
  }

  if (requirements.requireStructuredOutput && !model.structuredOutput) {
    if (isStrict) {
      rejectionReasons.push(`Model '${model.id}' does not support required structured output`);
    } else {
      downgrades.push("missing_structured_output");
    }
  } else if (!model.structuredOutput) {
    downgrades.push("missing_structured_output");
  }

  if (requirements.requireImageInput && !model.imageInput) {
    if (isStrict) {
      rejectionReasons.push(`Model '${model.id}' does not support required image input`);
    } else {
      downgrades.push("missing_image_input");
    }
  }

  if (requirements.requireReasoning && !model.reasoning) {
    if (isStrict) {
      rejectionReasons.push(`Model '${model.id}' does not support required reasoning tokens`);
    } else {
      downgrades.push("reasoning_unavailable");
    }
  }

  if (model.inputCost > 0 && model.cachedInputCost === 0) {
    downgrades.push("missing_prompt_caching");
  }

  let status: ModelAdmissionStatus = "admitted";
  if (rejectionReasons.length > 0) {
    status = "rejected";
  } else if (downgrades.length > 0) {
    status = "downgraded";
  }

  return {
    modelId: model.id,
    vendor,
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
    protocolPackage: model.protocolPackage,
    status,
    downgrades,
    rejectionReasons,
    snapshotDigest: options?.snapshotDigest ?? getOfflineCatalogSnapshotDigest(),
    observedAt: options?.observedAt ?? new Date().toISOString(),
  };
}

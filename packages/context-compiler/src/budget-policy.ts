import type { ModelCapabilitySnapshot, ProviderCapabilitySnapshot, ProviderToolSchema } from "@terminus/provider-core";
import type { ContextBudget } from "@terminus/context-ir";
import type { TokenCount } from "@terminus/domain";
import type { TokenEstimator } from "./tokenizer.js";

export const CONTEXT_BUDGET_POLICY_VERSION = "terminus.context-budget-policy.v1" as const;

export interface ProviderAwareBudgetInput {
  readonly budget: ContextBudget;
  readonly provider: ProviderCapabilitySnapshot;
  readonly model: ModelCapabilitySnapshot;
  readonly tokenizer: TokenEstimator;
  readonly toolSchemas: readonly ProviderToolSchema[];
}

export interface ProviderAwareBudgetBreakdown {
  readonly policyVersion: typeof CONTEXT_BUDGET_POLICY_VERSION;
  readonly modelAdvertisedTokens: bigint;
  readonly testedSafeTokens: bigint;
  readonly protocolOverheadTokens: bigint;
  readonly exactContextTokens: bigint;
  readonly toolSchemaTokens: bigint;
  readonly envelopeTokens: bigint;
  readonly optionalContextTarget: bigint;
  readonly expectedToolResultReserve: bigint;
  readonly outputReserve: bigint;
  readonly reasoningReserve: bigint;
  readonly recoveryMargin: bigint;
  readonly hardInputLimit: bigint;
  readonly tokenizerStatus: string;
}

export interface ProviderAwareBudgetResult {
  readonly budget: ContextBudget;
  readonly breakdown: ProviderAwareBudgetBreakdown;
}

function boundedBigInt(value: number, label: string): bigint {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be finite and non-negative`);
  return BigInt(Math.ceil(value));
}

function minPositive(values: readonly bigint[]): bigint {
  const positive = values.filter((value) => value > 0n);
  return positive.length === 0 ? 0n : positive.reduce((min, value) => value < min ? value : min);
}

/**
 * Reconcile a caller budget with the selected provider/model capabilities.
 * Tool schemas and serialized envelopes consume the same hard context window
 * as retrieved fragments, so optional context is reduced before allocation.
 */
export function deriveProviderAwareContextBudget(
  input: ProviderAwareBudgetInput,
): ProviderAwareBudgetResult {
  if (input.provider.providerId !== input.model.providerId) {
    throw new Error("provider and model capability snapshots disagree");
  }
  const modelAdvertisedTokens = BigInt(Math.max(0, Math.floor(input.provider.context.advertisedTokens)));
  const testedSafeTokens = BigInt(Math.max(0, Math.floor(input.provider.context.testedSafeTokens)));
  const configuredHardLimit = input.budget.hardInputLimit;
  const hardInputLimit = minPositive([testedSafeTokens, configuredHardLimit]);
  const toolSchemaTokens = boundedBigInt(
    input.tokenizer.estimateToolSchemaTokens(input.toolSchemas),
    "tool schema token estimate",
  );
  const envelopeTokens = boundedBigInt(
    input.tokenizer.estimateEnvelope(
      Number(input.budget.expectedToolResultReserve + input.budget.outputReserve + input.budget.reasoningReserve),
    ).tokens,
    "provider envelope token estimate",
  );
  const reasoningReserve = input.provider.reasoning.supported
    ? input.budget.reasoningReserve
    : 0n;
  const expectedToolResultReserve = input.provider.context.toolCalling
    ? input.budget.expectedToolResultReserve
    : 0n;
  const fixed = input.budget.protocolOverheadTokens
    + input.budget.exactContextTokens
    + toolSchemaTokens
    + envelopeTokens
    + expectedToolResultReserve
    + input.budget.outputReserve
    + reasoningReserve
    + input.budget.recoveryMargin;
  const availableOptional = hardInputLimit > fixed ? hardInputLimit - fixed : 0n;
  const optionalContextTarget = input.budget.optionalContextTarget < availableOptional
    ? input.budget.optionalContextTarget
    : availableOptional;
  const budget: ContextBudget = {
    modelAdvertisedTokens: modelAdvertisedTokens as TokenCount,
    testedSafeTokens: testedSafeTokens as TokenCount,
    protocolOverheadTokens: input.budget.protocolOverheadTokens,
    exactContextTokens: input.budget.exactContextTokens,
    optionalContextTarget: optionalContextTarget as TokenCount,
    expectedToolResultReserve: expectedToolResultReserve as TokenCount,
    outputReserve: input.budget.outputReserve,
    reasoningReserve: reasoningReserve as TokenCount,
    recoveryMargin: input.budget.recoveryMargin,
    hardInputLimit: hardInputLimit as TokenCount,
    hardCostMicros: input.budget.hardCostMicros,
  };
  return {
    budget,
    breakdown: {
      policyVersion: CONTEXT_BUDGET_POLICY_VERSION,
      modelAdvertisedTokens,
      testedSafeTokens,
      protocolOverheadTokens: budget.protocolOverheadTokens,
      exactContextTokens: budget.exactContextTokens,
      toolSchemaTokens,
      envelopeTokens,
      optionalContextTarget,
      expectedToolResultReserve,
      outputReserve: budget.outputReserve,
      reasoningReserve,
      recoveryMargin: budget.recoveryMargin,
      hardInputLimit,
      tokenizerStatus: input.tokenizer.calibration.status,
    },
  };
}

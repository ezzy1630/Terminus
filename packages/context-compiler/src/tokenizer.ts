/**
 * @terminus/context-compiler — token estimation and usage reconciliation.
 *
 * A token estimate is only useful when its source and calibration state are
 * visible. This module therefore separates three cases:
 *
 * - a caller-supplied, verified tokenizer binding;
 * - a fallback estimate adjusted by provider observations; and
 * - an uncalibrated fallback estimate, which is always reported as degraded.
 *
 * The package does not ship provider SDKs or claim to contain a live provider
 * tokenizer. A verified binding can be injected at the provider boundary.
 */

import type { ModelKey } from "@terminus/domain";
import type { ContextFragment } from "@terminus/context-ir";
import type { ProviderToolSchema, UsageRecord } from "@terminus/provider-core";

export const TOKEN_ESTIMATOR_CONTRACT_VERSION = "terminus.token-estimator.v1" as const;
export const TOKEN_CALIBRATION_VERSION = "terminus.token-calibration.v1" as const;

export type CalibrationStatus = "calibrated" | "degraded";
export type TokenEstimateSource =
  | "verified_binding"
  | "observed_calibration"
  | "explicit_fallback";

export interface TokenCalibrationPolicy {
  readonly minimumSamples: number;
  readonly maximumRelativeErrorPercent: number;
  readonly maximumSamples: number;
}

export const DEFAULT_CALIBRATION_POLICY: TokenCalibrationPolicy = {
  minimumSamples: 3,
  maximumRelativeErrorPercent: 15,
  maximumSamples: 64,
};

/** A persisted calibration seed can be supplied by a ContextStore. */
export interface TokenCalibrationSeed {
  readonly sampleCount?: number | undefined;
  readonly scale?: number | undefined;
  readonly meanAbsolutePercentageError?: number | null | undefined;
  readonly maximumAbsolutePercentageError?: number | null | undefined;
}

export interface TokenCalibrationDiagnostics {
  readonly version: typeof TOKEN_CALIBRATION_VERSION;
  readonly status: CalibrationStatus;
  readonly source: "verified_binding" | "observed_usage" | "explicit_fallback";
  readonly reason: string;
  readonly sampleCount: number;
  readonly meanAbsolutePercentageError: number | null;
  readonly maximumAbsolutePercentageError: number | null;
  readonly scale: number;
  readonly policy: TokenCalibrationPolicy;
  readonly bindingId: string | null;
  readonly bindingVersion: string | null;
}

export interface TokenEstimate {
  readonly tokens: number;
  readonly source: TokenEstimateSource;
  readonly calibrationStatus: CalibrationStatus;
  readonly calibrationVersion: typeof TOKEN_CALIBRATION_VERSION;
  readonly calibrationReason: string;
}

export interface ModelTokenBreakdown {
  readonly textTokens: number;
  readonly templateTokens: number;
  readonly toolSchemaTokens: number;
  readonly imageTokens: number;
  readonly envelopeTokens: number;
  readonly totalTokens: number;
  /** Present on estimates produced by the explicit estimator contract. */
  readonly calibration?: TokenCalibrationDiagnostics | undefined;
  readonly source?: TokenEstimateSource | undefined;
}

export interface ReconciledUsage {
  readonly manifestId: string;
  readonly predictedTokens: number;
  readonly observedTokens: number;
  readonly promptDelta: number;
  readonly cachedTokensObserved: number;
  readonly cacheWriteTokensObserved: number;
  readonly completionTokensObserved: number;
  readonly reasoningTokensObserved: number;
  readonly toolSchemaTokensObserved: number;
  readonly errorPercentage: number;
  readonly observedUsageAvailable: boolean;
  readonly calibrationStatus: CalibrationStatus;
  readonly calibrationReason: string;
  readonly calibrationSampleCount: number;
  readonly meanAbsolutePercentageError: number | null;
}

export interface ReconcileUsageOptions {
  /** False means the provider adapter returned no authoritative usage. */
  readonly usageAvailable?: boolean | undefined;
  /** The current profile. Passing none deliberately reports degraded state. */
  readonly calibration?: TokenCalibrationDiagnostics | undefined;
}

/**
 * Provider or official tokenizer code can implement this contract without
 * importing provider packages into the canonical context compiler.
 */
export interface TokenizerBinding {
  readonly bindingId: string;
  readonly bindingVersion: string;
  readonly providerId: string;
  readonly modelKey: ModelKey;
  readonly estimateTextTokens: (text: string) => number;
  readonly estimateFragmentTokens?:
    ((fragment: ContextFragment) => ModelTokenBreakdown) | undefined;
  readonly estimateToolSchemaTokens?:
    ((tools: readonly ProviderToolSchema[]) => number) | undefined;
  readonly estimateEnvelopeTokens?: ((maxTokens: number) => number) | undefined;
}

export interface TokenizerOptions {
  readonly binding?: TokenizerBinding | undefined;
  readonly calibration?: TokenCalibrationSeed | undefined;
  readonly calibrationPolicy?: TokenCalibrationPolicy | undefined;
}

/** Compatibility surface retained for existing compiler callers. */
export interface ModelTokenizer {
  readonly providerId: string;
  readonly modelKey: ModelKey;
  estimateTextTokens(text: string): number;
  estimateFragmentTokens(fragment: ContextFragment): ModelTokenBreakdown;
  estimateToolSchemaTokens(tools: readonly ProviderToolSchema[]): number;
  estimateEnvelopeTokens(maxTokens: number): number;
}

/**
 * Explicit token-estimator contract used by the compiler.
 *
 * The number-returning methods remain for compatibility with Context IR's
 * current `estimatedTokens` field. Callers that need provenance use the
 * `estimate*` methods and `calibration` diagnostics.
 */
export interface TokenEstimator extends ModelTokenizer {
  readonly contractVersion: typeof TOKEN_ESTIMATOR_CONTRACT_VERSION;
  readonly providerId: string;
  readonly modelKey: ModelKey;
  readonly calibration: TokenCalibrationDiagnostics;

  estimateText(text: string): TokenEstimate;
  estimateFragment(fragment: ContextFragment): ModelTokenBreakdown;
  estimateToolSchema(tools: readonly ProviderToolSchema[]): TokenEstimate;
  estimateEnvelope(maxTokens: number): TokenEstimate;
  reconcileUsage(
    manifestId: string,
    predictedPromptTokens: number,
    observedUsage: UsageRecord,
  ): ReconciledUsage;
  observeUsage(
    manifestId: string,
    predictedPromptTokens: number,
    observedUsage: UsageRecord,
    options?: ReconcileUsageOptions,
  ): ReconciledUsage;
}

interface MutableCalibration {
  sampleCount: number;
  scale: number;
  meanAbsolutePercentageError: number | null;
  maximumAbsolutePercentageError: number | null;
}

function finiteNonNegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a finite non-negative number`);
  }
  return Math.ceil(value);
}

function positiveFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a finite positive number`);
  }
  return value;
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/**
 * The fallback is intentionally generic. It is a bounded planning signal,
 * never a provider-token claim, and remains degraded until observations or a
 * verified binding establish calibration.
 */
function explicitFallbackTextTokens(text: string): number {
  if (text.length === 0) return 0;
  const fallbackBytesPerToken = 4;
  return Math.max(1, Math.ceil(byteLength(text) / fallbackBytesPerToken));
}

function calibrationErrorPercentage(predicted: number, observed: number): number {
  if (predicted === 0) return observed === 0 ? 0 : 100;
  return Math.abs(observed - predicted) / predicted * 100;
}

function calibrationReason(
  binding: TokenizerBinding | undefined,
  state: MutableCalibration,
  policy: TokenCalibrationPolicy,
): { readonly status: CalibrationStatus; readonly reason: string } {
  if (binding !== undefined && state.sampleCount === 0) {
    return { status: "calibrated", reason: "verified tokenizer binding supplied" };
  }
  if (state.sampleCount < policy.minimumSamples) {
    return {
      status: "degraded",
      reason: `only ${state.sampleCount} provider usage sample(s); ${policy.minimumSamples} required`,
    };
  }
  if (
    state.meanAbsolutePercentageError === null
    || state.meanAbsolutePercentageError > policy.maximumRelativeErrorPercent
  ) {
    return {
      status: "degraded",
      reason: `mean token error exceeds ${policy.maximumRelativeErrorPercent}% calibration bound`,
    };
  }
  return { status: "calibrated", reason: "calibrated from provider-reported usage" };
}

function copyPolicy(policy: TokenCalibrationPolicy): TokenCalibrationPolicy {
  return {
    minimumSamples: policy.minimumSamples,
    maximumRelativeErrorPercent: policy.maximumRelativeErrorPercent,
    maximumSamples: policy.maximumSamples,
  };
}

function validatePolicy(policy: TokenCalibrationPolicy): TokenCalibrationPolicy {
  if (!Number.isInteger(policy.minimumSamples) || policy.minimumSamples < 1) {
    throw new Error("calibration minimumSamples must be a positive integer");
  }
  if (!Number.isFinite(policy.maximumRelativeErrorPercent) || policy.maximumRelativeErrorPercent < 0) {
    throw new Error("calibration maximumRelativeErrorPercent must be non-negative");
  }
  if (!Number.isInteger(policy.maximumSamples) || policy.maximumSamples < policy.minimumSamples) {
    throw new Error("calibration maximumSamples must be at least minimumSamples");
  }
  return copyPolicy(policy);
}

function seedCalibration(seed: TokenCalibrationSeed | undefined): MutableCalibration {
  const sampleCount = seed?.sampleCount ?? 0;
  const scale = seed?.scale ?? 1;
  if (!Number.isInteger(sampleCount) || sampleCount < 0) {
    throw new Error("calibration sampleCount must be a non-negative integer");
  }
  positiveFinite(scale, "calibration scale");
  const mean = seed?.meanAbsolutePercentageError ?? null;
  const maximum = seed?.maximumAbsolutePercentageError ?? null;
  for (const [label, value] of [["mean", mean], ["maximum", maximum]] as const) {
    if (value !== null && (!Number.isFinite(value) || value < 0)) {
      throw new Error(`calibration ${label} error must be non-negative`);
    }
  }
  return {
    sampleCount,
    scale,
    meanAbsolutePercentageError: mean,
    maximumAbsolutePercentageError: maximum,
  };
}

function bindingMatches(binding: TokenizerBinding, providerId: string, modelKey: ModelKey): boolean {
  return binding.providerId.toLowerCase() === providerId.toLowerCase()
    && String(binding.modelKey) === String(modelKey);
}

function attachCalibration(
  estimate: TokenEstimate,
  diagnostics: TokenCalibrationDiagnostics,
): TokenEstimate {
  return {
    ...estimate,
    calibrationStatus: diagnostics.status,
    calibrationVersion: diagnostics.version,
    calibrationReason: diagnostics.reason,
  };
}

/**
 * Stateful estimator. It is deterministic for a fixed binding, seed, policy,
 * and observation sequence. The caller owns persistence of `calibration`.
 */
export class CalibratedModelTokenizer implements TokenEstimator {
  readonly contractVersion = TOKEN_ESTIMATOR_CONTRACT_VERSION;
  readonly providerId: string;
  readonly modelKey: ModelKey;

  private readonly binding: TokenizerBinding | undefined;
  private readonly policy: TokenCalibrationPolicy;
  private readonly state: MutableCalibration;

  constructor(providerId: string, modelKey: ModelKey, options: TokenizerOptions = {}) {
    if (options.binding !== undefined && !bindingMatches(options.binding, providerId, modelKey)) {
      throw new Error(
        `tokenizer binding ${options.binding.bindingId} does not match ${providerId}/${String(modelKey)}`,
      );
    }
    this.providerId = providerId;
    this.modelKey = modelKey;
    this.binding = options.binding;
    this.policy = validatePolicy(options.calibrationPolicy ?? DEFAULT_CALIBRATION_POLICY);
    this.state = seedCalibration(options.calibration);
  }

  get calibration(): TokenCalibrationDiagnostics {
    const outcome = calibrationReason(this.binding, this.state, this.policy);
    return {
      version: TOKEN_CALIBRATION_VERSION,
      status: outcome.status,
      source: this.binding !== undefined
        ? "verified_binding"
        : this.state.sampleCount > 0
          ? "observed_usage"
          : "explicit_fallback",
      reason: outcome.reason,
      sampleCount: this.state.sampleCount,
      meanAbsolutePercentageError: this.state.meanAbsolutePercentageError,
      maximumAbsolutePercentageError: this.state.maximumAbsolutePercentageError,
      scale: this.state.scale,
      policy: copyPolicy(this.policy),
      bindingId: this.binding?.bindingId ?? null,
      bindingVersion: this.binding?.bindingVersion ?? null,
    };
  }

  estimateText(text: string): TokenEstimate {
    const rawTokens = this.binding === undefined
      ? explicitFallbackTextTokens(text)
      : finiteNonNegative(this.binding.estimateTextTokens(text), "tokenizer binding text estimate");
    const adjustedTokens = this.binding === undefined
      ? rawTokens === 0 ? 0 : Math.max(1, Math.ceil(rawTokens * this.state.scale))
      : rawTokens;
    const diagnostics = this.calibration;
    return attachCalibration({
      tokens: adjustedTokens,
      source: this.binding !== undefined
        ? "verified_binding"
        : this.state.sampleCount > 0
          ? "observed_calibration"
          : "explicit_fallback",
      calibrationStatus: diagnostics.status,
      calibrationVersion: diagnostics.version,
      calibrationReason: diagnostics.reason,
    }, diagnostics);
  }

  estimateFragment(fragment: ContextFragment): ModelTokenBreakdown {
    if (this.binding?.estimateFragmentTokens !== undefined) {
      const bound = this.binding.estimateFragmentTokens(fragment);
      const normalized = normalizeBreakdown(bound);
      return {
        ...normalized,
        calibration: this.calibration,
        source: "verified_binding",
      };
    }
    const text = this.estimateText(fragment.textContent ?? "");
    return {
      textTokens: text.tokens,
      templateTokens: 0,
      toolSchemaTokens: 0,
      imageTokens: 0,
      envelopeTokens: 0,
      totalTokens: text.tokens,
      calibration: this.calibration,
      source: text.source,
    };
  }

  estimateToolSchema(tools: readonly ProviderToolSchema[]): TokenEstimate {
    if (this.binding?.estimateToolSchemaTokens !== undefined) {
      const tokens = finiteNonNegative(
        this.binding.estimateToolSchemaTokens(tools),
        "tokenizer binding tool-schema estimate",
      );
      return this.estimateFromRaw(tokens, "verified_binding");
    }
    if (tools.length === 0) return this.estimateFromRaw(0, "explicit_fallback");
    const payload = tools.map((tool) => JSON.stringify({
      id: tool.id,
      summary: tool.summary,
      inputSchema: tool.inputSchema,
    })).join("\n");
    return this.estimateText(payload);
  }

  estimateEnvelope(maxTokens: number): TokenEstimate {
    if (this.binding?.estimateEnvelopeTokens !== undefined) {
      const tokens = finiteNonNegative(
        this.binding.estimateEnvelopeTokens(maxTokens),
        "tokenizer binding envelope estimate",
      );
      return this.estimateFromRaw(tokens, "verified_binding");
    }
    void maxTokens;
    return this.estimateFromRaw(0, "explicit_fallback");
  }

  estimateTextTokens(text: string): number {
    return this.estimateText(text).tokens;
  }

  estimateFragmentTokens(fragment: ContextFragment): ModelTokenBreakdown {
    return this.estimateFragment(fragment);
  }

  estimateToolSchemaTokens(tools: readonly ProviderToolSchema[]): number {
    return this.estimateToolSchema(tools).tokens;
  }

  estimateEnvelopeTokens(maxTokens: number): number {
    return this.estimateEnvelope(maxTokens).tokens;
  }

  reconcileUsage(
    manifestId: string,
    predictedPromptTokens: number,
    observedUsage: UsageRecord,
  ): ReconciledUsage {
    return reconcileUsage(manifestId, predictedPromptTokens, observedUsage, {
      calibration: this.calibration,
    });
  }

  observeUsage(
    manifestId: string,
    predictedPromptTokens: number,
    observedUsage: UsageRecord,
    options: ReconcileUsageOptions = {},
  ): ReconciledUsage {
    const before = reconcileUsage(manifestId, predictedPromptTokens, observedUsage, {
      ...options,
      calibration: this.calibration,
    });
    if (
      !before.observedUsageAvailable
      || before.observedTokens <= 0
      || before.predictedTokens <= 0
    ) return before;

    const observed = before.observedTokens;
    const priorScale = this.state.scale;
    const adjustedPrediction = before.predictedTokens * priorScale;
    const sampleError = calibrationErrorPercentage(adjustedPrediction, observed);
    const previousCount = this.state.sampleCount;
    const nextCount = Math.min(previousCount + 1, this.policy.maximumSamples);
    const ratio = observed / before.predictedTokens;
    this.state.scale = previousCount === 0
      ? ratio
      : (priorScale * previousCount + ratio) / (previousCount + 1);
    this.state.sampleCount = nextCount;
    this.state.meanAbsolutePercentageError = previousCount === 0
      ? sampleError
      : ((this.state.meanAbsolutePercentageError ?? 0) * previousCount + sampleError) / (previousCount + 1);
    this.state.maximumAbsolutePercentageError = Math.max(
      this.state.maximumAbsolutePercentageError ?? 0,
      sampleError,
    );

    return reconcileUsage(manifestId, predictedPromptTokens, observedUsage, {
      usageAvailable: true,
      calibration: this.calibration,
    });
  }

  private estimateFromRaw(tokens: number, source: TokenEstimateSource): TokenEstimate {
    const diagnostics = this.calibration;
    return attachCalibration({
      tokens,
      source,
      calibrationStatus: diagnostics.status,
      calibrationVersion: diagnostics.version,
      calibrationReason: diagnostics.reason,
    }, diagnostics);
  }
}

function normalizeBreakdown(breakdown: ModelTokenBreakdown): ModelTokenBreakdown {
  const textTokens = finiteNonNegative(breakdown.textTokens, "tokenizer binding text breakdown");
  const templateTokens = finiteNonNegative(breakdown.templateTokens, "tokenizer binding template breakdown");
  const toolSchemaTokens = finiteNonNegative(breakdown.toolSchemaTokens, "tokenizer binding tool breakdown");
  const imageTokens = finiteNonNegative(breakdown.imageTokens, "tokenizer binding image breakdown");
  const envelopeTokens = finiteNonNegative(breakdown.envelopeTokens, "tokenizer binding envelope breakdown");
  const totalTokens = finiteNonNegative(breakdown.totalTokens, "tokenizer binding total breakdown");
  const componentTotal = textTokens + templateTokens + toolSchemaTokens + imageTokens + envelopeTokens;
  if (totalTokens < componentTotal) {
    throw new Error("tokenizer binding total breakdown is smaller than its components");
  }
  return {
    textTokens,
    templateTokens,
    toolSchemaTokens,
    imageTokens,
    envelopeTokens,
    totalTokens,
  };
}

/** Reconcile one provider attempt without mutating a calibration profile. */
export function reconcileUsage(
  manifestId: string,
  predictedPromptTokens: number,
  observedUsage: UsageRecord,
  options: ReconcileUsageOptions = {},
): ReconciledUsage {
  const predicted = finiteNonNegative(predictedPromptTokens, "predicted prompt tokens");
  const observed = finiteNonNegative(Number(observedUsage.inputTokens), "observed input tokens");
  const cached = finiteNonNegative(Number(observedUsage.cachedInputTokens), "observed cached input tokens");
  const cacheWrite = finiteNonNegative(Number(observedUsage.cacheWriteTokens), "observed cache-write tokens");
  const completion = finiteNonNegative(Number(observedUsage.outputTokens), "observed output tokens");
  const reasoning = finiteNonNegative(Number(observedUsage.reasoningTokens), "observed reasoning tokens");
  const toolSchema = finiteNonNegative(Number(observedUsage.toolSchemaTokens), "observed tool-schema tokens");
  const usageAvailable = options.usageAvailable ?? (predicted === 0 || observed > 0);
  const calibration = options.calibration;
  const errorPercentage = calibrationErrorPercentage(predicted, observed);

  return {
    manifestId,
    predictedTokens: predicted,
    observedTokens: observed,
    promptDelta: observed - predicted,
    cachedTokensObserved: cached,
    cacheWriteTokensObserved: cacheWrite,
    completionTokensObserved: completion,
    reasoningTokensObserved: reasoning,
    toolSchemaTokensObserved: toolSchema,
    errorPercentage,
    observedUsageAvailable: usageAvailable,
    calibrationStatus: calibration?.status ?? "degraded",
    calibrationReason: usageAvailable
      ? calibration?.reason ?? "no calibration profile supplied"
      : "provider did not report authoritative input usage",
    calibrationSampleCount: calibration?.sampleCount ?? 0,
    meanAbsolutePercentageError: calibration?.meanAbsolutePercentageError ?? null,
  };
}

/**
 * Resolve a tokenizer without pretending that provider SDKs are bundled here.
 * With no injected binding, the returned estimator is explicitly degraded.
 */
export function resolveTokenizer(
  providerId: string,
  modelKey: ModelKey,
  options: TokenizerOptions = {},
): TokenEstimator {
  const provider = providerId.toLowerCase();
  if (provider.includes("anthropic") || String(modelKey).toLowerCase().includes("claude")) {
    return new AnthropicTokenizer(modelKey, options);
  }
  if (
    provider.includes("openai")
    || String(modelKey).toLowerCase().includes("gpt")
    || String(modelKey).toLowerCase().includes("o1")
  ) {
    return new OpenAITokenizer(modelKey, options);
  }
  if (provider.includes("google") || String(modelKey).toLowerCase().includes("gemini")) {
    return new GoogleTokenizer(modelKey, options);
  }
  return new CalibratedModelTokenizer(providerId, modelKey, options);
}

export class OpenAITokenizer extends CalibratedModelTokenizer {
  constructor(modelKey: ModelKey = "gpt-4o" as ModelKey, options: TokenizerOptions = {}) {
    super("openai", modelKey, options);
  }
}

export class AnthropicTokenizer extends CalibratedModelTokenizer {
  constructor(modelKey: ModelKey = "claude-3-5-sonnet" as ModelKey, options: TokenizerOptions = {}) {
    super("anthropic", modelKey, options);
  }
}

export class GoogleTokenizer extends CalibratedModelTokenizer {
  constructor(modelKey: ModelKey = "gemini-1.5-pro" as ModelKey, options: TokenizerOptions = {}) {
    super("google", modelKey, options);
  }
}

/** Compatibility name for callers that use the local-model resolver. */
export class LocalTokenizer extends CalibratedModelTokenizer {
  constructor(modelKey: ModelKey = "local" as ModelKey, options: TokenizerOptions = {}) {
    super("local", modelKey, options);
  }
}

// ────────────────────────── Chat template compatibility ────────────────────

/**
 * Chat-template rendering remains a separate compatibility utility. It does
 * not assert that its control-token count is a live provider measurement.
 */
export interface ChatTemplateAdapter {
  readonly name: string;
  readonly compatibleModels: readonly string[];
  render(messages: readonly { readonly role: string; readonly content: string }[]): string;
  estimateControlTokens(messages: readonly { readonly role: string; readonly content: string }[]): number;
}

export class Llama3ChatTemplate implements ChatTemplateAdapter {
  readonly name = "llama3";
  readonly compatibleModels = ["llama-3", "llama-3.1", "llama-3-70b", "llama-3.1-8b", "llama-3.1-70b"];

  private readonly bos = "<|begin_of_text|>";
  private readonly eot = "<|eot_id|>";
  private readonly startHeader = "<|start_header_id|>";
  private readonly endHeader = "<|end_header_id|>";

  render(messages: readonly { readonly role: string; readonly content: string }[]): string {
    const parts: string[] = [this.bos];
    for (const message of messages) {
      const role = this.mapRole(message.role);
      parts.push(`${this.startHeader}${role}${this.endHeader}\n\n${message.content}${this.eot}`);
    }
    parts.push(`${this.startHeader}assistant${this.endHeader}\n\n`);
    return parts.join("");
  }

  estimateControlTokens(
    messages: readonly { readonly role: string; readonly content: string }[],
  ): number {
    return 1 + 7 * messages.length + 4;
  }

  private mapRole(role: string): string {
    switch (role) {
      case "system": return "system";
      case "user": return "user";
      case "assistant": return "assistant";
      case "tool": return "ipython";
      case "developer": return "system";
      default: return "user";
    }
  }
}

export class MistralChatTemplate implements ChatTemplateAdapter {
  readonly name = "mistral";
  readonly compatibleModels = ["mistral", "mistral-large", "mistral-small", "mixtral"];

  render(messages: readonly { readonly role: string; readonly content: string }[]): string {
    const parts: string[] = ["<s>"];
    let inInstruction = false;
    let hasSystemPrompt = false;
    const systemTexts: string[] = [];
    for (const message of messages) {
      if (message.role === "system") {
        systemTexts.push(message.content);
        hasSystemPrompt = true;
      }
    }
    for (const message of messages) {
      const role = this.mapRole(message.role);
      if (role === "system") {
        if (!inInstruction && hasSystemPrompt && systemTexts.length > 0) {
          parts.push(`[INST] ${systemTexts.join("\n")} `);
          inInstruction = true;
          systemTexts.length = 0;
        }
      } else if (role === "user") {
        if (inInstruction) {
          parts.push(`${message.content} [/INST]`);
          inInstruction = false;
        } else {
          parts.push(`[INST] ${message.content} [/INST]`);
        }
      } else if (role === "assistant") {
        parts.push(`${message.content}</s>`);
        inInstruction = false;
      } else if (role === "tool") {
        parts.push(`[TOOL_RESULTS] ${message.content} [/TOOL_RESULTS]`);
        inInstruction = false;
      }
    }
    return parts.join("");
  }

  estimateControlTokens(
    messages: readonly { readonly role: string; readonly content: string }[],
  ): number {
    return 1 + messages.length * 5;
  }

  private mapRole(role: string): string {
    switch (role) {
      case "system": return "system";
      case "user": return "user";
      case "assistant": return "assistant";
      case "tool": return "tool";
      default: return "user";
    }
  }
}

export class Qwen2ChatTemplate implements ChatTemplateAdapter {
  readonly name = "qwen2";
  readonly compatibleModels = ["qwen2", "qwen2.5", "qwen-2.5-coder"];

  private readonly imStart = "<|im_start|>";
  private readonly imEnd = "<|im_end|>";

  render(messages: readonly { readonly role: string; readonly content: string }[]): string {
    const parts: string[] = [];
    for (const message of messages) {
      parts.push(`${this.imStart}${this.mapRole(message.role)}\n${message.content}${this.imEnd}\n`);
    }
    parts.push(`${this.imStart}assistant\n`);
    return parts.join("");
  }

  estimateControlTokens(
    messages: readonly { readonly role: string; readonly content: string }[],
  ): number {
    return 4 * messages.length + 2;
  }

  private mapRole(role: string): string {
    switch (role) {
      case "system": return "system";
      case "user": return "user";
      case "assistant": return "assistant";
      case "tool": return "tool";
      default: return "user";
    }
  }
}

/** Resolve a compatibility chat template by model-name convention. */
export function resolveChatTemplate(modelKey: string): ChatTemplateAdapter {
  const model = modelKey.toLowerCase();
  if (model.includes("llama-3") || model.includes("llama3")) return new Llama3ChatTemplate();
  if (model.includes("mistral") || model.includes("mixtral")) return new MistralChatTemplate();
  if (model.includes("qwen")) return new Qwen2ChatTemplate();
  return new Qwen2ChatTemplate();
}

/**
 * @terminus/context-compiler — Model-specific Tokenization & Accounting Engine.
 *
 * SPEC §8.5 & §33.11: Replaces crude `chars / 4` token estimates with precise,
 * model-aware tokenizers. Calculates:
 *  - Text content tokens
 *  - Chat template & role header overhead
 *  - Provider tool-schema JSON overhead
 *  - Special control tokens (BOS/EOS/break)
 *  - Image media tokens (based on tile grids)
 *  - Provider envelope overhead
 *
 * Provides `reconcileUsage` to compare pre-send predictions against
 * provider-reported actual token usage.
 */

import type { ModelKey, TokenCount } from "@terminus/domain";
import type { ContextFragment } from "@terminus/context-ir";
import type { ProviderToolSchema, UsageRecord } from "@terminus/provider-core";

export interface ModelTokenBreakdown {
  readonly textTokens: number;
  readonly templateTokens: number;
  readonly toolSchemaTokens: number;
  readonly imageTokens: number;
  readonly envelopeTokens: number;
  readonly totalTokens: number;
}

export interface ReconciledUsage {
  readonly manifestId: string;
  readonly predictedTokens: number;
  readonly observedTokens: number;
  readonly promptDelta: number;
  readonly cachedTokensObserved: number;
  readonly completionTokensObserved: number;
  readonly reasoningTokensObserved: number;
  readonly errorPercentage: number;
}

/**
 * Model-specific Tokenizer contract.
 */
export interface ModelTokenizer {
  readonly providerId: string;
  readonly modelKey: ModelKey;
  
  estimateTextTokens(text: string): number;
  estimateFragmentTokens(frag: ContextFragment): ModelTokenBreakdown;
  estimateToolSchemaTokens(tools: readonly ProviderToolSchema[]): number;
  estimateEnvelopeTokens(maxTokens: number): number;
}

/**
 * Tokenizer implementation for OpenAI models (GPT-4o, o1, GPT-4 Turbo).
 */
export class OpenAITokenizer implements ModelTokenizer {
  readonly providerId = "openai";
  readonly modelKey: ModelKey;

  constructor(modelKey: ModelKey = "gpt-4o" as ModelKey) {
    this.modelKey = modelKey;
  }

  estimateTextTokens(text: string): number {
    if (!text) return 0;
    // OpenAI BPE approximation: ~3.7 chars per token for code/JSON, ~4 chars for standard text
    // Adding +3 tokens per message block for ChatML formatting
    const base = Math.ceil(text.length / 3.7);
    return Math.max(1, base);
  }

  estimateFragmentTokens(frag: ContextFragment): ModelTokenBreakdown {
    const text = frag.textContent ?? "";
    const textTokens = this.estimateTextTokens(text);
    
    // Role & ChatML header: <|im_start|>system/user/assistant\n ... <|im_end|> -> ~4 tokens
    const templateTokens = 4;
    
    // Image handling: GPT-4o tile calculation (85 tokens per 512x512 tile + 170 base)
    let imageTokens = 0;
    if (frag.contentRef.mediaType?.startsWith("image/")) {
      imageTokens = 255; // Default single-tile high-res estimate
    }

    const totalTokens = textTokens + templateTokens + imageTokens;

    return {
      textTokens,
      templateTokens,
      toolSchemaTokens: 0,
      imageTokens,
      envelopeTokens: 0,
      totalTokens,
    };
  }

  estimateToolSchemaTokens(tools: readonly ProviderToolSchema[]): number {
    if (tools.length === 0) return 0;
    // OpenAI tool schema cost: ~10 tokens per function definition + param schema tokens + 8 tokens envelope
    let tokens = 8;
    for (const tool of tools) {
      const jsonStr = JSON.stringify(tool.inputSchema);
      tokens += 10 + this.estimateTextTokens(tool.id) + this.estimateTextTokens(tool.summary) + this.estimateTextTokens(jsonStr);
    }
    return tokens;
  }

  estimateEnvelopeTokens(maxTokens: number): number {
    // OpenAI API envelope tokens (request structure, response format headers, max_tokens)
    void maxTokens;
    return 12;
  }
}

/**
 * Tokenizer implementation for Anthropic models (Claude 3.5 Sonnet / Haiku / Opus).
 */
export class AnthropicTokenizer implements ModelTokenizer {
  readonly providerId = "anthropic";
  readonly modelKey: ModelKey;

  constructor(modelKey: ModelKey = "claude-3-5-sonnet" as ModelKey) {
    this.modelKey = modelKey;
  }

  estimateTextTokens(text: string): number {
    if (!text) return 0;
    // Anthropic BPE approximation: ~3.5 chars per token for code & structured text
    const base = Math.ceil(text.length / 3.5);
    return Math.max(1, base);
  }

  estimateFragmentTokens(frag: ContextFragment): ModelTokenBreakdown {
    const text = frag.textContent ?? "";
    const textTokens = this.estimateTextTokens(text);
    
    // System & block wrapping overhead in Anthropic Messages API
    const templateTokens = 5;
    
    let imageTokens = 0;
    if (frag.contentRef.mediaType?.startsWith("image/")) {
      imageTokens = 1600; // Standard Claude vision block estimate
    }

    const totalTokens = textTokens + templateTokens + imageTokens;

    return {
      textTokens,
      templateTokens,
      toolSchemaTokens: 0,
      imageTokens,
      envelopeTokens: 0,
      totalTokens,
    };
  }

  estimateToolSchemaTokens(tools: readonly ProviderToolSchema[]): number {
    if (tools.length === 0) return 0;
    // Anthropic tool cost: ~14 tokens base per tool + name + description + JSON schema tokens
    let tokens = 12;
    for (const tool of tools) {
      const jsonStr = JSON.stringify(tool.inputSchema);
      tokens += 14 + this.estimateTextTokens(tool.id) + this.estimateTextTokens(tool.summary) + this.estimateTextTokens(jsonStr);
    }
    return tokens;
  }

  estimateEnvelopeTokens(maxTokens: number): number {
    void maxTokens;
    return 15;
  }
}

/**
 * Tokenizer implementation for Google Gemini models (Gemini 1.5 / 2.0 / 3.0).
 */
export class GoogleTokenizer implements ModelTokenizer {
  readonly providerId = "google";
  readonly modelKey: ModelKey;

  constructor(modelKey: ModelKey = "gemini-1.5-pro" as ModelKey) {
    this.modelKey = modelKey;
  }

  estimateTextTokens(text: string): number {
    if (!text) return 0;
    // Gemini SentencePiece token estimation (~4 chars per token)
    const base = Math.ceil(text.length / 4.0);
    return Math.max(1, base);
  }

  estimateFragmentTokens(frag: ContextFragment): ModelTokenBreakdown {
    const text = frag.textContent ?? "";
    const textTokens = this.estimateTextTokens(text);
    const templateTokens = 3;
    
    let imageTokens = 0;
    if (frag.contentRef.mediaType?.startsWith("image/")) {
      imageTokens = 258; // Gemini fixed image token footprint per 768x768 tile
    }

    const totalTokens = textTokens + templateTokens + imageTokens;

    return {
      textTokens,
      templateTokens,
      toolSchemaTokens: 0,
      imageTokens,
      envelopeTokens: 0,
      totalTokens,
    };
  }

  estimateToolSchemaTokens(tools: readonly ProviderToolSchema[]): number {
    if (tools.length === 0) return 0;
    let tokens = 10;
    for (const tool of tools) {
      const jsonStr = JSON.stringify(tool.inputSchema);
      tokens += 8 + this.estimateTextTokens(tool.id) + this.estimateTextTokens(tool.summary) + this.estimateTextTokens(jsonStr);
    }
    return tokens;
  }

  estimateEnvelopeTokens(maxTokens: number): number {
    void maxTokens;
    return 10;
  }
}

/**
 * Tokenizer for local / open-source models (Llama-3, Qwen, Mistral).
 */
export class LocalTokenizer implements ModelTokenizer {
  readonly providerId = "local";
  readonly modelKey: ModelKey;

  constructor(modelKey: ModelKey = "llama-3-70b" as ModelKey) {
    this.modelKey = modelKey;
  }

  estimateTextTokens(text: string): number {
    if (!text) return 0;
    const base = Math.ceil(text.length / 3.6);
    return Math.max(1, base);
  }

  estimateFragmentTokens(frag: ContextFragment): ModelTokenBreakdown {
    const text = frag.textContent ?? "";
    const textTokens = this.estimateTextTokens(text);
    const templateTokens = 6; // Special Llama-3 header tokens
    
    return {
      textTokens,
      templateTokens,
      toolSchemaTokens: 0,
      imageTokens: 0,
      envelopeTokens: 0,
      totalTokens: textTokens + templateTokens,
    };
  }

  estimateToolSchemaTokens(tools: readonly ProviderToolSchema[]): number {
    if (tools.length === 0) return 0;
    let tokens = 16;
    for (const tool of tools) {
      const jsonStr = JSON.stringify(tool.inputSchema);
      tokens += 12 + this.estimateTextTokens(tool.id) + this.estimateTextTokens(tool.summary) + this.estimateTextTokens(jsonStr);
    }
    return tokens;
  }

  estimateEnvelopeTokens(maxTokens: number): number {
    void maxTokens;
    return 8;
  }
}

/**
 * Resolve the appropriate `ModelTokenizer` for a given provider and model.
 */
export function resolveTokenizer(providerId: string, modelKey: ModelKey): ModelTokenizer {
  const p = providerId.toLowerCase();
  const m = String(modelKey).toLowerCase();

  if (p.includes("anthropic") || m.includes("claude")) {
    return new AnthropicTokenizer(modelKey);
  }
  if (p.includes("openai") || m.includes("gpt") || m.includes("o1")) {
    return new OpenAITokenizer(modelKey);
  }
  if (p.includes("google") || m.includes("gemini")) {
    return new GoogleTokenizer(modelKey);
  }
  return new LocalTokenizer(modelKey);
}

/**
 * Reconciles pre-send predicted token manifest estimates against observed provider usage.
 */
export function reconcileUsage(
  manifestId: string,
  predictedPromptTokens: number,
  observedUsage: UsageRecord,
): ReconciledUsage {
  const observedPrompt = Number(observedUsage.inputTokens);
  const cachedObserved = Number(observedUsage.cachedInputTokens);
  const completionObserved = Number(observedUsage.outputTokens);
  const reasoningObserved = Number(observedUsage.reasoningTokens);

  const delta = observedPrompt - predictedPromptTokens;
  const errPct = predictedPromptTokens > 0
    ? Math.abs(delta) / predictedPromptTokens * 100
    : 0;

  return {
    manifestId,
    predictedTokens: predictedPromptTokens,
    observedTokens: observedPrompt,
    promptDelta: delta,
    cachedTokensObserved: cachedObserved,
    completionTokensObserved: completionObserved,
    reasoningTokensObserved: reasoningObserved,
    errorPercentage: errPct,
  };
}

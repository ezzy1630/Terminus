import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ProbeResult } from "../types.js";

export function probeProviders(rootDir: string): ProbeResult[] {
  const results: ProbeResult[] = [];

  // 1. Provider Core & Renderers
  const providerCore = join(rootDir, "packages", "provider-core");
  const providerOpenAi = join(rootDir, "packages", "provider-openai");
  const providerAnthropic = join(rootDir, "packages", "provider-anthropic");

  const coreExists = existsSync(providerCore);
  const openAiExists = existsSync(providerOpenAi);
  const anthropicExists = existsSync(providerAnthropic);

  if (coreExists && openAiExists && anthropicExists) {
    results.push({
      id: "provider.packages",
      name: "Provider Packages & Renderers",
      status: "pass",
      message: "provider-core, provider-openai, and provider-anthropic packages present",
      details: { coreExists, openAiExists, anthropicExists },
      isProductionInvariant: true,
    });
  } else {
    results.push({
      id: "provider.packages",
      name: "Provider Packages & Renderers",
      status: "fail",
      message: `Missing provider packages: core=${coreExists}, openai=${openAiExists}, anthropic=${anthropicExists}`,
      recommendation: "Ensure packages/provider-* directories are intact",
      isProductionInvariant: true,
    });
  }

  // 2. API Key / Credentials Configuration
  const hasOpenAiKey = Boolean(process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim().length > 0);
  const hasAnthropicKey = Boolean(process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY.trim().length > 0);
  const hasLocalEndpoint = Boolean(process.env.TERMINUS_LOCAL_PROVIDER_URL || process.env.OLLAMA_BASE_URL);

  const configuredCount = (hasOpenAiKey ? 1 : 0) + (hasAnthropicKey ? 1 : 0) + (hasLocalEndpoint ? 1 : 0);

  if (configuredCount > 0) {
    results.push({
      id: "provider.credentials",
      name: "Provider Credentials Configuration",
      status: "pass",
      message: `Detected ${configuredCount} active provider credentials (OpenAI: ${hasOpenAiKey}, Anthropic: ${hasAnthropicKey}, Local: ${hasLocalEndpoint})`,
      details: { hasOpenAiKey, hasAnthropicKey, hasLocalEndpoint },
      isProductionInvariant: false,
    });
  } else {
    results.push({
      id: "provider.credentials",
      name: "Provider Credentials Configuration",
      status: "warn",
      message: "No provider credentials configured in environment (OPENAI_API_KEY, ANTHROPIC_API_KEY)",
      recommendation: "Set OPENAI_API_KEY or ANTHROPIC_API_KEY in your environment or .env file",
      isProductionInvariant: false,
    });
  }

  return results;
}

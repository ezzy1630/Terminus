import { describe, expect, test } from "bun:test";
import {
  admitDirectModelRecord,
  configuredDirectProviderSnapshot,
  directSecretUri,
  parseDirectProviderConfiguration,
  DIRECT_PROVIDER_CONFIGURATION_ENV,
} from "./direct-provider-config.js";

describe("direct provider configuration (audit P0-2)", () => {
  test("parses a valid anthropic messages configuration", () => {
    const config = parseDirectProviderConfiguration(JSON.stringify({
      vendor: "anthropic",
      protocol: "messages",
      model: "claude-3-5-sonnet-20241022",
    }));
    expect(config).not.toBeNull();
    expect(config?.vendor).toBe("anthropic");
    expect(config?.protocol).toBe("messages");
    expect(config?.model).toBe("claude-3-5-sonnet-20241022");
    expect(config?.workspaceAccess).toBe(false);
    expect(config?.secretUri).toBe("secret://direct/anthropic");
  });

  test("parses openai responses configuration with workspace access", () => {
    const config = parseDirectProviderConfiguration(JSON.stringify({
      vendor: "openai",
      protocol: "responses",
      model: "gpt-4o",
      workspace_access: true,
    }));
    expect(config?.protocol).toBe("responses");
    expect(config?.workspaceAccess).toBe(true);
    expect(config?.secretUri).toBe(directSecretUri("openai"));
  });

  test("empty/missing environment yields no configuration", () => {
    expect(parseDirectProviderConfiguration(undefined)).toBeNull();
    expect(parseDirectProviderConfiguration(null)).toBeNull();
    expect(parseDirectProviderConfiguration("")).toBeNull();
    expect(parseDirectProviderConfiguration("   ")).toBeNull();
  });

  test("fails closed on malformed JSON, unknown vendors, protocols, and models", () => {
    expect(() => parseDirectProviderConfiguration("{not json")).toThrow(/not valid JSON/);
    expect(() => parseDirectProviderConfiguration(JSON.stringify({ vendor: "mistral", protocol: "messages", model: "x" })))
      .toThrow(/invalid/i);
    // Anthropic does not speak the OpenAI-only protocols.
    expect(() => parseDirectProviderConfiguration(JSON.stringify({ vendor: "anthropic", protocol: "responses", model: "claude-3-5-sonnet-20241022" })))
      .toThrow(/does not support protocol 'responses'/);
    // Unknown model ids have no offline catalog record.
    expect(() => parseDirectProviderConfiguration(JSON.stringify({ vendor: "openai", protocol: "chat_completions", model: "gpt-does-not-exist" })))
      .toThrow(/no record in the offline catalog/);
    expect(() => parseDirectProviderConfiguration(JSON.stringify({ vendor: "openai" }))).toThrow(/invalid/i);
  });

  test("catalog admission exposes capability and economics fields", () => {
    const model = admitDirectModelRecord("anthropic", "messages", "claude-3-5-sonnet-20241022");
    expect(model).not.toBeNull();
    expect(model?.contextTokens).toBeGreaterThan(0);
    expect(model?.inputMicrosPerMillion).toBe(3_000_000);
    expect(model?.cachedInputMicrosPerMillion).toBe(300_000);
    expect(model?.outputMicrosPerMillion).toBe(15_000_000);
    expect(model?.toolCalling).toBe(true);
    expect(admitDirectModelRecord("openai", "responses", "nope")).toBeNull();
  });

  test("capability snapshot mirrors gateway shape with vendor-specific caching", () => {
    const config = parseDirectProviderConfiguration(JSON.stringify({
      vendor: "anthropic",
      protocol: "messages",
      model: "claude-3-5-sonnet-20241022",
      workspace_access: true,
    }));
    if (config === null) throw new Error("expected config");
    const snapshot = configuredDirectProviderSnapshot(config, "2026-08-24T00:00:00Z" as never);
    expect(snapshot.providerId).toBe("anthropic");
    expect(snapshot.context.toolCalling).toBe(true);
    expect(snapshot.caching.mode).toBe("explicit_breakpoints");
    expect(snapshot.policy.allowedConfidentiality).toEqual(["public", "workspace"]);
    expect(snapshot.economics.inputMicrosPerMillion as unknown as bigint).toBe(3_000_000n);
    expect(snapshot.source).toMatch(/^terminus-control\/direct-provider-config-v1:[0-9a-f]{64}$/);
  });

  test("default confidentiality is public-only until workspace access is admitted", () => {
    const config = parseDirectProviderConfiguration(JSON.stringify({
      vendor: "openai",
      protocol: "chat_completions",
      model: "gpt-4o-mini",
    }));
    if (config === null) throw new Error("expected config");
    const snapshot = configuredDirectProviderSnapshot(config, "2026-08-24T00:00:00Z" as never);
    expect(snapshot.policy.allowedConfidentiality).toEqual(["public"]);
    expect(snapshot.continuation.nativeId).toBe(false);
  });

  test("the context ceiling is per-family, not a blanket 32,768", () => {
    const gpt = parseDirectProviderConfiguration(JSON.stringify({
      vendor: "openai", protocol: "responses", model: "gpt-5.6-sol",
    }));
    if (gpt === null) throw new Error("expected config");
    const gptSnapshot = configuredDirectProviderSnapshot(gpt, "2026-08-24T00:00:00Z" as never);
    expect(gptSnapshot.context.advertisedTokens).toBe(1_050_000);
    // The 272K billing cliff, not a capability limit.
    expect(gptSnapshot.context.testedSafeTokens).toBe(270_000);
    expect(gptSnapshot.context.maxOutputTokens).toBe(128_000);
    expect(gptSnapshot.context.parallelToolCalls).toBe(true);
    expect(gptSnapshot.caching).toMatchObject({
      mode: "explicit_breakpoints",
      exactPrefixRequired: true,
      minimumTokens: 1_024,
      ttlOptions: ["30m"],
    });
    expect(gptSnapshot.economics.cacheWriteMicrosPerMillion).toBe(
      (gptSnapshot.economics.inputMicrosPerMillion * 5n) / 4n,
    );

    const claude = parseDirectProviderConfiguration(JSON.stringify({
      vendor: "anthropic", protocol: "messages", model: "claude-opus-5",
    }));
    if (claude === null) throw new Error("expected config");
    const claudeSnapshot = configuredDirectProviderSnapshot(claude, "2026-08-24T00:00:00Z" as never);
    // Claude 5 gets its whole window: 1M is the default *and* the maximum.
    expect(claudeSnapshot.context.testedSafeTokens).toBe(1_000_000);
    expect(claudeSnapshot.context.maxOutputTokens).toBe(128_000);

    // Everything else keeps its catalog window, capped at 200k.
    const legacy = parseDirectProviderConfiguration(JSON.stringify({
      vendor: "openai", protocol: "responses", model: "gpt-4o",
    }));
    if (legacy === null) throw new Error("expected config");
    const legacySnapshot = configuredDirectProviderSnapshot(legacy, "2026-08-24T00:00:00Z" as never);
    expect(legacySnapshot.context.testedSafeTokens).toBe(128_000);
    expect(legacySnapshot.caching.mode).toBe("automatic_prefix");
  });

  test("Responses accounts are stateless: no continuation id to resume from", () => {
    const config = parseDirectProviderConfiguration(JSON.stringify({
      vendor: "openai", protocol: "responses", model: "gpt-5.6-sol",
    }));
    if (config === null) throw new Error("expected config");
    const snapshot = configuredDirectProviderSnapshot(config, "2026-08-24T00:00:00Z" as never);
    // `store: false` means there is no server-side response to point at.
    expect(snapshot.continuation.nativeId).toBe(false);
    expect(snapshot.continuation.crossRequest).toBe(false);
  });

  test("env variable name is exported for documentation and ops", () => {
    expect(DIRECT_PROVIDER_CONFIGURATION_ENV).toBe("TERMINUS_DIRECT_PROVIDER_JSON");
  });
});

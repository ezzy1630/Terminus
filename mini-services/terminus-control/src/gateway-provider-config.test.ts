import { describe, expect, test } from "bun:test";
import {
  configuredGatewayModel,
  configuredGatewayProviderSnapshot,
  gatewayCredentialBindingId,
  gatewayProviderConfigurationWire,
  parseGatewayProviderConfigurationUpdate,
} from "./gateway-provider-config.js";
import type { Rfc3339Timestamp } from "@terminus/domain";

const row = {
  deployment: "zen",
  protocol: "chat_completions",
  model: "gpt-5-nano",
  secretUri: "secret://opencode/zen",
  credentialConfigured: true,
  toolsEnabled: true,
  freeModel: true,
  workspaceAccess: false,
  privacyTermsAdmitted: false,
  privacyTermsVersion: null,
  revision: 2,
  updatedBy: "control",
  createdAt: new Date("2026-08-24T00:00:00Z"),
  updatedAt: new Date("2026-08-24T00:01:00Z"),
};

describe("gateway provider configuration", () => {
  test("never projects credential material", () => {
    const update = parseGatewayProviderConfigurationUpdate({
      deployment: "zen", protocol: "chat_completions", model: "gpt-5-nano",
      tools_enabled: true, free_model: true, workspace_access: false, credential: "secret-value", expected_revision: 0,
    });
    expect(update.credential).toBe("secret-value");
    expect(JSON.stringify(gatewayProviderConfigurationWire(row))).not.toContain("secret-value");
  });

  test("requires an admitted model discovery record", () => {
    expect(() => configuredGatewayModel(row, "2026-08-24T00:02:00.000Z" as Rfc3339Timestamp)).toThrow(
      "has no admitted discovery record",
    );
  });

  test("constructs a provider snapshot from an admitted model record", () => {
    const discovered = {
      id: "gpt-5-nano",
      name: "GPT-5 Nano",
      deployment: "zen" as const,
      providerId: "open_code_zen" as const,
      baseUrl: "https://opencode.ai/zen/v1",
      protocol: "chat_completions" as const,
      free: true,
      toolCalling: true,
      structuredOutput: true,
      imageInput: false,
      reasoning: false,
      contextTokens: 32_768,
      outputTokens: 8_192,
      inputMicrosPerMillion: 0,
      cachedInputMicrosPerMillion: 0,
      outputMicrosPerMillion: 0,
      observedAt: "2026-08-24T00:01:00.000Z",
    };
    const model = configuredGatewayModel(row, "2026-08-24T00:02:00.000Z" as Rfc3339Timestamp, discovered);
    const snapshot = configuredGatewayProviderSnapshot(model, row.revision, row.workspaceAccess);
    expect(model.baseUrl).toBe("https://opencode.ai/zen/v1");
    expect(model.protocol).toBe("chat_completions");
    expect(snapshot.providerId).toBe("open_code_zen");
    expect(snapshot.policy.allowedConfidentiality).toEqual(["public"]);
    expect(configuredGatewayProviderSnapshot(model, row.revision, true, true, "opencode-zen-privacy-v1").policy.allowedConfidentiality)
      .toEqual(["public", "workspace"]);
    expect(() => configuredGatewayModel(row, "2026-08-24T00:02:00.000Z" as Rfc3339Timestamp, {
      ...discovered,
      deployment: "go",
      providerId: "open_code_go",
    })).toThrow("has no admitted discovery record");
  });

  test("the gateway's large-window models keep their window", () => {
    const discovered = {
      id: "gpt-5-nano",
      name: "GPT-5 Nano",
      deployment: "zen" as const,
      providerId: "open_code_zen" as const,
      baseUrl: "https://opencode.ai/zen/v1",
      protocol: "chat_completions" as const,
      free: true,
      toolCalling: true,
      structuredOutput: true,
      imageInput: false,
      reasoning: false,
      contextTokens: 262_144,
      outputTokens: 64_000,
      inputMicrosPerMillion: 0,
      cachedInputMicrosPerMillion: 0,
      outputMicrosPerMillion: 0,
      observedAt: "2026-08-24T00:01:00.000Z",
    };
    const model = configuredGatewayModel(row, "2026-08-24T00:02:00.000Z" as Rfc3339Timestamp, discovered);
    const snapshot = configuredGatewayProviderSnapshot(model, row.revision, row.workspaceAccess);
    expect(snapshot.context.advertisedTokens).toBe(262_144);
    // Capped at the 200k default ceiling for an unknown family, not thrown
    // away down to the old blanket 32,768.
    expect(snapshot.context.testedSafeTokens).toBe(200_000);
    expect(snapshot.context.maxOutputTokens).toBe(64_000);
  });

  test("permits only an admitted free Zen model to use an anonymous binding", () => {
    const anonymousRow = { ...row, credentialConfigured: false, model: "gpt-5-nano" };
    const discovered = {
      id: "gpt-5-nano",
      name: "GPT-5 Nano",
      deployment: "zen" as const,
      providerId: "open_code_zen" as const,
      baseUrl: "https://opencode.ai/zen/v1",
      protocol: "chat_completions" as const,
      free: true,
      toolCalling: false,
      structuredOutput: true,
      imageInput: false,
      reasoning: false,
      contextTokens: 32_768,
      outputTokens: 8_192,
      inputMicrosPerMillion: 0,
      cachedInputMicrosPerMillion: 0,
      outputMicrosPerMillion: 0,
      observedAt: "2026-08-24T00:01:00.000Z",
    };
    const model = configuredGatewayModel(anonymousRow, "2026-08-24T00:02:00.000Z" as Rfc3339Timestamp, discovered);
    expect(gatewayCredentialBindingId(model, false)).toBe("");
    expect(() => configuredGatewayModel(
      { ...anonymousRow, model: "paid-model" },
      "2026-08-24T00:02:00.000Z" as Rfc3339Timestamp,
      { ...discovered, id: "paid-model", free: false },
    )).toThrow("gateway provider credential is not configured");
  });

  test("does not admit workspace content without recorded privacy terms", () => {
    expect(() => parseGatewayProviderConfigurationUpdate({
      deployment: "zen", protocol: "chat_completions", model: "gpt-5-nano",
      tools_enabled: true, free_model: true, workspace_access: true,
      expected_revision: 0,
    })).toThrow("current provider privacy terms");
  });

  test("rejects a credential URI that does not match the deployment", () => {
    expect(() => gatewayProviderConfigurationWire({ ...row, secretUri: "secret://opencode/go" })).toThrow("does not match");
  });

  test("requires the current provider terms identity for workspace access", () => {
    const input = {
      deployment: "zen",
      protocol: "chat_completions",
      model: "gpt-5-nano",
      tools_enabled: true,
      free_model: true,
      workspace_access: true,
      privacy_terms_admitted: true,
      privacy_terms_version: "opencode-go-privacy-v1",
      expected_revision: 0,
    };
    expect(() => parseGatewayProviderConfigurationUpdate(input)).toThrow("current provider privacy terms");
    expect(parseGatewayProviderConfigurationUpdate({
      ...input,
      privacy_terms_version: "opencode-zen-privacy-v1",
    }).privacy_terms_version).toBe("opencode-zen-privacy-v1");
  });
});

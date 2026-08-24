import { describe, expect, test } from "bun:test";
import {
  configuredGatewayModel,
  configuredGatewayProviderSnapshot,
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

  test("constructs an exact conservative model and provider snapshot", () => {
    const model = configuredGatewayModel(row, "2026-08-24T00:02:00.000Z" as Rfc3339Timestamp);
    const snapshot = configuredGatewayProviderSnapshot(model, row.revision, row.workspaceAccess);
    expect(model.baseUrl).toBe("https://opencode.ai/zen/v1");
    expect(model.protocol).toBe("chat_completions");
    expect(snapshot.providerId).toBe("open_code_zen");
    expect(snapshot.policy.allowedConfidentiality).toEqual(["public"]);
    expect(configuredGatewayProviderSnapshot(model, row.revision, true, true).policy.allowedConfidentiality)
      .toEqual(["public", "workspace"]);
  });

  test("does not admit workspace content without recorded privacy terms", () => {
    expect(() => parseGatewayProviderConfigurationUpdate({
      deployment: "zen", protocol: "chat_completions", model: "gpt-5-nano",
      tools_enabled: true, free_model: true, workspace_access: true,
      expected_revision: 0,
    })).toThrow("privacy terms admission");
  });

  test("rejects a credential URI that does not match the deployment", () => {
    expect(() => gatewayProviderConfigurationWire({ ...row, secretUri: "secret://opencode/go" })).toThrow("does not match");
  });
});

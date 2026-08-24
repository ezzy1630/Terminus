import { describe, expect, test } from "bun:test";
import {
  configuredLocalProviderSnapshot,
  parseProviderConfigurationInput,
  parseProviderConfigurationUpdate,
  providerConfigurationCommand,
  providerConfigurationWire,
} from "./provider-config.js";

import type { ModelKey, Rfc3339Timestamp } from "@terminus/domain";
import type { ProviderConfigurationInput } from "./provider-config.js";

describe("durable local provider configuration", () => {
  const input: ProviderConfigurationInput = {
    program: "terminus-provider-fixture",
    args: ["--stdio"],
    model: "local/test-model",
    timeout_seconds: 42,
    tools_enabled: false,
  };

  test("accepts exact argv and model fields, but rejects shell/control syntax", () => {
    expect(parseProviderConfigurationInput(input)).toEqual(input);
    expect(() => parseProviderConfigurationInput({ ...input, program: "provider\nnext" })).toThrow(/control delimiters/);
    expect(() => parseProviderConfigurationInput({ ...input, program: "provider; rm -rf" })).toThrow(/shell expression/);
    expect(() => parseProviderConfigurationInput({ ...input, args: [""] })).toThrow(/Too small/);
    expect(() => parseProviderConfigurationInput({ ...input, extra: true })).toThrow(/Unrecognized key/);
    expect(parseProviderConfigurationUpdate({ ...input, expected_revision: 0 }).expected_revision).toBe(0);
    expect(() => parseProviderConfigurationUpdate({ ...input, expected_revision: -1 })).toThrow(/invalid/);
  });

  test("projects a persisted row without credentials and reconstructs argv", () => {
    const row = {
      program: input.program,
      argsJson: JSON.stringify(input.args),
      model: input.model,
      timeoutSeconds: input.timeout_seconds,
      toolsEnabled: input.tools_enabled,
      revision: 3,
      updatedBy: "terminus-control-bearer",
      createdAt: new Date("2026-08-23T00:00:00.000Z"),
      updatedAt: new Date("2026-08-23T00:00:01.000Z"),
    };
    expect(providerConfigurationWire(row)).toMatchObject({ configured: true, configuration: { ...input, revision: 3 } });
    expect(providerConfigurationCommand(row)).toEqual({
      program: input.program,
      args: input.args,
      model: input.model as ModelKey,
      timeoutSeconds: input.timeout_seconds,
      toolsEnabled: input.tools_enabled,
    });
    expect(JSON.stringify(providerConfigurationWire(row))).not.toContain("api_key");
  });

  test("snapshot identifies the exact config while keeping unproven capabilities disabled", () => {
    const timestamp = "2026-08-23T00:00:00.000Z" as Rfc3339Timestamp;
    const first = configuredLocalProviderSnapshot(input, 1, timestamp);
    const second = configuredLocalProviderSnapshot(input, 2, timestamp);
    expect(first.providerId).toBe("local");
    expect(first.source).toMatch(/^terminus-control\/local-provider-config-v1:/);
    expect(first.source).not.toBe(second.source);
    expect(first.context.toolCalling).toBe(false);
    expect(configuredLocalProviderSnapshot({ ...input, tools_enabled: true }, 1, timestamp).context.toolCalling).toBe(true);
    expect(first.policy.retentionMode).toBe("local_only");
  });
});

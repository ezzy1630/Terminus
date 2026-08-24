import { afterEach, describe, expect, test, vi } from "vitest";
import { TerminusApiClient } from "../src/lib/api";

describe("desktop provider configuration API", () => {
  afterEach(() => vi.restoreAllMocks());

  test("decodes the control-plane configured state without credential fields", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      configured: true,
      configuration: {
        program: "terminus-provider-fixture",
        args: ["--stdio"],
        model: "local/test-model",
        timeout_seconds: 42,
        tools_enabled: false,
        revision: 2,
        updated_by: "terminus-control-bearer",
        created_at: "2026-08-23T00:00:00.000Z",
        updated_at: "2026-08-23T00:00:01.000Z",
      },
    })));
    const response = await new TerminusApiClient("http://127.0.0.1:3050", "token").getProviderConfiguration();
    expect(response.configured).toBe(true);
    expect(response.configuration?.model).toBe("local/test-model");
    expect(JSON.stringify(response)).not.toContain("api_key");
  });

  test("PUT sends argv/model as an idempotent mutation", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe("PUT");
      expect(new Headers(init?.headers).get("idempotency-key")).toBe("provider-config:test");
      expect(JSON.parse(String(init?.body))).toEqual({
        program: "provider",
        args: ["--stdio"],
        model: "local/test",
        timeout_seconds: 60,
        tools_enabled: true,
        expected_revision: 0,
      });
      return Response.json({
        configured: true,
        configuration: {
          program: "provider", args: ["--stdio"], model: "local/test", timeout_seconds: 60, tools_enabled: true,
          revision: 1, updated_by: "terminus-control-bearer",
          created_at: "2026-08-23T00:00:00.000Z", updated_at: "2026-08-23T00:00:00.000Z",
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const response = await new TerminusApiClient("http://127.0.0.1:3050", "token").putProviderConfiguration({
      program: "provider", args: ["--stdio"], model: "local/test", timeout_seconds: 60, tools_enabled: true, expected_revision: 0,
    }, { idempotencyKey: "provider-config:test" });
    expect(response.configuration?.program).toBe("provider");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("rejects a configured flag without a row", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ configured: true, configuration: null })));
    await expect(new TerminusApiClient("http://127.0.0.1:3050", "token").getProviderConfiguration()).rejects.toThrow(/configured without a row/);
  });
});

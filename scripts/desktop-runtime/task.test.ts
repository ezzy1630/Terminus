import { describe, expect, test } from "bun:test";
import { deterministicProviderCommand, parseDevToolsTargets } from "./task";

describe("packaged deterministic task helpers", () => {
  test("accepts only loopback renderer DevTools targets", () => {
    expect(
      parseDevToolsTargets([
        {
          type: "page",
          url: "terminus://app/index.html",
          webSocketDebuggerUrl: "ws://127.0.0.1:41231/devtools/page/abc",
        },
      ]),
    ).toEqual([
      {
        type: "page",
        url: "terminus://app/index.html",
        webSocketDebuggerUrl: "ws://127.0.0.1:41231/devtools/page/abc",
      },
    ]);
    expect(() =>
      parseDevToolsTargets([
        {
          type: "page",
          url: "terminus://app/index.html",
          webSocketDebuggerUrl: "ws://192.0.2.1:41231/devtools/page/abc",
        },
      ]),
    ).toThrow("not loopback-bound");
  });

  test("builds a tools-enabled local provider command without ambient credentials", () => {
    const parsed = JSON.parse(
      deterministicProviderCommand(
        "/opt/homebrew/bin/bun",
        "/tmp/workspace/provider.ts",
      ),
    ) as Record<string, unknown>;
    expect(parsed).toEqual({
      program: "/opt/homebrew/bin/bun",
      args: ["/tmp/workspace/provider.ts"],
      model: "local/e2e-model",
      timeout_seconds: 30,
      tools_enabled: true,
    });
    expect(JSON.stringify(parsed)).not.toContain("TOKEN");
  });
});

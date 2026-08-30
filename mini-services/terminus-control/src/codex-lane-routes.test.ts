import { describe, expect, test } from "bun:test";

describe("external Codex control-plane contract", () => {
  test("declares every route in the authenticated HTTP surface", async () => {
    const source = await Bun.file(new URL("./index.ts", import.meta.url)).text();
    for (const route of [
      '"/v1/external/codex/status"',
      '"/v1/external/codex/account"',
      '"/v1/external/codex/models"',
      '"/v1/external/codex/thread/start"',
      '"/v1/external/codex/thread/resume"',
      '"/v1/external/codex/turn/start"',
      '"/v1/external/codex/turn/interrupt"',
      '"/v1/external/codex/stop"',
    ]) {
      expect(source).toContain(route);
    }
    expect(source).toContain('if (!checkAuth(req))');
    expect(source).toContain('external_harness: CODEX_EXTERNAL_HARNESS');
  });

  test("keeps OpenCode connect consent and credential identity bounded", async () => {
    const source = await Bun.file(new URL("./index.ts", import.meta.url)).text();
    expect(source).toContain("expected_fingerprint: z.string().min(1).max(512)");
    expect(source).toContain("consent: z.literal(true)");
    expect(source).toContain("account.fingerprint !== parsed.data.expected_fingerprint");
    expect(source).toContain("ChatGPT subscriptions require the separate Codex App Server lane");
  });
});

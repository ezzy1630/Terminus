import { describe, expect, test } from "bun:test";

describe("external Codex control-plane contract", () => {
  test("declares every route in the authenticated HTTP surface", async () => {
    const source = await Bun.file(new URL("./index.ts", import.meta.url)).text();
    for (const route of [
      '"/v1/external/codex/status"',
      '"/v1/external/codex/account"',
      '"/v1/external/codex/models"',
      '"/v1/external/codex/events"',
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
    expect(source).toContain("cursor_expired");
    expect(source).toContain("codexLaneEventBuffers.get(codexLaneKey");
    const eventsStart = source.indexOf('route("GET", "/v1/external/codex/events"');
    const accountStart = source.indexOf('route("GET", "/v1/external/codex/account"');
    expect(eventsStart).toBeGreaterThanOrEqual(0);
    expect(accountStart).toBeGreaterThan(eventsStart);
    expect(source.slice(eventsStart, accountStart)).not.toContain("getCodexLaneSession");
    const statusStart = source.indexOf('route("GET", "/v1/external/codex/status"');
    expect(statusStart).toBeGreaterThanOrEqual(0);
    expect(source.slice(statusStart, eventsStart)).not.toContain("await lane.open");
    expect(source.slice(statusStart, eventsStart)).toContain("codexStatusFromPersisted");
  });

  test("keeps OpenCode connect consent and credential identity bounded", async () => {
    const source = await Bun.file(new URL("./index.ts", import.meta.url)).text();
    expect(source).toContain("expected_fingerprint: z.string().regex(/^[0-9a-f]{64}$/)");
    expect(source).toContain("expected_destination: z.string().url().max(2_048)");
    expect(source).toContain("expected_catalog_digest: z.string().regex(/^sha256:[0-9a-f]{64}$/)");
    expect(source).toContain("consent: z.literal(true)");
    expect(source).toContain("account.fingerprint !== parsed.data.expected_fingerprint");
    expect(source).toContain("account.baseUrl !== parsed.data.expected_destination");
    expect(source).toContain("account.catalogDigest !== parsed.data.expected_catalog_digest");
    expect(source).toContain("ChatGPT subscriptions require the separate Codex App Server lane");
  });
});

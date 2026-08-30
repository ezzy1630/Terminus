import { describe, expect, test } from "bun:test";
import { computeContentHash } from "@terminus/context-ir";
import type { CapabilityCard } from "@terminus/aci";
import { CapabilityDiscoverySession } from "./capability-discovery.js";

function card(input: {
  readonly id: string;
  readonly purpose: string;
  readonly kind?: CapabilityCard["kind"];
  readonly schemaCostTokens?: number;
}): CapabilityCard {
  return {
    id: input.id,
    version: "1",
    kind: input.kind ?? "tool_pack",
    name: input.id.replace(/^standalone\./, ""),
    purpose: input.purpose,
    effects: ["read"],
    trustLevel: "builtin",
    schemaCostTokens: input.schemaCostTokens ?? 100,
    useWhen: [input.purpose],
    doNotUseWhen: [],
    definitionHash: computeContentHash(input.id),
  };
}

describe("CapabilityDiscoverySession", () => {
  const cards = [
    card({ id: "standalone.web_fetch", purpose: "Fetch a public HTTPS source", schemaCostTokens: 180 }),
    card({ id: "skill.release_notes", purpose: "Draft release notes from repository changes", kind: "skill", schemaCostTokens: 80 }),
    card({ id: "tool.database", purpose: "Inspect a governed database", schemaCostTokens: 240 }),
  ];

  test("searches compact cards deterministically and exposes real continuation", () => {
    const session = new CapabilityDiscoverySession(cards, []);
    const first = session.execute({ action: "list", limit: 2, cursor: 0 });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.message);
    expect(first.data).toMatchObject({
      action: "list",
      total_matches: 3,
      omitted_count: 1,
      next_cursor: 2,
    });
    expect(first.data.cards?.map((entry) => entry.id)).toEqual([
      "skill.release_notes",
      "standalone.web_fetch",
    ]);

    const second = session.execute({ action: "list", limit: 2, cursor: 2 });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error(second.message);
    expect(second.data).toMatchObject({
      total_matches: 3,
      omitted_count: 0,
      next_cursor: null,
    });
    expect(second.data.cards?.map((entry) => entry.id)).toEqual(["tool.database"]);

    const search = session.execute({ action: "search", query: "HTTPS public", limit: 8, cursor: 0 });
    expect(search.ok).toBe(true);
    if (!search.ok) throw new Error(search.message);
    expect(search.data.cards?.map((entry) => entry.id)).toEqual(["standalone.web_fetch"]);
  });

  test("filters by kind without exposing a full tool schema", () => {
    const session = new CapabilityDiscoverySession(cards, []);
    const result = session.execute({ action: "list", kind: "skill", limit: 8, cursor: 0 });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.data.cards?.map((entry) => entry.id)).toEqual(["skill.release_notes"]);
    expect(result.data.cards?.[0]).not.toHaveProperty("inputSchema");
    expect(result.data.cards?.[0]).not.toHaveProperty("resultSchema");
  });

  test("activates only an exact admitted id and hashes the active definitions", () => {
    const session = new CapabilityDiscoverySession(cards, []);
    const missing = session.execute({ action: "activate", capability_id: "standalone.missing" });
    expect(missing).toEqual({
      ok: false,
      message: "Capability 'standalone.missing' is not admitted. Search capability cards and activate an exact id.",
    });
    expect(session.activeCapabilityIds()).toEqual([]);

    const activated = session.execute({ action: "activate", capability_id: "standalone.web_fetch" });
    expect(activated.ok).toBe(true);
    if (!activated.ok) throw new Error(activated.message);
    expect(activated.data).toMatchObject({
      action: "activate",
      active_capabilities: ["standalone.web_fetch"],
      schema_cost_tokens: 180,
    });
    expect(activated.data.active_tool_set_hash).toMatch(/^sha256:[0-9a-f]{64}$/);

    const status = session.execute({ action: "status" });
    expect(status.ok).toBe(true);
    if (!status.ok) throw new Error(status.message);
    expect(status.data.active_capabilities).toEqual(["standalone.web_fetch"]);

    const deactivated = session.execute({ action: "deactivate", capability_id: "standalone.web_fetch" });
    expect(deactivated.ok).toBe(true);
    expect(session.activeCapabilityIds()).toEqual([]);
  });

  test("rejects duplicate and invalid admitted cards instead of resolving ambiguously", () => {
    expect(() => new CapabilityDiscoverySession([cards[0]!, cards[0]!], [])).toThrow(/duplicate capability card/);
    expect(() => new CapabilityDiscoverySession([
      { ...cards[0]!, definitionHash: "not-a-hash" as CapabilityCard["definitionHash"] },
    ], [])).toThrow(/definition hash/);
  });
});

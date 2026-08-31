import { describe, expect, test } from "bun:test";
import { computeContentHash } from "@terminus/context-ir";
import type { CapabilityCard } from "@terminus/aci";
import {
  CapabilityDiscoverySession,
  recoverCommittedActiveCapabilityIds,
} from "./capability-discovery.js";

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
    expect(session.observationSnapshot()).toBeNull();
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

  test("recovers the latest committed active set and drops stale capability ids", () => {
    expect(recoverCommittedActiveCapabilityIds(
      ["tool.database"],
      [
        "not-json",
        JSON.stringify({ active_capabilities: ["tool.database", "standalone.web_fetch"] }),
        JSON.stringify({ capability_id: "workspace" }),
        JSON.stringify({ active_capabilities: ["standalone.web_fetch", "retired.tool"] }),
      ],
      cards.map((entry) => entry.id),
    )).toEqual(["standalone.web_fetch"]);
  });

  test("rejects duplicate and invalid admitted cards instead of resolving ambiguously", () => {
    expect(() => new CapabilityDiscoverySession([cards[0]!, cards[0]!], [])).toThrow(/duplicate capability card/);
    expect(() => new CapabilityDiscoverySession([
      { ...cards[0]!, definitionHash: "not-a-hash" as CapabilityCard["definitionHash"] },
    ], [])).toThrow(/definition hash/);
  });

  test("records deterministic discovery counters without exposing them in outcomes", () => {
    const session = new CapabilityDiscoverySession(cards, ["tool.database"], {
      observe: true,
      admittedCatalogCostTokens: 45,
    });
    const listed = session.execute({ action: "list", limit: 8, cursor: 0 });
    const searched = session.execute({ action: "search", query: "HTTPS", limit: 8, cursor: 0 });
    const described = session.execute({ action: "describe", capability_id: "standalone.web_fetch" });
    const activated = session.execute(
      { action: "activate", capability_id: "standalone.web_fetch" },
      { activationLatencyMs: 12 },
    );
    expect(listed.ok && searched.ok && described.ok && activated.ok).toBe(true);
    expect(activated.ok && "observation" in activated.data).toBe(false);
    expect(session.observationSnapshot()).toMatchObject({
      admitted_card_count: 3,
      admitted_catalog_cost_tokens: 45,
      admitted_full_schema_cost_tokens: 500,
      initial_active_schema_cost_tokens: 240,
      initial_deferred_schema_cost_tokens: 260,
      list_attempts: 1,
      search_attempts: 1,
      describe_attempts: 1,
      activate_attempts: 1,
      deactivate_attempts: 0,
      successful_selections: 1,
      failed_selections: 0,
      activation_latency_ms_total: 12,
      activation_latency_samples: 1,
      final_active_schema_cost_tokens: 420,
    });
    expect(session.observationSnapshot()?.active_tool_set_hash).toBe(session.activeToolSetHash());
  });

  test("counts failed exact-id activation and leaves the active set unchanged", () => {
    const session = new CapabilityDiscoverySession(cards, [], {
      observe: true,
      admittedCatalogCostTokens: 45,
    });
    expect(session.execute({ action: "activate", capability_id: "standalone.missing" }).ok).toBe(false);
    expect(session.activeCapabilityIds()).toEqual([]);
    expect(session.observationSnapshot()).toMatchObject({
      activate_attempts: 1,
      successful_selections: 0,
      failed_selections: 1,
      final_active_schema_cost_tokens: 0,
    });
  });

  test("counts repeated activation and deactivation attempts while keeping set semantics", () => {
    const session = new CapabilityDiscoverySession(cards, [], {
      observe: true,
      admittedCatalogCostTokens: 45,
    });
    session.execute({ action: "activate", capability_id: "standalone.web_fetch" });
    session.execute({ action: "activate", capability_id: "standalone.web_fetch" });
    session.execute({ action: "deactivate", capability_id: "standalone.web_fetch" });
    session.execute({ action: "deactivate", capability_id: "standalone.web_fetch" });
    expect(session.activeCapabilityIds()).toEqual([]);
    expect(session.observationSnapshot()).toMatchObject({
      activate_attempts: 2,
      deactivate_attempts: 2,
      successful_selections: 2,
      failed_selections: 0,
      final_active_schema_cost_tokens: 0,
    });
  });

  test("calculates deferred schema tokens as admitted minus initially active", () => {
    const session = new CapabilityDiscoverySession(
      cards,
      ["standalone.web_fetch", "skill.release_notes"],
      { observe: true, admittedCatalogCostTokens: 45 },
    );
    expect(session.observationSnapshot()).toMatchObject({
      admitted_catalog_cost_tokens: 45,
      admitted_full_schema_cost_tokens: 500,
      initial_active_schema_cost_tokens: 260,
      initial_deferred_schema_cost_tokens: 240,
    });
  });

  test("ignores observation metadata when observation is disabled", () => {
    const session = new CapabilityDiscoverySession(cards, []);
    const outcome = session.execute(
      { action: "activate", capability_id: "standalone.web_fetch" },
      { activationLatencyMs: Number.NaN },
    );
    expect(outcome.ok).toBe(true);
    expect(session.activeCapabilityIds()).toEqual(["standalone.web_fetch"]);
    expect(session.observationSnapshot()).toBeNull();
  });

  test("rejects unsafe observation inputs before recording them", () => {
    expect(() => new CapabilityDiscoverySession(cards, [], {
      observe: true,
      admittedCatalogCostTokens: 100_000_001,
    })).toThrow(/admitted catalog cost/);
    const maximumSafeCostCard = {
      ...cards[0]!,
      schemaCostTokens: Number.MAX_SAFE_INTEGER,
    };
    expect(() => new CapabilityDiscoverySession([maximumSafeCostCard], [])).not.toThrow();
    expect(() => new CapabilityDiscoverySession([
      maximumSafeCostCard,
      { ...cards[1]!, schemaCostTokens: 1 },
    ], [], {
      observe: true,
      admittedCatalogCostTokens: 45,
    })).toThrow(/schema token total/);

    const session = new CapabilityDiscoverySession(cards, [], {
      observe: true,
      admittedCatalogCostTokens: 45,
    });
    expect(() => session.execute(
      { action: "activate", capability_id: "standalone.web_fetch" },
      { activationLatencyMs: 86_400_001 },
    )).toThrow(/activation latency/);
    expect(session.observationSnapshot()).toMatchObject({
      activate_attempts: 0,
      activation_latency_ms_total: 0,
      activation_latency_samples: 0,
    });
  });
});

import { describe, expect, test } from "bun:test";
import type { ProviderReasoningItem, ProviderResponseChunk } from "./index.js";
import {
  ReasoningReplayLedger,
  parseReasoningReplay,
  serializeReasoningReplay,
} from "./reasoning_replay.js";

function item(id: string, signature: string): ProviderReasoningItem {
  return { id, encryptedContent: signature, summary: [`thought ${id}`] };
}

function call(id: string): ProviderResponseChunk {
  return { kind: "tool_call", toolCall: { toolCallId: id, toolName: "read", arguments: {} } };
}

function reasoning(value: ProviderReasoningItem): ProviderResponseChunk {
  return { kind: "text", reasoningItem: value };
}

describe("ReasoningReplayLedger", () => {
  test("attaches each run of reasoning to the call that followed it", () => {
    const ledger = new ReasoningReplayLedger();
    const all = ledger.ingest([
      reasoning(item("rs_1", "sig-1")),
      call("call_a"),
      reasoning(item("rs_2", "sig-2")),
      reasoning(item("rs_3", "sig-3")),
      call("call_b"),
      // A trailing run with no following call belongs to the final message.
      reasoning(item("rs_4", "sig-4")),
    ]);
    expect(all.map((entry) => entry.id)).toEqual(["rs_1", "rs_2", "rs_3", "rs_4"]);
    expect(ledger.itemsFor("call_a").map((entry) => entry.id)).toEqual(["rs_1"]);
    expect(ledger.itemsFor("call_b").map((entry) => entry.id)).toEqual(["rs_2", "rs_3"]);
    expect(ledger.itemsFor("call_missing")).toEqual([]);
    expect(ledger.size).toBe(2);
  });

  test("ingestAll reports the flat list and the keyed entries from one walk", () => {
    const ledger = new ReasoningReplayLedger();
    const { items, entries } = ledger.ingestAll([
      reasoning(item("rs_1", "sig-1")),
      call("call_a"),
      reasoning(item("rs_2", "sig-2")),
    ]);
    expect(items.map((entry) => entry.id)).toEqual(["rs_1", "rs_2"]);
    // Only the replayable association survives into `entries`; `rs_2` has no
    // call to be replayed before.
    expect(entries).toEqual([{ callId: "call_a", items: [item("rs_1", "sig-1")] }]);
  });

  test("seeding restores a persisted map into a fresh ledger", () => {
    const first = new ReasoningReplayLedger();
    first.ingest([reasoning(item("rs_1", "sig-1")), call("call_a")]);

    // What a control plane restarted mid-turn has to reconstruct: the tool
    // call is still in the database and will be rendered again, and replaying
    // it without its signed reasoning is a 400.
    const rebuilt = new ReasoningReplayLedger();
    expect(rebuilt.itemsFor("call_a")).toEqual([]);
    rebuilt.seed(parseReasoningReplay(serializeReasoningReplay(first.entries())));
    expect(rebuilt.itemsFor("call_a")).toEqual([item("rs_1", "sig-1")]);
  });

  test("a live observation is never clobbered by a stale seed", () => {
    const ledger = new ReasoningReplayLedger();
    ledger.record("call_a", [item("rs_new", "sig-new")]);
    ledger.seed([{ callId: "call_a", items: [item("rs_old", "sig-old")] }]);
    expect(ledger.itemsFor("call_a")).toEqual([item("rs_new", "sig-new")]);
  });

  test("empty call ids and empty runs are not recorded", () => {
    const ledger = new ReasoningReplayLedger();
    ledger.record("", [item("rs_1", "sig-1")]);
    ledger.record("call_a", []);
    ledger.seed([{ callId: "", items: [item("rs_2", "sig-2")] }]);
    ledger.ingest([call("call_b")]);
    expect(ledger.size).toBe(0);
  });

  test("a round trip preserves the signature byte for byte", () => {
    const signature = "ErUBCkYIBRgCKkD+".repeat(8);
    const entries = [{ callId: "call_a", items: [{ id: "rs_1", encryptedContent: signature, summary: ["a", "b"] }] }];
    expect(parseReasoningReplay(serializeReasoningReplay(entries))).toEqual(entries);
  });

  test("a corrupt or foreign column degrades to no replay instead of throwing", () => {
    // The cost of a missing entry is a re-derived chain; the cost of a throw
    // is a dead turn.
    expect(parseReasoningReplay(null)).toEqual([]);
    expect(parseReasoningReplay(undefined)).toEqual([]);
    expect(parseReasoningReplay("")).toEqual([]);
    expect(parseReasoningReplay("{not json")).toEqual([]);
    expect(parseReasoningReplay('{"call_id":"a"}')).toEqual([]);
    expect(parseReasoningReplay('[{"call_id":"a"}]')).toEqual([]);
    expect(parseReasoningReplay('[{"call_id":"a","items":[{"id":"rs_1"}]}]')).toEqual([]);
    expect(parseReasoningReplay('[{"items":[{"id":"rs_1","encrypted_content":"s"}]}]')).toEqual([]);
    expect(parseReasoningReplay('[{"call_id":"a","items":[{"id":"rs_1","encrypted_content":"s"}]}]'))
      .toEqual([{ callId: "a", items: [{ id: "rs_1", encryptedContent: "s", summary: [] }] }]);
  });
});

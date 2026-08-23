import { describe, expect, test } from "bun:test";
import type {
  ContentHash,
  ContextFragment,
  ModelKey,
  Rfc3339Timestamp,
} from "@terminus/context-ir";
import { compactContext } from "./compaction.js";

const MODEL = "local/test" as ModelKey;
const NOW = "2026-08-22T00:00:00Z" as Rfc3339Timestamp;

function fragment(id: string, kind: ContextFragment["kind"], authority: number, text: string): ContextFragment {
  const hash = `sha256:${id.padEnd(64, "0").slice(0, 64)}` as ContentHash;
  return {
    id,
    kind,
    contentRef: {
      hash,
      uri: `artifact://sha256/${hash.slice("sha256:".length)}` as ContextFragment["contentRef"]["uri"],
      mediaType: "text/plain",
      bytes: BigInt(text.length) as ContextFragment["contentRef"]["bytes"],
    },
    textContent: text,
    source: {
      uri: `test://${id}`,
      producer: "test",
      producerVersion: "v1",
      observedAt: NOW,
      observedBy: "control",
      evidenceRefs: [],
    },
    sourceVersion: null,
    authority,
    priority: authority,
    trust: "derived",
    confidentiality: "workspace",
    injectionRisk: "low",
    exactness: "recoverable_by_reference",
    scope: { workspaceId: null, sessionId: null, taskId: null, pathPatterns: [] },
    freshness: { observedAt: NOW, sourceVersion: null, stale: false, staleReason: null },
    dependencies: [],
    invalidation: [],
    estimatedTokens: { [MODEL]: 20 },
    selectionFeatures: {
      relevance: 1,
      novelty: 0.5,
      coverage: 1,
      uncertaintyReduction: 1,
      riskReduction: 1,
      modelCompatibility: 1,
      redundancyPenalty: 0,
      injectionPenalty: 0,
    },
  };
}

describe("semantic context compaction", () => {
  test("preserves authoritative invariants and links summaries to exact evidence", () => {
    const authority = fragment("authority", "authority", 100, "Never bypass the kernel.");
    const contract = fragment("contract", "task_contract", 95, "Complete the requested task.");
    const codeA = fragment("code-a", "code", 40, "const first = true;");
    const codeB = fragment("code-b", "code", 40, "const second = true;");

    const result = compactContext({
      fragments: [authority, contract, codeA, codeB],
      modelKey: MODEL,
      targetTokens: 1,
      observedAt: NOW,
      invariants: [{ id: "task", statement: contract.textContent!, evidenceFragmentIds: [contract.id] }],
    });

    expect(result.fragments.map((item) => item.id)).toContain(authority.id);
    expect(result.fragments.map((item) => item.id)).toContain(contract.id);
    expect(result.transforms).toHaveLength(1);
    const summary = result.fragments.find((item) => item.id.startsWith("compacted:code:"));
    expect(summary?.exactness).toBe("recoverable_by_reference");
    expect(summary?.source.evidenceRefs.map((ref) => ref.hash)).toEqual(
      expect.arrayContaining([codeA.contentRef.hash, codeB.contentRef.hash]),
    );
    expect(result.preservedInvariantIds).toContain("task");
  });

  test("keeps complete tool episodes exact while compacting other history", () => {
    const call = fragment("runtime:episode:call:tool_call", "recent_episode", 40, "tool call");
    const result = {
      ...fragment("runtime:episode:result:tool_result", "recent_episode", 40, "tool result"),
      dependencies: [call.id],
    } satisfies ContextFragment;
    const codeA = fragment("code-a", "code", 40, "first");
    const codeB = fragment("code-b", "code", 40, "second");

    const compacted = compactContext({
      fragments: [call, result, codeA, codeB],
      modelKey: MODEL,
      targetTokens: 1,
      observedAt: NOW,
    });

    expect(compacted.fragments.map((item) => item.id)).toEqual([
      call.id,
      result.id,
      expect.stringMatching(/^compacted:code:/),
    ]);
    expect(compacted.transforms[0]?.inputFragmentIds).toEqual([codeA.id, codeB.id]);
  });

  test("is deterministic for identical inputs", () => {
    const input = {
      fragments: [fragment("one", "documentation", 30, "one"), fragment("two", "documentation", 30, "two")],
      modelKey: MODEL,
      targetTokens: 1,
      observedAt: NOW,
    } as const;
    const first = compactContext(input);
    const second = compactContext(input);
    expect(first.fragments.map((item) => item.contentRef.hash)).toEqual(
      second.fragments.map((item) => item.contentRef.hash),
    );
    expect(first.transforms).toEqual(second.transforms);
  });
});

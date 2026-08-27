import { describe, expect, test } from "bun:test";
import {
  buildRepositoryMapFragment,
  hydrateSearchHit,
  hashFragmentText,
  type RepoMapEntry,
  type SearchHit,
} from "./retrieval-hydrator.js";

function readerFor(files: Record<string, string>) {
  return async (input: { path: string; startLine: number; endLine: number }) => {
    const content = files[input.path];
    if (content === undefined) return { content: null, fileSha256: null, totalLines: null };
    // Emulate the kernel's ranged read: slice [startLine, endLine] (1-based,
    // inclusive).
    const allLines = content.split("\n");
    const sliced = allLines.slice(input.startLine - 1, input.endLine).join("\n");
    return {
      content: sliced,
      fileSha256: `sha256:${"0".repeat(64)}`,
      totalLines: allLines.length,
    };
  };
}

describe("hydrateSearchHit", () => {
  test("renders a line-numbered source span with symbol and version", async () => {
    const files = {
      "src/auth.ts": Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n"),
    };
    const hit: SearchHit = { path: "src/auth.ts", line: 20, symbol: "login", method: "tree_sitter" };
    const span = await hydrateSearchHit(hit, readerFor(files));
    expect(span).not.toBeNull();
    expect(span!.fragmentText).toContain("symbol: login");
    expect(span!.fragmentText).toMatch(/20→ line 20/);
    expect(span!.startLine).toBeLessThan(20);
    expect(span!.endLine).toBeGreaterThanOrEqual(20);
    expect(span!.fileSha256).toStartWith("sha256:");
  });

  test("reports truncation when the span is bounded", async () => {
    const files = {
      "big.ts": Array.from({ length: 500 }, (_, i) => `l${i + 1}`).join("\n"),
    };
    const hit: SearchHit = { path: "big.ts", line: 5, symbol: null, method: "lexical_bm25" };
    const span = await hydrateSearchHit(hit, readerFor(files), { contextLines: 2, maxSpanLines: 10 });
    expect(span!.truncated).toBe(true);
    expect(span!.fragmentText).toContain("truncation");
  });

  test("returns null for a deleted file so callers can fall back", async () => {
    const span = await hydrateSearchHit(
      { path: "gone.ts", line: 1, symbol: null, method: "lexical_bm25" },
      readerFor({}),
    );
    expect(span).toBeNull();
  });
});

describe("buildRepositoryMapFragment", () => {
  const entries: RepoMapEntry[] = [
    { path: "a.ts", symbols: ["alpha", "beta"] },
    { path: "b.ts", symbols: [] },
  ];
  test("renders one line per file with symbols", () => {
    const map = buildRepositoryMapFragment(entries);
    expect(map.entryCount).toBe(2);
    expect(map.omittedEntries).toBe(0);
    expect(map.text).toContain("a.ts: alpha, beta");
    expect(map.text).toContain("b.ts");
  });

  test("states omitted entries beyond the budget instead of silently dropping", () => {
    const map = buildRepositoryMapFragment(entries, { maxEntries: 1 });
    expect(map.entryCount).toBe(1);
    expect(map.omittedEntries).toBe(1);
    expect(map.text).toContain("omitted");
  });

  test("preserves page omissions and the opaque continuation", () => {
    const map = buildRepositoryMapFragment([entries[0]!], {
      omittedEntries: 4,
      continuationToken: "v1|sha256:revision|1",
    });
    expect(map.omittedEntries).toBe(4);
    expect(map.text).toContain("showing 1 of 5 indexed files");
    expect(map.text).toContain("continuation: v1|sha256:revision|1");
  });
});

describe("hashFragmentText", () => {
  test("is stable across calls", () => {
    expect(hashFragmentText("hello")).toBe(hashFragmentText("hello"));
    expect(hashFragmentText("hello")).not.toBe(hashFragmentText("world"));
  });
});

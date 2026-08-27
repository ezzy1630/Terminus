import { describe, expect, test } from "bun:test";
import {
  readCompleteRepositoryMap,
  type RepositoryMapPage,
} from "./repository-map.js";

const revision = `sha256:${"a".repeat(64)}`;
const sourceHash = `sha256:${"b".repeat(64)}`;

function page(
  paths: readonly string[],
  continuationToken: string | null,
  totalEntries = paths.length,
  indexRevision = revision,
): RepositoryMapPage {
  return {
    entries: paths.map((path) => ({
      path,
      symbols: path.endsWith(".ts") ? [path.replace(".ts", "Symbol")] : [],
      sourceSha256: sourceHash,
    })),
    indexRevision,
    totalEntries,
    truncated: continuationToken !== null,
    continuationToken,
  };
}

describe("complete repository map reads", () => {
  test("follows every opaque continuation and returns one complete revision", async () => {
    const calls: Array<{ readonly continuationToken: string; readonly pageNumber: number }> = [];
    const pages = new Map<string, RepositoryMapPage>([
      ["", page(["a.ts", "b.rs"], "opaque:next", 3)],
      ["opaque:next", page(["c.ts"], null, 3)],
    ]);

    const result = await readCompleteRepositoryMap({
      readPage: async (continuationToken, pageNumber) => {
        calls.push({ continuationToken, pageNumber });
        const response = pages.get(continuationToken);
        if (response === undefined) throw new Error("unexpected continuation");
        return response;
      },
    });

    expect(calls).toEqual([
      { continuationToken: "", pageNumber: 0 },
      { continuationToken: "opaque:next", pageNumber: 1 },
    ]);
    expect(result.entries.map((entry) => entry.path)).toEqual(["a.ts", "b.rs", "c.ts"]);
    expect(result.totalEntries).toBe(3);
    expect(result.truncated).toBe(false);
    expect(result.continuationToken).toBeNull();
  });

  test("rejects a revision change between pages", async () => {
    let callCount = 0;
    await expect(readCompleteRepositoryMap({
      readPage: async () => {
        callCount += 1;
        return callCount === 1
          ? page(["a.ts"], "next", 2)
          : page(["b.ts"], null, 2, `sha256:${"c".repeat(64)}`);
      },
    })).rejects.toThrow("changed index revision");
  });

  test("rejects an incomplete final page and inconsistent truncation", async () => {
    await expect(readCompleteRepositoryMap({
      readPage: async () => page(["a.ts"], null, 2),
    })).rejects.toThrow("ended before its declared entry count");

    await expect(readCompleteRepositoryMap({
      readPage: async () => ({ ...page(["a.ts"], null), truncated: true }),
    })).rejects.toThrow("inconsistent repository map continuation");
  });

  test("rejects unsorted, unsafe, and repeated page data", async () => {
    await expect(readCompleteRepositoryMap({
      readPage: async () => page(["b.ts", "a.ts"], null),
    })).rejects.toThrow("unsafe or unsorted");

    await expect(readCompleteRepositoryMap({
      readPage: async () => page(["../secret.ts"], null),
    })).rejects.toThrow("unsafe or unsorted");

    let callCount = 0;
    await expect(readCompleteRepositoryMap({
      readPage: async () => {
        callCount += 1;
        return page([callCount === 1 ? "a.ts" : "b.ts"], "same", 2);
      },
    })).rejects.toThrow("repeated continuation");
  });

  test("fails closed at the entry and page bounds", async () => {
    await expect(readCompleteRepositoryMap({
      maxEntries: 1,
      readPage: async () => page(["a.ts"], "next", 2),
    })).rejects.toThrow("complete-read bound");

    await expect(readCompleteRepositoryMap({
      maxPages: 1,
      readPage: async () => page(["a.ts"], "next", 2),
    })).rejects.toThrow("page bound");
  });
});

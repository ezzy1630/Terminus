import { describe, expect, test } from "bun:test";
import {
  generateUuid7,
  uuid7TimestampMs,
  compareUuid7,
  canonicalizeUri,
  canonicalizeResourceUri,
  uuid7Schema,
} from "./ids.js";

describe("UUIDv7 and URI Canonicalization", () => {
  test("generateUuid7 produces valid UUIDv7 strings matching schema", () => {
    const id = generateUuid7();
    expect(uuid7Schema.safeParse(id).success).toBe(true);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test("uuid7TimestampMs extracts precise timestamp", () => {
    const fixedTime = 1720000000123;
    const id = generateUuid7(fixedTime);
    const extracted = uuid7TimestampMs(id);
    expect(extracted).toBe(fixedTime);
  });

  test("compareUuid7 preserves chronological and lexicographical order", () => {
    const t1 = 1720000000000;
    const t2 = 1720000005000;
    const id1 = generateUuid7(t1);
    const id2 = generateUuid7(t2);
    expect(compareUuid7(id1, id2)).toBeLessThan(0);
    expect(compareUuid7(id2, id1)).toBeGreaterThan(0);
    expect(compareUuid7(id1, id1)).toBe(0);
    expect(id1.localeCompare(id2)).toBeLessThan(0);
  });

  test("canonicalizeUri normalizes file paths and URIs correctly", () => {
    expect(canonicalizeUri("/foo/bar/../baz")).toBe("file:///foo/baz");
    expect(canonicalizeUri("file:///foo/./bar//baz")).toBe("file:///foo/bar/baz");
    expect(canonicalizeUri("workspace://dir1/./sub/../file.txt")).toBe("workspace://dir1/file.txt");
    expect(canonicalizeUri("task://12345678-1234-7890-89ab-1234567890ab")).toBe("task://12345678-1234-7890-89ab-1234567890ab");
  });

  test("canonicalizeResourceUri throws on invalid URI format", () => {
    expect(() => canonicalizeResourceUri("invalid-scheme://foo")).toThrow();
  });
});

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createDeterministicArchive, readDeterministicArchive } from "./archive";

const fixtures = [
  { path: "terminus-control/bin/terminus-control", bytes: Buffer.from("binary"), mode: 0o755 },
  { path: "terminus-control/share/terminus/schema.prisma", bytes: Buffer.from("schema"), mode: 0o644 },
] as const;

describe("deterministic control runtime archive", () => {
  test("is byte-identical for the same inputs and preserves content and mode", () => {
    const left = createDeterministicArchive(fixtures, 1_700_000_000);
    const right = createDeterministicArchive([...fixtures].reverse(), 1_700_000_000);
    expect(createHash("sha256").update(left).digest("hex"))
      .toBe(createHash("sha256").update(right).digest("hex"));
    expect(readDeterministicArchive(left)).toEqual([
      { path: fixtures[0].path, bytes: fixtures[0].bytes, mode: 0o755 },
      { path: fixtures[1].path, bytes: fixtures[1].bytes, mode: 0o644 },
    ]);
  });

  test("rejects traversal and duplicate paths", () => {
    expect(() => createDeterministicArchive([
      { path: "../escape", bytes: Buffer.alloc(0), mode: 0o644 },
    ], 0)).toThrow("unsafe archive path");
    expect(() => createDeterministicArchive([fixtures[0]!, fixtures[0]!], 0)).toThrow("duplicate archive path");
  });

  test("rejects corrupted tar metadata", () => {
    const archive = createDeterministicArchive(fixtures, 0);
    const corrupted = Buffer.from(archive);
    const byte = corrupted[corrupted.length - 8];
    if (byte !== undefined) corrupted[corrupted.length - 8] = byte ^ 0xff;
    expect(() => readDeterministicArchive(corrupted)).toThrow();
  });
});

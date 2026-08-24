import { describe, expect, test } from "bun:test";
import { ConfigLayer, mergeConfigLayers } from "./index.js";

describe("config merge safety", () => {
  test("rejects prototype-polluting keys before merge", () => {
    const value = JSON.parse('{"providers":{"accounts":{"__proto__":{"polluted":true}}}}') as Record<string, unknown>;

    expect(() =>
      mergeConfigLayers([
        {
          layer: ConfigLayer.USER,
          value,
          origin: "test",
        },
      ]),
    ).toThrow("unsafe object key");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

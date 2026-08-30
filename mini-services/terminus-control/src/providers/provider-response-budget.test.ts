import { describe, expect, test } from "bun:test";
import {
  MAX_BOUNDED_STREAM_OUTPUT_TOKENS,
  boundedStreamOutputReserve,
} from "./provider-response-budget.js";

describe("boundedStreamOutputReserve", () => {
  test("keeps a small model maximum unchanged", () => {
    expect(boundedStreamOutputReserve(8_192n)).toBe(8_192n);
  });

  test("caps large model maxima at the bounded stream envelope", () => {
    expect(boundedStreamOutputReserve(64_000n)).toBe(MAX_BOUNDED_STREAM_OUTPUT_TOKENS);
    expect(boundedStreamOutputReserve(128_000n)).toBe(MAX_BOUNDED_STREAM_OUTPUT_TOKENS);
  });

  test("preserves an unknown zero maximum", () => {
    expect(boundedStreamOutputReserve(0n)).toBe(0n);
  });
});

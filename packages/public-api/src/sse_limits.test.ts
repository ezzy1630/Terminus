import { describe, expect, test } from "bun:test";

import {
  createSseDecoder,
  SseDecoderLimitError,
  SseDecoderProtocolError,
} from "./index";

describe("bounded SSE decoder", () => {
  test("rejects a frame larger than the configured frame limit", () => {
    const decoder = createSseDecoder({ maxFrameBytes: 12, maxBufferBytes: 64 });

    expect(() => decoder.feed("data: 123456789\n\n")).toThrow(SseDecoderLimitError);
    expect(() => decoder.feed("data: 123456789\n\n")).toThrow(/SSE frame exceeded/);
  });

  test("rejects an unterminated frame at EOF", () => {
    const decoder = createSseDecoder({ maxFrameBytes: 64, maxBufferBytes: 64 });
    decoder.feed("data: still-open");

    expect(() => decoder.finish()).toThrow(SseDecoderProtocolError);
    expect(() => decoder.finish()).toThrow(/unterminated frame/);
  });

  test("rejects buffer growth before an unterminated frame can grow unbounded", () => {
    const decoder = createSseDecoder({ maxFrameBytes: 8, maxBufferBytes: 16 });

    expect(() => decoder.feed("data: 123456789012345")).toThrow(SseDecoderLimitError);
    expect(() => decoder.feed("data: 123456789012345")).toThrow(/SSE buffer exceeded/);
  });

  test("accepts a complete bounded event and clean EOF", () => {
    const decoder = createSseDecoder({ maxFrameBytes: 64, maxBufferBytes: 128 });

    expect(decoder.feed("id: 1\ndata: hello\n\n")).toEqual([{
      id: "1",
      event: "message",
      data: "hello",
    }]);
    expect(() => decoder.finish()).not.toThrow();
  });
});

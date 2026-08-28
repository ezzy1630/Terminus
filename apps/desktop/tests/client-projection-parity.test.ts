import { describe, expect, test } from "vitest";
import { projectEvent, PUBLIC_CLIENT_EVENT_FIXTURES } from "@terminus/public-client";
import { projectEvent as desktopProjectEvent } from "../src/lib/task-surface";

describe("desktop/public-client projection parity", () => {
  test("desktop's compatibility surface uses the shared fixture contract", () => {
    const fixture = PUBLIC_CLIENT_EVENT_FIXTURES[2]!;
    const now = new Date("2026-08-28T12:00:00Z");
    expect(desktopProjectEvent(fixture, now)).toEqual(projectEvent(fixture, now));
  });
});

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { projectEvent, PUBLIC_CLIENT_EVENT_FIXTURES } from "@terminus/public-client";
import { projectEvent as desktopProjectEvent } from "../src/lib/task-surface";
import { IGNORED_TURN_EVENTS } from "../src/lib/turn-activity";

describe("desktop/public-client projection parity", () => {
  test("desktop's compatibility surface uses the shared fixture contract", () => {
    const fixture = PUBLIC_CLIENT_EVENT_FIXTURES[2]!;
    const now = new Date("2026-08-28T12:00:00Z");
    expect(desktopProjectEvent(fixture, now)).toEqual(projectEvent(fixture, now));
  });
});

// ────────────────────────── Turn event coverage ──────────────────────────────
//
// The renderer decoded `turn.provider_running`, an event the control plane has
// never emitted, and ignored `turn.provider_text_delta`, the one it does — so
// every streamed reply was dropped and nothing in the suite noticed. This reads
// the control plane's own source at test time and requires that every turn
// event it publishes is either decoded by the conversation reducer or listed,
// with a reason, in `IGNORED_TURN_EVENTS`.

/** Paths are relative to `apps/desktop`, which is vitest's working directory. */
function readRepoFile(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8");
}

function emittedTurnEvents(): string[] {
  const source = readRepoFile("../../mini-services/terminus-control/src/index.ts");
  const matches = source.matchAll(/eventType:\s*"(turn\.[a-z_]+)"/g);
  return [...new Set([...matches].map((match) => match[1]!))].sort();
}

function decodedTurnEvents(): Set<string> {
  const source = readRepoFile("src/components/Conversation.tsx");
  const matches = source.matchAll(/case\s+"(turn\.[a-z_]+)":/g);
  return new Set([...matches].map((match) => match[1]!));
}

describe("conversation turn-event coverage", () => {
  test("the control plane's turn events are readable at test time", () => {
    const emitted = emittedTurnEvents();
    expect(emitted).toContain("turn.provider_text_delta");
    expect(emitted.length).toBeGreaterThan(10);
  });

  test("every emitted turn event is decoded or explicitly ignored", () => {
    const decoded = decodedTurnEvents();
    const uncovered = emittedTurnEvents().filter(
      (event) => !decoded.has(event) && IGNORED_TURN_EVENTS[event] === undefined,
    );
    expect(uncovered).toEqual([]);
  });

  test("the ignore list carries a reason and never shadows a decoded event", () => {
    const decoded = decodedTurnEvents();
    for (const [event, reason] of Object.entries(IGNORED_TURN_EVENTS)) {
      expect(reason.length).toBeGreaterThan(20);
      expect(decoded.has(event)).toBe(false);
    }
  });

  test("the reducer no longer decodes the event the control plane never emits", () => {
    expect(decodedTurnEvents().has("turn.provider_running")).toBe(false);
  });
});

/**
 * Resolving a turn's prompt from its admitted input artifact.
 *
 * The defect these tests exist to prevent: every user message in the
 * transcript rendered as an empty bubble, because the client read
 * `user_input` off `turn.started` while the control plane emits
 * `input_artifact` / `input_hash` and stores the prompt as immutable
 * content-addressed input.
 */
import { describe, expect, it } from "vitest";
import {
  artifactHashFromUri,
  turnInputPlaceholder,
  turnInputReferences,
  type TurnInputState,
} from "../src/lib/turn-input";

const HASH = "a".repeat(64);
const URI = `artifact://sha256/${HASH}`;

function startedEvent(id: string, payload: unknown) {
  return { id, event: "turn.started", payload };
}

describe("artifactHashFromUri", () => {
  it("accepts a canonical artifact URI", () => {
    expect(artifactHashFromUri(URI)).toBe(HASH);
  });

  it("rejects anything that is not a sha256 artifact URI", () => {
    expect(artifactHashFromUri("artifact://sha512/" + "a".repeat(64))).toBeNull();
    expect(artifactHashFromUri("https://example.com/evil")).toBeNull();
    expect(artifactHashFromUri("artifact://sha256/")).toBeNull();
    expect(artifactHashFromUri(null)).toBeNull();
    expect(artifactHashFromUri(42)).toBeNull();
  });

  it("refuses a digest that is not exactly 64 lowercase hex characters", () => {
    // Path traversal and case tricks must not survive into a request path.
    expect(artifactHashFromUri(`artifact://sha256/${"A".repeat(64)}`)).toBeNull();
    expect(artifactHashFromUri(`artifact://sha256/${"a".repeat(63)}`)).toBeNull();
    expect(artifactHashFromUri(`artifact://sha256/${"a".repeat(65)}`)).toBeNull();
    expect(artifactHashFromUri("artifact://sha256/../../etc/passwd")).toBeNull();
  });
});

describe("turnInputReferences", () => {
  it("reads the reference the control plane actually emits", () => {
    // Payload shape is turn-coordinator.ts: thread_id, task_id, sequence,
    // input_artifact, input_hash. Notably there is no user_input.
    const events = [
      startedEvent("event-1", {
        thread_id: "thread-1",
        task_id: "task-1",
        sequence: 1,
        input_artifact: URI,
        input_hash: `sha256:${HASH}`,
      }),
    ];
    expect(turnInputReferences(events)).toEqual([{ eventId: "event-1", uri: URI, hash: HASH }]);
  });

  it("handles a payload recorded verbatim from a live control plane", () => {
    // Copied from semantic_events.payload_json after a real turn on
    // 2026-08-28. The artifact it names contained exactly the prompt that was
    // sent, which is what makes the join correct rather than merely plausible.
    const recorded = {
      thread_id: "0ac1c52b-c512-453a-af64-00983174124e",
      task_id: "23a88a12-4271-4657-8565-48b29dd4b1c3",
      sequence: 1,
      input_artifact: "artifact://sha256/66b725ec88affd60d32d01434a1631113ab182fbdb70e8911840ea024cbf8b32",
      input_hash: "sha256:66b725ec88affd60d32d01434a1631113ab182fbdb70e8911840ea024cbf8b32",
    };
    expect("user_input" in recorded).toBe(false);
    expect(turnInputReferences([startedEvent("event-live", recorded)])).toEqual([{
      eventId: "event-live",
      uri: recorded.input_artifact,
      hash: "66b725ec88affd60d32d01434a1631113ab182fbdb70e8911840ea024cbf8b32",
    }]);
  });

  it("ignores events that are not turn.started", () => {
    const events = [
      { id: "event-1", event: "turn.completed", payload: { input_artifact: URI } },
      { id: "event-2", event: "task.created", payload: { input_artifact: URI } },
    ];
    expect(turnInputReferences(events)).toEqual([]);
  });

  it("skips a turn whose payload carries no usable reference", () => {
    const events = [
      startedEvent("event-1", { thread_id: "thread-1" }),
      startedEvent("event-2", { input_artifact: "not-an-artifact" }),
      startedEvent("event-3", null),
      startedEvent("event-4", { input_artifact: URI }),
    ];
    expect(turnInputReferences(events).map((reference) => reference.eventId)).toEqual(["event-4"]);
  });

  it("reads the live SSE shape, where the payload is a JSON string in `data`", () => {
    // decodeFeed accepts both shapes, so this extractor must too — reading only
    // `payload` finds nothing at all against the real stream.
    const events = [
      {
        id: "event-1",
        event: "turn.started",
        data: JSON.stringify({ thread_id: "thread-1", input_artifact: URI, input_hash: `sha256:${HASH}` }),
      },
    ];
    expect(turnInputReferences(events)).toEqual([{ eventId: "event-1", uri: URI, hash: HASH }]);
  });

  it("survives malformed JSON in data", () => {
    expect(turnInputReferences([{ id: "event-1", event: "turn.started", data: "{not json" }])).toEqual([]);
    expect(turnInputReferences([{ id: "event-2", event: "turn.started", data: "" }])).toEqual([]);
    expect(turnInputReferences([{ id: "event-3", event: "turn.started", data: "[1,2]" }])).toEqual([]);
  });

  it("preserves order and does not duplicate an event id", () => {
    const other = "b".repeat(64);
    const events = [
      startedEvent("event-2", { input_artifact: `artifact://sha256/${other}` }),
      startedEvent("event-1", { input_artifact: URI }),
      startedEvent("event-1", { input_artifact: URI }),
    ];
    expect(turnInputReferences(events).map((reference) => reference.eventId)).toEqual(["event-2", "event-1"]);
  });

  it("keeps two turns that share one prompt as separate references", () => {
    const events = [
      startedEvent("event-1", { input_artifact: URI }),
      startedEvent("event-2", { input_artifact: URI }),
    ];
    const references = turnInputReferences(events);
    expect(references).toHaveLength(2);
    expect(references.every((reference) => reference.hash === HASH)).toBe(true);
  });
});

describe("turnInputPlaceholder", () => {
  it("never renders a user message as empty", () => {
    const states: (TurnInputState | undefined)[] = [
      undefined,
      { status: "loading" },
      { status: "unavailable", reason: "the artifact could not be read." },
      { status: "ready", text: "", truncated: false },
    ];
    for (const state of states) {
      // The one legitimately empty case is a genuinely empty prompt, which the
      // transcript can only get from a resolved artifact.
      if (state?.status === "ready") continue;
      expect(turnInputPlaceholder(state).length).toBeGreaterThan(0);
    }
  });

  it("says why the prompt is missing rather than implying silence", () => {
    expect(turnInputPlaceholder({ status: "loading" })).toBe("Loading prompt…");
    expect(turnInputPlaceholder({ status: "unavailable", reason: "artifact 404" }))
      .toContain("artifact 404");
    expect(turnInputPlaceholder(undefined)).toContain("no admitted input");
  });

  it("returns the prompt verbatim once resolved", () => {
    expect(turnInputPlaceholder({ status: "ready", text: "List the files", truncated: false }))
      .toBe("List the files");
  });
});

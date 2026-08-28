/**
 * Conversation history has to survive closing a task.
 *
 * Observed on 2026-08-28 against a live control plane: opening a task that had
 * already run showed an empty transcript. `GET /v1/events` is a live tail — no
 * cursor means "deliver what happens next" — while every event sat unread in
 * `semantic_events`. The client now replays the durable transcript first and
 * attaches the stream immediately after the last replayed event, so the two
 * meet exactly once: no gap, no duplicate.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { useTerminusStore } from "../src/hooks/use-terminus";
import { api } from "../src/lib/api";
import type { TaskTranscriptPage, TerminusSseEvent } from "../src/types";

function event(id: string, type = "turn.started"): TerminusSseEvent {
  return { id, event: type, data: JSON.stringify({ task_id: "task-1" }) };
}

function page(overrides: Partial<TaskTranscriptPage> = {}): TaskTranscriptPage {
  return {
    task_id: "task-1",
    events: [event("e1"), event("e2", "turn.completed")],
    total: 2,
    next_cursor: "e2",
    earlier_cursor: null,
    truncation: { occurred: false, continuation: null },
    ...overrides,
  };
}

/**
 * The event-id dedupe set is module state in the store, shared across tests
 * exactly as it is across a session. Tests that append must therefore use ids
 * no earlier test has used, or the second append is correctly rejected as a
 * replay of an event already on screen.
 */
let uniqueIdCounter = 0;
function uniquePair(): [string, string] {
  uniqueIdCounter += 1;
  return [`t${uniqueIdCounter}-0`, `t${uniqueIdCounter}-1`];
}

beforeEach(() => {
  vi.restoreAllMocks();
  useTerminusStore.setState({
    eventsByTask: {},
    eventBytesByTask: {},
    transcriptByTask: {},
    selectedTaskId: null,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("hydrateTranscript", () => {
  test("replays stored events into the conversation window", async () => {
    vi.spyOn(api, "getTaskTranscript").mockResolvedValue(page());
    const attach = vi.fn();
    useTerminusStore.setState({ _attachStream: attach });

    await useTerminusStore.getState().hydrateTranscript("task-1");
    await vi.waitFor(() => {
      expect(useTerminusStore.getState().eventsByTask["task-1"]?.map((entry) => entry.id)).toEqual(["e1", "e2"]);
    });
  });

  test("attaches the live stream at the last replayed event", async () => {
    vi.spyOn(api, "getTaskTranscript").mockResolvedValue(page());
    const attach = vi.fn();
    useTerminusStore.setState({ _attachStream: attach });

    await useTerminusStore.getState().hydrateTranscript("task-1");

    // Anything that happened during the replay is delivered from this cursor,
    // so replay and tail join without a gap or a repeated event.
    expect(attach).toHaveBeenCalledWith("task-1", "e2");
  });

  test("attaches without a cursor when the task has no history at all", async () => {
    vi.spyOn(api, "getTaskTranscript").mockResolvedValue(page({ events: [], total: 0, next_cursor: null }));
    const attach = vi.fn();
    useTerminusStore.setState({ _attachStream: attach });

    await useTerminusStore.getState().hydrateTranscript("task-1");

    expect(attach).toHaveBeenCalledWith("task-1", null);
  });

  test("still connects live updates when replay fails", async () => {
    // History is worth less than a working stream: failing to load the past
    // must not leave the task with no connection to the present.
    vi.spyOn(api, "getTaskTranscript").mockRejectedValue(new Error("transcript unavailable"));
    const attach = vi.fn();
    useTerminusStore.setState({ _attachStream: attach });

    await useTerminusStore.getState().hydrateTranscript("task-1");

    expect(attach).toHaveBeenCalledWith("task-1", null);
    expect(useTerminusStore.getState().transcriptByTask["task-1"]).toMatchObject({
      status: "error",
      error: "transcript unavailable",
    });
  });

  test("records whether earlier pages remain", async () => {
    vi.spyOn(api, "getTaskTranscript").mockResolvedValue(page({ earlier_cursor: "e0", total: 900 }));
    useTerminusStore.setState({ _attachStream: vi.fn() });

    await useTerminusStore.getState().hydrateTranscript("task-1");

    expect(useTerminusStore.getState().transcriptByTask["task-1"]).toMatchObject({
      status: "ready",
      earlierCursor: "e0",
      total: 900,
    });
  });

  test("a slower reply for a task the user already left cannot hijack the stream", async () => {
    let resolveFirst!: (value: TaskTranscriptPage) => void;
    const slow = new Promise<TaskTranscriptPage>((resolve) => { resolveFirst = resolve; });
    const getTaskTranscript = vi.spyOn(api, "getTaskTranscript")
      .mockImplementationOnce(() => slow)
      .mockResolvedValue(page({ task_id: "task-2", next_cursor: "z9" }));
    const attach = vi.fn();
    useTerminusStore.setState({ _attachStream: attach });

    const first = useTerminusStore.getState().hydrateTranscript("task-1");
    await useTerminusStore.getState().hydrateTranscript("task-1");
    resolveFirst(page({ next_cursor: "stale" }));
    await first;

    expect(getTaskTranscript).toHaveBeenCalledTimes(2);
    expect(attach).not.toHaveBeenCalledWith("task-1", "stale");
  });
});

describe("loadEarlierTranscript", () => {
  test("prepends the earlier page rather than appending it", async () => {
    // Every other write to the event window appends. Earlier events belong
    // before what is already on screen, not after it.
    const [older1, older2] = uniquePair();
    const [newer1, newer2] = uniquePair();
    vi.spyOn(api, "getTaskTranscript").mockResolvedValue(page({
      events: [event(newer1), event(newer2, "turn.completed")],
      next_cursor: newer2,
    }));
    useTerminusStore.setState({ _attachStream: vi.fn() });
    await useTerminusStore.getState().hydrateTranscript("task-1");
    await vi.waitFor(() => {
      expect(useTerminusStore.getState().eventsByTask["task-1"]).toHaveLength(2);
    });
    useTerminusStore.setState((state) => ({
      transcriptByTask: {
        ...state.transcriptByTask,
        "task-1": { status: "ready", earlierCursor: newer1, loadingEarlier: false, total: 4, error: null },
      },
    }));
    vi.spyOn(api, "getTaskTranscript").mockResolvedValue(page({
      events: [event(older1), event(older2)],
      earlier_cursor: null,
      next_cursor: older2,
    }));

    await useTerminusStore.getState().loadEarlierTranscript("task-1");

    expect(useTerminusStore.getState().eventsByTask["task-1"]?.map((entry) => entry.id))
      .toEqual([older1, older2, newer1, newer2]);
  });

  test("does nothing once the start of the conversation is reached", async () => {
    const getTaskTranscript = vi.spyOn(api, "getTaskTranscript").mockResolvedValue(page());
    useTerminusStore.setState((state) => ({
      transcriptByTask: {
        ...state.transcriptByTask,
        "task-1": { status: "ready", earlierCursor: null, loadingEarlier: false, total: 2, error: null },
      },
    }));

    await useTerminusStore.getState().loadEarlierTranscript("task-1");

    expect(getTaskTranscript).not.toHaveBeenCalled();
  });

  test("does not issue a second request while one is in flight", async () => {
    const getTaskTranscript = vi.spyOn(api, "getTaskTranscript").mockResolvedValue(page());
    useTerminusStore.setState((state) => ({
      transcriptByTask: {
        ...state.transcriptByTask,
        "task-1": { status: "ready", earlierCursor: "e1", loadingEarlier: true, total: 9, error: null },
      },
    }));

    await useTerminusStore.getState().loadEarlierTranscript("task-1");

    expect(getTaskTranscript).not.toHaveBeenCalled();
  });

  test("reports a failure without discarding what is already loaded", async () => {
    const [loaded1, loaded2] = uniquePair();
    vi.spyOn(api, "getTaskTranscript").mockResolvedValue(page({
      events: [event(loaded1), event(loaded2, "turn.completed")],
      next_cursor: loaded2,
    }));
    useTerminusStore.setState({ _attachStream: vi.fn() });
    await useTerminusStore.getState().hydrateTranscript("task-1");
    await vi.waitFor(() => {
      expect(useTerminusStore.getState().eventsByTask["task-1"]).toHaveLength(2);
    });
    useTerminusStore.setState((state) => ({
      transcriptByTask: {
        ...state.transcriptByTask,
        "task-1": { status: "ready", earlierCursor: loaded1, loadingEarlier: false, total: 4, error: null },
      },
    }));
    vi.spyOn(api, "getTaskTranscript").mockRejectedValue(new Error("page unavailable"));

    await useTerminusStore.getState().loadEarlierTranscript("task-1");

    expect(useTerminusStore.getState().eventsByTask["task-1"]).toHaveLength(2);
    expect(useTerminusStore.getState().transcriptByTask["task-1"]).toMatchObject({
      loadingEarlier: false,
      error: "page unavailable",
    });
  });
});

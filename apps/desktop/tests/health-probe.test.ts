/**
 * The liveness probe must not gate the sidebar.
 *
 * Observed on 2026-08-28 against a live control plane: while a turn was in
 * flight, `/v1/system/health` stopped answering (it reports writer state, and
 * the run holds the writer lease) while `/v1/sessions`, `/v2/tasks` and
 * `/v1/provider-models` all answered in about a millisecond. `refreshSessions`
 * awaited health first, so the app sat on "Starting Terminus" with an empty
 * sidebar for the whole duration of the run.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { useTerminusStore } from "../src/hooks/use-terminus";
import { api } from "../src/lib/api";
import type { Session } from "../src/types";

function session(id: string): Session {
  return {
    id,
    workspace_id: `workspace-${id}`,
    owner_principal: "operator",
    title: `Space ${id}`,
    status: "active",
    default_model_profile: "implementer",
    default_permission_profile: "secure-local-default",
    active_thread_id: `thread-${id}`,
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
  };
}

const sessionsResponse = {
  sessions: [session("a")],
  total: 1,
  next_cursor: null,
  truncation: { occurred: false, continuation: null },
};

describe("refreshSessions", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useTerminusStore.setState({
      sessions: [],
      healthStatus: "ready",
      healthReady: true,
      healthDetail: null,
      selectedSessionId: null,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test("loads sessions even while the health endpoint never answers", async () => {
    // Never resolves, exactly like the observed control plane.
    vi.spyOn(api, "health").mockImplementation(
      (signal?: AbortSignal | null) => new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")));
      }),
    );
    const listSessions = vi.spyOn(api, "listSessions").mockResolvedValue(sessionsResponse);

    await useTerminusStore.getState().refreshSessions();

    expect(listSessions).toHaveBeenCalled();
    expect(useTerminusStore.getState().sessions.map((entry) => entry.id)).toEqual(["a"]);
    expect(useTerminusStore.getState().loadingSessions).toBe(false);
  });

  test("does not wait for the probe before returning", async () => {
    vi.spyOn(api, "health").mockImplementation(
      (signal?: AbortSignal | null) => new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")));
      }),
    );
    vi.spyOn(api, "listSessions").mockResolvedValue(sessionsResponse);

    // No timer advance: if refreshSessions awaited the 5s probe timeout this
    // would not settle.
    await expect(useTerminusStore.getState().refreshSessions()).resolves.toBeUndefined();
  });

  test("reports a hung probe as degraded rather than offline", async () => {
    vi.spyOn(api, "health").mockImplementation(
      (signal?: AbortSignal | null) => new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")));
      }),
    );
    vi.spyOn(api, "listSessions").mockResolvedValue(sessionsResponse);

    await useTerminusStore.getState().refreshSessions();
    await vi.advanceTimersByTimeAsync(5_000);
    await Promise.resolve();

    // The rest of the API is answering, so "offline" would be a lie.
    expect(useTerminusStore.getState().healthStatus).toBe("degraded");
    expect(useTerminusStore.getState().healthDetail).toContain("did not answer");
  });

  test("still reports a genuinely unreachable control plane as offline", async () => {
    vi.spyOn(api, "health").mockRejectedValue(new Error("network error: Failed to fetch"));
    vi.spyOn(api, "listSessions").mockResolvedValue(sessionsResponse);

    await useTerminusStore.getState().refreshSessions();
    await Promise.resolve();
    await Promise.resolve();

    expect(useTerminusStore.getState().healthStatus).toBe("offline");
  });

  test("reports a healthy control plane as ready", async () => {
    vi.spyOn(api, "health").mockResolvedValue({
      status: "ok",
      ready: true,
      version: "0.1.0",
      kernel: { status: "ok" },
    } as never);
    vi.spyOn(api, "listSessions").mockResolvedValue(sessionsResponse);

    await useTerminusStore.getState().refreshSessions();
    await Promise.resolve();
    await Promise.resolve();

    expect(useTerminusStore.getState().healthStatus).toBe("ready");
    expect(useTerminusStore.getState().healthReady).toBe(true);
  });
});

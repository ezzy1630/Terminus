import { afterEach, describe, expect, test } from "vitest";
import {
  readMissionBoardPreferences,
  writeMissionBoardPreferences,
  type MissionBoardPreferences,
} from "../src/lib/mission-board-prefs";

afterEach(() => window.sessionStorage.clear());

function preferences(patch: Partial<MissionBoardPreferences> = {}): MissionBoardPreferences {
  return {
    viewMode: "list",
    query: "authentication",
    spaceFilter: "all",
    statusFilter: "done",
    attentionOnly: true,
    doneExpanded: true,
    scrollLeft: 96,
    scrollTop: 144,
    selectedSessionId: "session-1",
    ...patch,
  };
}

describe("mission board preferences", () => {
  test("round trips bounded window-session state", () => {
    writeMissionBoardPreferences(preferences());

    expect(readMissionBoardPreferences("session-1")).toEqual(preferences());
  });

  test("keeps filters when returning to the same project and follows a deliberate project switch", () => {
    writeMissionBoardPreferences(preferences({ spaceFilter: "all" }));

    expect(readMissionBoardPreferences("session-1").spaceFilter).toBe("all");
    expect(readMissionBoardPreferences("session-2").spaceFilter).toBe("session-2");
  });

  test("falls back safely when stored state is malformed", () => {
    window.sessionStorage.setItem("terminus-desktop.mission-board-state.v1", "{");

    expect(readMissionBoardPreferences("session-1")).toEqual({
      viewMode: "list",
      query: "",
      spaceFilter: "session-1",
      statusFilter: "all",
      attentionOnly: false,
      doneExpanded: false,
      scrollLeft: 0,
      scrollTop: 0,
      selectedSessionId: "session-1",
    });
  });
});

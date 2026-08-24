import { describe, expect, test } from "bun:test";
import type { SessionSnapshot, TaskSnapshot } from "@terminus/public-api";
import { appendEvent, initialState, type TuiState } from "../src/model.js";
import { computeLayout, hitTest, renderScreen, stripAnsi } from "../src/render.js";

const session = {
  id: "session-1",
  workspace_id: "workspace-1",
  owner_principal: "operator",
  title: "Terminus TUI",
  status: "active",
  default_model_profile: "balanced",
  default_permission_profile: "local",
  active_thread_id: "thread-1",
  created_at: "2026-08-23T12:00:00Z",
  updated_at: "2026-08-23T12:01:00Z",
} satisfies SessionSnapshot;

const task = {
  id: "task-1",
  session_id: session.id,
  thread_id: "thread-1",
  status: "running",
  phase: "implementation",
  active_contract_version: 1,
  risk_class: "normal",
  created_at: "2026-08-23T12:00:00Z",
  updated_at: "2026-08-23T12:01:00Z",
  completed_at: null,
  terminal_reason: null,
} satisfies TaskSnapshot;

function populatedState() {
  const state = {
    ...initialState(),
    connection: "online" as const,
    health: { status: "ok" as const, version: "0.1.0", ready: true },
    sessions: [session],
    tasks: [task],
    inspectorOpen: true,
  };
  return appendEvent(state, {
    id: "event-1",
    event: "task.started",
    data: JSON.stringify({ summary: "Reading the repository" }),
  }, new Date("2026-08-23T12:02:00Z"));
}

describe("TUI renderer", () => {
  test("renders the three-pane desktop frame at a stable size", () => {
    const frame = stripAnsi(renderScreen(populatedState(), 140, 36));
    const lines = frame.split("\n");

    expect(lines).toHaveLength(36);
    expect(lines.every((line) => [...line].length === 140)).toBe(true);
    expect(frame).toContain("TERMINUS");
    expect(frame).toContain("SESSIONS");
    expect(frame).toContain("Reading the repository");
    expect(frame).toContain("ATTENTION");
    expect(frame).toContain("Ask Terminus");
  });

  test("collapses to the activity and composer on narrow terminals", () => {
    const layout = computeLayout(72, 24);
    const frame = stripAnsi(renderScreen(populatedState(), 72, 24));

    expect(layout.showSidebar).toBe(false);
    expect(layout.showInspector).toBe(false);
    expect(frame).not.toContain("SESSIONS");
    expect(frame).toContain("Reading the repository");
  });

  test("defaults to a transcript-first wide layout with optional details", () => {
    const state = { ...populatedState(), inspectorOpen: false };
    const layout = computeLayout(140, 36, { sidebar: state.sidebarOpen, inspector: state.inspectorOpen });
    const frame = stripAnsi(renderScreen(state, 140, 36));

    expect(layout.showSidebar).toBe(true);
    expect(layout.showInspector).toBe(false);
    expect(frame).not.toContain("ATTENTION");
    expect(frame).toContain("· SYS");
  });

  test("shows semantic transcript roles and inline command suggestions", () => {
    let state: TuiState = { ...populatedState(), inspectorOpen: false, focus: "composer", composer: "/re", composerCursor: 3 };
    state = appendEvent(state, {
      id: "event-2",
      event: "turn.started",
      data: JSON.stringify({ user_input: "Run the focused checks" }),
    }, new Date("2026-08-23T12:03:00Z"));
    state = appendEvent(state, {
      id: "event-3",
      event: "tool.settled",
      data: JSON.stringify({ tool: "shell", command: "just check", result_status: "succeeded" }),
    }, new Date("2026-08-23T12:04:00Z"));
    const frame = stripAnsi(renderScreen(state, 120, 32));

    expect(frame).toContain("› YOU");
    expect(frame).toContain("● TOOL");
    expect(frame).toContain("/refresh");
    expect(frame).toContain("/resume");
  });

  test("shows a bounded resize message below the minimum size", () => {
    const frame = stripAnsi(renderScreen(populatedState(), 30, 8));
    const lines = frame.split("\n");
    expect(lines).toHaveLength(8);
    expect(lines.every((line) => [...line].length === 30)).toBe(true);
    expect(frame).toContain("Terminus needs a 40 × 12");
  });

  test("maps sidebar clicks to canonical selections", () => {
    expect(hitTest(populatedState(), 140, 36, 3, 5)).toEqual({ kind: "session", index: 0 });
    expect(hitTest(populatedState(), 140, 36, 3, 8)).toEqual({ kind: "task", index: 0 });
  });

  test("keeps deep session selections visible and clickable", () => {
    const sessions = Array.from({ length: 12 }, (_, index) => ({
      ...session,
      id: `session-${index}`,
      title: `Session ${index}`,
    }));
    const state = { ...populatedState(), sessions, selectedSession: 10 };
    const frame = stripAnsi(renderScreen(state, 140, 36));

    expect(frame).toContain("Session 10");
    expect(hitTest(state, 140, 36, 3, 9)).toEqual({ kind: "session", index: 10 });
  });

  test("renders approval decisions with exact action detail", () => {
    const approvalState = {
      ...populatedState(),
      approvals: [{
        id: "approval-1",
        task_id: task.id,
        operation_hash: "sha256:operation",
        binding: null,
        display: {
          summary: "Run the release command",
          exact_action: "just release-check",
          reason: "The task requested release evidence.",
          reversibility: "No deployment is performed.",
          environment: "local",
        },
        status: "pending" as const,
        decision: null,
        supported_decisions: ["allow_once" as const, "deny_once" as const],
        risk: "normal",
        scope: ["workspace"],
        use_limit: 1,
        use_count: 0,
        expires_at: null,
        requested_at: "2026-08-23T12:03:00Z",
        resolved_at: null,
        rationale: null,
      }],
      modal: { kind: "approval" as const, selected: 0 },
    };
    const frame = stripAnsi(renderScreen(approvalState, 120, 32));
    expect(frame).toContain("just release-check");
    expect(frame).toContain("allow once");
    expect(frame).toContain("deny once");
  });
});

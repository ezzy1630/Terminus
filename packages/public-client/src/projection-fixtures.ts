import type { SseEvent } from "@terminus/public-api";

/** Shared wire fixtures used by the public-client, TUI, and desktop parity tests. */
export function fixtureEvent(id: string, event: string, payload: unknown): SseEvent {
  return {
    id,
    event,
    data: typeof payload === "string" ? payload : JSON.stringify(payload),
  };
}

export const PUBLIC_CLIENT_EVENT_FIXTURES: readonly SseEvent[] = [
  fixtureEvent("turn-1", "turn.started", { user_input: "Inspect the runtime" }),
  fixtureEvent("provider-1", "turn.provider_running", { provider: "fixture", delta: "Agent is working" }),
  fixtureEvent("tool-1", "tool.settled", { tool: "shell", command: "just check", status: "success" }),
  fixtureEvent("task-1", "task.completed", { task_id: "task-1", status: "COMPLETED", summary: "Checks passed" }),
  fixtureEvent("approval-1", "approval.requested", { approval_id: "approval-1", operation_summary: "Run checks", risk: "normal" }),
  fixtureEvent("approval-2", "approval.resolved", { approval_id: "approval-1", decision: "deny_once" }),
  fixtureEvent("cursor-1", "cursor_expired", {
    cursor: "old-cursor",
    oldest_retained_event_id: "new-cursor",
    snapshot_url: "/v1/tasks/task-1",
  }),
];

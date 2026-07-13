import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Inspector } from "../src/components/Inspector";
import { useTerminusStore } from "../src/hooks/use-terminus";
import type { Task, TerminusSseEvent } from "../src/types";

const task: Task = {
  id: "task-1",
  session_id: "session-1",
  thread_id: "thread-1",
  status: "ACTIVE",
  phase: "EXECUTING",
  active_contract_version: 1,
  risk_class: "normal",
  created_at: "2026-07-13T00:00:00.000Z",
  updated_at: "2026-07-13T00:00:00.000Z",
  completed_at: null,
  contract: null,
};

function event(id: string, eventName: string, payload: Record<string, unknown>): TerminusSseEvent {
  return { id, event: eventName, data: JSON.stringify(payload) };
}

describe("Inspector relevance", () => {
  beforeEach(() => {
    useTerminusStore.setState({
      selectedTaskId: task.id,
      taskById: { [task.id]: task },
      eventsByTask: { [task.id]: [] },
    });
  });

  afterEach(() => cleanup());

  test("omits task sections that have no supporting runtime evidence", () => {
    render(<Inspector />);

    expect(screen.getByRole("button", { name: "Environment" })).toBeInTheDocument();
    for (const name of ["Changes", "Subagents", "Verification", "Activity", "Approvals", "Computer Use"]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    }
  });

  test("reveals evidence-backed sections and opens the real review action", async () => {
    const diff = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new";
    useTerminusStore.setState({
      eventsByTask: {
        [task.id]: [
          event("1", "tool.settled", { tool: "patch", result: { patch: diff } }),
          event("2", "agent.spawned", { agentId: "agent-1", role: "Review UI" }),
          event("3", "verification.node_passed", { nodeId: "desktop-unit" }),
          event("4", "approval.requested", { approvalId: "approval-1", operationSummary: "Apply changes", risk: "normal" }),
        ],
      },
    });
    const onShowChanges = vi.fn();
    render(
      <Inspector
        computerUseSession={{ active: true, hidden: true }}
        onShowChanges={onShowChanges}
        onComputerUseShow={vi.fn()}
      />,
    );

    for (const name of ["Changes, Ready", "Subagents, 1 working · 0 done", "Verification, 1/1", "Activity, 4", "Approvals, 1 waiting", "Computer Use"]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }

    await userEvent.setup().click(screen.getByRole("button", { name: "Open patch review" }));
    expect(onShowChanges).toHaveBeenCalledTimes(1);
  });
});

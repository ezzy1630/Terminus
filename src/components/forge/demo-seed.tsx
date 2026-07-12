"use client";

import * as React from "react";
import { forgeFetch } from "@/lib/forge-client";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Sparkles, Loader2 } from "lucide-react";

interface DemoSeedProps {
  /** Whether the demo button should be visible (e.g. only when no sessions exist). */
  visible: boolean;
  onDone?: (task: { id: string; session_id: string; thread_id: string }) => void;
}

/**
 * "Try the demo" button. On click, runs the full end-to-end demo seed:
 * 1. Open a workspace at /tmp/forge-demo
 * 2. Create a session ("Forge demo")
 * 3. Create a task ("Demonstrate the Forge agent loop") with 2 acceptance criteria
 * 4. Start the task
 * 5. Start a turn ("Hello, Forge — show me what you can do.")
 * 6. Hand control back to the caller, who should switch to the task detail view.
 *
 * The control plane agent loop runs asynchronously and emits semantic events
 * that the UI can observe in real time via /v1/events.
 */
export function DemoSeed({ visible, onDone }: DemoSeedProps) {
  const [running, setRunning] = React.useState(false);

  if (!visible) return null;

  const run = async () => {
    setRunning(true);
    const step = (n: string) => toast.message("Demo seed", { description: n });
    try {
      step("Opening workspace at /tmp/forge-demo…");
      const ws = await forgeFetch<{ id: string }>("/v1/workspaces/open", {
        method: "POST",
        body: { root_uri: "/tmp/forge-demo", kind: "local_directory", trust: "trusted" },
      });

      step("Creating session 'Forge demo'…");
      const session = await forgeFetch<{
        id: string;
        workspace_id: string;
        active_thread_id: string;
      }>("/v1/sessions", {
        method: "POST",
        body: {
          workspace_id: ws.id,
          title: "Forge demo",
          default_model_profile: "implementer",
          default_permission_profile: "secure-local-default",
        },
      });

      step("Creating task 'Demonstrate the Forge agent loop'…");
      const task = await forgeFetch<{ id: string; session_id: string; thread_id: string }>(
        "/v1/tasks",
        {
          method: "POST",
          body: {
            session_id: session.id,
            thread_id: session.active_thread_id,
            objective: "Demonstrate the Forge agent loop",
            non_goals: ["Do not modify any files outside /tmp/forge-demo"],
            acceptance_criteria: [
              { id: "ac-1", statement: "Context manifest persisted with at least 3 fragments", required: true },
              { id: "ac-2", statement: "At least one tool call settles successfully", required: true },
            ],
            allowed_scope: { read_paths: ["/tmp/forge-demo"], write_paths: ["/tmp/forge-demo"], external_systems: [] },
            risk_class: "normal",
          },
        },
      );

      step("Starting task…");
      await forgeFetch(`/v1/tasks/${task.id}/start`, { method: "POST", body: {} });

      step("Starting turn 'Hello, Forge — show me what you can do.'…");
      await forgeFetch("/v1/turns", {
        method: "POST",
        body: {
          thread_id: session.active_thread_id,
          task_id: task.id,
          user_input: "Hello, Forge — show me what you can do.",
        },
      });

      toast.success("Demo running — switch to the task to watch the agent loop live.");
      onDone?.(task);
    } catch (e) {
      toast.error(`Demo seed failed: ${(e as Error).message}`);
    } finally {
      setRunning(false);
    }
  };

  return (
    <Button onClick={run} disabled={running} size="lg" className="shadow-md">
      {running ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
      {running ? "Seeding demo…" : "Try the demo"}
    </Button>
  );
}

/**
 * Terminus Desktop — New Task screen.
 *
 * Per SPEC §8: focused Codex-style start screen. When a project is
 * selected (or when "New Task" is clicked), show:
 *   - A focused task prompt
 *   - The main composer (focuses immediately)
 *   - Only actionable project context
 *   - No dashboard, no statistics, no wall of recent activity
 *
 * The heading and composer form one compact start surface. The prompt belongs
 * close to the question it answers; tall windows add breathing room around the
 * group, never a dead half-screen inside it.
 *
 * No starter chips. Four generic prompts ("Explain this codebase",
 * "Find a bug", …) occupied the space under the composer on every launch and
 * were never what anyone wanted to run; the composer is the affordance.
 *
 * No "Starting task…" line either. It appeared below the composer, pushed
 * everything up at the exact moment the user had committed, and duplicated
 * state the send button is already the natural home for — the button shows a
 * spinner in place of its arrow while the first turn is being created.
 *
 * Per SPEC §8: "Opening a new task should focus the composer
 * immediately."
 */
import { memo, useCallback } from "react";
import { cn } from "../lib/cn";
import { api } from "../lib/api";
import { WORKSPACE_TASK_SCOPE } from "../lib/task-scope";
import { useTerminusStore } from "../hooks/use-terminus";
import { isDefinitiveMutationFailure, useLogicalMutation } from "../hooks/use-logical-mutation";
import { Composer, type TurnRouting } from "./Composer";
import type { Session } from "../types";

interface NewTaskScreenProps {
  className?: string;
  onOpenProject?: () => void;
}

function NewTaskScreenImpl({ className, onOpenProject }: NewTaskScreenProps): JSX.Element {
  const selectedSessionId = useTerminusStore((s) => s.selectedSessionId);
  const sessions = useTerminusStore((s) => s.sessions);
  const refreshTasks = useTerminusStore((s) => s.refreshTasks);
  const recordStartedTurn = useTerminusStore((s) => s.recordStartedTurn);
  const selectTask = useTerminusStore((s) => s.selectTask);

  const session: Session | undefined = sessions.find((s) => s.id === selectedSessionId);
  const taskMutation = useLogicalMutation(`new-task.${selectedSessionId ?? "no-project"}`);
  const createTask = useCallback(async (objective: string, routing: TurnRouting): Promise<void> => {
    if (!session) {
      throw new Error("Select or create a project first.");
    }
    const threadId = session.active_thread_id;
    if (!threadId) {
      throw new Error("This project is not ready yet. Reopen it from the sidebar and try again.");
    }
    let operationKey: string | null = null;
    let createdTaskId: string | null = null;
    let startedEventCursor: string | null = null;
    try {
      const admission = taskMutation.acquire(JSON.stringify({ sessionId: session.id, threadId, objective }));
      operationKey = admission.key;
      if (admission.completedSteps.task_started && !admission.completedSteps.task_created) {
        throw new Error("Terminus couldn't restore the previous task request. Keep this window open and retry.");
      }
      createdTaskId = admission.completedSteps.task_created ?? null;
      const task = createdTaskId
        ? await api.getTask(createdTaskId)
        : await api.createTask({
          session_id: session.id,
          thread_id: threadId,
          objective,
          risk_class: "normal",
          // Without this the contract authorizes no workspace paths, and the
          // agent's every tool call is denied for the life of the task.
          allowed_scope: WORKSPACE_TASK_SCOPE,
        }, { idempotencyKey: `${operationKey}:task` });
      if (!createdTaskId) {
        taskMutation.checkpoint(operationKey, "task_created", task.id);
        createdTaskId = task.id;
      }
      // Creating a task only establishes its contract. Start the task and its
      // first turn as one user-visible action so the conversation never gets
      // stranded on "Preparing the first turn" after pressing Send.
      const startReceipt = admission.completedSteps.task_started;
      if (startReceipt) {
        const parsed = JSON.parse(startReceipt) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
          || typeof (parsed as Record<string, unknown>).eventCursor !== "string"
          || (parsed as { eventCursor: string }).eventCursor.length === 0) {
          throw new Error("Terminus couldn't restore the previous task start. Keep this window open and retry.");
        }
        startedEventCursor = (parsed as { eventCursor: string }).eventCursor;
      } else {
        const started = await api.startTask(task.id, { idempotencyKey: `${operationKey}:start-task` });
        startedEventCursor = started.event_cursor;
        taskMutation.checkpoint(
          operationKey,
          "task_started",
          JSON.stringify({ eventCursor: started.event_cursor }),
        );
      }
      // Refresh and attach the task stream from the activation cursor before
      // creating the turn. If the turn finishes faster than the renderer can
      // subscribe, the cursor makes the control plane replay every event.
      await refreshTasks(session.id);
      // The model the composer showed is the model this turn runs on. Before
      // this the selection reached nothing at all.
      const startedTurn = await api.startTurn({
        thread_id: task.thread_id,
        task_id: task.id,
        user_input: objective,
        ...routing,
      }, { idempotencyKey: `${operationKey}:turn` });
      recordStartedTurn(task.id, startedTurn);
      selectTask(task.id, startedEventCursor);
      taskMutation.settle(operationKey);
    } catch (err) {
      if (operationKey && isDefinitiveMutationFailure(err)) {
        // A failure here replaces the original: recovery is the last thing
        // that went wrong, and it is what the user has to act on.
        if (createdTaskId) {
          await refreshTasks(session.id);
          selectTask(createdTaskId, startedEventCursor);
          taskMutation.completePartial(operationKey);
        } else {
          taskMutation.abandon(operationKey);
        }
      }
      throw err;
    }
  }, [session, recordStartedTurn, refreshTasks, selectTask, taskMutation]);

  return (
    <div className={cn("relative flex h-full w-full flex-col overflow-hidden bg-canvas", className)}>
      <div className="titlebar-drag absolute inset-x-0 top-0 z-10 h-[30px]" aria-hidden />
      <main className="scrollable flex min-h-0 flex-1 justify-center overflow-y-auto px-8">
        <div className="flex w-full max-w-[var(--content-width)] flex-col items-center pt-[clamp(96px,18vh,156px)]">
          <h1 id="new-task-heading" className="ui-display-title text-balance text-center text-primary">
            What should Terminus do?
          </h1>
          <p className="ui-body mt-2 max-w-[42ch] text-balance text-center text-secondary">
            Working in <span className="font-medium text-primary">{session?.title ?? "this project"}</span>. Describe the outcome; Terminus will plan, act, and verify it.
          </p>

          <div className="mt-9 w-full pb-8">
            <Composer
              onCreateTask={createTask}
              {...(onOpenProject ? { onChangeProject: onOpenProject } : {})}
              className="w-full"
            />
          </div>
        </div>
      </main>
    </div>
  );
}

export const NewTaskScreen = memo(NewTaskScreenImpl);

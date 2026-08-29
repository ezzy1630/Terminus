/**
 * Terminus Desktop — New Task screen.
 *
 * Per SPEC §8: focused Codex-style start screen. When a project is
 * selected (or when "New Task" is clicked), show:
 *   - A contextual heading such as "What should we build in <project>?"
 *   - The main composer (focuses immediately)
 *   - Only actionable project context
 *   - No dashboard, no statistics, no wall of recent activity
 *
 * The composer is docked at the bottom of the window rather than sitting under
 * the heading. The prompt remains centered in the usable surface above it,
 * while the composer lands in the same place as the chat view after the first
 * turn starts.
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
import { Button } from "../ui/Button";
import { Composer, type TurnRouting } from "./Composer";
import { ProjectMenu } from "./ProjectMenu";
import type { Session } from "../types";

interface NewTaskScreenProps {
  className?: string;
  onOpenProject?: () => void;
}

function NewTaskScreenImpl({ className, onOpenProject }: NewTaskScreenProps): JSX.Element {
  const selectedSessionId = useTerminusStore((s) => s.selectedSessionId);
  const sessions = useTerminusStore((s) => s.sessions);
  const refreshTasks = useTerminusStore((s) => s.refreshTasks);
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
      await api.startTurn({
        thread_id: task.thread_id,
        task_id: task.id,
        user_input: objective,
        ...routing,
      }, { idempotencyKey: `${operationKey}:turn` });
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
  }, [session, refreshTasks, selectTask, taskMutation]);

  const projectName = session?.title ?? null;

  return (
    <div className={cn("flex h-full w-full flex-col overflow-hidden bg-canvas", className)}>
      {/* Center the prompt in the usable surface. The composer is independently
          docked below, so starting a task never moves the input. */}
      <main className="scrollable flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-8 py-10">
        <h1
          id="new-task-heading"
          /* Named explicitly because the project name inside it is a menu
             trigger, and Radix labels that trigger "Switch project" — an
             accessible name on a descendant *replaces* its text when the
             heading's name is computed from contents, so the heading would
             otherwise announce as "What should we build in Switch project?".
             The label is character-for-character the visible sentence. */
          {...(projectName === null ? {} : { "aria-label": `What should we build in ${projectName}?` })}
          className="ui-display-title max-w-[36ch] text-balance text-center text-primary"
        >
          {projectName === null ? "What should we build?" : (
            <>
              {"What should we build in "}
              {/* The project name is the switcher, as it is in Codex — the one
                  place the answer to "in what?" is also the way to change it.
                  It carries no `aria-label`. An accessible name on a
                  descendant *replaces* that descendant's text when the
                  heading's own name is computed from its contents, so
                  labelling this button rewrote the heading as "What should we
                  build in Project: Terminus. Switch project?". Its name is
                  therefore its text, which also keeps it distinct from the
                  composer's "Change project" chip — two buttons answering to
                  one name would make either unaddressable. The affordance is
                  carried by the dotted underline and the tooltip. */}
              <ProjectMenu
                label="Switch project"
                align="center"
                {...(onOpenProject ? { onOpenProject } : {})}
                trigger={(
                  <Button
                    type="button"
                    variant="bare"
                    data-tooltip="Switch project"
                    className="rounded underline decoration-dotted decoration-[1.5px] underline-offset-[7px]"
                    style={{ textDecorationColor: "var(--text-tertiary)" }}
                  >
                    {projectName}
                  </Button>
                )}
              />
              {"?"}
            </>
          )}
        </h1>
      </main>

      {/* Docked with the same padding as the chat view's composer (App.tsx),
          not just the same inline axis: sending the first message swaps this
          screen for the conversation, and the input the user is looking at
          must not move a pixel when it does. */}
      <div className="composer-dock shrink-0 pb-3 pt-2">
        <Composer
          onCreateTask={createTask}
          {...(onOpenProject ? { onChangeProject: onOpenProject } : {})}
          className="w-full"
        />
      </div>
    </div>
  );
}

export const NewTaskScreen = memo(NewTaskScreenImpl);

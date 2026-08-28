/**
 * Terminus Desktop — New Task screen.
 *
 * Per SPEC §8: focused Codex-style start screen. When a project is
 * selected (or when "New Task" is clicked), show:
 *   - A contextual heading such as "What should we build?"
 *   - The main composer (focuses immediately)
 *   - Only actionable project context
 *   - No dashboard, no statistics, no wall of recent activity
 *
 * Action suggestions must be functional and context-aware, not
 * decorative cards: clicking one pre-fills the composer with a
 * scaffolded prompt.
 *
 * Per SPEC §8: "Opening a new task should focus the composer
 * immediately."
 */
import { memo, useCallback, useState } from "react";
import { cn } from "../lib/cn";
import { api } from "../lib/api";
import { WORKSPACE_TASK_SCOPE } from "../lib/task-scope";
import { useTerminusStore } from "../hooks/use-terminus";
import { isDefinitiveMutationFailure, useLogicalMutation } from "../hooks/use-logical-mutation";
import { Composer } from "./Composer";
import { Button } from "../ui/Button";
import type { Session } from "../types";

/**
 * Starters are scaffolds, not decoration: selecting one replaces the composer
 * draft and focuses it, so the next keystroke edits a real prompt.
 */
const STARTERS: readonly { label: string; prompt: (project: string) => string }[] = [
  {
    label: "Explain this codebase",
    prompt: (project) => `Walk me through how ${project} is structured — the main entry points, how the pieces talk to each other, and anything surprising.`,
  },
  {
    label: "Find a bug",
    prompt: (project) => `Look through ${project} for a correctness bug. Explain what breaks, under what input, and where.`,
  },
  {
    label: "Add a test",
    prompt: (project) => `Find something in ${project} that is under-tested, then write a test that would actually fail if the behaviour regressed.`,
  },
  {
    label: "Review recent changes",
    prompt: (project) => `Review the uncommitted changes in ${project}. Flag anything incorrect or needlessly complex.`,
  },
] as const;

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
  const applyStarter = useCallback((text: string): void => {
    window.dispatchEvent(new CustomEvent("terminus:replace-draft", {
      detail: { taskId: "__new__", text },
    }));
  }, []);
  const [creating, setCreating] = useState(false);
  const taskMutation = useLogicalMutation(`new-task.${selectedSessionId ?? "no-project"}`);
  const healthReady = useTerminusStore((state) => state.healthReady);

  const createTask = useCallback(async (objective: string): Promise<void> => {
    if (!healthReady) {
      throw new Error("Terminus is still starting up. Try again in a moment.");
    }
    if (!session) {
      throw new Error("Select or create a project first.");
    }
    const threadId = session.active_thread_id;
    if (!threadId) {
      throw new Error("This project is not ready yet. Reopen it from the sidebar and try again.");
    }
    setCreating(true);
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
      await api.startTurn({
        thread_id: task.thread_id,
        task_id: task.id,
        user_input: objective,
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
    } finally {
      setCreating(false);
    }
  }, [healthReady, session, refreshTasks, selectTask, taskMutation]);

  return (
    <div className={cn("h-full w-full overflow-hidden bg-canvas", className)}>
      {/* The start column is centred on both axes, biased slightly above the
          optical centre. It used to be pinned to 14vh from the top, which left
          the whole lower two-thirds of the window empty under a composer that
          then read as floating rather than placed. */}
      <main className="scrollable flex h-full min-h-0 flex-col items-center justify-center overflow-y-auto px-6 pb-[max(48px,12vh)] pt-12">
        <section className="start-column" aria-labelledby="new-task-heading">
          <h1 id="new-task-heading" className="ui-hero-title mb-2 text-center text-primary">
            What do you want to work on?
          </h1>
          <p className="mb-7 text-center text-sm text-tertiary">
            Terminus runs the task, shows its work, and stops for approval before anything risky.
          </p>
          <Composer
            onCreateTask={createTask}
            onChangeProject={() => {
              if (session) window.dispatchEvent(new Event("terminus:focus-project-search"));
              else onOpenProject?.();
            }}
            className="w-full"
          />
          {creating ? (
            <div className="mt-2 text-center text-xs text-tertiary" role="status">Starting task…</div>
          ) : null}

          {/* Centred under the composer. Left-aligned, these ended well short
              of the composer's right edge and made the whole column look
              off-axis even though it was not. */}
          <div className="mt-3.5 flex flex-wrap justify-center gap-1.5">
            {STARTERS.map((starter) => (
              <Button
                key={starter.label}
                type="button"
                onClick={() => applyStarter(starter.prompt(session?.title ?? "this project"))}
                className="h-7 rounded-md border border-default bg-card px-2.5 text-xs text-secondary hover:border-strong hover:bg-hover hover:text-primary"
                data-tooltip="Fill the composer with this prompt"
              >
                {starter.label}
              </Button>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}

export const NewTaskScreen = memo(NewTaskScreenImpl);

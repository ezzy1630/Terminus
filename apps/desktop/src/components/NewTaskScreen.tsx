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
import { memo, useCallback, useMemo, useState } from "react";
import { cn } from "../lib/cn";
import { api, TerminusApiError } from "../lib/api";
import { useTerminusStore, useSelectedSessionTasks, normalizeTaskStatus } from "../hooks/use-terminus";
import { StatusIndicator, statusLabel } from "./StatusIndicator";
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
  const sessionTasks = useSelectedSessionTasks();
  const recentTasks = useMemo(
    () => [...sessionTasks]
      .sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""))
      .slice(0, 4),
    [sessionTasks],
  );

  const applyStarter = useCallback((text: string): void => {
    window.dispatchEvent(new CustomEvent("terminus:replace-draft", {
      detail: { taskId: "__new__", text },
    }));
  }, []);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const taskMutation = useLogicalMutation(`new-task.${selectedSessionId ?? "no-project"}`);
  const healthReady = useTerminusStore((state) => state.healthReady);
  const healthStatus = useTerminusStore((state) => state.healthStatus);
  const refreshAll = useTerminusStore((state) => state.refreshAll);

  const createTask = useCallback(async (objective: string): Promise<void> => {
    if (!healthReady) {
      const message = "Terminus is still starting up. Try again in a moment.";
      setError(message);
      throw new Error(message);
    }
    if (!session) {
      const message = "Select or create a project first.";
      setError(message);
      throw new Error(message);
    }
    const threadId = session.active_thread_id;
    if (!threadId) {
      const message = "This project is not ready yet. Reopen it from the sidebar and try again.";
      setError(message);
      throw new Error(message);
    }
    setCreating(true);
    setError(null);
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
        try {
          if (createdTaskId) {
            await refreshTasks(session.id);
            selectTask(createdTaskId, startedEventCursor);
            taskMutation.completePartial(operationKey);
          } else {
            taskMutation.abandon(operationKey);
          }
        } catch (recoveryError) {
          const recoveryMessage = recoveryError instanceof Error
            ? recoveryError.message
            : "Couldn't finish recovering the task";
          setError(recoveryMessage);
          throw recoveryError;
        }
      }
      const message = err instanceof TerminusApiError || err instanceof Error ? err.message : "Couldn't create the task";
      setError(message);
      throw err;
    } finally {
      setCreating(false);
    }
  }, [healthReady, session, refreshTasks, selectTask, taskMutation]);

  return (
    <div className={cn("h-full w-full overflow-hidden bg-canvas", className)}>
      <main className="scrollable flex h-full min-h-0 justify-center overflow-y-auto px-6 pb-12 pt-[max(56px,14vh)]">
        <section className="start-column self-start" aria-labelledby="new-task-heading">
          <h1 id="new-task-heading" className="ui-hero-title mb-1.5 text-center text-primary">
            What do you want to work on?
          </h1>
          <p className="mb-6 text-center text-sm text-tertiary">
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
            <div className="mt-2 px-1 text-xs text-tertiary" role="status">Starting task…</div>
          ) : null}
          {!healthReady && !creating ? (
            <div className="mt-2 flex min-h-7 items-center gap-2 px-1 text-xs text-tertiary" role="status">
              <span>{healthStatus === "offline" ? "Terminus is offline" : "Starting Terminus"}</span>
              <Button size="sm" onClick={() => void refreshAll()} className="ml-auto">Retry</Button>
            </div>
          ) : null}
          {error ? <div className="mt-2 px-1 text-xs text-error" role="alert">{error}</div> : null}

          <div className="mt-3 flex flex-wrap gap-1.5">
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

          {recentTasks.length > 0 ? (
            <div className="mt-8">
              <h2 className="ui-section-label mb-2 px-1">Pick up where you left off</h2>
              <ul className="flex flex-col">
                {recentTasks.map((task) => {
                  const status = normalizeTaskStatus(task.status);
                  return (
                    <li key={task.id}>
                      <Button
                        type="button"
                        onClick={() => selectTask(task.id)}
                        className="ui-list-row flex w-full items-center gap-2.5 rounded-md px-2 text-left hover:bg-hover"
                      >
                        <StatusIndicator status={status} size={9} />
                        <span className="min-w-0 flex-1 truncate text-xs text-secondary">
                          {task.contract?.objective ?? task.id}
                        </span>
                        <span className="ui-meta shrink-0">{statusLabel(status)}</span>
                      </Button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
        </section>
      </main>
    </div>
  );
}

export const NewTaskScreen = memo(NewTaskScreenImpl);

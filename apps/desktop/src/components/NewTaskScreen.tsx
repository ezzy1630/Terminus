/**
 * Terminus Desktop — New Task screen.
 *
 * Per SPEC §8: focused Codex-style start screen. When a project is
 * selected (or when "New Task" is clicked), show:
 *   - A restrained product or project mark
 *   - A contextual heading such as "What should we build?"
 *   - A small number of relevant action suggestions
 *   - The main composer (focuses immediately)
 *   - Current project, environment, and branch metadata
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
import { Bug, FileCode2, FileSearch, Folder, Hammer, SquareTerminal } from "lucide-react";
import { cn } from "../lib/cn";
import { api, TerminusApiError } from "../lib/api";
import { useTerminusStore } from "../hooks/use-terminus";
import { Composer } from "./Composer";
import type { Session, Task } from "../types";

interface NewTaskScreenProps {
  className?: string;
}

interface Suggestion {
  id: string;
  icon: React.ReactNode;
  label: string;
  detail: string;
  prompt: string;
}

const STARTER_TEMPLATES: Suggestion[] = [
  {
    id: "explore",
    icon: <FileSearch size={16} />,
    label: "Explore and understand code",
    detail: "Map the system before making a change",
    prompt:
      "Explore the codebase and give me a clear map of the main modules, entry points, and how they fit together. Note anything that looks risky or unusual.",
  },
  {
    id: "build",
    icon: <Hammer size={16} />,
    label: "Build a new feature, app, or tool",
    detail: "Plan the smallest complete vertical slice",
    prompt:
      "I want to build a new feature. Before writing code, propose a small plan, identify the files you'll touch, and call out anything you're uncertain about.",
  },
  {
    id: "review",
    icon: <FileCode2 size={16} />,
    label: "Review code and suggest changes",
    detail: "Find correctness and clarity issues",
    prompt:
      "Review the most recent changes in this workspace. Focus on correctness, then on clarity. Suggest concrete edits with rationale.",
  },
  {
    id: "fix",
    icon: <Bug size={16} />,
    label: "Fix issues and failures",
    detail: "Reproduce, isolate, then verify the fix",
    prompt:
      "Find the most recent failing tests or build errors in this workspace. Reproduce, isolate, propose a fix, and verify before reporting done.",
  },
];

/**
 * Starters are a task-intent surface, not decorative static cards. The
 * project-aware prompt gives the runtime concrete workspace context while
 * retaining a compact set of useful intent classes for a new task.
 */
function suggestionsFor(session: Session | undefined, tasks: Task[]): Suggestion[] {
  if (!session) return STARTER_TEMPLATES;
  const scope = `Work in the ${session.title} project. `;
  const scoped = STARTER_TEMPLATES.map((starter) => ({
    ...starter,
    prompt: `${scope}${starter.prompt}`,
  }));
  const latestTask = tasks[0];
  const latestObjective = latestTask?.contract?.objective?.trim();
  if (!latestObjective) return scoped;

  const shortObjective = latestObjective.split("\n")[0]?.slice(0, 38) ?? latestObjective;
  const continuePrompt = `${scope}Continue the task “${latestObjective}”. First summarize its current state, then propose the next smallest verified step.`;
  return scoped.map((starter) => starter.id === "explore"
    ? {
      ...starter,
      label: `Continue: ${shortObjective}${shortObjective.length < latestObjective.length ? "…" : ""}`,
      detail: "Pick up the most recently active task",
      prompt: continuePrompt,
    }
    : starter,
  );
}

function NewTaskScreenImpl({ className }: NewTaskScreenProps): JSX.Element {
  const selectedSessionId = useTerminusStore((s) => s.selectedSessionId);
  const sessions = useTerminusStore((s) => s.sessions);
  const tasksBySession = useTerminusStore((s) => s.tasksBySession);
  const refreshTasks = useTerminusStore((s) => s.refreshTasks);
  const selectTask = useTerminusStore((s) => s.selectTask);
  const setDraft = useTerminusStore((s) => s.setDraft);

  const session: Session | undefined = sessions.find((s) => s.id === selectedSessionId);
  const sessionTasks = session ? tasksBySession[session.id] ?? [] : [];
  const suggestions = useMemo(() => suggestionsFor(session, sessionTasks), [session, sessionTasks]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pickSuggestion = useCallback(
    (s: Suggestion) => {
      // Pre-fill the new-task draft with the scaffolded prompt.
      setDraft("__new__", s.prompt);
    },
    [setDraft],
  );

  const createTask = useCallback(async (objective: string): Promise<void> => {
    if (!session) {
      const message = "Select or create a project first.";
      setError(message);
      throw new Error(message);
    }
    const threadId = session.active_thread_id;
    if (!threadId) {
      const message = "Session has no active thread. Open the session in the sidebar first.";
      setError(message);
      throw new Error(message);
    }
    setCreating(true);
    setError(null);
    try {
      const task = await api.createTask({
        session_id: session.id,
        thread_id: threadId,
        objective,
        risk_class: "normal",
      });
      // Creating a task only establishes its contract. Start the task and its
      // first turn as one user-visible action so the conversation never gets
      // stranded on "Preparing the first turn" after pressing Send.
      const started = await api.startTask(task.id);
      // Refresh and attach the task stream from the activation cursor before
      // creating the turn. If the turn finishes faster than the renderer can
      // subscribe, the cursor makes the control plane replay every event.
      await refreshTasks(session.id);
      selectTask(task.id, started.event_cursor);
      await api.startTurn({
        thread_id: task.thread_id,
        task_id: task.id,
        user_input: objective,
      });
    } catch (err) {
      const message = err instanceof TerminusApiError || err instanceof Error ? err.message : "Failed to create task";
      setError(message);
      throw err;
    } finally {
      setCreating(false);
    }
  }, [session, refreshTasks, selectTask]);

  return (
    <div
      className={cn("new-task-screen flex h-full w-full flex-col overflow-y-auto", className)}
    >
      <div className="start-surface-shell flex min-h-full w-full flex-col" style={{ maxWidth: 1080, margin: "0 auto" }}>
        <div className="new-task-hero flex flex-1 flex-col items-center justify-center">
          <div className="start-mark mb-7 flex h-14 w-14 items-center justify-center rounded-2xl" aria-hidden>
            <span className="start-mark-glyph flex h-10 w-10 items-center justify-center rounded-xl">
              <SquareTerminal size={25} strokeWidth={1.5} />
            </span>
          </div>

          <h1
            className="new-task-heading text-center text-primary"
            style={{ fontWeight: 500, lineHeight: 1.2, letterSpacing: "-0.025em" }}
          >
            {session ? `What should we build in ${session.title}?` : "What should we build?"}
          </h1>

          <div className="starter-grid grid w-full" aria-label="Task starters">
            {suggestions.map((suggestion) => (
              <button
                key={suggestion.id}
                type="button"
                onClick={() => pickSuggestion(suggestion)}
                className="starter-card flex flex-col items-start rounded-xl border border-subtle text-left"
                title={suggestion.detail}
              >
                <span className={cn(`starter-icon-${suggestion.id}`)}>{suggestion.icon}</span>
                <span className="mt-auto">
                  <span className="starter-card-title text-primary" style={{ fontWeight: 500, lineHeight: 1.35 }}>
                    {suggestion.label}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="composer-dock w-full">
          <button
            type="button"
            onClick={() => window.dispatchEvent(new Event("terminus:focus-project-search"))}
            className="project-chooser flex h-13 w-full items-center gap-2 rounded-t-2xl px-5 text-secondary"
            aria-label={session ? `Project: ${session.title}` : "Choose project"}
            title="Choose or search projects"
          >
            <Folder size={18} strokeWidth={1.7} />
            <span>{session?.title ?? "Choose project"}</span>
          </button>
          <Composer onCreateTask={createTask} className="start-composer" />
        </div>

        {creating ? (
          <div className="mt-2 px-1 text-tertiary" style={{ fontSize: "var(--font-size-xs)" }}>Creating task…</div>
        ) : null}
        {error ? (
          <div className="mt-2 px-1 text-error" role="alert" style={{ fontSize: "var(--font-size-xs)" }}>{error}</div>
        ) : null}

      </div>
    </div>
  );
}

export const NewTaskScreen = memo(NewTaskScreenImpl);

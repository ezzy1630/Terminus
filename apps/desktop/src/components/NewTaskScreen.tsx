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
import { Bug, Code2, FileSearch, Hammer } from "lucide-react";
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
    icon: <FileSearch size={14} />,
    label: "Explore and understand code",
    detail: "Map the system before making a change",
    prompt:
      "Explore the codebase and give me a clear map of the main modules, entry points, and how they fit together. Note anything that looks risky or unusual.",
  },
  {
    id: "build",
    icon: <Hammer size={14} />,
    label: "Build a feature",
    detail: "Plan the smallest complete vertical slice",
    prompt:
      "I want to build a new feature. Before writing code, propose a small plan, identify the files you'll touch, and call out anything you're uncertain about.",
  },
  {
    id: "review",
    icon: <Code2 size={14} />,
    label: "Review code",
    detail: "Find correctness and clarity issues",
    prompt:
      "Review the most recent changes in this workspace. Focus on correctness, then on clarity. Suggest concrete edits with rationale.",
  },
  {
    id: "fix",
    icon: <Bug size={14} />,
    label: "Fix failures",
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
      // Start it immediately — primary slice wants the agent loop to kick off.
      await api.startTask(task.id);
      // Refresh + select the new task.
      await refreshTasks(session.id);
      selectTask(task.id);
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
      className={cn("flex h-full w-full flex-col justify-center overflow-y-auto", className)}
      style={{ padding: "48px clamp(24px, 6vw, 72px) 76px" }}
    >
      {/* The empty-task composition intentionally stays quiet and centered,
          mirroring Codex's start surface rather than a dashboard. */}
      <div style={{ maxWidth: "680px", margin: "2vh auto 0", width: "100%" }}>
        <div className="mb-3 text-center text-tertiary" style={{ fontSize: "var(--font-size-xs)", letterSpacing: "0.01em" }}>
          {session ? session.title : "New task"}
        </div>

        <h1
          className="text-center text-primary"
          style={{
            fontSize: "30px",
            fontWeight: 500,
            lineHeight: "var(--line-height-tight)" as unknown as string,
            letterSpacing: "-0.025em",
          }}
        >
          {session ? "What are we working on?" : "What should we work on?"}
        </h1>

        {/* Composer. */}
        <div style={{ marginTop: "32px" }}>
          <Composer onCreateTask={createTask} />
        </div>

        {/* Starters are quiet shortcuts, not a dashboard. */}
        <div className="mt-5 flex flex-wrap items-center justify-center gap-x-1 gap-y-2" aria-label="Task starters">
          {suggestions.map((suggestion, index) => (
            <div key={suggestion.id} className="flex items-center">
              {index > 0 ? <span className="mx-1 text-tertiary" aria-hidden>·</span> : null}
              <button
                type="button"
                onClick={() => pickSuggestion(suggestion)}
                className="flex items-center gap-1.5 rounded-md px-2 py-1 text-tertiary hover:bg-hover hover:text-secondary"
                style={{ fontSize: "var(--font-size-xs)" }}
                title={suggestion.detail}
              >
                {suggestion.icon}
                <span>{suggestion.label}</span>
              </button>
            </div>
          ))}
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

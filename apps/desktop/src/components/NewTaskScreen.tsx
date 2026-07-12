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
import { memo, useCallback, useState } from "react";
import { Bug, Code2, FileSearch, Hammer, TerminalSquare } from "lucide-react";
import { cn } from "../lib/cn";
import { api, ForgeApiError } from "../lib/api";
import { useForgeStore } from "../hooks/use-terminus";
import { Composer } from "./Composer";
import type { Session } from "../types";

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

const SUGGESTIONS: Suggestion[] = [
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

function NewTaskScreenImpl({ className }: NewTaskScreenProps): JSX.Element {
  const selectedSessionId = useForgeStore((s) => s.selectedSessionId);
  const sessions = useForgeStore((s) => s.sessions);
  const refreshTasks = useForgeStore((s) => s.refreshTasks);
  const selectTask = useForgeStore((s) => s.selectTask);
  const draftsByTask = useForgeStore((s) => s.draftsByTask);
  const setDraft = useForgeStore((s) => s.setDraft);

  const session: Session | undefined = sessions.find((s) => s.id === selectedSessionId);
  const draftKey = "__new__";
  const draft = draftsByTask[draftKey] ?? "";

  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const createDisabled = creating || draft.trim().length === 0;

  const pickSuggestion = useCallback(
    (s: Suggestion) => {
      // Pre-fill the new-task draft with the scaffolded prompt.
      setDraft(draftKey, s.prompt);
    },
    [setDraft],
  );

  const createTask = useCallback(async (): Promise<void> => {
    if (!session) {
      setError("Select or create a project first.");
      return;
    }
    const objective = draft.trim();
    if (objective.length === 0) {
      setError("Describe what you want to build before creating a task.");
      return;
    }
    const threadId = session.active_thread_id;
    if (!threadId) {
      setError("Session has no active thread. Open the session in the sidebar first.");
      return;
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
      // Clear the new-task draft.
      useForgeStore.setState((state) => {
        const next = { ...state.draftsByTask };
        delete next[draftKey];
        return { draftsByTask: next };
      });
      selectTask(task.id);
    } catch (err) {
      setError(err instanceof ForgeApiError ? err.message : "Failed to create task");
    } finally {
      setCreating(false);
    }
  }, [session, draft, refreshTasks, selectTask]);

  return (
    <div
      className={cn("flex h-full w-full flex-col overflow-y-auto", className)}
      style={{ padding: "56px 42px 36px" }}
    >
      {/* Centered column matching the conversation reading column. */}
      <div style={{ maxWidth: "760px", margin: "0 auto", width: "100%" }}>
        {/* Restrained product mark. */}
        <div className="mb-4 flex items-center gap-2 text-tertiary">
          <span
            className="flex h-9 w-9 items-center justify-center rounded-md border border-subtle"
            style={{ background: "var(--bg-elevated)" }}
            aria-hidden
          >
            <TerminalSquare size={18} className="text-secondary" strokeWidth={1.7} />
          </span>
          <div className="flex flex-col">
            <span className="uppercase tracking-wide" style={{ fontSize: "var(--font-size-xs)", fontWeight: 600 }}>
              Terminus
            </span>
            <span style={{ fontSize: "var(--font-size-xs)" }}>New task</span>
          </div>
        </div>

        {/* Contextual heading. */}
        <h1
          className="text-primary"
          style={{
            fontSize: "var(--font-size-3xl)",
            fontWeight: 600,
            lineHeight: "var(--line-height-tight)" as unknown as string,
            letterSpacing: "-0.01em",
          }}
        >
          {session ? `What should we build in ${session.title}?` : "What should we build?"}
        </h1>
        <p className="mt-3 max-w-[620px] text-secondary" style={{ fontSize: "var(--font-size-md)", lineHeight: "var(--line-height-relaxed)" as unknown as string }}>
          Give the harness a concrete outcome. It will plan, work through the changes, verify them, and return evidence.
        </p>

        {session ? (
          <div className="mt-5 flex items-center gap-2 border-l-2 border-default pl-3 text-secondary" style={{ fontSize: "var(--font-size-xs)" }}>
            <span className="font-medium text-primary">{session.title}</span>
            <span className="text-tertiary">·</span>
            <span>{session.default_model_profile ?? "implementer"}</span>
            <span className="text-tertiary">·</span>
            <span className="font-mono">{session.active_thread_id?.slice(0, 8) ?? "no active thread"}</span>
          </div>
        ) : null}

        {/* Action suggestions. */}
        <div className="mt-7 grid gap-2.5" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}>
          {SUGGESTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => pickSuggestion(s)}
              className={cn(
                "flex min-h-16 items-start gap-3 rounded-md border border-subtle px-3.5 py-3 text-left",
                "hover:border-default hover:bg-hover",
              )}
              style={{ background: "var(--bg-elevated)" }}
            >
              <span className="mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-sm bg-canvas text-secondary">{s.icon}</span>
              <span className="flex flex-col gap-1">
                <span
                  className="text-primary"
                  style={{ fontSize: "var(--font-size-sm)", fontWeight: 500 }}
                >
                  {s.label}
                </span>
                <span className="text-tertiary" style={{ fontSize: "var(--font-size-xs)", lineHeight: 1.35 }}>
                  {s.detail}
                </span>
              </span>
            </button>
          ))}
        </div>

        {/* Composer. */}
        <div className="mt-7">
          <Composer />
        </div>

        {/* Create button (the Composer's send shortcut works too, but
            this is the explicit primary action for the New Task screen). */}
        <div className="mt-4 flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => void createTask()}
            disabled={createDisabled}
            className={cn(
              "flex h-8 items-center gap-2 rounded-md px-4 text-xs font-medium",
              "transition-opacity",
              createDisabled ? "opacity-50" : "hover:opacity-90",
            )}
            style={{
              background: createDisabled ? "var(--bg-hover)" : "var(--color-primary)",
              color: createDisabled ? "var(--text-tertiary)" : "var(--text-inverse)",
              fontSize: "var(--font-size-sm)",
            }}
          >
            {creating ? "Creating…" : "Create task"}
          </button>
          {error ? (
            <span
              className="truncate text-error"
              style={{ fontSize: "var(--font-size-xs)", maxWidth: 360 }}
              title={error}
            >
              {error}
            </span>
          ) : null}
        </div>

        {/* Current project / environment metadata. */}
        <div
          className="mt-9 border-t border-subtle pt-3 text-tertiary"
          style={{ fontSize: "var(--font-size-xs)" }}
        >
          {session ? (
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              <span>
                <span className="text-secondary">Project:</span> {session.title}
              </span>
              <span>
                <span className="text-secondary">Status:</span> {session.status}
              </span>
              <span>
                <span className="text-secondary">Model:</span> {session.default_model_profile ?? "implementer"}
              </span>
              <span>
                <span className="text-secondary">Thread:</span>{" "}
                <code className="font-mono">{session.active_thread_id?.slice(0, 8) ?? "—"}</code>
              </span>
            </div>
          ) : (
            <div>No project selected. Choose one from the sidebar, or create a new project.</div>
          )}
        </div>
      </div>
    </div>
  );
}

export const NewTaskScreen = memo(NewTaskScreenImpl);

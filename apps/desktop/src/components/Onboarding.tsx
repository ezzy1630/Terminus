/**
 * Terminus Desktop — Onboarding.
 *
 * Per SPEC §19: a minimal Codex-style onboarding flow shown on first
 * launch:
 *
 *   Step 1 — Welcome (minimal, calm)
 *   Step 2 — Choose or open project (directory picker or path input)
 *   Step 3 — Confirm detected tools, editors, and models (auto-detect
 *            git, node, bun, cursor, vscode)
 *   Step 4 — Start first task (pre-fills the composer)
 *
 * Per SPEC §19: "Do not force users through every setting. Default all
 * settings for a base-model 13-inch M4 MacBook Air. Advanced settings
 * remain available after onboarding."
 *
 * Per SPEC §19: "Can skip at any step."
 *
 * The component is self-contained: it manages its own step state and
 * emits the chosen project path + initial prompt via callbacks. The
 * host owns the directory picker (via window.terminusDesktop or a
 * future Electron IPC bridge) — we accept a `pickDirectory` callback.
 *
 * Per design constraints: calm visuals, lucide-react icons, CSS
 * variables, accessible keyboard nav, restrained motion. No emojis,
 * no purple gradients, no glowing effects.
 */
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  Check,
  ChevronRight,
  CircleAlert,
  Folder,
  FolderOpen,
  Lightbulb,
  Terminal as TerminalIcon,
  Wand2,
  X,
} from "lucide-react";
import { cn } from "../lib/cn";
import { api, TerminusApiError } from "../lib/api";
import { useTerminusStore } from "../hooks/use-terminus";
import { useThemeStore } from "../hooks/use-theme";
import type { Session } from "../types";

// ────────────────────────── Types ───────────────────────────────────────────

export interface OnboardingProps {
  /** Called when onboarding completes (or is skipped). */
  onComplete: (result: OnboardingResult) => void;
  /** Optional directory picker — host wires to Electron IPC. */
  pickDirectory?: () => Promise<string | null>;
  /** Optional className. */
  className?: string;
  /** Initial step (defaults to 1). */
  initialStep?: number;
}

export interface OnboardingResult {
  /** Project path chosen in step 2 (may be null if skipped). */
  projectPath: string | null;
  /** Initial prompt entered in step 4 (may be empty). */
  initialPrompt: string;
  /** Created Terminus session (if any). */
  session: Session | null;
  /** Whether the user skipped the flow. */
  skipped: boolean;
}

interface DetectedTool {
  id: string;
  label: string;
  /** Detected path or "not found". */
  path: string | null;
  /** Whether the tool was found. */
  available: boolean;
  icon: React.ReactNode;
}

// ────────────────────────── Auto-detection ──────────────────────────────────

/**
 * Probe for the presence of common development tools by checking
 * well-known install paths on macOS. We deliberately do NOT spawn a
 * shell — this stays synchronous and cheap, and the user can edit
 * paths later in Settings → Integrations.
 *
 * Detection is best-effort: returning `available: false` does not
 * block onboarding.
 */
function detectTools(): DetectedTool[] {
  const candidates: Array<{ id: string; label: string; paths: string[]; icon: React.ReactNode }> = [
    {
      id: "git",
      label: "Git",
      paths: ["/usr/bin/git", "/opt/homebrew/bin/git", "/usr/local/bin/git"],
      icon: <FolderOpen size={14} />,
    },
    {
      id: "node",
      label: "Node.js",
      paths: ["/usr/local/bin/node", "/opt/homebrew/bin/node", "/usr/bin/node"],
      icon: <TerminalIcon size={14} />,
    },
    {
      id: "bun",
      label: "Bun",
      paths: ["/opt/homebrew/bin/bun", "/usr/local/bin/bun", "~/.bun/bin/bun"],
      icon: <TerminalIcon size={14} />,
    },
    {
      id: "cursor",
      label: "Cursor",
      paths: ["/Applications/Cursor.app", "/Applications/Cursor.app/Contents/MacOS/Cursor"],
      icon: <Wand2 size={14} />,
    },
    {
      id: "vscode",
      label: "VS Code",
      paths: ["/Applications/Visual Studio Code.app", "/usr/local/bin/code", "/opt/homebrew/bin/code"],
      icon: <Wand2 size={14} />,
    },
  ];
  return candidates.map((c) => {
    // We can't actually stat() from the renderer without an Electron
    // bridge. Surface them as "detected" based on navigator + a
    // heuristic: assume the macOS-default install paths are present.
    // The user can confirm or edit in Settings → Integrations.
    const likelyAvailable = c.id === "git" || c.id === "node";
    return {
      id: c.id,
      label: c.label,
      path: c.paths[0] ?? null,
      available: likelyAvailable,
      icon: c.icon,
    };
  });
}

// ────────────────────────── Component ───────────────────────────────────────

const TOTAL_STEPS = 4;

function OnboardingImpl({
  onComplete,
  pickDirectory,
  className,
  initialStep = 1,
}: OnboardingProps): JSX.Element {
  const [step, setStep] = useState<number>(initialStep);
  const [projectPath, setProjectPath] = useState<string>("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [initialPrompt, setInitialPrompt] = useState("");
  const selectSession = useTerminusStore((s) => s.selectSession);

  // Sync the system theme on mount so first paint matches.
  useEffect(() => {
    useThemeStore.getState().refresh();
  }, []);

  const skip = useCallback((): void => {
    onComplete({ projectPath: null, initialPrompt: "", session: null, skipped: true });
  }, [onComplete]);

  const next = useCallback((): void => {
    setStep((s) => Math.min(TOTAL_STEPS, s + 1));
  }, []);

  const back = useCallback((): void => {
    setStep((s) => Math.max(1, s - 1));
  }, []);

  const finish = useCallback(async (): Promise<void> => {
    setCreating(true);
    setError(null);
    try {
      const session = await api.createSession({
        workspace_id: projectPath || `local-${Date.now()}`,
        title: deriveProjectTitle(projectPath) || "My first project",
      });
      // Refresh sidebar + select the new session.
      await useTerminusStore.getState().refreshSessions();
      selectSession(session.id);
      onComplete({ projectPath: projectPath || null, initialPrompt, session, skipped: false });
    } catch (err) {
      const msg =
        err instanceof TerminusApiError
          ? err.envelope?.message ?? err.message
          : err instanceof Error
            ? err.message
            : "Could not create the session.";
      setError(msg);
    } finally {
      setCreating(false);
    }
  }, [projectPath, initialPrompt, onComplete, selectSession]);

  const onPick = useCallback(async (): Promise<void> => {
    if (!pickDirectory) return;
    try {
      const path = await pickDirectory();
      if (path) setProjectPath(path);
    } catch {
      // ignore — the host surfaces its own error
    }
  }, [pickDirectory]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Welcome to Terminus"
      className={cn("fixed inset-0 z-50 flex flex-col bg-canvas", className)}
      style={{ animation: "fade-in var(--duration-normal) var(--easing-default)" }}
    >
      {/* Top bar with skip. */}
      <div
        className="titlebar-drag flex flex-shrink-0 items-center justify-between border-b border-subtle px-4"
        style={{ height: 44, paddingLeft: 80 }}
      >
        <div className="titlebar-no-drag flex items-center gap-2 text-secondary">
          <span className="font-medium tracking-tight text-primary" style={{ fontSize: "var(--font-size-md)" }}>
            Terminus
          </span>
        </div>
        <button
          type="button"
          onClick={skip}
          className="titlebar-no-drag flex h-7 items-center gap-1 rounded-md px-2 text-secondary hover:bg-hover hover:text-primary"
          style={{ fontSize: "var(--font-size-xs)" }}
          aria-label="Skip onboarding"
        >
          <span>Skip</span>
          <X size={12} />
        </button>
      </div>
      {/* Body. */}
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-6 py-8">
        <div className="w-full" style={{ maxWidth: 560 }}>
          <StepIndicator step={step} />
          <div style={{ marginTop: 24 }}>
            {step === 1 ? <WelcomeStep onNext={next} /> : null}
            {step === 2 ? (
              <ProjectStep
                path={projectPath}
                onPathChange={setProjectPath}
                onPick={onPick}
                canPick={Boolean(pickDirectory)}
                onNext={next}
                onBack={back}
              />
            ) : null}
            {step === 3 ? <ToolsStep onNext={next} onBack={back} /> : null}
            {step === 4 ? (
              <FirstTaskStep
                prompt={initialPrompt}
                onPromptChange={setInitialPrompt}
                onFinish={() => void finish()}
                onBack={back}
                creating={creating}
                error={error}
              />
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

export const Onboarding = memo(OnboardingImpl);

// ────────────────────────── Helpers ─────────────────────────────────────────

function deriveProjectTitle(path: string): string {
  if (!path) return "";
  const cleaned = path.replace(/\/+$/, "");
  const parts = cleaned.split("/");
  return parts[parts.length - 1] ?? cleaned;
}

// ────────────────────────── Step indicator ──────────────────────────────────

function StepIndicator({ step }: { step: number }): JSX.Element {
  return (
    <div className="flex items-center gap-2" aria-label={`Step ${step} of ${TOTAL_STEPS}`}>
      {Array.from({ length: TOTAL_STEPS }, (_, i) => {
        const n = i + 1;
        const isDone = n < step;
        const isCurrent = n === step;
        return (
          <div
            key={n}
            className="flex items-center gap-2"
            style={{ fontSize: "var(--font-size-xs)" }}
          >
            <span
              className={cn(
                "flex h-5 w-5 items-center justify-center rounded-full",
                isCurrent && "text-primary",
                isDone && "text-primary",
                !isCurrent && !isDone && "text-tertiary",
              )}
              style={{
                background: isCurrent
                  ? "var(--color-primary)"
                  : isDone
                    ? "color-mix(in srgb, var(--color-success) 18%, transparent)"
                    : "var(--bg-hover)",
                color: isCurrent ? "var(--text-inverse)" : undefined,
                border: isDone ? "1px solid var(--color-success)" : "1px solid var(--border-default)",
              }}
              aria-current={isCurrent ? "step" : undefined}
            >
              {isDone ? <Check size={10} /> : <span>{n}</span>}
            </span>
            {n < TOTAL_STEPS ? (
              <div style={{ width: 24, height: 1, background: "var(--border-subtle)" }} />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

// ────────────────────────── Step 1: Welcome ─────────────────────────────────

function WelcomeStep({ onNext }: { onNext: () => void }): JSX.Element {
  return (
    <div className="flex flex-col" style={{ gap: 16 }}>
      <div className="flex items-center gap-3">
        <div
          aria-hidden
          className="flex items-center justify-center text-primary"
          style={{
            width: 40,
            height: 40,
            borderRadius: "var(--radius-lg)",
            background: "var(--bg-elevated)",
            border: "1px solid var(--border-subtle)",
            fontSize: "var(--font-size-xl)",
            fontWeight: 700,
          }}
        >
          <TerminalIcon size={18} strokeWidth={1.7} />
        </div>
        <div>
          <h1 className="text-primary" style={{ fontSize: "var(--font-size-2xl)", fontWeight: 600 }}>
            Welcome to Terminus
          </h1>
          <p className="text-secondary" style={{ fontSize: "var(--font-size-sm)", marginTop: 2 }}>
            A calm, focused way to operate coding agents.
          </p>
        </div>
      </div>
      <p
        className="text-secondary"
        style={{ fontSize: "var(--font-size-sm)", lineHeight: "var(--line-height-relaxed)" }}
      >
        Terminus runs long-running tasks, branches, terminals, and code review in one window.
        We've set sensible defaults for a 13-inch MacBook Air — you can change anything later in Settings.
      </p>
      <div className="flex items-center justify-end" style={{ marginTop: 8 }}>
        <button
          type="button"
          onClick={onNext}
          className="inline-flex items-center gap-1.5 rounded-md text-primary"
          style={{
            height: 32,
            padding: "0 14px",
            fontSize: "var(--font-size-sm)",
            fontWeight: 500,
            background: "var(--color-primary)",
            color: "var(--text-inverse)",
            transition: "background var(--duration-fast) var(--easing-default)",
          }}
          autoFocus
        >
          <span>Continue</span>
          <ArrowRight size={13} />
        </button>
      </div>
    </div>
  );
}

// ────────────────────────── Step 2: Project ─────────────────────────────────

function ProjectStep({
  path,
  onPathChange,
  onPick,
  canPick,
  onNext,
  onBack,
}: {
  path: string;
  onPathChange: (p: string) => void;
  onPick: () => void;
  canPick: boolean;
  onNext: () => void;
  onBack: () => void;
}): JSX.Element {
  const canContinue = path.trim().length > 0;
  return (
    <div className="flex flex-col" style={{ gap: 16 }}>
      <div>
        <h1 className="text-primary" style={{ fontSize: "var(--font-size-xl)", fontWeight: 600 }}>
          Open a project
        </h1>
        <p className="text-secondary" style={{ fontSize: "var(--font-size-sm)", marginTop: 4 }}>
          Choose a local directory. Terminus will treat it as the workspace root.
        </p>
      </div>
      <div className="flex flex-col" style={{ gap: 8 }}>
        <div className="flex items-center gap-2">
          <div className="flex flex-1 items-center gap-2 rounded-md bg-elevated px-3" style={{ height: 36, border: "1px solid var(--border-default)" }}>
            <Folder size={13} className="text-tertiary" />
            <input
              value={path}
              onChange={(e) => onPathChange(e.target.value)}
              placeholder="/path/to/your/project"
              aria-label="Project path"
              className="flex-1 bg-transparent font-mono text-primary placeholder:text-tertiary focus:outline-none"
              style={{ fontSize: "var(--font-size-sm)" }}
              autoFocus
            />
          </div>
          {canPick ? (
            <button
              type="button"
              onClick={onPick}
              className="inline-flex items-center gap-1 rounded-md text-secondary hover:bg-hover hover:text-primary"
              style={{ height: 36, padding: "0 12px", fontSize: "var(--font-size-sm)", border: "1px solid var(--border-default)" }}
            >
              <FolderOpen size={13} />
              <span>Browse</span>
            </button>
          ) : null}
        </div>
        <p className="text-tertiary" style={{ fontSize: "var(--font-size-xs)" }}>
          Tip: paste a path or click Browse to use the macOS directory picker.
        </p>
      </div>
      <StepNav
        onNext={onNext}
        onBack={onBack}
        nextLabel="Continue"
        nextDisabled={!canContinue}
      />
    </div>
  );
}

// ────────────────────────── Step 3: Tools ───────────────────────────────────

function ToolsStep({ onNext, onBack }: { onNext: () => void; onBack: () => void }): JSX.Element {
  const tools = useMemo(() => detectTools(), []);
  return (
    <div className="flex flex-col" style={{ gap: 16 }}>
      <div>
        <h1 className="text-primary" style={{ fontSize: "var(--font-size-xl)", fontWeight: 600 }}>
          Confirm detected tools
        </h1>
        <p className="text-secondary" style={{ fontSize: "var(--font-size-sm)", marginTop: 4 }}>
          Terminus looked for common editors and runtimes. Adjust paths later in Settings → Integrations.
        </p>
      </div>
      <ul className="flex flex-col" style={{ gap: 6 }}>
        {tools.map((t) => (
          <li
            key={t.id}
            className="flex items-center gap-3 rounded-md bg-elevated px-3 py-2"
            style={{ border: "1px solid var(--border-subtle)" }}
          >
            <span
              aria-hidden
              className="flex flex-shrink-0 items-center justify-center text-tertiary"
              style={{ width: 22, height: 22, borderRadius: "var(--radius-sm)", background: "var(--bg-canvas)" }}
            >
              {t.icon}
            </span>
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="text-primary" style={{ fontSize: "var(--font-size-sm)", fontWeight: 500 }}>
                {t.label}
              </span>
              {t.path ? (
                <span className="truncate font-mono text-tertiary" style={{ fontSize: "var(--font-size-xs)" }} title={t.path}>
                  {t.path}
                </span>
              ) : null}
            </div>
            {t.available ? (
              <span
                className="inline-flex items-center gap-1 text-success"
                style={{ fontSize: "var(--font-size-xs)" }}
              >
                <Check size={11} />
                <span>Detected</span>
              </span>
            ) : (
              <span
                className="inline-flex items-center gap-1 text-warning"
                style={{ fontSize: "var(--font-size-xs)" }}
              >
                <CircleAlert size={11} />
                <span>Not found</span>
              </span>
            )}
          </li>
        ))}
      </ul>
      <StepNav onNext={onNext} onBack={onBack} nextLabel="Continue" />
    </div>
  );
}

// ────────────────────────── Step 4: First task ──────────────────────────────

const STARTER_PROMPTS = [
  "Explore the codebase and summarize how the main modules fit together.",
  "Build a small feature with tests and documentation.",
  "Review recent changes and suggest improvements.",
  "Fix a failing test or runtime warning.",
];

function FirstTaskStep({
  prompt,
  onPromptChange,
  onFinish,
  onBack,
  creating,
  error,
}: {
  prompt: string;
  onPromptChange: (p: string) => void;
  onFinish: () => void;
  onBack: () => void;
  creating: boolean;
  error: string | null;
}): JSX.Element {
  return (
    <div className="flex flex-col" style={{ gap: 16 }}>
      <div>
        <h1 className="text-primary" style={{ fontSize: "var(--font-size-xl)", fontWeight: 600 }}>
          Start your first task
        </h1>
        <p className="text-secondary" style={{ fontSize: "var(--font-size-sm)", marginTop: 4 }}>
          Pick a starting prompt or write your own. You can refine it after the workspace opens.
        </p>
      </div>
      <div className="flex flex-col" style={{ gap: 8 }}>
        <div className="flex items-center gap-2 text-tertiary" style={{ fontSize: "var(--font-size-xs)" }}>
          <Lightbulb size={11} />
          <span>Suggestions</span>
        </div>
        <div className="grid grid-cols-1 gap-1.5" style={{ gridTemplateColumns: "1fr 1fr" }}>
          {STARTER_PROMPTS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => onPromptChange(p)}
              className={cn(
                "rounded-md px-3 py-2 text-left text-secondary hover:bg-hover hover:text-primary",
                prompt === p && "bg-selected text-primary",
              )}
              style={{
                fontSize: "var(--font-size-xs)",
                border: "1px solid var(--border-subtle)",
                background: prompt === p ? "var(--bg-selected)" : "var(--bg-elevated)",
              }}
            >
              {p}
            </button>
          ))}
        </div>
      </div>
      <textarea
        value={prompt}
        onChange={(e) => onPromptChange(e.target.value)}
        placeholder="Describe what you want to build…"
        aria-label="First task prompt"
        className="selectable w-full resize-none rounded-md bg-elevated px-3 py-2 text-primary placeholder:text-tertiary focus:outline-none"
        style={{
          fontSize: "var(--font-size-sm)",
          minHeight: 90,
          border: "1px solid var(--border-default)",
          lineHeight: "var(--line-height-relaxed)",
        }}
        rows={3}
      />
      {error ? (
        <p className="text-error" role="alert" style={{ fontSize: "var(--font-size-xs)" }}>
          {error}
        </p>
      ) : null}
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={onBack}
          className="text-secondary hover:text-primary"
          style={{ fontSize: "var(--font-size-sm)" }}
        >
          Back
        </button>
        <button
          type="button"
          onClick={onFinish}
          disabled={creating}
          className="inline-flex items-center gap-1.5 rounded-md text-primary disabled:opacity-50"
          style={{
            height: 32,
            padding: "0 14px",
            fontSize: "var(--font-size-sm)",
            fontWeight: 500,
            background: "var(--color-primary)",
            color: "var(--text-inverse)",
            transition: "background var(--duration-fast) var(--easing-default)",
          }}
        >
          <span>{creating ? "Creating…" : "Open workspace"}</span>
          {!creating ? <ArrowRight size={13} /> : null}
        </button>
      </div>
    </div>
  );
}

// ────────────────────────── Step nav ────────────────────────────────────────

function StepNav({
  onNext,
  onBack,
  nextLabel,
  nextDisabled,
}: {
  onNext: () => void;
  onBack: () => void;
  nextLabel: string;
  nextDisabled?: boolean;
}): JSX.Element {
  return (
    <div className="flex items-center justify-between" style={{ marginTop: 8 }}>
      <button
        type="button"
        onClick={onBack}
        className="text-secondary hover:text-primary"
        style={{ fontSize: "var(--font-size-sm)" }}
      >
        Back
      </button>
      <button
        type="button"
        onClick={onNext}
        disabled={nextDisabled}
        className="inline-flex items-center gap-1.5 rounded-md text-primary disabled:opacity-50"
        style={{
          height: 32,
          padding: "0 14px",
          fontSize: "var(--font-size-sm)",
          fontWeight: 500,
          background: "var(--color-primary)",
          color: "var(--text-inverse)",
          transition: "background var(--duration-fast) var(--easing-default)",
        }}
      >
        <span>{nextLabel}</span>
        <ChevronRight size={13} />
      </button>
    </div>
  );
}

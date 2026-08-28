/**
 * Terminus Desktop — Onboarding.
 *
 * A focused project picker with an optional first task on first run.
 *
 * Per SPEC §19: "Do not force users through every setting. Default all
 * settings for a base-model 13-inch M4 MacBook Air. Advanced settings
 * remain available after onboarding."
 *
 * Per SPEC §19: setup remains skippable.
 *
 * The component is self-contained and emits the chosen project path plus
 * optional initial prompt via callbacks. The
 * host owns the directory picker (via window.terminusDesktop or a
 * future Electron IPC bridge) — we accept a `pickDirectory` callback.
 *
 * Per design constraints: calm visuals, lucide-react icons, CSS
 * variables, accessible keyboard nav, restrained motion. No emojis,
 * no purple gradients, no glowing effects.
 */
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useDialogFocus } from "../hooks/use-dialog-focus";
import { isDefinitiveMutationFailure, useLogicalMutation } from "../hooks/use-logical-mutation";
import {
  Folder,
  FolderOpen,
  X,
} from "lucide-react";
import { cn } from "../lib/cn";
import { api, TerminusApiError } from "../lib/api";
import { WORKSPACE_TASK_SCOPE } from "../lib/task-scope";
import {
  deriveProjectTitle,
  isAbsoluteLocalPath,
  noteRecentProject,
  projectPathToUri,
  sameProjectRoot,
} from "../lib/projects";
import { useModelInventory } from "../hooks/use-model-inventory";
import { useModelSelection } from "../lib/models";
import { useTerminusStore } from "../hooks/use-terminus";
import { useThemeStore } from "../hooks/use-theme";
import type { Session, WorkspaceKind, WorkspaceSnapshot } from "../types";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";
import { Input, Textarea } from "../ui/Input";
import { DialogSurface } from "../ui/Dialog";

// ────────────────────────── Types ───────────────────────────────────────────

export interface OnboardingProps {
  /** Called when onboarding completes (or is skipped). */
  onComplete: (result: OnboardingResult) => void;
  /** Optional directory picker — host wires to Electron IPC. */
  pickDirectory?: () => Promise<string | null>;
  /** Optional className. */
  className?: string;
  /** Retained for caller compatibility with the former stepped flow. */
  initialStep?: number;
  /** Preselected path, for example from a directory dropped on the window. */
  initialProjectPath?: string;
  /** First-run wizard or the focused existing-user project opener. */
  mode?: "first-run" | "open-project";
}

export interface OnboardingResult {
  /** Project path chosen in the picker (may be null if skipped). */
  projectPath: string | null;
  /** Optional initial prompt (may be empty). */
  initialPrompt: string;
  /** Created Terminus session (if any). */
  session: Session | null;
  /** Whether the user skipped the flow. */
  skipped: boolean;
}

// ────────────────────────── Component ───────────────────────────────────────

const ONBOARDING_DRAFT_PREFIX = "terminus-desktop.onboarding-draft.v1.";
const MAX_ONBOARDING_PATH_BYTES = 4 * 1024;
const MAX_ONBOARDING_PROMPT_BYTES = 16 * 1024;
const MAX_ONBOARDING_DRAFT_BYTES = 24 * 1024;
const ONBOARDING_DRAFT_WRITE_DELAY_MS = 150;
const onboardingDraftEncoder = new TextEncoder();

interface OnboardingDraft {
  step: number;
  projectPath: string;
  initialPrompt: string;
}

function onboardingDraftKey(mode: NonNullable<OnboardingProps["mode"]>): string {
  return `${ONBOARDING_DRAFT_PREFIX}${mode}`;
}

function onboardingDraftValidationError(draft: OnboardingDraft): string | null {
  if (onboardingDraftEncoder.encode(draft.projectPath).byteLength > MAX_ONBOARDING_PATH_BYTES) {
    return "The project path exceeds the 4 KiB setup-draft limit.";
  }
  if (onboardingDraftEncoder.encode(draft.initialPrompt).byteLength > MAX_ONBOARDING_PROMPT_BYTES) {
    return "The first-task prompt exceeds the 16 KiB draft limit.";
  }
  if (onboardingDraftEncoder.encode(JSON.stringify(draft)).byteLength > MAX_ONBOARDING_DRAFT_BYTES) {
    return "The setup draft exceeds the 24 KiB storage limit.";
  }
  return null;
}

function readOnboardingDraft(mode: NonNullable<OnboardingProps["mode"]>): {
  draft: OnboardingDraft | null;
  error: string | null;
} {
  try {
    const storage = window.localStorage;
    if (!storage) throw new Error("Local storage is unavailable.");
    const raw = storage.getItem(onboardingDraftKey(mode));
    if (raw === null) return { draft: null, error: null };
    if (onboardingDraftEncoder.encode(raw).byteLength > MAX_ONBOARDING_DRAFT_BYTES) {
      return { draft: null, error: "Stored setup data exceeds the supported limit and was preserved for recovery." };
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { draft: null, error: "Stored setup data is invalid and was preserved for recovery." };
    }
    const record = parsed as Record<string, unknown>;
    if (
      typeof record.step !== "number" ||
      !Number.isInteger(record.step) ||
      typeof record.projectPath !== "string" ||
      typeof record.initialPrompt !== "string"
    ) return { draft: null, error: "Stored setup data is invalid and was preserved for recovery." };
    const draft = {
      step: Math.max(1, Math.min(4, record.step)),
      projectPath: record.projectPath,
      initialPrompt: record.initialPrompt,
    };
    const validationError = onboardingDraftValidationError(draft);
    return validationError
      ? { draft: null, error: `${validationError} The original entry was preserved for recovery.` }
      : { draft, error: null };
  } catch (error) {
    return {
      draft: null,
      error: error instanceof Error
        ? `Stored setup data could not be read: ${error.message}`
        : "Stored setup data could not be read.",
    };
  }
}

function writeOnboardingDraft(
  mode: NonNullable<OnboardingProps["mode"]>,
  draft: OnboardingDraft | null,
): string | null {
  if (draft) {
    const validationError = onboardingDraftValidationError(draft);
    if (validationError) return `${validationError} The current setup remains available only in this window.`;
  }
  try {
    const storage = window.localStorage;
    if (!storage) throw new Error("Local storage is unavailable.");
    if (draft) storage.setItem(onboardingDraftKey(mode), JSON.stringify(draft));
    else storage.removeItem(onboardingDraftKey(mode));
    return null;
  } catch (error) {
    return error instanceof Error
      ? `Setup remains available only in this window: ${error.message}`
      : "Setup remains available only in this window because local storage failed.";
  }
}

function OnboardingImpl({
  onComplete,
  pickDirectory,
  className,
  initialProjectPath,
  mode = "first-run",
}: OnboardingProps): JSX.Element {
  const projectOnly = mode === "open-project";
  const [savedDraftLoad] = useState(() => readOnboardingDraft(mode));
  const savedDraft = savedDraftLoad.draft;
  const step = 2;
  const [projectPath, setProjectPath] = useState<string>(initialProjectPath ?? savedDraft?.projectPath ?? "");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [initialPrompt, setInitialPrompt] = useState(savedDraft?.initialPrompt ?? "");
  const [draftStorageError, setDraftStorageError] = useState<string | null>(savedDraftLoad.error);
  const draftStorageBlockedRef = useRef(savedDraftLoad.error !== null);
  const draftCompletedRef = useRef(false);
  const draftWriteTimerRef = useRef<number | null>(null);
  const latestDraftRef = useRef<OnboardingDraft>({ step, projectPath, initialPrompt });
  latestDraftRef.current = { step, projectPath, initialPrompt };
  const selectSession = useTerminusStore((s) => s.selectSession);
  const selectTask = useTerminusStore((s) => s.selectTask);
  const setDraft = useTerminusStore((s) => s.setDraft);
  const onboardingMutation = useLogicalMutation("onboarding");
  // The first turn of a brand-new project is a turn like any other: it has to
  // name the model it runs on. There is no session yet to carry a default, so
  // the inventory's first available model is what it gets.
  const modelSelection = useModelSelection(useModelInventory());
  const inFlightRecoveryRef = useRef<{ operationKey: string; session: Session | null } | null>(null);
  const [partialRecovery, setPartialRecovery] = useState<{ operationKey: string; session: Session } | null>(null);

  useEffect(() => {
    if (draftStorageBlockedRef.current) return;
    if (draftWriteTimerRef.current !== null) window.clearTimeout(draftWriteTimerRef.current);
    const nextDraft = { step, projectPath, initialPrompt };
    draftWriteTimerRef.current = window.setTimeout(() => {
      draftWriteTimerRef.current = null;
      setDraftStorageError(writeOnboardingDraft(mode, nextDraft));
    }, ONBOARDING_DRAFT_WRITE_DELAY_MS);
    return () => {
      if (draftWriteTimerRef.current !== null) {
        window.clearTimeout(draftWriteTimerRef.current);
        draftWriteTimerRef.current = null;
      }
    };
  }, [initialPrompt, mode, projectPath, step]);

  useEffect(() => () => {
    if (draftWriteTimerRef.current !== null) window.clearTimeout(draftWriteTimerRef.current);
    if (!draftCompletedRef.current && !draftStorageBlockedRef.current) {
      writeOnboardingDraft(mode, latestDraftRef.current);
    }
  }, [mode]);

  const clearCompletedDraft = useCallback((): void => {
    draftCompletedRef.current = true;
    if (draftWriteTimerRef.current !== null) {
      window.clearTimeout(draftWriteTimerRef.current);
      draftWriteTimerRef.current = null;
    }
    writeOnboardingDraft(mode, null);
  }, [mode]);

  // Sync the system theme on mount so first paint matches.
  useEffect(() => {
    useThemeStore.getState().refresh();
  }, []);

  const skip = useCallback((): void => {
    if (creating) return;
    onComplete({ projectPath: null, initialPrompt: "", session: null, skipped: true });
  }, [creating, onComplete]);
  const dialogRef = useDialogFocus<HTMLDivElement>(true, skip);

  const changeProjectPath = useCallback((path: string): void => {
    if (onboardingDraftEncoder.encode(path).byteLength > MAX_ONBOARDING_PATH_BYTES) {
      setDraftStorageError("The project path is limited to 4 KiB and was not changed.");
      return;
    }
    setProjectPath(path);
    setError(null);
  }, []);

  const changeInitialPrompt = useCallback((prompt: string): void => {
    if (onboardingDraftEncoder.encode(prompt).byteLength > MAX_ONBOARDING_PROMPT_BYTES) {
      setDraftStorageError("The first-task prompt is limited to 16 KiB and was not changed.");
      return;
    }
    setInitialPrompt(prompt);
  }, []);

  const createWorkspaceSession = useCallback(async (objective: string): Promise<{
    session: Session;
    operationKey: string;
  }> => {
    if (!isAbsoluteLocalPath(projectPath)) {
      throw new Error("Choose an absolute local directory before opening the workspace.");
    }
    const admission = onboardingMutation.acquire(JSON.stringify({ projectPath, objective }));
    const operationKey = admission.key;
    inFlightRecoveryRef.current = { operationKey, session: null };
    if (admission.completedSteps.session_created && !admission.completedSteps.workspace_opened) {
      throw new Error("Setup stopped partway through. Recover the saved project before trying again.");
    }
    const rootUri = projectPathToUri(projectPath);
    // Opening a directory that is already a project selects it instead of
    // creating a second session against the same workspace.
    const alreadyOpenSession = useTerminusStore.getState().sessions
      .find((candidate) => sameProjectRoot(candidate.workspace_root_uri, rootUri));
    if (alreadyOpenSession) {
      onboardingMutation.settle(operationKey);
      inFlightRecoveryRef.current = null;
      selectSession(alreadyOpenSession.id);
      void noteRecentProject(projectPath);
      return { session: alreadyOpenSession, operationKey };
    }
    let workspaceId = admission.completedSteps.workspace_opened ?? null;
    if (!workspaceId) {
      const workspace = await openWorkspaceForPath(projectPath, rootUri, operationKey);
      workspaceId = workspace.id;
      onboardingMutation.checkpoint(operationKey, "workspace_opened", workspace.id);
    }
    const sessionId = admission.completedSteps.session_created;
    const openWorkspaceId = workspaceId;
    const existingForWorkspace = useTerminusStore.getState().sessions
      .find((candidate) => candidate.workspace_id === openWorkspaceId);
    const session = sessionId
      ? await api.getSession(sessionId)
      : existingForWorkspace ?? await api.createSession({
        workspace_id: workspaceId,
        title: deriveProjectTitle(projectPath) || "Untitled project",
      }, { idempotencyKey: `${operationKey}:session` });
    if (!sessionId) onboardingMutation.checkpoint(operationKey, "session_created", session.id);
    inFlightRecoveryRef.current = { operationKey, session };
    await useTerminusStore.getState().refreshSessions();
    selectSession(session.id);
    void noteRecentProject(projectPath);
    return { session, operationKey };
  }, [onboardingMutation, projectPath, selectSession]);

  const finish = useCallback(async (): Promise<void> => {
    setCreating(true);
    setError(null);
    const objective = initialPrompt.trim();
    try {
      const { session, operationKey } = await createWorkspaceSession(objective);
      if (objective && session.active_thread_id) {
        const resumed = onboardingMutation.acquire(JSON.stringify({ projectPath, objective }));
        if (
          (resumed.completedSteps.task_started || resumed.completedSteps.turn_started)
          && !resumed.completedSteps.task_created
        ) {
          throw new Error("The first task was only partly created. Recover it before trying again.");
        }
        if (resumed.completedSteps.turn_started && !resumed.completedSteps.task_started) {
          throw new Error("The first task stopped before it could start. Recover it before trying again.");
        }
        const taskId = resumed.completedSteps.task_created;
        const task = taskId
          ? await api.getTask(taskId)
          : await api.createTask({
            session_id: session.id,
            thread_id: session.active_thread_id,
            objective,
            risk_class: "normal",
            allowed_scope: WORKSPACE_TASK_SCOPE,
          }, { idempotencyKey: `${operationKey}:task` });
        if (!taskId) onboardingMutation.checkpoint(operationKey, "task_created", task.id);
        const startReceipt = resumed.completedSteps.task_started;
        let eventCursor: string;
        if (startReceipt) {
          const parsed = JSON.parse(startReceipt) as unknown;
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
            || typeof (parsed as Record<string, unknown>).eventCursor !== "string"
            || (parsed as { eventCursor: string }).eventCursor.length === 0) {
            throw new Error("The saved task state is invalid. Recover the task before trying again.");
          }
          eventCursor = (parsed as { eventCursor: string }).eventCursor;
        } else {
          const started = await api.startTask(task.id, { idempotencyKey: `${operationKey}:start-task` });
          eventCursor = started.event_cursor;
          onboardingMutation.checkpoint(
            operationKey,
            "task_started",
            JSON.stringify({ eventCursor: started.event_cursor }),
          );
        }
        await useTerminusStore.getState().refreshTasks(session.id);
        if (!resumed.completedSteps.turn_started) {
          await api.startTurn({
            thread_id: task.thread_id,
            task_id: task.id,
            user_input: objective,
            ...(modelSelection.selected ? { model: modelSelection.selected.slug } : {}),
            ...(modelSelection.effort ? { reasoning_effort: modelSelection.effort } : {}),
          }, { idempotencyKey: `${operationKey}:turn` });
          onboardingMutation.checkpoint(operationKey, "turn_started", "done");
        }
        selectTask(task.id, eventCursor);
      }
      onboardingMutation.settle(operationKey);
      inFlightRecoveryRef.current = null;
      clearCompletedDraft();
      onComplete({ projectPath: projectPath || null, initialPrompt, session, skipped: false });
    } catch (err) {
      const recovery = inFlightRecoveryRef.current;
      if (recovery && isDefinitiveMutationFailure(err)) {
        try {
          if (recovery.session) {
            setPartialRecovery({ operationKey: recovery.operationKey, session: recovery.session });
          } else {
            onboardingMutation.completePartial(recovery.operationKey);
            inFlightRecoveryRef.current = null;
          }
        } catch (recoveryError) {
          setError(recoveryError instanceof Error ? recoveryError.message : "Couldn't recover the saved setup.");
          return;
        }
      }
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
  }, [
    clearCompletedDraft,
    createWorkspaceSession,
    initialPrompt,
    modelSelection.effort,
    modelSelection.selected,
    onComplete,
    onboardingMutation,
    projectPath,
    selectTask,
  ]);

  const continueWithPartialProject = useCallback((): void => {
    if (!partialRecovery) return;
    try {
      onboardingMutation.completePartial(partialRecovery.operationKey);
      if (initialPrompt.trim()) setDraft("__new__", initialPrompt);
      selectSession(partialRecovery.session.id);
      clearCompletedDraft();
      inFlightRecoveryRef.current = null;
      onComplete({ projectPath: projectPath || null, initialPrompt, session: partialRecovery.session, skipped: false });
    } catch (recoveryError) {
      setError(recoveryError instanceof Error ? recoveryError.message : "Couldn't recover the saved setup.");
    }
  }, [clearCompletedDraft, initialPrompt, onComplete, onboardingMutation, partialRecovery, projectPath, selectSession, setDraft]);

  const openSelectedProject = useCallback(async (): Promise<void> => {
    setCreating(true);
    setError(null);
    try {
      const { session, operationKey } = await createWorkspaceSession("");
      onboardingMutation.settle(operationKey);
      inFlightRecoveryRef.current = null;
      clearCompletedDraft();
      onComplete({ projectPath, initialPrompt: "", session, skipped: false });
    } catch (openError: unknown) {
      const recovery = inFlightRecoveryRef.current;
      if (recovery && isDefinitiveMutationFailure(openError)) {
        try {
          if (recovery.session) {
            setPartialRecovery({ operationKey: recovery.operationKey, session: recovery.session });
          } else {
            onboardingMutation.completePartial(recovery.operationKey);
            inFlightRecoveryRef.current = null;
          }
        } catch (recoveryError) {
          setError(recoveryError instanceof Error ? recoveryError.message : "Couldn't recover the saved setup.");
          return;
        }
      }
      setError(openError instanceof Error ? openError.message : "Could not open the project.");
    } finally {
      setCreating(false);
    }
  }, [clearCompletedDraft, createWorkspaceSession, onComplete, onboardingMutation, projectPath]);

  const onPick = useCallback(async (): Promise<void> => {
    if (!pickDirectory) return;
    try {
      const path = await pickDirectory();
      if (path) {
        changeProjectPath(path);
      }
    } catch (pickError: unknown) {
      setError(pickError instanceof Error ? pickError.message : "The directory picker could not be opened.");
    }
  }, [changeProjectPath, pickDirectory]);

  const canOpen = isAbsoluteLocalPath(projectPath) && !creating;

  return (
    <DialogSurface
      ref={dialogRef}
      open
      onOpenChange={(nextOpen) => {
        if (!nextOpen) skip();
      }}
      accessibleTitle={projectOnly ? "Open project" : "Welcome to Terminus"}
      overlayClassName={projectOnly ? "bg-black/40" : "bg-canvas"}
      className={cn(
        projectOnly
          ? "dialog-panel fixed left-1/2 top-1/2 flex w-[min(480px,calc(100%-32px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-lg border border-default bg-elevated shadow-lg"
          : "fixed inset-0 flex flex-col bg-canvas data-[state=open]:animate-fade-in",
        className,
      )}
    >
      {!projectOnly ? (
        <div className="titlebar-drag flex h-11 flex-shrink-0 items-center justify-end px-4" style={{ paddingLeft: 80 }}>
          <IconButton
            onClick={skip}
            disabled={creating}
            className="titlebar-no-drag"
            label={creating ? "Workspace creation in progress" : "Skip onboarding"}
            icon={<X size={12} />}
          />
        </div>
      ) : (
        <IconButton
          onClick={skip}
          disabled={creating}
          className="absolute right-3 top-3"
          label={creating ? "Workspace creation in progress" : "Cancel opening project"}
          icon={<X size={12} />}
        />
      )}
      <div className={cn("scrollable flex min-h-0 flex-1 items-center justify-center px-4", projectOnly ? "py-4" : "py-8")}>
        <div className={cn("w-full p-4", projectOnly ? "max-w-none" : "max-w-[480px]")}>
          <header className="mb-4">
            <h1 className="ui-page-title text-primary">
              {projectOnly ? "Open a project" : "Open your first project"}
            </h1>
            <p className="ui-body mt-1 text-secondary">
              {projectOnly
                ? "Choose a local project to open in its own workspace."
                : "Choose a project and optionally describe the first task."}
            </p>
          </header>

          <section aria-labelledby="setup-project-heading">
            <h2 id="setup-project-heading" className="mb-2 text-xs font-medium text-primary">Project</h2>
            <div className="flex gap-2">
              <div className="relative min-w-0 flex-1">
                <Folder className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-tertiary" size={14} />
                <Input
                  value={projectPath}
                  onChange={(event) => changeProjectPath(event.target.value)}
                  readOnly={Boolean(pickDirectory)}
                  placeholder="/path/to/project"
                  aria-label="Project path"
                  aria-invalid={projectPath.length > 0 && !isAbsoluteLocalPath(projectPath)}
                  className="pl-8 font-mono"
                  autoFocus
                />
              </div>
              {pickDirectory ? (
                <Button variant="secondary" onClick={() => void onPick()}>
                  <FolderOpen size={14} /> Browse
                </Button>
              ) : null}
            </div>
            <p className="mt-1.5 text-xs text-tertiary">Terminus verifies the directory before opening it.</p>
          </section>

          {!projectOnly ? (
              <section className="mt-4" aria-labelledby="setup-task-heading">
                <h2 id="setup-task-heading" className="mb-2 text-xs font-medium text-primary">First task <span className="font-normal text-tertiary">(optional)</span></h2>
                <Textarea
                  value={initialPrompt}
                  onChange={(event) => changeInitialPrompt(event.target.value)}
                  placeholder="Describe the result you want"
                  aria-label="First task prompt"
                  rows={3}
                />
              </section>
          ) : null}

          {error ? <p className="mt-3 border-l-2 border-error px-2 text-xs text-danger" role="alert">{error}</p> : null}
            {partialRecovery ? (
              <div className="mt-3 border-l-2 border-warning/55 px-2.5 py-1" role="status">
                <p className="text-xs text-secondary">
                  The project opened, but the first task did not. Continue and the request will remain in your draft.
                </p>
                <Button className="mt-2" variant="primary" onClick={continueWithPartialProject}>
                  Continue with created project
                </Button>
              </div>
            ) : null}
            {draftStorageError ? (
              <p className="mt-3 text-xs text-tertiary" role="status">
                {draftStorageError}
              </p>
            ) : null}

          <footer className="mt-4 flex items-center justify-between border-t border-subtle pt-3">
            <Button variant="ghost" onClick={skip} disabled={creating}>
              {projectOnly ? "Cancel" : "Not now"}
            </Button>
            <Button
              variant="primary"
              onClick={() => void (projectOnly ? openSelectedProject() : finish())}
              disabled={!canOpen}
              aria-busy={creating || undefined}
            >
              {creating ? "Opening…" : "Open project"}
            </Button>
          </footer>
        </div>
      </div>
    </DialogSurface>
  );
}

export const Onboarding = memo(OnboardingImpl);

/**
 * Open a directory as a workspace, choosing the right kind.
 *
 * Everything was opened as `local_directory`, so a repository lost its git
 * identity and the tools that depend on it. The shell can stat the path; when
 * it cannot, `local_git` is attempted first and a `WORKSPACE_IDENTITY_CONFLICT`
 * is the control plane telling us which one it actually is.
 */
async function openWorkspaceForPath(
  projectPath: string,
  rootUri: string,
  operationKey: string,
): Promise<WorkspaceSnapshot> {
  let kinds: readonly WorkspaceKind[] = ["local_git", "local_directory"];
  const validate = window.terminusDesktop?.validateDirectory;
  if (validate) {
    const verdict = await validate(projectPath);
    if (!verdict.ok) throw new Error(`${projectPath} is not a directory this app can open.`);
    kinds = verdict.isGit ? ["local_git"] : ["local_directory"];
  }
  let lastError: unknown = null;
  for (const kind of kinds) {
    try {
      return await api.openWorkspace(
        { root_uri: rootUri, kind, trust: "untrusted" },
        { idempotencyKey: `${operationKey}:workspace:${kind}` },
      );
    } catch (error: unknown) {
      lastError = error;
      const identityConflict = error instanceof TerminusApiError
        && error.status === 409
        && error.envelope?.code === "WORKSPACE_IDENTITY_CONFLICT";
      if (!identityConflict) throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("The workspace could not be opened.");
}

// ────────────────────────── Helpers ─────────────────────────────────────────
//
// Path ⇄ URI conversion, the recents list and the "already open?" check live in
// lib/projects: onboarding is no longer the only surface that opens a project.

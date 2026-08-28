/**
 * Terminus Desktop — the project switcher.
 *
 * Switching projects previously required finding the right row inside the
 * "Spaces" tree, and the only way to add one was an onboarding overlay reached
 * from an icon that hid itself whenever the list was empty. This is the one
 * control that answers "which project am I in, and how do I get to another
 * one" — mounted in the sidebar header, the title bar, and the composer, so
 * all three agree.
 */
import { memo, useCallback, useEffect, useState } from "react";
import { useTerminusStore } from "../hooks/use-terminus";
import { projectUriToPath, readRecentProjects } from "../lib/projects";
import type { Session } from "../types";
import { Menu, type MenuItem } from "../ui/Menu";
import type { ReactElement } from "react";

export interface ProjectMenuProps {
  trigger: ReactElement;
  /** Where the label goes when the menu has no anchor of its own. */
  label?: string;
  align?: "start" | "center" | "end";
  side?: "top" | "right" | "bottom" | "left";
  /** Called after a project is selected, so the caller can route the view. */
  onProjectSelected?: (sessionId: string) => void;
  /** Fallback for adding a project when the native picker is unavailable. */
  onOpenProject?: () => void;
}

/** The project's directory, for the muted second line. */
export function projectSubtitle(session: Session): string | null {
  return projectUriToPath(session.workspace_root_uri ?? null);
}

function ProjectMenuImpl({
  trigger,
  label = "Switch project",
  align = "start",
  side = "bottom",
  onProjectSelected,
  onOpenProject,
}: ProjectMenuProps): JSX.Element {
  const sessions = useTerminusStore((s) => s.sessions);
  const selectedSessionId = useTerminusStore((s) => s.selectedSessionId);
  const selectSession = useTerminusStore((s) => s.selectSession);
  const openProjectPath = useTerminusStore((s) => s.openProjectPath);
  const [recents, setRecents] = useState<readonly string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setRecents(readRecentProjects()), [sessions]);

  const openPath = useCallback((path: string): void => {
    setError(null);
    void openProjectPath(path)
      .then((sessionId) => {
        setRecents(readRecentProjects());
        onProjectSelected?.(sessionId);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "That project could not be opened.");
      });
  }, [onProjectSelected, openProjectPath]);

  const addRepository = useCallback((): void => {
    const pick = window.terminusDesktop?.pickDirectory;
    // No native picker means a plain browser dev build; the onboarding overlay
    // is the only way to type a path there.
    if (!pick) {
      onOpenProject?.();
      return;
    }
    void pick()
      .then((path) => { if (path) openPath(path); })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "The directory picker failed.");
      });
  }, [onOpenProject, openPath]);

  const items: MenuItem[] = sessions.map((session) => ({
    id: `project-${session.id}`,
    label: session.title ?? session.id,
    ...(projectSubtitle(session) ? { detail: projectSubtitle(session)! } : {}),
    selected: session.id === selectedSessionId,
    onSelect: () => {
      selectSession(session.id);
      onProjectSelected?.(session.id);
    },
  }));

  items.push({
    id: "project-add",
    label: "Add repository…",
    separatorBefore: sessions.length > 0,
    onSelect: addRepository,
  });

  const unopened = recents.filter(
    (path) => !sessions.some((session) => projectSubtitle(session) === path),
  );
  for (const [index, path] of unopened.entries()) {
    items.push({
      id: `project-recent-${path}`,
      label: path.split("/").filter(Boolean).slice(-1)[0] ?? path,
      detail: path,
      ...(index === 0 ? { separatorBefore: true } : {}),
      onSelect: () => openPath(path),
    });
  }

  if (error) {
    items.push({ id: "project-error", label: error, separatorBefore: true, disabled: true });
  }

  return <Menu trigger={trigger} items={items} label={label} align={align} side={side} />;
}

export const ProjectMenu = memo(ProjectMenuImpl);

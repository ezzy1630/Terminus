import type { ReactNode } from "react";
import { FIXED_SHORTCUTS, shortcutDisplay } from "./shortcuts";

export type CommandGroup =
  | "Navigation"
  | "Task"
  | "Changes"
  | "Terminal"
  | "Tools"
  | "Appearance"
  | "Help";

export interface Command {
  readonly id: string;
  readonly label: string;
  readonly group: CommandGroup;
  readonly hint?: string;
  readonly keywords?: readonly string[];
  readonly icon?: ReactNode;
  readonly description?: string;
  readonly action: () => void | Promise<void>;
  readonly available?: boolean;
}

export interface DefaultCommandActions {
  readonly openProject?: () => void;
  readonly newTask?: () => void;
  readonly stopRun?: () => void;
  readonly showChanges?: () => void;
  readonly toggleInspector?: () => void;
  readonly toggleSidebar?: () => void;
  readonly sidebarVisible?: boolean;
  readonly switchTheme?: () => void;
  readonly switchDensity?: () => void;
  readonly openSettings?: () => void;
  readonly viewShortcuts?: () => void;
  readonly openMissionBoard?: () => void;
  readonly openAttentionCenter?: () => void;
  /**
   * Every open project, so switching to one is a search away.
   *
   * The palette could open a project but not change to one already open, which
   * made the sidebar the only route between projects.
   */
  readonly projects?: readonly CommandProject[];
  readonly selectProject?: (sessionId: string) => void;
}

export interface CommandProject {
  readonly id: string;
  readonly title: string;
  /** The workspace root, matched on so a path fragment finds the project. */
  readonly path: string | null;
  readonly current: boolean;
}

/** Convert supported host actions into the provider-neutral command catalog. */
export function buildDefaultCommands(actions: DefaultCommandActions): Command[] {
  const commands: Command[] = [];
  const push = (
    id: string,
    label: string,
    group: CommandGroup,
    hint: string | undefined,
    action: (() => void) | undefined,
    keywords: readonly string[] = [],
  ): void => {
    if (!action) return;
    commands.push({ id, label, group, hint, keywords, action, available: true });
  };

  // "Needs attention" is the queue of work waiting on a human, so it leads.
  push("task.attention", "Needs attention", "Task", undefined, actions.openAttentionCenter, ["material questions", "consequence matrix", "approval", "blocked", "waiting"]);
  push("project.open", "Open project", "Navigation", shortcutDisplay(FIXED_SHORTCUTS.openProject), actions.openProject, ["workspace", "folder", "onboarding"]);
  push("nav.mission-board", "Open mission board", "Navigation", undefined, actions.openMissionBoard, ["kanban", "tasks", "work", "status"]);
  push("task.new", "New task", "Task", shortcutDisplay(FIXED_SHORTCUTS.newTask), actions.newTask, ["create task"]);
  push("task.stop", "Stop this run", "Task", shortcutDisplay(FIXED_SHORTCUTS.stopRun), actions.stopRun, ["cancel", "abort", "interrupt", "halt"]);
  push("changes.show", "Show changes", "Changes", shortcutDisplay(FIXED_SHORTCUTS.showChanges), actions.showChanges, ["diff review"]);
  push("nav.toggle-inspector", "Toggle inspector", "Navigation", shortcutDisplay(FIXED_SHORTCUTS.toggleInspector), actions.toggleInspector, ["hide show panel"]);
  push(
    "nav.toggle-sidebar",
    actions.sidebarVisible === false ? "Show sidebar" : "Hide sidebar",
    "Navigation",
    shortcutDisplay(FIXED_SHORTCUTS.toggleSidebar),
    actions.toggleSidebar,
    ["navigation", "projects", "panel"],
  );
  push("appearance.switch-theme", "Switch theme", "Appearance", undefined, actions.switchTheme, ["light dark system"]);
  push("appearance.switch-density", "Switch density", "Appearance", undefined, actions.switchDensity, ["compact spacious"]);
  push("help.open-settings", "Open settings", "Help", shortcutDisplay(FIXED_SHORTCUTS.settings), actions.openSettings, ["preferences config"]);
  push("help.view-shortcuts", "View shortcuts", "Help", shortcutDisplay(FIXED_SHORTCUTS.shortcutReference), actions.viewShortcuts, ["keyboard cheatsheet"]);
  const selectProject = actions.selectProject;
  if (selectProject) {
    for (const project of actions.projects ?? []) {
      if (project.current) continue;
      commands.push({
        id: `project.switch.${project.id}`,
        label: `Switch to ${project.title}`,
        group: "Navigation",
        ...(project.path ? { description: project.path } : {}),
        keywords: ["project", "workspace", "switch", project.title, ...(project.path ? [project.path] : [])],
        action: () => selectProject(project.id),
        available: true,
      });
    }
  }
  return commands;
}

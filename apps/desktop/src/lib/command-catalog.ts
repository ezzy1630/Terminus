import type { ReactNode } from "react";
import { FIXED_SHORTCUTS, shortcutDisplay } from "./shortcuts";

export type CommandGroup =
  | "Navigation"
  | "Cockpit"
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
  readonly openInterventions?: () => void;
  readonly openAgents?: () => void;
  readonly openMissionLedger?: () => void;
  readonly openEffectQueue?: () => void;
  readonly openArtifactDiff?: () => void;
  readonly openFleetBudget?: () => void;
  readonly openCausalReplay?: () => void;
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

  push("cockpit.attention-center", "Attention Center", "Cockpit", undefined, actions.openAttentionCenter, ["material questions", "consequence matrix", "approval"]);
  push("cockpit.interventions", "Structured Interventions", "Cockpit", undefined, actions.openInterventions, ["pause", "resume", "takeover", "rewind", "fork"]);
  push("nav.agents", "Open agents", "Navigation", undefined, actions.openAgents, ["departments", "operators", "rooms", "capabilities"]);
  push("cockpit.mission-ledger", "Task overview", "Cockpit", undefined, actions.openMissionLedger, ["contract", "acceptance", "claims"]);
  push("cockpit.effect-queue", "Task activity", "Cockpit", undefined, actions.openEffectQueue, ["effects", "authorization", "commit"]);
  push("cockpit.artifact-diff", "Task changes", "Cockpit", undefined, actions.openArtifactDiff, ["artifacts", "diffs", "patches"]);
  push("cockpit.fleet-budget", "Task usage", "Cockpit", undefined, actions.openFleetBudget, ["tokens", "compute", "costs"]);
  push("cockpit.causal-replay", "Task replay", "Cockpit", undefined, actions.openCausalReplay, ["causal", "counterfactual", "diagnostics"]);
  push("project.open", "Open project", "Navigation", shortcutDisplay(FIXED_SHORTCUTS.openProject), actions.openProject, ["workspace", "folder", "onboarding"]);
  push("nav.mission-board", "Open mission board", "Navigation", undefined, actions.openMissionBoard, ["kanban", "tasks", "work", "status"]);
  push("task.new", "New task", "Task", shortcutDisplay(FIXED_SHORTCUTS.newTask), actions.newTask, ["create task"]);
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
  return commands;
}

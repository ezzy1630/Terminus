import type { ApprovalSnapshot } from "@terminus/public-api";
import { commandSuggestions } from "./commands.js";
import {
  pendingApprovals,
  pendingQuestions,
  selectedSession,
  selectedTask,
  type FocusArea,
  type Modal,
  type Tone,
  type TuiState,
} from "./model.js";

const ESC = "\u001b[";
const RESET = `${ESC}0m`;
const COLORS = {
  text: "\u001b[38;2;220;223;228m",
  muted: "\u001b[38;2;116;121;132m",
  faint: "\u001b[38;2;72;76;86m",
  accent: "\u001b[38;2;190;139;255m",
  accentSoft: "\u001b[38;2;148;103;201m",
  good: "\u001b[38;2;101;211;155m",
  warn: "\u001b[38;2;241;184;92m",
  danger: "\u001b[38;2;245;116;122m",
  cyan: "\u001b[38;2;104;197;235m",
  selected: "\u001b[48;2;43;36;53m",
  overlay: "\u001b[48;2;25;26;31m",
  bold: "\u001b[1m",
  inverse: "\u001b[7m",
} as const;

export interface Layout {
  readonly columns: number;
  readonly rows: number;
  readonly compact: boolean;
  readonly showSidebar: boolean;
  readonly showInspector: boolean;
  readonly sidebarWidth: number;
  readonly inspectorWidth: number;
  readonly contentTop: number;
  readonly contentBottom: number;
}

export type HitTarget =
  | { readonly kind: "session"; readonly index: number }
  | { readonly kind: "task"; readonly index: number }
  | { readonly kind: "timeline" }
  | { readonly kind: "composer" }
  | { readonly kind: "none" };

export function computeLayout(
  columns: number,
  rows: number,
  panes: { readonly sidebar: boolean; readonly inspector: boolean } = { sidebar: true, inspector: false },
): Layout {
  const safeColumns = Math.max(40, columns);
  const safeRows = Math.max(12, rows);
  const showSidebar = panes.sidebar && safeColumns >= 84;
  const showInspector = panes.inspector && safeColumns >= 122;
  return {
    columns: safeColumns,
    rows: safeRows,
    compact: safeColumns < 84 || safeRows < 24,
    showSidebar,
    showInspector,
    sidebarWidth: showSidebar ? Math.min(29, Math.max(23, Math.floor(safeColumns * 0.23))) : 0,
    inspectorWidth: showInspector ? Math.min(34, Math.max(28, Math.floor(safeColumns * 0.25))) : 0,
    contentTop: 3,
    contentBottom: safeRows - 4,
  };
}

export function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

function truncate(value: string, width: number): string {
  if (width <= 0) return "";
  const flat = value.replace(/[\r\n\t]+/g, " ");
  const characters = [...flat];
  if (characters.length <= width) return flat;
  if (width === 1) return "…";
  return `${characters.slice(0, width - 1).join("")}…`;
}

function pad(value: string, width: number): string {
  const clipped = truncate(value, width);
  return clipped + " ".repeat(Math.max(0, width - [...clipped].length));
}

function paint(value: string, color: string, background = ""): string {
  return `${background}${color}${value}${RESET}`;
}

function toneColor(tone: Tone): string {
  switch (tone) {
    case "accent": return COLORS.accent;
    case "danger": return COLORS.danger;
    case "good": return COLORS.good;
    case "muted": return COLORS.muted;
    case "warn": return COLORS.warn;
    default: return COLORS.text;
  }
}

function toneForStatus(status: string): Tone {
  const value = status.toLowerCase();
  if (["completed", "active", "ok", "ready", "allowed", "applied"].includes(value)) return "good";
  if (["failed", "denied", "down", "cancelled", "blocked", "rejected"].includes(value)) return "danger";
  if (["pending", "running", "verifying", "waiting_user", "waiting_auth", "paused"].includes(value)) return "warn";
  return "muted";
}

function heading(label: string, width: number, active = false): string {
  const text = pad(label.toUpperCase(), width);
  return paint(text, active ? COLORS.accent : COLORS.muted, COLORS.bold);
}

function listWindowStart(total: number, selected: number, limit: number): number {
  if (total <= limit) return 0;
  return Math.max(0, Math.min(total - limit, selected - Math.floor(limit / 2)));
}

function selectableRow(
  marker: string,
  primary: string,
  secondary: string,
  width: number,
  selected: boolean,
  tone: Tone,
): string {
  const markerWidth = 2;
  const secondaryWidth = Math.min(10, Math.max(5, secondary.length));
  const primaryWidth = Math.max(1, width - markerWidth - secondaryWidth - 1);
  const plain = `${pad(marker, markerWidth)}${pad(primary, primaryWidth)} ${pad(secondary, secondaryWidth)}`;
  const background = selected ? COLORS.selected : "";
  return `${background}${paint(pad(marker, markerWidth), selected ? COLORS.accent : COLORS.faint, background)}${background}${paint(pad(primary, primaryWidth), selected ? COLORS.text : COLORS.muted, background)}${background}${paint(` ${pad(secondary, secondaryWidth)}`, toneColor(tone), background)}${RESET}`;
}

function leftPane(state: TuiState, layout: Layout): readonly string[] {
  const width = layout.sidebarWidth - 2;
  const lines: string[] = [];
  lines.push(heading(`Sessions  ${state.sessions.length}`, width, state.focus === "sessions"));
  const sessionLimit = Math.max(2, Math.min(6, Math.floor((layout.contentBottom - layout.contentTop) * 0.35)));
  const sessionStart = listWindowStart(state.sessions.length, state.selectedSession, sessionLimit);
  if (state.sessions.length === 0) {
    lines.push(paint(pad("  No sessions", width), COLORS.muted));
  } else {
    for (const [offset, session] of state.sessions.slice(sessionStart, sessionStart + sessionLimit).entries()) {
      const index = sessionStart + offset;
      lines.push(selectableRow(
        index === state.selectedSession ? "›" : " ",
        session.title,
        session.status,
        width,
        index === state.selectedSession,
        toneForStatus(session.status),
      ));
    }
  }
  lines.push("");
  lines.push(heading(`Tasks  ${state.tasks.length}`, width, state.focus === "tasks"));
  if (state.tasks.length === 0) {
    lines.push(paint(pad("  No tasks in session", width), COLORS.muted));
  } else {
    const remaining = Math.max(2, layout.contentBottom - layout.contentTop - lines.length - 1);
    const taskStart = listWindowStart(state.tasks.length, state.selectedTask, remaining);
    for (const [offset, task] of state.tasks.slice(taskStart, taskStart + remaining).entries()) {
      const index = taskStart + offset;
      lines.push(selectableRow(
        index === state.selectedTask ? "›" : " ",
        task.phase || task.id,
        task.status,
        width,
        index === state.selectedTask,
        toneForStatus(task.status),
      ));
    }
  }
  return lines;
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "--:--";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

function wrapText(value: string, width: number, maxLines: number): readonly string[] {
  if (width <= 0 || maxLines <= 0) return [];
  const words = value.replace(/[\r\n\t]+/g, " ").split(/\s+/).filter(Boolean);
  if (words.length === 0) return [""];
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (word.length > width) {
      if (current) lines.push(current);
      lines.push(truncate(word, width));
      current = "";
    } else if (!current) {
      current = word;
    } else if (current.length + word.length + 1 <= width) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
    if (lines.length >= maxLines) break;
  }
  if (lines.length < maxLines && current) lines.push(current);
  if (lines.length === maxLines && words.join(" ").length > lines.join(" ").length) {
    lines[maxLines - 1] = truncate(`${lines[maxLines - 1] ?? ""}…`, width);
  }
  return lines.slice(0, maxLines);
}

function transcriptRows(state: TuiState, width: number, height: number): readonly string[] {
  if (state.timeline.length === 0) {
    return ["", paint(pad(selectedTask(state) ? "Waiting for task activity…" : "Choose a task, or press n to create one.", width), COLORS.muted)];
  }
  const end = Math.max(0, state.timeline.length - state.timelineScroll);
  const collected: string[][] = [];
  let used = 0;
  for (let index = end - 1; index >= 0 && used < height; index -= 1) {
    const item = state.timeline[index];
    if (!item) continue;
    const selected = state.focus === "timeline" && index === state.selectedTimeline;
    const label = item.presentation === "user" ? "YOU" : item.presentation === "agent" ? "TERM" : item.presentation === "tool" ? "TOOL" : "SYS";
    const glyph = item.presentation === "user" ? "›" : item.presentation === "agent" ? "◆" : item.presentation === "tool" ? "●" : "·";
    const prefix = `${glyph} ${pad(label, 4)} `;
    const textWidth = Math.max(1, width - 7);
    const wrapped = wrapText(item.summary, textWidth, item.presentation === "tool" ? 1 : 2);
    const background = selected ? COLORS.selected : "";
    const rows = wrapped.map((line, lineIndex) => {
      const left = lineIndex === 0 ? prefix : "       ";
      const labelTone = selected ? COLORS.accent : toneColor(item.tone);
      return `${background}${paint(left, labelTone, background)}${background}${paint(pad(line, textWidth), selected ? COLORS.text : item.presentation === "system" ? COLORS.muted : COLORS.text, background)}${RESET}`;
    });
    if (used + rows.length > height) rows.splice(0, used + rows.length - height);
    collected.unshift(rows);
    used += rows.length;
  }
  return collected.flat();
}

function composerContent(state: TuiState, width: number): string {
  const innerWidth = Math.max(0, width);
  if (state.busy) return paint(pad(` ${state.busy}`, innerWidth), COLORS.warn);
  const characters = [...state.composer];
  const cursor = Math.max(0, Math.min(state.composerCursor, characters.length));
  const prefix = " › ";
  const textWidth = Math.max(1, innerWidth - prefix.length);
  if (characters.length === 0) {
    const cursorCell = state.focus === "composer" ? `${COLORS.inverse} ${RESET}` : " ";
    return `${paint(prefix, state.focus === "composer" ? COLORS.accent : COLORS.faint)}${cursorCell}${paint(pad("Ask Terminus or type / for commands", Math.max(0, textWidth - 1)), COLORS.muted)}`;
  }
  const windowStart = Math.max(0, Math.min(cursor, characters.length - textWidth + 1));
  const visible = characters.slice(windowStart, windowStart + textWidth);
  const localCursor = cursor - windowStart;
  const before = visible.slice(0, localCursor).join("");
  const cursorCharacter = visible[localCursor] ?? " ";
  const after = visible.slice(localCursor + 1).join("");
  const cursorCell = state.focus === "composer" ? `${COLORS.inverse}${cursorCharacter}${RESET}` : cursorCharacter;
  const textTone = state.focus === "composer" ? COLORS.text : COLORS.muted;
  const visibleWidth = before.length + 1 + after.length;
  return `${paint(prefix, state.focus === "composer" ? COLORS.accent : COLORS.faint)}${paint(before, textTone)}${cursorCell}${paint(after, textTone)}${" ".repeat(Math.max(0, textWidth - visibleWidth))}`;
}

function centerPane(state: TuiState, width: number, height: number): readonly string[] {
  const lines: string[] = [];
  const task = selectedTask(state);
  const session = selectedSession(state);
  const title = state.taskV2?.contract.mission ?? task?.phase ?? session?.title ?? "Start a task";
  lines.push(`${paint(pad(truncate(title, Math.max(1, width - 14)), Math.max(1, width - 14)), COLORS.text, COLORS.bold)}${paint(pad(task?.status ?? "idle", 14), toneColor(toneForStatus(task?.status ?? "idle")))}`);
  lines.push(paint("─".repeat(width), COLORS.faint));

  const suggestions = commandSuggestions(state.composer);
  const visibleSuggestions = suggestions.slice(0, 3);
  const composerHeight = visibleSuggestions.length > 0 ? 4 + visibleSuggestions.length : 4;
  const eventHeight = Math.max(2, height - composerHeight - 2);
  lines.push(...transcriptRows(state, width, eventHeight));
  while (lines.length < height - composerHeight) lines.push("");

  for (const [index, suggestion] of visibleSuggestions.entries()) {
    const selected = index === Math.min(state.commandSelection, visibleSuggestions.length - 1);
    const background = selected ? COLORS.selected : "";
    const row = `   ${pad(suggestion.usage, Math.min(24, Math.max(10, Math.floor(width * 0.38))))}${suggestion.description}`;
    lines.push(`${background}${paint(pad(row, width), selected ? COLORS.text : COLORS.muted, background)}${RESET}`);
  }
  const borderTone = state.focus === "composer" ? COLORS.accentSoft : COLORS.faint;
  lines.push(paint(`╭${"─".repeat(Math.max(0, width - 2))}╮`, borderTone));
  lines.push(`${paint("│", borderTone)}${composerContent(state, Math.max(0, width - 2))}${paint("│", borderTone)}`);
  const promptHint = visibleSuggestions.length > 0 ? "  ↑↓ choose   Tab complete   Enter run" : "  Enter send   ↑ history   Ctrl+P commands";
  lines.push(`${paint("│", borderTone)}${paint(pad(promptHint, Math.max(0, width - 2)), COLORS.faint)}${paint("│", borderTone)}`);
  lines.push(paint(`╰${"─".repeat(Math.max(0, width - 2))}╯`, borderTone));
  return lines.slice(0, height);
}

function keyValue(label: string, value: string, width: number, tone: Tone = "default"): string {
  const labelWidth = Math.min(11, Math.max(7, Math.floor(width * 0.34)));
  const valueWidth = Math.max(1, width - labelWidth);
  return `${paint(pad(label, labelWidth), COLORS.muted)}${paint(pad(value, valueWidth), toneColor(tone))}`;
}

function approvalSummary(approval: ApprovalSnapshot): string {
  return approval.display?.summary ?? approval.binding?.exact_action ?? (approval.scope.join(", ") || approval.id);
}

function rightPane(state: TuiState, layout: Layout): readonly string[] {
  const width = layout.inspectorWidth - 2;
  const task = selectedTask(state);
  const approvals = pendingApprovals(state);
  const questions = pendingQuestions(state);
  const lines: string[] = [heading("Task", width)];
  if (task === null) {
    lines.push(paint(pad("No task selected", width), COLORS.muted));
    return lines;
  }
  lines.push(keyValue("Status", task.status, width, toneForStatus(task.status)));
  lines.push(keyValue("Risk", task.risk_class, width, task.risk_class === "high" || task.risk_class === "critical" ? "danger" : "muted"));
  lines.push(keyValue("Phase", task.phase, width));
  lines.push(keyValue("Updated", formatTime(task.updated_at), width, "muted"));
  lines.push("");
  lines.push(heading(`Attention  ${approvals.length + questions.length}`, width));
  if (approvals.length === 0 && questions.length === 0) {
    lines.push(paint(pad("No decisions needed", width), COLORS.good));
  } else {
    if (approvals[0]) {
      lines.push(paint(pad(`Approval · ${approvalSummary(approvals[0])}`, width), COLORS.warn));
      lines.push(paint(pad("Press a to review", width), COLORS.muted));
    }
    if (questions[0]) {
      lines.push(paint(pad(`Question · ${questions[0].questionText}`, width), COLORS.warn));
      lines.push(paint(pad("Press x to answer", width), COLORS.muted));
    }
  }
  lines.push("");
  lines.push(heading("Connection", width));
  lines.push(keyValue("Gateway", state.connection, width, state.connection === "online" ? "good" : "warn"));
  lines.push(keyValue("Terminus", state.health?.ready ? "ready" : "starting", width, state.health?.ready ? "good" : "warn"));
  if (state.contextManifest) {
    lines.push("");
    lines.push(heading("Context", width));
    lines.push(keyValue("Model", state.contextManifest.model_key, width));
    lines.push(keyValue("Provider", state.contextManifest.provider_key, width));
    lines.push(keyValue("Request", state.contextManifest.rendered_request_hash.slice(0, 12), width, "muted"));
  }
  if (state.interventions[0]) {
    lines.push("");
    lines.push(heading("Last intervention", width));
    lines.push(keyValue("Action", state.interventions[0].verb.replaceAll("_", " "), width));
    lines.push(keyValue("State", state.interventions[0].status, width, toneForStatus(state.interventions[0].status)));
  }
  return lines;
}

function header(state: TuiState, width: number): string {
  const connection = state.connection === "online"
    ? "● online"
    : state.connection === "offline"
      ? "× offline"
      : state.connection === "connecting"
        ? "○ connecting"
        : "◌ reconnecting";
  const connectionTone = state.connection === "online" ? COLORS.good : state.connection === "offline" ? COLORS.danger : COLORS.warn;
  const session = selectedSession(state);
  const task = selectedTask(state);
  const attentionCount = pendingApprovals(state).length + pendingQuestions(state).length;
  const left = " TERMINUS";
  const taskSegment = task ? `${task.phase} · ${task.status}` : "no task";
  const attentionSegment = attentionCount > 0 ? ` · ${attentionCount} need input` : "";
  const middleBudget = Math.max(0, width - [...left, ...connection].length - 3);
  const middle = truncate(`  ${session?.title ?? "local operator"}  │  ${taskSegment}${attentionSegment}`, middleBudget);
  const gap = Math.max(1, width - [...left, ...middle, ...connection].length - 2);
  return `${paint(left, COLORS.accent, COLORS.bold)}${paint(middle, COLORS.muted)}${" ".repeat(gap)}${paint(connection, connectionTone)} `;
}

function footer(state: TuiState, width: number): string {
  const notice = state.notice?.message;
  const keys = width >= 110
    ? "Tab focus  ↑↓ move  Enter open/send  / commands  b sidebar  d details  ? help  Ctrl+Q quit"
    : width >= 84
      ? "Tab focus  ↑↓ move  / commands  b panes  ? help  ^Q quit"
      : "Tab focus  ↑↓ move  / commands  ? help  ^Q quit";
  const value = notice ?? keys;
  return paint(pad(` ${value}`, width), notice ? toneColor(state.notice?.tone ?? "default") : COLORS.muted);
}

function composeColumns(left: string, center: string, right: string, layout: Layout): string {
  const padAnsi = (value: string, width: number): string => `${value}${" ".repeat(Math.max(0, width - [...stripAnsi(value)].length))}`;
  const leftValue = layout.showSidebar ? `${padAnsi(left, layout.sidebarWidth - 1)}${paint("│", COLORS.faint)}` : "";
  const rightValue = layout.showInspector ? `${paint("│", COLORS.faint)}${padAnsi(right, layout.inspectorWidth - 1)}` : "";
  return `${leftValue}${padAnsi(center, layout.columns - stripAnsi(leftValue).length - stripAnsi(rightValue).length)}${rightValue}`;
}

function modalLines(modal: Modal, state: TuiState, width: number): readonly string[] {
  if (modal.kind === "approval") {
    const approval = pendingApprovals(state)[0];
    if (!approval) return ["No pending approvals."];
    const lines = [
      approval.display?.summary ?? "Review exact effect",
      "",
      `Action   ${approval.display?.exact_action ?? approval.binding?.exact_action ?? "Unavailable"}`,
      `Reason   ${approval.display?.reason ?? "No reason supplied"}`,
      `Risk     ${approval.risk}`,
      `Scope    ${approval.scope.join(", ") || "No additional scope"}`,
      "",
    ];
    for (const [index, decision] of approval.supported_decisions.entries()) {
      lines.push(`${index === modal.selected ? "›" : " "} ${decision.replaceAll("_", " ")}`);
    }
    lines.push("", "Enter decide   Esc cancel");
    return lines.map((line) => truncate(line, width));
  }
  if (modal.kind === "question") {
    const question = pendingQuestions(state)[0];
    if (!question) return ["No pending questions."];
    const lines = [question.questionText, ""];
    for (const [index, option] of question.options.entries()) {
      const consequence = question.consequenceMatrix[option] ?? "No consequence supplied";
      lines.push(`${index === modal.selected ? "›" : " "} ${option}`);
      lines.push(`    ${consequence}`);
    }
    lines.push("", "Enter answer   Esc cancel");
    return lines.map((line) => truncate(line, width));
  }
  if (modal.kind === "new_task") {
    const fields = [
      ["Workspace", modal.draft.workspaceUri || "/path/to/project"],
      ["Session", modal.draft.sessionTitle || "What are you working on?"],
      ["Objective", modal.draft.objective || "What should Terminus finish?"],
      ["First request", modal.draft.firstMessage || "Give Terminus its first instruction"],
    ] as const;
    return [
      "Create task",
      "",
      ...fields.map(([label, value], index) => `${index === modal.draft.field ? "›" : " "} ${pad(label, 14)} ${value}`),
      "",
      modal.draft.field === 3 ? "Enter create   Shift+Tab back   Esc cancel" : "Enter next   Tab next   Esc cancel",
    ].map((line) => truncate(line, width));
  }
  if (modal.kind === "help" || modal.kind === "inspect" || modal.kind === "palette" || modal.kind === "confirm") {
    const paletteBody = modal.kind === "palette"
      ? commandSuggestions(`/${modal.input}`).map((command, index) => `${index === Math.min(state.commandSelection, commandSuggestions(`/${modal.input}`).length - 1) ? "›" : " "} ${pad(command.usage, 25)} ${command.description}`)
      : [];
    const body = modal.kind === "help" || modal.kind === "inspect"
      ? modal.body.slice(modal.scroll)
      : modal.kind === "palette"
        ? paletteBody
        : modal.body;
    const scrollHint = modal.kind === "help" || modal.kind === "inspect" ? "↑↓ scroll   Esc close" : modal.kind === "confirm" ? "Enter confirm   Esc cancel" : "Esc close";
    return [modal.title, "", ...body, ...(modal.kind === "palette" ? ["", `› /${modal.input}`] : []), "", scrollHint]
      .map((line) => truncate(line, width));
  }
  return [];
}

function modalTitle(modal: Modal): string {
  if (modal.kind === "approval") return "Approval";
  if (modal.kind === "question") return "Decision";
  if (modal.kind === "new_task") return "New task";
  return modal.title;
}

function applyModal(screen: string[], state: TuiState, layout: Layout): void {
  if (!state.modal) return;
  const boxWidth = Math.min(layout.columns - 6, Math.max(48, Math.floor(layout.columns * 0.62)));
  const contentWidth = boxWidth - 4;
  const content = modalLines(state.modal, state, contentWidth);
  const boxHeight = Math.min(layout.rows - 4, content.length + 4);
  const startX = Math.max(0, Math.floor((layout.columns - boxWidth) / 2));
  const startY = Math.max(1, Math.floor((layout.rows - boxHeight) / 2));
  const title = modalTitle(state.modal);
  const top = `╭─ ${truncate(title, boxWidth - 6)} ${"─".repeat(Math.max(0, boxWidth - title.length - 5))}╮`;
  const bottom = `╰${"─".repeat(boxWidth - 2)}╯`;
  const rows = [top];
  for (let index = 0; index < boxHeight - 2; index += 1) {
    const raw = content[index] ?? "";
    const selected = raw.startsWith("›");
    rows.push(`│ ${pad(raw, contentWidth)} │${RESET}`.replace(/^/, selected ? COLORS.selected : COLORS.overlay));
  }
  rows.push(bottom);
  for (const [offset, row] of rows.entries()) {
    const target = startY + offset;
    if (target >= screen.length) break;
    screen[target] = `${" ".repeat(startX)}${paint(row, COLORS.text, COLORS.overlay)}${" ".repeat(Math.max(0, layout.columns - startX - boxWidth))}`;
  }
}

export function renderScreen(state: TuiState, columns: number, rows: number): string {
  if (columns < 40 || rows < 12) {
    const width = Math.max(1, columns);
    const height = Math.max(1, rows);
    const message = truncate("Terminus needs a 40 × 12 terminal. Resize to continue.", width);
    const screen = Array.from({ length: height }, (_, index) => {
      const value = index === Math.floor(height / 2) ? message : "";
      return paint(pad(value, width), index === Math.floor(height / 2) ? COLORS.warn : COLORS.text);
    });
    return `${ESC}H${screen.join("\n")}${RESET}`;
  }
  const layout = computeLayout(columns, rows, { sidebar: state.sidebarOpen, inspector: state.inspectorOpen });
  const contentHeight = Math.max(1, layout.contentBottom - layout.contentTop + 1);
  const centerWidth = layout.columns
    - (layout.showSidebar ? layout.sidebarWidth + 1 : 0)
    - (layout.showInspector ? layout.inspectorWidth + 1 : 0);
  const left = layout.showSidebar ? leftPane(state, layout) : [];
  const center = centerPane(state, centerWidth, contentHeight);
  const right = layout.showInspector ? rightPane(state, layout) : [];
  const screen: string[] = [
    header(state, layout.columns),
    paint("─".repeat(layout.columns), COLORS.faint),
    "",
  ];
  for (let index = 0; index < contentHeight; index += 1) {
    screen.push(composeColumns(
      left[index] ?? "",
      center[index] ?? "",
      right[index] ?? "",
      layout,
    ));
  }
  screen.push(paint("─".repeat(layout.columns), COLORS.faint));
  screen.push(footer(state, layout.columns));
  while (screen.length < layout.rows) screen.push("");
  if (screen.length > layout.rows) screen.length = layout.rows;
  for (let index = 0; index < screen.length; index += 1) {
    const line = screen[index] ?? "";
    const missing = layout.columns - [...stripAnsi(line)].length;
    if (missing > 0) screen[index] = `${line}${" ".repeat(missing)}`;
  }
  applyModal(screen, state, layout);
  return `${ESC}H${screen.join("\n")}${RESET}`;
}

export function hitTest(state: TuiState, columns: number, rows: number, x: number, y: number): HitTarget {
  const layout = computeLayout(columns, rows, { sidebar: state.sidebarOpen, inspector: state.inspectorOpen });
  if (y >= rows - 5 && y <= rows - 2) return { kind: "composer" };
  if (!layout.showSidebar || x > layout.sidebarWidth) return { kind: "timeline" };
  const localY = y - layout.contentTop - 1;
  const sessionLimit = Math.max(2, Math.min(6, Math.floor((layout.contentBottom - layout.contentTop) * 0.35)));
  const visibleSessionCount = Math.min(state.sessions.length, sessionLimit);
  const sessionStart = listWindowStart(state.sessions.length, state.selectedSession, sessionLimit);
  if (localY >= 1 && localY <= visibleSessionCount) {
    return { kind: "session", index: sessionStart + localY - 1 };
  }
  const taskFirstRow = visibleSessionCount + 3;
  const taskLimit = Math.max(2, layout.contentBottom - layout.contentTop - (visibleSessionCount + 3) - 1);
  const taskStart = listWindowStart(state.tasks.length, state.selectedTask, taskLimit);
  const visibleTaskCount = Math.min(state.tasks.length, taskLimit);
  if (localY >= taskFirstRow && localY < taskFirstRow + visibleTaskCount) {
    return { kind: "task", index: taskStart + localY - taskFirstRow };
  }
  return { kind: "none" };
}

export function focusLabel(focus: FocusArea): string {
  return focus === "composer" ? "prompt" : focus;
}

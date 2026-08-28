import { stdin, stdout } from "node:process";
import { TerminusClient } from "@terminus/public-client";
import { COMMANDS, commandSuggestions } from "./commands.js";
import { decodeTerminalInput, type KeyInput, type MouseInput, type TerminalInput } from "./input.js";
import {
  appendEvent,
  cycleFocus,
  initialState,
  moveSelection,
  pendingApprovals,
  pendingQuestions,
  selectedSession,
  selectedTask,
  type Tone,
  type TuiState,
} from "./model.js";
import { hitTest, renderScreen } from "./render.js";

const ENTER_ALT_SCREEN = "\u001b[?1049h\u001b[?25l\u001b[?1000h\u001b[?1006h\u001b[?2004h\u001b[2J";
const LEAVE_ALT_SCREEN = "\u001b[?2004l\u001b[?1006l\u001b[?1000l\u001b[?25h\u001b[?1049l\u001b[0m";
const MAX_ARTIFACT_PREVIEW_BYTES = 64 * 1024;

interface TerminalPort {
  readonly columns: number;
  readonly rows: number;
  write(value: string): void;
}

interface InputPort {
  isTTY?: boolean;
  setRawMode?(enabled: boolean): void;
  resume(): void;
  pause(): void;
  on(event: "data", listener: (data: Uint8Array) => void): void;
  off(event: "data", listener: (data: Uint8Array) => void): void;
}

export interface TuiAppOptions {
  readonly client: TerminusClient;
  readonly terminal?: TerminalPort;
  readonly input?: InputPort;
  readonly now?: () => Date;
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function operationKey(scope: string): string {
  return `tui:${process.pid}:${Date.now().toString(36)}:${scope}`;
}

function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timeout = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
  });
}

function helpLines(): readonly string[] {
  return [
    "Navigate",
    "  Tab / Shift+Tab     Move focus",
    "  ↑ ↓                 Move selection",
    "  Enter               Open or send",
    "  Mouse               Select rows and scroll activity",
    "  b / d               Toggle sidebar / task details",
    "",
    "Work",
    "  n                   Create a task",
    "  a                   Review pending approval",
    "  x                   Answer material question",
    "  i                   Inspect selected event",
    "  r                   Refresh snapshots",
    "  Ctrl+P              Open command palette",
    "  /                   Type a command with suggestions",
    "",
    "Commands",
    "  /pause  /resume  /review  /stop",
    "  /context <manifest-id>  /artifact <hash>",
    "  /job <id>  /stop-job <id>  /clear",
    "  /new  /refresh  /quit",
  ];
}

export class TuiApp {
  private stateValue: TuiState = initialState();
  private readonly client: TerminusClient;
  private readonly terminal: TerminalPort;
  private readonly input: InputPort;
  private readonly now: () => Date;
  private stopped = false;
  private streamAbort: AbortController | null = null;
  private streamGeneration = 0;
  private refreshAbort: AbortController | null = null;
  private rendered = false;
  private renderTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: TuiAppOptions) {
    this.client = options.client;
    this.terminal = options.terminal ?? stdout;
    this.input = options.input ?? stdin;
    this.now = options.now ?? (() => new Date());
  }

  get state(): TuiState {
    return this.stateValue;
  }

  async start(): Promise<void> {
    if (!this.input.isTTY || !this.input.setRawMode) {
      throw new Error("The interactive TUI needs a terminal. Use `health`, `sessions`, or another command in scripts.");
    }
    this.stopped = false;
    this.input.setRawMode(true);
    this.input.resume();
    this.input.on("data", this.onData);
    process.on("SIGWINCH", this.onResize);
    process.on("SIGINT", this.onSignal);
    process.on("SIGTERM", this.onSignal);
    this.terminal.write(ENTER_ALT_SCREEN);
    this.rendered = true;
    this.render();
    await this.refreshAll();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.streamAbort?.abort();
    this.refreshAbort?.abort();
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.renderTimer = null;
    this.input.off("data", this.onData);
    process.off("SIGWINCH", this.onResize);
    process.off("SIGINT", this.onSignal);
    process.off("SIGTERM", this.onSignal);
    this.input.setRawMode?.(false);
    this.input.pause();
    if (this.rendered) this.terminal.write(LEAVE_ALT_SCREEN);
  }

  private readonly onData = (data: Uint8Array): void => {
    for (const input of decodeTerminalInput(data)) void this.handleInput(input);
  };

  private readonly onResize = (): void => this.render();
  private readonly onSignal = (): void => this.stop();

  private setState(next: TuiState): void {
    this.stateValue = next;
    this.scheduleRender();
  }

  private patch(patch: Partial<TuiState>): void {
    this.setState({ ...this.stateValue, ...patch });
  }

  private render(): void {
    if (this.stopped) return;
    this.terminal.write(renderScreen(this.stateValue, this.terminal.columns, this.terminal.rows));
  }

  /** Coalesce event bursts so a busy task cannot repaint the terminal without a frame limit. */
  private scheduleRender(): void {
    if (this.renderTimer || this.stopped) return;
    this.renderTimer = setTimeout(() => {
      this.renderTimer = null;
      this.render();
    }, 16);
  }

  private notice(message: string, tone: Tone = "default"): void {
    this.patch({ notice: { message, tone } });
  }

  private async refreshAll(): Promise<void> {
    this.refreshAbort?.abort();
    const abort = new AbortController();
    this.refreshAbort = abort;
    this.patch({ busy: "Refreshing…", notice: null, connection: "connecting" });

    const [healthResult, sessionsResult, approvalsResult, questionsResult] = await Promise.allSettled([
      this.client.health(abort.signal),
      this.client.listSessions(abort.signal),
      this.client.listApprovals(abort.signal),
      this.client.listMaterialQuestionsV2(undefined, abort.signal),
    ]);
    if (abort.signal.aborted || this.stopped) return;

    const failures: string[] = [];
    let next = this.stateValue;
    if (healthResult.status === "fulfilled") {
      next = {
        ...next,
        health: {
          status: healthResult.value.status,
          version: healthResult.value.version,
          ready: healthResult.value.ready,
        },
      };
    } else failures.push(`health: ${errorMessage(healthResult.reason)}`);
    if (sessionsResult.status === "fulfilled") {
      next = { ...next, sessions: sessionsResult.value.sessions, selectedSession: Math.min(next.selectedSession, Math.max(0, sessionsResult.value.sessions.length - 1)) };
    } else failures.push(`sessions: ${errorMessage(sessionsResult.reason)}`);
    if (approvalsResult.status === "fulfilled") next = { ...next, approvals: approvalsResult.value.approvals };
    else failures.push(`approvals: ${errorMessage(approvalsResult.reason)}`);
    if (questionsResult.status === "fulfilled") next = { ...next, questions: questionsResult.value.questions };
    else failures.push(`questions: ${errorMessage(questionsResult.reason)}`);
    next = {
      ...next,
      busy: null,
      connection: failures.length === 0 ? "online" : healthResult.status === "fulfilled" ? "online" : "offline",
      notice: failures.length > 0 ? { message: `Some data could not be loaded. ${failures[0] ?? ""}`, tone: "warn" } : null,
    };
    this.setState(next);
    await this.loadSelectedSession();
  }

  private async loadSelectedSession(): Promise<void> {
    const session = selectedSession(this.stateValue);
    if (!session) {
      this.streamAbort?.abort();
      this.patch({ tasks: [], taskV2: null, attention: null, interventions: [] });
      return;
    }
    this.patch({ busy: "Loading tasks…" });
    try {
      const result = await this.client.listSessionTasks(session.id);
      if (this.stopped || selectedSession(this.stateValue)?.id !== session.id) return;
      this.patch({
        tasks: result.tasks,
        selectedTask: Math.min(this.stateValue.selectedTask, Math.max(0, result.tasks.length - 1)),
        busy: null,
      });
      await this.loadSelectedTask();
    } catch (error) {
      this.patch({ busy: null });
      this.notice(`Couldn't load tasks. ${errorMessage(error)}`, "danger");
    }
  }

  private async loadSelectedTask(): Promise<void> {
    const task = selectedTask(this.stateValue);
    this.streamAbort?.abort();
    if (!task) {
      this.patch({ taskV2: null, attention: null, interventions: [], timeline: [], lastCursor: null });
      return;
    }
    this.patch({ busy: "Loading task…", timeline: [], seenEventIds: new Set(), lastCursor: null });
    const [taskResult, attentionResult, interventionResult] = await Promise.allSettled([
      this.client.getTaskV2(task.id),
      this.client.assessTaskAttentionV2(task.id),
      this.client.listInterventionsV2(task.id),
    ]);
    if (this.stopped || selectedTask(this.stateValue)?.id !== task.id) return;
    this.patch({
      taskV2: taskResult.status === "fulfilled" ? taskResult.value : null,
      attention: attentionResult.status === "fulfilled" ? attentionResult.value : null,
      interventions: interventionResult.status === "fulfilled" ? interventionResult.value.interventions : [],
      busy: null,
      // The public session list includes legacy tasks that do not yet have a
      // v2 cockpit projection. Their canonical task snapshot remains usable.
      notice: this.stateValue.notice,
    });
    this.startEventStream(task.id);
  }

  private startEventStream(taskId: string): void {
    this.streamAbort?.abort();
    const abort = new AbortController();
    this.streamAbort = abort;
    const generation = ++this.streamGeneration;
    void this.consumeEvents(taskId, generation, abort);
  }

  private async consumeEvents(taskId: string, generation: number, abort: AbortController): Promise<void> {
    let backoff = 250;
    while (!abort.signal.aborted && !this.stopped && generation === this.streamGeneration) {
      try {
        this.patch({ connection: backoff === 250 ? "online" : "reconnecting" });
        for await (const event of this.client.subscribeEvents({
          cursor: this.stateValue.lastCursor,
          task_id: taskId,
          signal: abort.signal,
        })) {
          if (abort.signal.aborted || generation !== this.streamGeneration) return;
          this.setState(appendEvent(this.stateValue, event, this.now()));
          backoff = 250;
          if (event.event.includes("approval") || event.event.includes("attention") || event.event.includes("task")) {
            void this.refreshTaskQueues(taskId);
          }
        }
        if (!abort.signal.aborted) throw new Error("The event stream closed.");
      } catch (error) {
        if (abort.signal.aborted) return;
        this.patch({
          connection: "reconnecting",
          notice: { message: `Live activity disconnected. Retrying from the saved cursor. ${errorMessage(error)}`, tone: "warn" },
        });
        await sleep(backoff, abort.signal);
        backoff = Math.min(5_000, backoff * 2);
      }
    }
  }

  private async refreshTaskQueues(taskId: string): Promise<void> {
    const session = selectedSession(this.stateValue);
    const [approvalsResult, questionsResult, tasksResult] = await Promise.allSettled([
      this.client.listApprovals(),
      this.client.listMaterialQuestionsV2(taskId),
      session ? this.client.listSessionTasks(session.id) : Promise.resolve({ tasks: this.stateValue.tasks }),
    ]);
    if (this.stopped || selectedTask(this.stateValue)?.id !== taskId) return;
    const tasks = tasksResult.status === "fulfilled" ? tasksResult.value.tasks : this.stateValue.tasks;
    const selectedTaskIndex = tasks.findIndex((task) => task.id === taskId);
    this.patch({
      approvals: approvalsResult.status === "fulfilled" ? approvalsResult.value.approvals : this.stateValue.approvals,
      questions: questionsResult.status === "fulfilled" ? questionsResult.value.questions : this.stateValue.questions,
      tasks,
      selectedTask: selectedTaskIndex >= 0 ? selectedTaskIndex : this.stateValue.selectedTask,
    });
  }

  private async handleInput(input: TerminalInput): Promise<void> {
    if (input.kind === "mouse") {
      await this.handleMouse(input);
      return;
    }
    if (input.ctrl && (input.name === "q" || input.name === "c")) {
      this.stop();
      return;
    }
    if (input.ctrl && input.name === "p") {
      this.openPalette();
      return;
    }
    if (input.ctrl && input.name === "r") {
      await this.refreshAll();
      return;
    }
    if (this.stateValue.modal) {
      await this.handleModalKey(input);
      return;
    }
    await this.handleMainKey(input);
  }

  private async handleMouse(input: MouseInput): Promise<void> {
    if (input.action === "scroll_up" || input.action === "scroll_down") {
      const delta = input.action === "scroll_up" ? 3 : -3;
      this.patch({ timelineScroll: Math.max(0, Math.min(this.stateValue.timeline.length, this.stateValue.timelineScroll + delta)) });
      return;
    }
    if (input.action !== "down" || input.button !== "left" || this.stateValue.modal) return;
    const target = hitTest(this.stateValue, this.terminal.columns, this.terminal.rows, input.x, input.y);
    if (target.kind === "session") {
      this.patch({ selectedSession: target.index, focus: "sessions" });
      await this.loadSelectedSession();
    } else if (target.kind === "task") {
      this.patch({ selectedTask: target.index, focus: "tasks" });
      await this.loadSelectedTask();
    } else if (target.kind === "composer") {
      this.patch({ focus: "composer" });
    } else if (target.kind === "timeline") {
      this.patch({ focus: "timeline" });
    }
  }

  private async handleMainKey(input: KeyInput): Promise<void> {
    if (input.name === "escape") {
      this.patch({ composer: "", composerCursor: 0, composerHistoryIndex: null, commandSelection: 0, focus: "timeline", notice: null });
      return;
    }
    if (this.stateValue.focus === "composer") {
      await this.handleComposerKey(input);
      return;
    }
    if (input.name === "tab") {
      this.setState(cycleFocus(this.stateValue, input.shift));
      return;
    }
    if (input.name === "up" || input.name === "down") {
      this.setState(moveSelection(this.stateValue, input.name === "up" ? -1 : 1));
      return;
    }
    if (input.name === "enter") {
      if (this.stateValue.focus === "sessions") await this.loadSelectedSession();
      else if (this.stateValue.focus === "tasks") await this.loadSelectedTask();
      else this.inspectSelectedEvent();
      return;
    }
    if (input.text === "n") this.openNewTask();
    else if (input.text === "a") this.openApproval();
    else if (input.text === "x") this.openQuestion();
    else if (input.text === "i") this.inspectSelectedEvent();
    else if (input.text === "r") await this.refreshAll();
    else if (input.text === "b") this.patch({ sidebarOpen: !this.stateValue.sidebarOpen });
    else if (input.text === "d") this.patch({ inspectorOpen: !this.stateValue.inspectorOpen });
    else if (input.text === "?" || input.name === "?") this.openHelp();
    else if (input.text === "/") this.patch({ focus: "composer", composer: "/", composerCursor: 1, commandSelection: 0, composerHistoryIndex: null });
    else if (input.text.length > 0 && !input.ctrl && !input.alt) {
      this.patch({ focus: "composer", composer: input.text, composerCursor: [...input.text].length, commandSelection: 0, composerHistoryIndex: null });
    }
  }

  private async handleComposerKey(input: KeyInput): Promise<void> {
    const suggestions = commandSuggestions(this.stateValue.composer);
    if (input.name === "up" || input.name === "down") {
      if (suggestions.length > 0) {
        const delta = input.name === "up" ? -1 : 1;
        const selected = (this.stateValue.commandSelection + delta + suggestions.length) % suggestions.length;
        this.patch({ commandSelection: selected });
      } else {
        this.browseComposerHistory(input.name === "up" ? -1 : 1);
      }
    } else if (input.name === "left" || input.name === "right" || input.name === "home" || input.name === "end") {
      const length = [...this.stateValue.composer].length;
      const cursor = input.name === "home"
        ? 0
        : input.name === "end"
          ? length
          : Math.max(0, Math.min(length, this.stateValue.composerCursor + (input.name === "left" ? -1 : 1)));
      this.patch({ composerCursor: cursor, composerHistoryIndex: null });
    } else if (input.name === "backspace") {
      const characters = [...this.stateValue.composer];
      if (this.stateValue.composerCursor > 0) {
        characters.splice(this.stateValue.composerCursor - 1, 1);
        this.patch({ composer: characters.join(""), composerCursor: this.stateValue.composerCursor - 1, commandSelection: 0, composerHistoryIndex: null });
      }
    } else if (input.name === "delete") {
      const characters = [...this.stateValue.composer];
      if (this.stateValue.composerCursor < characters.length) {
        characters.splice(this.stateValue.composerCursor, 1);
        this.patch({ composer: characters.join(""), commandSelection: 0, composerHistoryIndex: null });
      }
    } else if (input.name === "tab") {
      const suggestion = suggestions[Math.min(this.stateValue.commandSelection, suggestions.length - 1)];
      if (suggestion) {
        const value = `/${suggestion.name}${suggestion.usage.includes(" <") ? " " : ""}`;
        this.patch({ composer: value, composerCursor: [...value].length, commandSelection: 0, composerHistoryIndex: null });
      } else {
        this.setState(cycleFocus(this.stateValue, input.shift));
      }
    } else if (input.name === "enter") {
      const selected = suggestions[Math.min(this.stateValue.commandSelection, suggestions.length - 1)];
      const value = selected && !this.stateValue.composer.slice(1).includes(" ") ? `/${selected.name}` : this.stateValue.composer.trim();
      this.recordComposerHistory(value);
      if (value.startsWith("/")) await this.runCommand(value.slice(1));
      else await this.sendMessage(value);
    } else if (input.text.length > 0 && !input.ctrl && !input.alt) {
      const characters = [...this.stateValue.composer];
      characters.splice(this.stateValue.composerCursor, 0, ...input.text);
      this.patch({
        composer: characters.join(""),
        composerCursor: this.stateValue.composerCursor + [...input.text].length,
        commandSelection: 0,
        composerHistoryIndex: null,
      });
    }
  }

  private browseComposerHistory(delta: -1 | 1): void {
    const history = this.stateValue.composerHistory;
    if (history.length === 0) return;
    const current = this.stateValue.composerHistoryIndex;
    const next = current === null
      ? delta < 0 ? history.length - 1 : null
      : current + delta < 0 || current + delta >= history.length ? null : current + delta;
    const composer = next === null ? "" : history[next] ?? "";
    this.patch({ composer, composerCursor: [...composer].length, composerHistoryIndex: next, commandSelection: 0 });
  }

  private recordComposerHistory(value: string): void {
    if (value.length === 0) return;
    const history = this.stateValue.composerHistory.filter((item) => item !== value);
    history.push(value);
    this.patch({ composerHistory: history.slice(-100), composerHistoryIndex: null });
  }

  private async handleModalKey(input: KeyInput): Promise<void> {
    const modal = this.stateValue.modal;
    if (!modal) return;
    if (input.name === "escape") {
      this.patch({ modal: null });
      return;
    }
    if (modal.kind === "approval" || modal.kind === "question") {
      if (input.name === "up" || input.name === "down") {
        this.setState(moveSelection(this.stateValue, input.name === "up" ? -1 : 1));
      } else if (input.name === "enter") {
        if (modal.kind === "approval") await this.resolveApproval(modal.selected);
        else await this.resolveQuestion(modal.selected);
      }
      return;
    }
    if (modal.kind === "new_task") {
      await this.handleNewTaskKey(input);
      return;
    }
    if (modal.kind === "confirm") {
      if (input.name === "enter") await this.confirmAction(modal.confirmAction, modal.confirmTarget);
      return;
    }
    if (modal.kind === "help" || modal.kind === "inspect") {
      const delta = input.name === "up"
        ? -1
        : input.name === "down"
          ? 1
          : input.name === "pageup"
            ? -10
            : input.name === "pagedown"
              ? 10
              : 0;
      if (delta !== 0) {
        this.patch({ modal: { ...modal, scroll: Math.max(0, Math.min(modal.body.length - 1, modal.scroll + delta)) } });
      }
      return;
    }
    if (modal.kind === "palette") {
      if (input.name === "backspace") {
        this.patch({ modal: { ...modal, input: [...modal.input].slice(0, -1).join("") }, commandSelection: 0 });
      } else if (input.name === "up" || input.name === "down") {
        const suggestions = commandSuggestions(`/${modal.input}`);
        if (suggestions.length > 0) {
          const delta = input.name === "up" ? -1 : 1;
          this.patch({ commandSelection: (this.stateValue.commandSelection + delta + suggestions.length) % suggestions.length });
        }
      } else if (input.name === "tab") {
        const suggestions = commandSuggestions(`/${modal.input}`);
        const selected = suggestions[Math.min(this.stateValue.commandSelection, suggestions.length - 1)];
        if (selected) this.patch({ modal: { ...modal, input: selected.name }, commandSelection: 0 });
      } else if (input.name === "enter") {
        const suggestions = commandSuggestions(`/${modal.input}`);
        const selected = suggestions[Math.min(this.stateValue.commandSelection, suggestions.length - 1)];
        await this.runCommand(selected?.name ?? modal.input);
      } else if (input.text.length > 0 && !input.ctrl && !input.alt) {
        this.patch({ modal: { ...modal, input: `${modal.input}${input.text}` }, commandSelection: 0 });
      }
    }
  }

  private async handleNewTaskKey(input: KeyInput): Promise<void> {
    const modal = this.stateValue.modal;
    if (!modal || modal.kind !== "new_task") return;
    const fieldNames = ["workspaceUri", "sessionTitle", "objective", "firstMessage"] as const;
    const fieldName = fieldNames[modal.draft.field];
    if (input.name === "tab" || input.name === "enter") {
      if (input.name === "enter" && modal.draft.field === 3) {
        await this.createTaskFromDraft();
        return;
      }
      const delta = input.shift ? -1 : 1;
      const field = Math.max(0, Math.min(3, modal.draft.field + delta)) as 0 | 1 | 2 | 3;
      this.patch({ modal: { ...modal, draft: { ...modal.draft, field } } });
    } else if (input.name === "backspace") {
      this.patch({ modal: { ...modal, draft: { ...modal.draft, [fieldName]: [...modal.draft[fieldName]].slice(0, -1).join("") } } });
    } else if (input.text.length > 0 && !input.ctrl && !input.alt) {
      this.patch({ modal: { ...modal, draft: { ...modal.draft, [fieldName]: `${modal.draft[fieldName]}${input.text}` } } });
    }
  }

  private openPalette(): void {
    this.patch({
      modal: { kind: "palette", title: "Command palette", body: COMMANDS.map((command) => `${command.usage}  ${command.description}`), input: "", scroll: 0 },
      commandSelection: 0,
    });
  }

  private openHelp(): void {
    this.patch({ modal: { kind: "help", title: "Keyboard and commands", body: helpLines(), input: "", scroll: 0 } });
  }

  private openNewTask(): void {
    this.patch({
      modal: {
        kind: "new_task",
        draft: { workspaceUri: process.cwd(), sessionTitle: "", objective: "", firstMessage: "", field: 0 },
      },
    });
  }

  private openApproval(): void {
    if (pendingApprovals(this.stateValue).length === 0) {
      this.notice("No pending approvals for this task.", "muted");
      return;
    }
    this.patch({ modal: { kind: "approval", selected: 0 } });
  }

  private openQuestion(): void {
    if (pendingQuestions(this.stateValue).length === 0) {
      this.notice("No material questions for this task.", "muted");
      return;
    }
    this.patch({ modal: { kind: "question", selected: 0 } });
  }

  private inspectSelectedEvent(): void {
    const item = this.stateValue.timeline[this.stateValue.selectedTimeline];
    if (!item) return;
    let detail = item.detail;
    try {
      detail = JSON.stringify(JSON.parse(item.detail), null, 2);
    } catch {
      // Raw event data is the correct fallback.
    }
    this.patch({ modal: { kind: "inspect", title: item.kind, body: detail.split("\n"), input: "", scroll: 0 } });
  }

  private async sendMessage(value: string): Promise<void> {
    if (value.length === 0) return;
    const task = selectedTask(this.stateValue);
    if (!task) {
      this.notice("Choose a task before sending a message.", "warn");
      return;
    }
    this.patch({ busy: "Sending…", composer: "", composerCursor: 0, composerHistoryIndex: null, commandSelection: 0 });
    try {
      await this.client.startTurn(
        { thread_id: task.thread_id, task_id: task.id, user_input: value },
        { idempotencyKey: operationKey("start-turn") },
      );
      this.patch({ busy: null, notice: { message: "Message sent.", tone: "good" } });
    } catch (error) {
      this.patch({ busy: null, composer: value, composerCursor: [...value].length });
      this.notice(`Couldn't send the message. ${errorMessage(error)}`, "danger");
    }
  }

  private async createTaskFromDraft(): Promise<void> {
    const modal = this.stateValue.modal;
    if (!modal || modal.kind !== "new_task") return;
    const draft = modal.draft;
    if (!draft.workspaceUri.trim() || !draft.objective.trim() || !draft.firstMessage.trim()) {
      this.notice("Workspace, objective, and first request are required.", "warn");
      return;
    }
    this.patch({ modal: null, busy: "Creating task…" });
    const key = operationKey("new-task");
    try {
      const workspace = await this.client.openWorkspace(
        { root_uri: draft.workspaceUri.trim() },
        { idempotencyKey: `${key}:workspace` },
      );
      const session = await this.client.createSession(
        { workspace_id: workspace.id, title: draft.sessionTitle.trim() || draft.objective.trim() },
        { idempotencyKey: `${key}:session` },
      );
      if (!session.active_thread_id) throw new Error("The new session has no active thread.");
      const task = await this.client.createTask(
        { session_id: session.id, thread_id: session.active_thread_id, objective: draft.objective.trim() },
        { idempotencyKey: `${key}:task` },
      );
      await this.client.startTask(task.id, { idempotencyKey: `${key}:start` });
      await this.client.startTurn(
        { thread_id: session.active_thread_id, task_id: task.id, user_input: draft.firstMessage.trim() },
        { idempotencyKey: `${key}:turn` },
      );
      this.patch({ busy: null, notice: { message: "Task created and started.", tone: "good" } });
      await this.refreshAll();
      const sessionIndex = this.stateValue.sessions.findIndex((candidate) => candidate.id === session.id);
      if (sessionIndex >= 0) {
        this.patch({ selectedSession: sessionIndex });
        await this.loadSelectedSession();
        const taskIndex = this.stateValue.tasks.findIndex((candidate) => candidate.id === task.id);
        if (taskIndex >= 0) this.patch({ selectedTask: taskIndex });
        await this.loadSelectedTask();
      }
    } catch (error) {
      this.patch({ busy: null, modal });
      this.notice(`Couldn't create the task. ${errorMessage(error)}`, "danger");
    }
  }

  private async resolveApproval(selected: number): Promise<void> {
    const approval = pendingApprovals(this.stateValue)[0];
    const decision = approval?.supported_decisions[selected];
    if (!approval || !decision) return;
    this.patch({ modal: null, busy: "Recording decision…" });
    try {
      const result = await this.client.resolveApproval(
        approval.id,
        approval.operation_hash,
        decision,
        { idempotencyKey: operationKey(`approval:${approval.id}`) },
      );
      this.patch({
        approvals: this.stateValue.approvals.map((item) => item.id === result.id ? result : item),
        busy: null,
        notice: { message: `Approval ${decision.replaceAll("_", " ")}.`, tone: decision.startsWith("deny") || decision === "stop_task" ? "warn" : "good" },
      });
    } catch (error) {
      this.patch({ busy: null, modal: { kind: "approval", selected } });
      this.notice(`Couldn't record the decision. ${errorMessage(error)}`, "danger");
    }
  }

  private async resolveQuestion(selected: number): Promise<void> {
    const question = pendingQuestions(this.stateValue)[0];
    const option = question?.options[selected];
    if (!question || !option) return;
    this.patch({ modal: null, busy: "Recording answer…" });
    try {
      const result = await this.client.resolveMaterialQuestionV2(
        question.id,
        option,
        { idempotencyKey: operationKey(`question:${question.id}`) },
      );
      if (!result.success) throw new Error(result.error ?? "The server rejected the answer.");
      this.patch({
        questions: this.stateValue.questions.map((item) => item.id === question.id && result.question ? result.question : item),
        busy: null,
        notice: { message: "Answer recorded.", tone: "good" },
      });
    } catch (error) {
      this.patch({ busy: null, modal: { kind: "question", selected } });
      this.notice(`Couldn't record the answer. ${errorMessage(error)}`, "danger");
    }
  }

  private async runCommand(raw: string): Promise<void> {
    const [command = "", ...args] = raw.trim().replace(/^\//, "").split(/\s+/);
    this.patch({ modal: null, composer: "", composerCursor: 0, composerHistoryIndex: null, commandSelection: 0 });
    switch (command) {
      case "":
      case "help": this.openHelp(); break;
      case "new": this.openNewTask(); break;
      case "refresh": await this.refreshAll(); break;
      case "quit": this.stop(); break;
      case "clear": this.patch({ timeline: [], seenEventIds: new Set(), selectedTimeline: 0, timelineScroll: 0 }); break;
      case "approve": this.openApproval(); break;
      case "answer": this.openQuestion(); break;
      case "pause": await this.applyTaskIntervention("pause"); break;
      case "resume": await this.applyTaskIntervention("resume"); break;
      case "review": await this.applyTaskIntervention("request_independent_review"); break;
      case "stop": this.confirmCancelTask(); break;
      case "context": await this.inspectContext(args[0]); break;
      case "artifact": await this.inspectArtifact(args[0]); break;
      case "job": await this.inspectJob(args[0]); break;
      case "stop-job": this.confirmStopJob(args[0]); break;
      default: this.notice(`Unknown command: /${command}. Press ? for commands.`, "warn");
    }
  }

  private async applyTaskIntervention(verb: "pause" | "resume" | "request_independent_review"): Promise<void> {
    const task = selectedTask(this.stateValue);
    if (!task) {
      this.notice("Choose a task first.", "warn");
      return;
    }
    this.patch({ busy: `${verb.replaceAll("_", " ")}…` });
    try {
      const proposed = verb === "request_independent_review"
        ? await this.client.proposeInterventionV2({
          taskId: task.id,
          verb,
          targetEntityId: task.id,
          payload: { scope: "Review the task against its acceptance criteria." },
          rationale: "Operator requested an independent review from the TUI.",
        }, { idempotencyKey: operationKey(`intervention:${verb}:propose`) })
        : await this.client.proposeInterventionV2({
          taskId: task.id,
          verb,
          targetEntityId: task.id,
          payload: {},
          rationale: `Operator requested ${verb} from the TUI.`,
        }, { idempotencyKey: operationKey(`intervention:${verb}:propose`) });
      const result = await this.client.applyInterventionV2(
        proposed.id,
        { idempotencyKey: operationKey(`intervention:${verb}:apply`) },
      );
      if (!result.success) throw new Error(result.error ?? "The intervention was not applied.");
      this.patch({ busy: null, notice: { message: `${verb.replaceAll("_", " ")} applied.`, tone: "good" } });
      await this.loadSelectedTask();
    } catch (error) {
      this.patch({ busy: null });
      this.notice(`Couldn't apply ${verb.replaceAll("_", " ")}. ${errorMessage(error)}`, "danger");
    }
  }

  private confirmCancelTask(): void {
    const task = selectedTask(this.stateValue);
    if (!task) {
      this.notice("Choose a task first.", "warn");
      return;
    }
    this.patch({
      modal: {
        kind: "confirm",
        title: "Stop task?",
        body: ["This cancels the active task. Completed work remains in its artifacts and event history.", "", task.id],
        input: "",
        scroll: 0,
        confirmAction: "cancel_task",
        confirmTarget: task.id,
      },
    });
  }

  private confirmStopJob(jobId: string | undefined): void {
    if (!jobId) {
      this.notice("Usage: /stop-job <job-id>", "warn");
      return;
    }
    this.patch({
      modal: {
        kind: "confirm",
        title: "Stop job?",
        body: ["This requests a controlled stop for the selected job.", "", jobId],
        input: "",
        scroll: 0,
        confirmAction: "stop_job",
        confirmTarget: jobId,
      },
    });
  }

  private async confirmAction(action: "cancel_task" | "stop_job" | undefined, target: string | undefined): Promise<void> {
    if (!action || !target) return;
    this.patch({ modal: null, busy: action === "cancel_task" ? "Stopping task…" : "Stopping job…" });
    try {
      if (action === "cancel_task") {
        await this.client.cancelTask(target, { idempotencyKey: operationKey(`cancel:${target}`), reason: "Stopped by the operator in the TUI." });
        await this.loadSelectedSession();
      } else {
        await this.client.stopJob(target, { idempotencyKey: operationKey(`stop-job:${target}`), reason: "Stopped by the operator in the TUI." });
      }
      this.patch({ busy: null, notice: { message: action === "cancel_task" ? "Task stopped." : "Job stop requested.", tone: "warn" } });
    } catch (error) {
      this.patch({ busy: null });
      this.notice(`Couldn't stop ${action === "cancel_task" ? "the task" : "the job"}. ${errorMessage(error)}`, "danger");
    }
  }

  private async inspectContext(id: string | undefined): Promise<void> {
    if (!id) {
      this.notice("Usage: /context <manifest-id>", "warn");
      return;
    }
    this.patch({ busy: "Loading context manifest…" });
    try {
      const manifest = await this.client.getContextManifest(id);
      this.patch({
        busy: null,
        contextManifest: manifest,
        modal: { kind: "inspect", title: "Context manifest", body: JSON.stringify(manifest, null, 2).split("\n"), input: "", scroll: 0 },
      });
    } catch (error) {
      this.patch({ busy: null });
      this.notice(`Couldn't load the context manifest. ${errorMessage(error)}`, "danger");
    }
  }

  private async inspectArtifact(hash: string | undefined): Promise<void> {
    if (!hash) {
      this.notice("Usage: /artifact <hash>", "warn");
      return;
    }
    const task = selectedTask(this.stateValue);
    if (!task) {
      this.notice("Select a task before loading one of its artifacts.", "warn");
      return;
    }
    this.patch({ busy: "Loading artifact…" });
    try {
      const bytes = await this.client.getArtifact(hash, task.id);
      const previewBytes = bytes.slice(0, MAX_ARTIFACT_PREVIEW_BYTES);
      const decoded = new TextDecoder("utf-8", { fatal: false }).decode(previewBytes);
      const lines = decoded.split("\n");
      if (bytes.length > MAX_ARTIFACT_PREVIEW_BYTES) {
        lines.push("", `[Preview truncated at ${MAX_ARTIFACT_PREVIEW_BYTES.toLocaleString()} of ${bytes.length.toLocaleString()} bytes. The immutable artifact hash is ${hash}.]`);
      }
      this.patch({
        busy: null,
        artifactPreview: lines,
        modal: { kind: "inspect", title: `Artifact ${hash.slice(0, 12)}`, body: lines, input: "", scroll: 0 },
      });
    } catch (error) {
      this.patch({ busy: null });
      this.notice(`Couldn't load the artifact. ${errorMessage(error)}`, "danger");
    }
  }

  private async inspectJob(id: string | undefined): Promise<void> {
    if (!id) {
      this.notice("Usage: /job <job-id>", "warn");
      return;
    }
    this.patch({ busy: "Loading job…" });
    try {
      const job = await this.client.getJob(id);
      this.patch({ busy: null, modal: { kind: "inspect", title: `Job ${id}`, body: JSON.stringify(job, null, 2).split("\n"), input: "", scroll: 0 } });
    } catch (error) {
      this.patch({ busy: null });
      this.notice(`Couldn't load the job. ${errorMessage(error)}`, "danger");
    }
  }
}

export function createTuiClient(baseUrl: string, token: string): TerminusClient {
  return new TerminusClient({ baseUrl, xformPort: 3050, token });
}

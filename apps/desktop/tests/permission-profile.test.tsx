/**
 * The access level is a control, not a caption.
 *
 * The composer used to render the session's `default_permission_profile` as a
 * static chip: it showed how much a project would let an agent do and offered
 * no way to change it short of calling the control plane by hand. It is the
 * most consequential setting a run has, so it belongs where runs are started.
 *
 * Three levels, and the project holds one. Legacy and unrecognised values
 * resolve to the level the control plane would itself apply rather than to an
 * invented fourth state — a client that displayed a *safer* level than the one
 * actually in force would be lying in the one place an operator checks.
 */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { Composer } from "../src/components/Composer";
import { useTerminusStore } from "../src/hooks/use-terminus";
import { api } from "../src/lib/api";
import {
  DEFAULT_PERMISSION_PROFILE,
  isKnownPermissionProfile,
  permissionProfileIsCaution,
  resolvePermissionProfile,
} from "../src/lib/permission-profiles";
import type { Session, Task } from "../src/types";

vi.mock("../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api");
  return {
    ...actual,
    api: {
      ...actual.api,
      startTask: vi.fn(async () => ({ task_id: "task-1", status: "ACTIVE", event_cursor: "c1", links: { events: "", task: "" } })),
      startTurn: vi.fn(async () => ({})),
      listTasks: vi.fn(async () => []),
      listProviderModels: vi.fn(async () => ({ providers: [], models: [] })),
      // The store writes the response back over the session it patched.
      updateSession: vi.fn(async (id: string, patch: Record<string, unknown>) => ({
        id,
        workspace_id: "ws-1",
        active_thread_id: "thread-1",
        title: "Terminus",
        status: "ACTIVE",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        ...patch,
      })),
    },
  };
});

const now = new Date().toISOString();

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: "session-1",
    workspace_id: "ws-1",
    active_thread_id: "thread-1",
    title: "Terminus",
    created_at: now,
    updated_at: now,
    ...overrides,
  } as Session;
}

function task(): Task {
  return {
    id: "task-1",
    session_id: "session-1",
    thread_id: "thread-1",
    status: "ACTIVE",
    phase: "EXECUTE",
    active_contract_version: 1,
    risk_class: "normal",
    created_at: now,
    updated_at: now,
    completed_at: null,
    terminal_reason: null,
    contract: null,
  };
}

/** Mounts the new-thread composer against a session with `profile`. */
function install(profile?: string): void {
  useTerminusStore.setState({
    sessions: [session(profile === undefined ? {} : { default_permission_profile: profile })],
    selectedSessionId: "session-1",
    selectedTaskId: null,
    taskById: { "task-1": task() },
    tasksBySession: { "session-1": [task()] },
    eventsByTask: {},
    queuedSteerByTask: {},
    draftsByTask: {},
    sessionDraftsByTask: {},
    draftPersistenceByTask: {},
    draftStorageError: null,
    healthReady: true,
    healthStatus: "ready",
  });
}

function renderAccessComposer(): ReturnType<typeof render> {
  return render(<Composer onCreateTask={vi.fn(async () => undefined)} />);
}

function chip(name: RegExp = /^Access level: /): HTMLElement {
  return screen.getByRole("button", { name });
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  cleanup();
});
afterEach(cleanup);

describe("resolving what the session stored", () => {
  test("the default is full access, which is what the control plane runs", () => {
    expect(DEFAULT_PERMISSION_PROFILE).toBe("full-access");
  });

  test("reads the three ids back unchanged", () => {
    expect(resolvePermissionProfile("full-access")).toBe("full-access");
    expect(resolvePermissionProfile("auto")).toBe("auto");
    expect(resolvePermissionProfile("ask")).toBe("ask");
  });

  test("treats the legacy id and anything unknown as full access", () => {
    // Not a safe-by-default fallback on purpose: these sessions really do run
    // with full access, and showing "Ask for approval" for one would be the
    // dangerous kind of wrong.
    expect(resolvePermissionProfile("secure-local-default")).toBe("full-access");
    expect(resolvePermissionProfile("something-new")).toBe("full-access");
    expect(resolvePermissionProfile(null)).toBe("full-access");
    expect(resolvePermissionProfile("")).toBe("full-access");
    expect(isKnownPermissionProfile("secure-local-default")).toBe(false);
    expect(isKnownPermissionProfile("ask")).toBe(true);
  });

  test("spends the caution colour only on full access", () => {
    expect(permissionProfileIsCaution("full-access")).toBe(true);
    expect(permissionProfileIsCaution("auto")).toBe(false);
    expect(permissionProfileIsCaution("ask")).toBe(false);
  });
});

describe("the access chip", () => {
  test("defaults to Full workspace access when the project stored nothing", async () => {
    install();
    renderAccessComposer();
    expect(await screen.findByRole("button", { name: "Access level: Full workspace access. Change the access level" }))
      .toBeInTheDocument();
  });

  test("shows Full workspace access for the legacy profile, and keeps the raw id in the tooltip", async () => {
    install("secure-local-default");
    renderAccessComposer();

    const trigger = await screen.findByRole("button", { name: /^Access level: Full workspace access/ });
    // The label is an interpretation; the tooltip is the receipt for it.
    expect(trigger).toHaveAttribute("data-tooltip", "Access level · secure-local-default");
  });

  test("states the level the project actually holds", async () => {
    install("ask");
    renderAccessComposer();
    expect(await screen.findByRole("button", { name: /^Access level: Ask for approval/ })).toBeInTheDocument();
  });

  test("offers exactly the three levels, each with what it permits", async () => {
    install("full-access");
    const user = userEvent.setup();
    renderAccessComposer();

    await user.click(chip());
    const menu = await screen.findByRole("menu");
    const items = within(menu).getAllByRole("menuitem");
    expect(items).toHaveLength(3);
    expect(items.map((item) => item.textContent)).toEqual([
      "✓Full workspace accessRuns commands and edits this workspace without asking; host access stays sandboxed",
      "AutoWorks in the workspace freely; asks before network access",
      "Ask for approvalAsks before every edit, command, or fetch",
    ]);
  });

  test("choosing Ask for approval persists it as the project default", async () => {
    install("full-access");
    const user = userEvent.setup();
    renderAccessComposer();

    await user.click(chip());
    await user.click(await screen.findByRole("menuitem", { name: /^Ask for approval/ }));

    await waitFor(() => expect(api.updateSession).toHaveBeenCalledWith(
      "session-1",
      { default_permission_profile: "ask" },
      expect.objectContaining({ idempotencyKey: expect.any(String) }),
    ));
    // Optimistic, so the chip reflects the new level without a refetch.
    expect(await screen.findByRole("button", { name: /^Access level: Ask for approval/ })).toBeInTheDocument();
  });

  test("puts the old level back and says why when the control plane refuses", async () => {
    install("full-access");
    vi.mocked(api.updateSession).mockRejectedValueOnce(new Error("session is read-only"));
    const user = userEvent.setup();
    renderAccessComposer();

    await user.click(chip());
    await user.click(await screen.findByRole("menuitem", { name: /^Auto/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent("session is read-only");
    // Never left claiming a level the server did not accept.
    expect(await screen.findByRole("button", { name: /^Access level: Full workspace access/ })).toBeInTheDocument();
  });

  test("shows no chip at all when no project is selected", () => {
    useTerminusStore.setState({
      sessions: [], selectedSessionId: null, selectedTaskId: null,
      taskById: {}, tasksBySession: {}, eventsByTask: {}, queuedSteerByTask: {},
      draftsByTask: {}, sessionDraftsByTask: {}, healthReady: true, healthStatus: "ready",
    });
    render(<Composer onCreateTask={vi.fn(async () => undefined)} />);
    // Nothing to read a level from and nothing to write one to.
    expect(screen.queryByRole("button", { name: /^Access level/ })).not.toBeInTheDocument();
  });
});
